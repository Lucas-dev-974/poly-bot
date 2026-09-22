// Imbalance audit — Phase 1 calibration on BTC 15m complete windows.
// Method: one deterministic baseline fav-band sim (BEST config, S1 sizing,
// same as best-config-cap20.mts), then post-hoc join of every BUY fill with
// the order-book snapshot at fill time to test whether book imbalance
// discriminates winners from losers.
//
// Features (computed from bookSnapshots, both tokens):
//   imbTop      : (bid1-ask1)/(bid1+ask1) on the FILLED (favorite) token
//   imb3        : same over 3 levels on the filled token
//   crossTop    : L1 cross-book pressure: (bidsUp+asksDown - asksUp-bidsDown)/total
//   cross3      : same over 3 levels
//   crossRel    : cross3 signed toward the filled token's side (+ = pressure agrees)
// Buckets -> winrate / avg pnl per bucket; counterfactual thresholds -> kept/dropped pnl.
// Flip lead: does cross3 change side BEFORE a favorite flip (price-based)?
//
// Usage: npx tsx scripts/research/imbalance/imbalance-audit.mts
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows, booksFromRows } from "../../../src/backtest/windows.ts";
import { listStrategyPresets } from "../../../src/strategy-presets.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";
import type { BacktestResult } from "../../../src/backtest/types.ts";
import type { BacktestPositionRow } from "../../../src/db/repositories.ts";
import type { TokenBook } from "../../../src/types.js";

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };
const CAPITAL = 20;
const TICK_STALE_MS = 20_000; // max age of the book tick used at fill time
const PREV_GAP_MS = 90_000; // max gap between fill tick and previous tick (persistence)
const FLIP_LOOKBACK_MS = 300_000; // how far back to search an imbalance side-change before a price flip
const CROSS_SIGNAL = 0.1; // |cross3| considered a real side

// --- baseline config: BEST_SIGNAL + S1 sizing (best-config-cap20.mts) ---
const PAUSE = { favBandWhipsawEnabled: true, favBandWhipsawPauseAfterLosses: 3, favBandWhipsawPauseWindows: 8 };
const BEST_SIGNAL = {
  favBandAskMin: 0.68,
  favBandAskMax: 0.82,
  favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: null,
  ...PAUSE,
  favBandInverseEnabled: false,
  favBandExitEnabled: false,
  favBandOrderUsdc: 4.5,
  maxSharesPerOrder: 5,
  maxExposureUsdc: 6,
  maxOpenPositionsPerSide: 3,
  simulatedCapital: CAPITAL,
};

// ---------- book feature helpers ----------

type Side = { s1: number; s3: number; hasSizes: boolean };

function sideSums(book: TokenBook | undefined): Side {
  const l1 = (book?.bestBidSize ?? 0) + (book?.bestAskSize ?? 0);
  const l3 =
    l1 +
    (book?.bid2Size ?? 0) + (book?.ask2Size ?? 0) +
    (book?.bid3Size ?? 0) + (book?.ask3Size ?? 0);
  return { s1: l1, s3: l3, hasSizes: l3 > 0 };
}

function imb1(book: TokenBook | undefined): number | null {
  const b = book?.bestBidSize ?? 0;
  const a = book?.bestAskSize ?? 0;
  return b + a > 0 ? (b - a) / (b + a) : null;
}

function imb3(book: TokenBook | undefined): number | null {
  const b =
    (book?.bestBidSize ?? 0) + (book?.bid2Size ?? 0) + (book?.bid3Size ?? 0);
  const a =
    (book?.bestAskSize ?? 0) + (book?.ask2Size ?? 0) + (book?.ask3Size ?? 0);
  return b + a > 0 ? (b - a) / (b + a) : null;
}

/** L1 cross pressure, Up-perspective: >0 = pressure toward Up. */
function crossTop(up: TokenBook | undefined, down: TokenBook | undefined): number | null {
  const bull = (up?.bestBidSize ?? 0) + (down?.bestAskSize ?? 0);
  const bear = (up?.bestAskSize ?? 0) + (down?.bestBidSize ?? 0);
  return bull + bear > 0 ? (bull - bear) / (bull + bear) : null;
}

/** 3-level cross pressure, Up-perspective. */
function cross3(up: TokenBook | undefined, down: TokenBook | undefined): number | null {
  const bull =
    (up?.bestBidSize ?? 0) + (up?.bid2Size ?? 0) + (up?.bid3Size ?? 0) +
    (down?.bestAskSize ?? 0) + (down?.ask2Size ?? 0) + (down?.ask3Size ?? 0);
  const bear =
    (up?.bestAskSize ?? 0) + (up?.ask2Size ?? 0) + (up?.ask3Size ?? 0) +
    (down?.bestBidSize ?? 0) + (down?.bid2Size ?? 0) + (down?.bid3Size ?? 0);
  return bull + bear > 0 ? (bull - bear) / (bull + bear) : null;
}

function favIdxOf(books: TokenBook[]): number | null {
  let best: TokenBook | null = null;
  for (const b of books) {
    if (b.bestAsk === null) continue;
    if (!best || (b.bestAsk ?? 0) > (best.bestAsk ?? 0)) best = b;
  }
  return best ? best.outcomeIndex : null;
}

const BUCKETS = [-1, -0.6, -0.3, -0.1, 0.1, 0.3, 0.6, 1.0001];

function bucketize(
  fills: Array<{ feats: Feats | null; pnl: number; won: boolean }>,
  pick: (f: Feats) => number | null,
) {
  const buckets = BUCKETS.slice(0, -1).map((lo, i) => ({
    lo,
    hi: BUCKETS[i + 1],
    n: 0,
    pnl: 0,
    won: 0,
    lost: 0,
  }));
  let noData = 0;
  for (const f of fills) {
    const v = f.feats ? pick(f.feats) : null;
    if (v === null || Number.isNaN(v)) {
      noData += 1;
      continue;
    }
    const bkt = buckets.find((b) => v >= b.lo && v < b.hi);
    if (!bkt) continue;
    bkt.n += 1;
    bkt.pnl = Math.round((bkt.pnl + f.pnl) * 100) / 100;
    if (f.pnl > 0) bkt.won += 1;
    else if (f.pnl < 0) bkt.lost += 1;
  }
  return {
    buckets: buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        range: `${b.lo >= 0 ? "+" : ""}${b.lo.toFixed(1)}..${b.hi >= 0 ? "+" : ""}${b.hi.toFixed(1)}`,
        n: b.n,
        wrPct: b.n ? Number(((b.won / b.n) * 100).toFixed(1)) : 0,
        pnl: b.pnl,
        avgPnl: b.n ? Number((b.pnl / b.n).toFixed(3)) : 0,
      })),
    noData,
  };
}

type Feats = {
  imbTop: number | null;
  imb3: number | null;
  crossTop: number | null;
  cross3: number | null;
  crossRel: number | null; // cross3 signed toward the filled token
  // previous tick (persistence)
  imbTopPrev: number | null;
  cross3Prev: number | null;
  crossRelPrev: number | null;
};

function featsAtFill(
  booksByTs: Map<number, TokenBook[]>,
  fillTs: number,
  filledIdx: number,
): Feats | null {
  let tickTs: number | null = null;
  for (const ts of booksByTs.keys()) {
    if (ts <= fillTs && fillTs - ts <= TICK_STALE_MS && (tickTs === null || ts > tickTs)) {
      tickTs = ts;
    }
  }
  if (tickTs === null) return null;
  const books = booksByTs.get(tickTs) ?? [];
  const up = books.find((b) => b.outcomeIndex === 0);
  const down = books.find((b) => b.outcomeIndex === 1);
  if (!up && !down) return null;
  const filled = filledIdx === 0 ? up : down;
  const cross = cross3(up, down);
  const crossT = crossTop(up, down);
  // prev tick (immediately before, any gap; staleness bounded by PREV_GAP_MS)
  const ticks = [...booksByTs.keys()].sort((a, b) => a - b);
  const pos = ticks.indexOf(tickTs);
  let prev: Feats["imbTopPrev"] = null;
  let prevCross: number | null = null;
  let prevCrossRel: number | null = null;
  if (pos > 0 && tickTs - ticks[pos - 1] <= PREV_GAP_MS) {
    const pbooks = booksByTs.get(ticks[pos - 1]) ?? [];
    const pup = pbooks.find((b) => b.outcomeIndex === 0);
    const pdown = pbooks.find((b) => b.outcomeIndex === 1);
    prev = imb1(filledIdx === 0 ? pup : pdown);
    prevCross = cross3(pup, pdown);
    if (prevCross !== null) prevCrossRel = filledIdx === 0 ? prevCross : -prevCross;
  }
  return {
    imbTop: imb1(filled),
    imb3: imb3(filled),
    crossTop: crossT,
    cross3: cross,
    crossRel: cross === null ? null : filledIdx === 0 ? cross : -cross,
    imbTopPrev: prev,
    cross3Prev: prevCross,
    crossRelPrev: prevCrossRel,
  };
}

// ---------- main ----------

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_imb-audit-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);

const allBtc = listBacktestWindows(repos, { prefix: "btc-updown-15m", completeness: criteria });
const selected = allBtc.filter((w) => w.complete);
console.error(JSON.stringify({ completeBtc15Windows: selected.length }));
if (selected.length === 0) {
  console.error("No complete BTC 15m windows — aborting.");
  process.exit(1);
}

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false, simulatedCapital: CAPITAL });
const patch = sanitizePatch({ ...basePreset.settings, strategyId: "fav-band", ...BEST_SIGNAL });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "fav-band";
config.enableExpensiveHedge = false;
config.arbAskLockOnly = false;
const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `imb-audit-${Date.now()}`;
process.stderr.write(`\n=== baseline fav-band sim (${selected.length} windows) ===\n`);
const t0 = Date.now();
const result: BacktestResult = await runBacktest({
  runId,
  config,
  windows: selected,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 200 === 0) process.stderr.write(`\r${cur}/${total}   `);
    },
  },
  skippedIncomplete: 0,
});
process.stderr.write(`\nsim done in ${Date.now() - t0}ms\n`);

const baselinePnl = Math.round(result.pnl * 100) / 100;

// --- collect resolved BUY fills (fav-band cheap legs) ---
const fills = repos
  .backtestPositions.byRun(runId)
  .filter((r: BacktestPositionRow) => r.side === "BUY" && r.status !== "open" && r.kind === "cheap");
const openCount = repos
  .backtestPositions.byRun(runId)
  .filter((r: BacktestPositionRow) => r.status === "open").length;

// --- per-slug tick books, joined to fills ---
const fillsBySlug = new Map<string, BacktestPositionRow[]>();
for (const r of fills) {
  const list = fillsBySlug.get(r.eventSlug) ?? [];
  list.push(r);
  fillsBySlug.set(r.eventSlug, list);
}

type Joined = { row: BacktestPositionRow; feats: Feats | null };
const joined: Joined[] = [];
let staleTicks = 0;
for (const [slug, rows] of fillsBySlug) {
  const meta = selected.find((w) => w.eventSlug === slug);
  const startMs = (meta?.windowStart ?? Math.floor(rows[0].ts / 1000)) * 1000 - 5_000;
  const endMs = (meta?.windowEnd ?? Math.ceil(rows[0].ts / 1000) + 900) * 1000 + 5_000;
  const booksByTs = booksFromRows(repos.bookSnapshots.bySlugAndRange(slug, startMs, endMs));
  for (const r of rows) {
    const f = featsAtFill(booksByTs, r.ts, r.outcomeIndex);
    if (f === null) staleTicks += 1;
    joined.push({ row: r, feats: f });
  }
}

const withFeats = joined.filter((j) => j.feats !== null) as Array<{ row: BacktestPositionRow; feats: Feats }>;
const noSizes = withFeats.filter(
  (j) => j.feats.imbTop === null && j.feats.imb3 === null && j.feats.crossRel === null,
).length;

// --- bucket analysis ---
const sample = withFeats.map((j) => ({ feats: j.feats, pnl: j.row.pnl ?? 0, won: (j.row.pnl ?? 0) > 0 }));
const buckets = {
  imbTop: bucketize(sample, (f) => f.imbTop),
  imb3: bucketize(sample, (f) => f.imb3),
  crossRel: bucketize(sample, (f) => f.crossRel),
  crossRelTop: bucketize(sample, (f) => (f.crossTop === null ? null : f.crossTop)),
};

// --- counterfactual thresholds ---
type CfRow = {
  feature: string;
  threshold: number;
  persist: boolean;
  kept: number;
  keptPnl: number;
  keptWr: number;
  dropped: number;
  droppedPnl: number;
  droppedWr: number;
};

function counterfactual(
  label: string,
  pick: (f: Feats) => number | null,
  pickPrev: (f: Feats) => number | null,
  thresholds: number[],
  persist: boolean,
): CfRow[] {
  const out: CfRow[] = [];
  for (const th of thresholds) {
    let kept = 0, keptPnl = 0, keptWon = 0, dropped = 0, droppedPnl = 0, droppedWon = 0;
    for (const j of withFeats) {
      const v = pick(j.feats);
      const vPrev = pickPrev(j.feats);
      const pass = v !== null && v >= th && (!persist || (vPrev !== null && vPrev >= th));
      const pnl = j.row.pnl ?? 0;
      if (pass) {
        kept += 1;
        keptPnl += pnl;
        if (pnl > 0) keptWon += 1;
      } else {
        dropped += 1;
        droppedPnl += pnl;
        if (pnl > 0) droppedWon += 1;
      }
    }
    out.push({
      feature: label + (persist ? ":persist2" : ""),
      threshold: th,
      persist,
      kept,
      keptPnl: Math.round(keptPnl * 100) / 100,
      keptWr: kept ? Number(((keptWon / kept) * 100).toFixed(1)) : 0,
      dropped,
      droppedPnl: Math.round(droppedPnl * 100) / 100,
      droppedWr: dropped ? Number(((droppedWon / dropped) * 100).toFixed(1)) : 0,
    });
  }
  return out;
}

const TH = [-0.3, -0.2, -0.1, 0, 0.1, 0.2];
const counterfactuals = [
  ...counterfactual("imbTop", (f) => f.imbTop, (f) => f.imbTopPrev, TH, false),
  ...counterfactual("imbTop", (f) => f.imbTop, (f) => f.imbTopPrev, TH, true),
  ...counterfactual("crossRel", (f) => f.crossRel, (f) => f.crossRelPrev, TH, false),
  ...counterfactual("crossRel", (f) => f.crossRel, (f) => f.crossRelPrev, TH, true),
  ...counterfactual("imb3", (f) => f.imb3, () => null, TH, false),
];

// --- flip lead analysis (does cross3 flip before the favorite price-flip?) ---
let flips = 0;
let withSignal = 0;
const leads: number[] = [];
for (const meta of selected) {
  const startMs = meta.windowStart * 1000 - 5_000;
  const endMs = meta.windowEnd * 1000 + 5_000;
  const booksByTs = booksFromRows(repos.bookSnapshots.bySlugAndRange(meta.eventSlug, startMs, endMs));
  const ticks = [...booksByTs.keys()].sort((a, b) => a - b);
  if (ticks.length < 10) continue;
  let curFav: number | null = null;
  for (let i = 0; i < ticks.length; i++) {
    const books = booksByTs.get(ticks[i]) ?? [];
    const idx = books.find((b) => b.bestAsk !== null);
    if (!idx) continue;
    const fav = idx.outcomeIndex;
    if (curFav !== null && fav !== curFav) {
      flips += 1;
      // scan back for the latest cross3 on the NEW fav's side before this tick
      const want = fav === 0 ? 1 : -1;
      let foundTs: number | null = null;
      for (let k = i - 1; k >= 0; k--) {
        if (ticks[i] - ticks[k] > FLIP_LOOKBACK_MS) break;
        const pb = booksByTs.get(ticks[k]) ?? [];
        const c = cross3(
          pb.find((b) => b.outcomeIndex === 0),
          pb.find((b) => b.outcomeIndex === 1),
        );
        if (c !== null && Math.abs(c) >= CROSS_SIGNAL && Math.sign(c) === want) {
          foundTs = ticks[k];
          break;
        }
      }
      if (foundTs !== null) {
        withSignal += 1;
        leads.push(ticks[i] - foundTs);
      }
    }
    curFav = fav;
  }
}
leads.sort((a, b) => a - b);
const q = (p: number) => (leads.length ? Math.round(leads[Math.min(leads.length - 1, Math.floor(p * leads.length))]) : null);

// --- report ---
const report = {
  note: "Phase 1 imbalance calibration — one deterministic baseline fav-band sim (BEST band 0.68-0.82, min200, pause 3x8, inverse/exit off, S1 sizing cap20) over complete BTC 15m windows; fills joined post-hoc with book snapshots at fill time. Positive imbTop/crossRel = pressure agrees with the bought favorite.",
  criteria,
  windows: selected.length,
  baseline: { pnl: baselinePnl, fills: result.fillCount, rejects: result.rejectCount, openPositions: openCount },
  dataCoverage: {
    resolvedFills: fills.length,
    withBooks: withFeats.length,
    staleNoTick: staleTicks,
    noSizes: noSizes,
    note: "stale = no tick within 20s before fill; noSizes = book rows lack size columns (legacy rows)",
  },
  buckets,
  counterfactuals,
  flipLead: {
    flips,
    withSignal,
    pctWithSignal: flips ? Number(((withSignal / flips) * 100).toFixed(1)) : 0,
    leadMs: { p25: q(0.25), p50: q(0.5), p75: q(0.75) },
    crossSignalAbs: CROSS_SIGNAL,
    lookbackMs: FLIP_LOOKBACK_MS,
  },
};

mkdirSync(join("audits", "backtest", "imbalance"), { recursive: true });
const outPath = join("audits", "backtest", "imbalance", `imbalance-audit-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  outPath,
  windows: selected.length,
  baselinePnl,
  resolvedFills: fills.length,
  withBooks: withFeats.length,
  crossRelBuckets: buckets.crossRel.buckets,
  bestCf: counterfactuals
    .slice()
    .sort((a, b) => b.keptPnl - a.keptPnl)
    .slice(0, 5),
  flipLead: report.flipLead,
}, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}