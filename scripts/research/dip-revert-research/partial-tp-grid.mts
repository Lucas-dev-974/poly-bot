/**
 * Dip-revert 15m - hold vs partial take-profit grid.
 *
 * Fork of scripts/research/antiflip-revert/partial-tp-grid.mts exit/metrics
 * pattern; entry logic from config/presets/dip-revert.json +
 * src/strategy/dip-revert-strategy.ts (official dip-revert preset).
 *
 * Entry (preset): band ask [0.55, 0.65], minDrop 0.03 over lookback 60s,
 * rebound (ask > window low by >=0.001), minElapsed 180s, maxElapsed 420s,
 * spread<=0.04, $15/order max 30 shares, depth guard, one entry/window.
 * Universe: official-aligned BTC 15m (book_snapshots, >=801 ticks, maxGap<=60s).
 *
 * Exit variants:
 *   - hold          : hold to resolution (baseline)
 *   - partial+0.08  : sell 50% when bid >= avgEntry + 0.08, residual hold
 *   - partial×1.20  : sell 50% when bid >= avgEntry * 1.20, residual hold
 *   - full+0.08     : sell 100% at bid >= avgEntry + 0.08 (else hold)
 *   - full×1.20     : sell 100% at bid >= avgEntry * 1.20 (else hold)
 *
 * Metrics per variant: n, sold WR, residual WR, blended WR, total PnL,
 * EV/trade, vs hold. Split-half IS/OOS chrono on window start.
 *
 * Usage (repo root):
 *   npx tsx scripts/research/dip-revert-research/partial-tp-grid.mts
 *
 * READ-ONLY on data/bot-live.db. Writes only under audits/backtest/dip-revert/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type Tick, type Universe } from "../antiflip-revert/universe.mts";

const OUT_DIR = join("audits", "backtest", "dip-revert");
const ORDER_USDC = 15;
const MAX_SHARES = 30;
const MIN_CLOB = 5;
const BAND_MIN = 0.55;
const BAND_MAX = 0.65;
const MIN_DROP = 0.03;
const LOOKBACK_MS = 60_000;
const MIN_ELAPSED = 180;
const MAX_ELAPSED = 420;
const MAX_SPREAD = 0.04;
const PARTIAL_FRAC = 0.5;

type ExitMode =
  | { kind: "hold"; label: string }
  | { kind: "partial"; label: string; tpAbs?: number; tpMult?: number; frac: number }
  | { kind: "full"; label: string; tpAbs?: number; tpMult?: number };

const VARIANTS: ExitMode[] = [
  { kind: "hold", label: "hold (baseline)" },
  { kind: "partial", label: "partial50 +0.08", tpAbs: 0.08, frac: PARTIAL_FRAC },
  { kind: "partial", label: "partial50 x1.20", tpMult: 1.2, frac: PARTIAL_FRAC },
  { kind: "full", label: "fullTP +0.08", tpAbs: 0.08 },
  { kind: "full", label: "fullTP x1.20", tpMult: 1.2 },
];

interface Entry {
  slug: string;
  wsSec: number;
  entryTs: number;
  price: number;
  size: number;
  outcomeIdx: 0 | 1;
  winnerIdx: number;
  postTicks: Tick[];
}

function tpTarget(entryPrice: number, mode: ExitMode): number | null {
  if (mode.kind === "hold") return null;
  if (mode.tpAbs != null) return entryPrice + mode.tpAbs;
  if (mode.tpMult != null) return entryPrice * mode.tpMult;
  return null;
}

/** Collect dip-revert entries (one per window), with post-entry tick stream for exit sim. */
function collectEntries(universe: Universe, slugFilter?: (slug: string) => boolean): Entry[] {
  const out: Entry[] = [];
  for (const [slug, ticks] of universe.slugs) {
    if (slugFilter && !slugFilter(slug)) continue;
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    const samples: Array<{ ts: number; ask: number }> = [];
    let entryIdx = -1;
    let entry: Omit<Entry, "postTicks" | "slug" | "wsSec" | "winnerIdx"> | null = null;

    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i];
      const elapsedSec = (t.ts - wsMs) / 1000;
      if (elapsedSec < 0 || elapsedSec >= 900) continue;

      // Favorite = higher ask (same as pickEdgeToken / dip-sim)
      const favIdx: 0 | 1 | null =
        t.up.ask != null && t.down.ask == null
          ? 0
          : t.down.ask != null && t.up.ask == null
            ? 1
            : t.up.ask != null && t.down.ask != null
              ? t.up.ask >= t.down.ask
                ? 0
                : 1
              : null;
      if (favIdx == null) continue;
      const favBook = favIdx === 0 ? t.up : t.down;
      const favAsk = favBook.ask;
      if (favAsk == null) continue;

      // Push sample BEFORE entry guards (live strategy samples from window start)
      const cutoff = Math.max(t.ts - LOOKBACK_MS, wsMs);
      while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
      samples.push({ ts: t.ts, ask: favAsk });

      if (entry) continue;
      if (elapsedSec < MIN_ELAPSED) continue;
      if (elapsedSec > MAX_ELAPSED) continue;
      if (favAsk < BAND_MIN || favAsk > BAND_MAX) continue;
      const favBid = favBook.bid;
      if (favBid != null && favAsk - favBid > MAX_SPREAD) continue;
      const size = Math.min(ORDER_USDC / favAsk, MAX_SHARES);
      if (size < MIN_CLOB) continue;
      if (favBook.askSize != null && favBook.askSize < size) continue;
      if (samples.length < 2) continue;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.ts - first.ts < LOOKBACK_MS * 0.7) continue;
      const low = Math.min(...samples.map((s) => s.ask));
      if (first.ask - favAsk < MIN_DROP) continue;
      if (!(favAsk > low)) continue;
      if (!(favAsk - low >= 0.001)) continue;

      entry = {
        entryTs: t.ts,
        price: favAsk,
        size,
        outcomeIdx: favIdx,
      };
      entryIdx = i;
    }

    if (!entry || entryIdx < 0) continue;
    out.push({
      slug,
      wsSec: wsMs / 1000,
      winnerIdx: res,
      ...entry,
      postTicks: ticks.slice(entryIdx + 1),
    });
  }
  return out;
}

interface TradeDetail {
  slug: string;
  entryPrice: number;
  size: number;
  tpHit: boolean;
  soldSize: number;
  soldPrice: number | null;
  soldPnl: number;
  residualSize: number;
  residualWon: boolean;
  residualPnl: number;
  totalPnl: number;
  blendedWin: boolean;
}

function simulate(entries: Entry[], mode: ExitMode): {
  trades: TradeDetail[];
  n: number;
  tpHits: number;
  soldWr: number | null;
  residualWr: number | null;
  residualN: number;
  blendedWr: number;
  totalPnl: number;
  evPerTrade: number;
  soldPnlSum: number;
  residualPnlSum: number;
} {
  const trades: TradeDetail[] = [];
  for (const e of entries) {
    const target = tpTarget(e.price, mode);
    let tpHit = false;
    let soldSize = 0;
    let soldPrice: number | null = null;
    let soldPnl = 0;
    let residualSize = e.size;

    if (mode.kind !== "hold" && target != null) {
      for (const t of e.postTicks) {
        // Held-token bid only (never current favorite after identity flip)
        const book = e.outcomeIdx === 0 ? t.up : t.down;
        const bid = book.bid;
        if (bid == null) continue;
        if (bid >= target) {
          tpHit = true;
          const frac = mode.kind === "partial" ? mode.frac : 1;
          soldSize = e.size * frac;
          soldPrice = bid;
          soldPnl = (bid - e.price) * soldSize;
          residualSize = e.size - soldSize;
          break;
        }
      }
    }

    const residualWon = residualSize > 0 && e.outcomeIdx === e.winnerIdx;
    const residualPnl =
      residualSize <= 0
        ? 0
        : residualWon
          ? (1 - e.price) * residualSize
          : -e.price * residualSize;
    const totalPnl = soldPnl + residualPnl;
    trades.push({
      slug: e.slug,
      entryPrice: e.price,
      size: e.size,
      tpHit,
      soldSize,
      soldPrice,
      soldPnl,
      residualSize,
      residualWon,
      residualPnl,
      totalPnl,
      blendedWin: totalPnl > 0,
    });
  }

  const n = trades.length;
  const tpHits = trades.filter((t) => t.tpHit).length;
  const soldLegs = trades.filter((t) => t.tpHit && t.soldSize > 0);
  const soldWins = soldLegs.filter((t) => t.soldPnl > 0).length;
  const residualLegs = trades.filter((t) => t.residualSize > 0);
  const residualWins = residualLegs.filter((t) => t.residualWon).length;
  const blendedWins = trades.filter((t) => t.blendedWin).length;
  const totalPnl = Math.round(trades.reduce((s, t) => s + t.totalPnl, 0) * 100) / 100;
  const soldPnlSum = Math.round(trades.reduce((s, t) => s + t.soldPnl, 0) * 100) / 100;
  const residualPnlSum = Math.round(trades.reduce((s, t) => s + t.residualPnl, 0) * 100) / 100;

  return {
    trades,
    n,
    tpHits,
    soldWr: soldLegs.length ? Math.round((soldWins / soldLegs.length) * 1000) / 10 : null,
    residualWr: residualLegs.length
      ? Math.round((residualWins / residualLegs.length) * 1000) / 10
      : null,
    residualN: residualLegs.length,
    blendedWr: n ? Math.round((blendedWins / n) * 1000) / 10 : 0,
    totalPnl,
    evPerTrade: n ? Math.round((totalPnl / n) * 1000) / 1000 : 0,
    soldPnlSum,
    residualPnlSum,
  };
}

function summarize(label: string, sim: ReturnType<typeof simulate>, holdEv: number | null) {
  const vsHold =
    holdEv != null && holdEv !== 0
      ? Math.round((sim.evPerTrade / holdEv) * 1000) / 1000
      : null;
  return {
    label,
    n: sim.n,
    tpHits: sim.tpHits,
    tpHitRate: sim.n ? Math.round((sim.tpHits / sim.n) * 1000) / 10 : 0,
    soldWr: sim.soldWr,
    residualWr: sim.residualWr,
    residualN: sim.residualN,
    blendedWr: sim.blendedWr,
    totalPnl: sim.totalPnl,
    evPerTrade: sim.evPerTrade,
    soldPnlSum: sim.soldPnlSum,
    residualPnlSum: sim.residualPnlSum,
    vsHoldRatio: vsHold,
  };
}

// ---------- CLI ----------
const universe = loadUniverse();
console.log(`universe: ${universe.slugs.size} windows (official-aligned BTC 15m)`);

const allEntries = collectEntries(universe);
console.log(`dip-revert entries (full sample): ${allEntries.length}`);

const allWs = [...new Set(allEntries.map((e) => e.wsSec))].sort((a, b) => a - b);
const medianWs = allWs[Math.floor(allWs.length / 2)] ?? 0;
const isEntries = allEntries.filter((e) => e.wsSec < medianWs);
const oosEntries = allEntries.filter((e) => e.wsSec >= medianWs);
console.log(
  `split-half boundary: ${new Date(medianWs * 1000).toISOString()} | IS=${isEntries.length} OOS=${oosEntries.length}`,
);

mkdirSync(OUT_DIR, { recursive: true });

type Row = ReturnType<typeof summarize>;
const fullRows: Row[] = [];
const isRows: Row[] = [];
const oosRows: Row[] = [];

let holdEvFull: number | null = null;
let holdEvIs: number | null = null;
let holdEvOos: number | null = null;

for (const mode of VARIANTS) {
  const full = simulate(allEntries, mode);
  if (mode.kind === "hold") holdEvFull = full.evPerTrade;
  fullRows.push(summarize(mode.label, full, holdEvFull));

  const is = simulate(isEntries, mode);
  if (mode.kind === "hold") holdEvIs = is.evPerTrade;
  isRows.push(summarize(mode.label, is, holdEvIs));

  const oos = simulate(oosEntries, mode);
  if (mode.kind === "hold") holdEvOos = oos.evPerTrade;
  oosRows.push(summarize(mode.label, oos, holdEvOos));
}

const pct = (x: number | null) => (x == null ? "n/a" : `${x.toFixed(1)}%`);
const money = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const ratio = (x: number | null) => (x == null ? "n/a" : `${x.toFixed(3)}x`);

function table(rows: Row[]): string {
  const header =
    "| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |";
  const sep = "|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    (r) =>
      `| ${r.label} | ${r.n} | ${r.tpHits} (${r.tpHitRate}%) | ${pct(r.soldWr)} | ${pct(r.residualWr)} | ${pct(r.blendedWr)} | ${money(r.totalPnl)} | ${money(r.evPerTrade)} | ${ratio(r.vsHoldRatio)} |`,
  );
  return [header, sep, ...body].join("\n");
}

const hold = fullRows.find((r) => r.label.startsWith("hold"))!;
const partials = fullRows.filter((r) => r.label.startsWith("partial"));
const bestPartial = [...partials].sort((a, b) => b.evPerTrade - a.evPerTrade)[0];

const passWr = bestPartial && bestPartial.blendedWr >= 50;
const passEv =
  bestPartial &&
  hold.evPerTrade !== 0 &&
  bestPartial.evPerTrade >= 0.7 * hold.evPerTrade;

let recommendation: string;
if (!bestPartial || hold.n < 20) {
  recommendation = "inconclusive - sample too small or no partial variants";
} else if (bestPartial.evPerTrade > hold.evPerTrade && passWr) {
  recommendation = `ship partial - best is "${bestPartial.label}" (EV ${money(bestPartial.evPerTrade)} > hold ${money(hold.evPerTrade)}, blended WR ${pct(bestPartial.blendedWr)})`;
} else if (passWr && passEv) {
  recommendation = `hold preferred but partial OK - "${bestPartial.label}" meets WR>=50% and EV>=0.7x hold (${ratio(bestPartial.vsHoldRatio)}), but does not beat hold EV`;
} else if (hold.evPerTrade >= bestPartial.evPerTrade) {
  recommendation = `hold only - hold EV ${money(hold.evPerTrade)} >= best partial ${money(bestPartial.evPerTrade)} (${bestPartial.label}); criteria WR>=50%=${passWr}, EV>=0.7x hold=${passEv}`;
} else {
  recommendation = `inconclusive - mixed signals (best partial EV better but WR/ratio gates: WR>=50%=${passWr}, EV>=0.7x=${passEv})`;
}

const generatedAt = new Date().toISOString();
const ts = Date.now();

const md = `# Dip-revert 15m - partial TP vs hold

Generated: ${generatedAt} (box/local)
Universe: ${universe.slugs.size} complete BTC 15m windows (book_snapshots, >=801 ticks, maxGap<=60s, resolved).
Entries: dip-revert preset - band ask [${BAND_MIN}, ${BAND_MAX}], minDrop ${MIN_DROP} lookback ${LOOKBACK_MS / 1000}s, rebound (ask>low>=0.001), minElapsed ${MIN_ELAPSED}s, maxElapsed ${MAX_ELAPSED}s, spread<=${MAX_SPREAD}, $${ORDER_USDC}/order max ${MAX_SHARES} shares, depth guard.
Fills: ${allEntries.length} (IS ${isEntries.length} / OOS ${oosEntries.length}). Split-half boundary: ${new Date(medianWs * 1000).toISOString()}.

## Full sample

${table(fullRows)}

## IS (older half)

${table(isRows)}

## OOS (newer half)

${table(oosRows)}

## Gates (success criteria)

- Blended WR >= 50% on best partial: **${passWr ? "YES" : "NO"}** (best partial blended WR = ${bestPartial ? pct(bestPartial.blendedWr) : "n/a"})
- EV >= ~0.7x hold: **${passEv ? "YES" : "NO"}** (best partial vs hold = ${bestPartial ? ratio(bestPartial.vsHoldRatio) : "n/a"})

## Recommendation

**${recommendation}**

## Notes

- Sold WR = fraction of TP-hit legs with sold PnL > 0 (should be ~100% when TP is above entry and fill at bid >= target).
- Residual WR = win rate of residual size held to resolution (among trades with residual > 0).
- Blended WR = fraction of trades with total PnL > 0 (sold leg + residual).
- Full TP variants are EV contrast only (not the shipping question).
- TP exit priced on HELD token bid only (never current favorite after identity flip).
- No live settings changed; DB opened read-only; no push/remote.
`;

const jsonPath = join(OUT_DIR, `partial-tp-grid-${ts}.json`);
const mdPath = join(OUT_DIR, `partial-tp-grid-${ts}.md`);
const latestMd = join(OUT_DIR, "partial-tp-grid-latest.md");
const latestJson = join(OUT_DIR, "partial-tp-grid-latest.json");

const payload = {
  phase: "dip-revert-15m-partial-tp-grid",
  generatedAt,
  entryPreset: {
    bandMin: BAND_MIN,
    bandMax: BAND_MAX,
    minDrop: MIN_DROP,
    lookbackMs: LOOKBACK_MS,
    minElapsedSec: MIN_ELAPSED,
    maxElapsedSec: MAX_ELAPSED,
    maxSpread: MAX_SPREAD,
    orderUsdc: ORDER_USDC,
    maxShares: MAX_SHARES,
    depthGuard: true,
    source: "config/presets/dip-revert.json",
  },
  universeSize: universe.slugs.size,
  nEntries: allEntries.length,
  splitHalfBoundary: new Date(medianWs * 1000).toISOString(),
  nIs: isEntries.length,
  nOos: oosEntries.length,
  full: fullRows,
  is: isRows,
  oos: oosRows,
  gates: { blendedWrGe50: !!passWr, evGe07xHold: !!passEv },
  recommendation,
};

writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
writeFileSync(mdPath, md);
writeFileSync(latestJson, JSON.stringify(payload, null, 2));
writeFileSync(latestMd, md);

console.log("\n" + table(fullRows));
console.log("\nRecommendation:", recommendation);
console.log("written:", mdPath);
console.log("written:", jsonPath);
console.log("latest:", latestMd);
