/**
 * Discovery sim round 6 — 3ᵉ candidat : FLIPCONFIRM fenêtré + split-half.
 * READ-ONLY. Univers complet+résolu, UN entry/fenêtre, FOK ask brut +
 * depth guard, hold-to-resolution, $15, maxShares 30.
 *
 * Inférence du round 3 : FLIPCONFIRM m120 (toutes entrées >=120s) = +$327,
 * mais m180+ = -$227 -> le signal vit dans les flips survenant en
 * elapsed [120,180]. Restreindre à maxElapsed 180.
 *
 * Round 6 :
 *   1. FLIPCONFIRM fenêtré [120,180] + split-half
 *   2. WINSTREAK n3 split-half
 *   3. ANTIFLIP / FIRSTFAV : polish final (maxElapsed, sizing)
 *
 * npx tsx scripts/research/research-new-strats/discovery-sim6.mts
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB = "data/bot-live.db";
const OUT_DIR = join("audits", "backtest", "research-new-strats");

interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
}
interface Tick {
  ts: number;
  up: SideBook;
  down: SideBook;
}
interface Universe {
  slugs: Map<string, Tick[]>;
  resMap: Map<string, number>;
  wsMap: Map<string, number>;
}

function loadUniverse(dbPath = DB): Universe {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const windows = db
    .prepare(
      `SELECT eventSlug AS slug, MAX(windowStart) AS ws, COUNT(DISTINCT ts) AS ticks
       FROM market_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'
       GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= 801`,
    )
    .all() as Array<{ slug: string; ws: number; ticks: number }>;
  const gapStmt = db.prepare(
    `WITH t AS (SELECT DISTINCT ts FROM market_snapshots WHERE eventSlug = ?)
     SELECT MAX(d) AS g FROM
       (SELECT ts - LAG(ts) OVER (ORDER BY ts) AS d FROM t)`,
  );
  const complete = windows
    .filter((w) => {
      const g = gapStmt.get(w.slug) as { g: number | null };
      return (g.g ?? 0) <= 60_000;
    })
    .map((w) => ({ slug: w.slug, ws: w.ws }));

  const resRows = db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));

  const slugs = new Map<string, Tick[]>();
  const wsMap = new Map<string, number>();
  for (const { slug, ws } of complete) {
    if (resMap.get(slug) === undefined) continue;
    const rows = db
      .prepare(
        `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize
         FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
      )
      .all(slug) as Array<{
      ts: number;
      outcomeIndex: number;
      bestAsk: number | null;
      bestBid: number | null;
      bestAskSize: number | null;
    }>;
    const byTs = new Map<number, { up: SideBook; down: SideBook }>();
    const blank = (): SideBook => ({ ask: null, bid: null, askSize: null });
    for (const r of rows) {
      let e = byTs.get(r.ts);
      if (!e) {
        e = { up: blank(), down: blank() };
        byTs.set(r.ts, e);
      }
      const side = r.outcomeIndex === 0 ? e.up : e.down;
      side.ask = r.bestAsk;
      side.bid = r.bestBid;
      side.askSize = r.bestAskSize;
    }
    const ticks: Tick[] = [];
    for (const [ts, b] of byTs) {
      if (b.up.ask == null && b.down.ask == null) continue;
      ticks.push({ ts, up: b.up, down: b.down });
    }
    slugs.set(slug, ticks);
    wsMap.set(slug, ws);
  }
  db.close();
  return { slugs, resMap, wsMap };
}

interface EntryParams {
  minElapsedSec: number;
  maxElapsedSec: number | null;
  bandMin: number;
  bandMax: number;
  maxSpread: number;
  orderUsdc: number;
  maxShares: number;
}

interface Variant {
  label: string;
  family: "antiflip" | "firstfav" | "winstreak" | "flipconfirm";
  entry: EntryParams;
  flipLookbackMs?: number;
  deposedAskMin?: number;
  streakN?: number;
}

interface SimResult {
  label: string;
  family: string;
  fills: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  maxDrawdown: number;
  evPerShare: number | null;
  avgEntryPrice: number | null;
  byDay: Record<string, number>;
}

function runSim(
  universe: Universe,
  P: Variant,
  opts?: { streakCtx?: Map<string, number>; slugFilter?: (slug: string) => boolean },
): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;
  const byDay: Record<string, number> = {};

  for (const [slug, ticks] of universe.slugs) {
    if (opts?.slugFilter && !opts.slugFilter(slug)) continue;
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    let streakSide: 0 | 1 | null = null;
    if (P.family === "winstreak") {
      const v = opts?.streakCtx?.get(slug);
      if (v === undefined) continue;
      const n = Math.floor(v / 10);
      if (n < (P.streakN ?? 3)) continue;
      streakSide = (v % 10) as 0 | 1;
    }

    let entry: { price: number; size: number; outcomeIdx: 0 | 1 } | null = null;
    let prevFavIdx: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;

    for (const t of ticks) {
      const elapsedSec = (t.ts - wsMs) / 1000;
      if (elapsedSec < 0 || elapsedSec >= 900) continue;

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
      const favAsk = favIdx === 0 ? t.up.ask : t.down.ask;
      if (favAsk == null) continue;

      if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipTs = t.ts;
      prevFavIdx = favIdx;

      if (entry) continue;
      const E = P.entry;
      if (elapsedSec < E.minElapsedSec) continue;
      if (E.maxElapsedSec != null && elapsedSec > E.maxElapsedSec) continue;

      let targetIdx: 0 | 1;
      let targetBook: SideBook;
      let targetAsk: number | null;

      if (P.family === "antiflip") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 90_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
        if (targetAsk == null) continue;
        if (P.deposedAskMin != null && targetAsk < P.deposedAskMin) continue;
      } else if (P.family === "firstfav") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      } else if (P.family === "flipconfirm") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 60_000)) continue;
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      } else {
        targetIdx = streakSide as 0 | 1;
        targetBook = targetIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      }

      if (targetAsk == null) continue;
      if (targetAsk < E.bandMin || targetAsk > E.bandMax) continue;
      const targetBid = targetBook.bid;
      if (targetBid != null && targetAsk - targetBid > E.maxSpread) continue;
      const size = Math.min(E.orderUsdc / targetAsk, E.maxShares);
      if (size < 5) continue;
      if (targetBook.askSize != null && targetBook.askSize < size) continue;

      entry = { price: targetAsk, size, outcomeIdx: targetIdx };
      fills++;
    }

    if (!entry) continue;
    notional += entry.price * entry.size;
    shares += entry.size;
    const win = res === entry.outcomeIdx;
    const p = win ? (1 - entry.price) * entry.size : -entry.price * entry.size;
    pnl += p;
    if (p > 0) wins++;
    else losses++;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    const day = new Date(wsMs).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + p;
  }

  pnl = Math.round(pnl * 100) / 100;
  return {
    label: P.label,
    family: P.family,
    fills,
    wins,
    losses,
    pnl,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    evPerShare: fills && shares ? Math.round((pnl / shares) * 100) / 100 : null,
    avgEntryPrice: fills && shares ? Math.round((notional / shares) * 1000) / 1000 : null,
    byDay: Object.fromEntries(
      Object.entries(byDay).map(([d, v]) => [d, Math.round(v * 100) / 100]),
    ),
  };
}

function buildStreakCtx(universe: Universe): Map<string, number> {
  const ordered = [...universe.slugs.keys()]
    .map((s) => ({ slug: s, ws: universe.wsMap.get(s) ?? 0, res: universe.resMap.get(s) }))
    .filter((x) => x.res !== undefined)
    .sort((a, b) => a.ws - b.ws);
  const ctx = new Map<string, number>();
  let runSide: number | null = null;
  let runN = 0;
  for (const { slug, res } of ordered) {
    if (runSide === null) ctx.set(slug, 0);
    else ctx.set(slug, runN * 10 + runSide);
    if (runSide === res) runN++;
    else {
      runSide = res!;
      runN = 1;
    }
  }
  return ctx;
}

const BASE_E = (o: Partial<EntryParams> = {}): EntryParams => ({
  minElapsedSec: 0,
  maxElapsedSec: null,
  bandMin: 0.5,
  bandMax: 0.95,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
  ...o,
});

const variants: Variant[] = [
  // 1. FLIPCONFIRM fenêtré [120,180]
  { label: "FLIPCONFIRM_120-180_l60_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 60_000 },
  { label: "FLIPCONFIRM_120-180_l45_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 45_000 },
  { label: "FLIPCONFIRM_120-180_l90_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 90_000 },
  { label: "FLIPCONFIRM_100-200_l60_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 100, maxElapsedSec: 200, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 60_000 },
  { label: "FLIPCONFIRM_120-180_l60_50-60", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.50, bandMax: 0.60 }), flipLookbackMs: 60_000 },
  { label: "FLIPCONFIRM_120-180_l60_55-70", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.55, bandMax: 0.70 }), flipLookbackMs: 60_000 },

  // 2. WINSTREAK n3 (pour split-half)
  { label: "WINSTREAK_n3_0-120_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 120, bandMin: 0.50, bandMax: 0.70 }), streakN: 3 },

  // 3. Polish final des 2 leaders
  { label: "ANTIFLIP_m240_l90_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 90_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l90_dep40_max600", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, maxElapsedSec: 600, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 90_000, deposedAskMin: 0.40 },
  { label: "FIRSTFAV_a60_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 45 }) },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows`);

  const allWs = [...universe.wsMap.values()].sort((a, b) => a - b);
  const medianWs = allWs[Math.floor(allWs.length / 2)];
  const older = (slug: string) => (universe.wsMap.get(slug) ?? 0) < medianWs;
  const newer = (slug: string) => (universe.wsMap.get(slug) ?? 0) >= medianWs;

  const streakCtx = buildStreakCtx(universe);
  const rows: SimResult[] = [];

  for (const P of variants) {
    const r = runSim(universe, P, P.family === "winstreak" ? { streakCtx } : undefined);
    rows.push(r);
    const days = Object.entries(r.byDay);
    const nPos = days.filter(([, v]) => v > 0).length;
    const nNeg = days.filter(([, v]) => v < 0).length;
    console.log(
      `${r.label.padEnd(36)} fills=${String(r.fills).padStart(3)} WR=${String(r.winRate).padStart(5)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} EV/sh=${String(r.evPerShare).padStart(6)}c px=${r.avgEntryPrice} d+/-:${nPos}/${nNeg}`,
    );
  }

  console.log("\n--- SPLIT-HALF 3ᵉ candidat ---");
  for (const label of ["FLIPCONFIRM_120-180_l60_55-65", "WINSTREAK_n3_0-120_50-70", "FLIPCONFIRM_100-200_l60_55-65"]) {
    const P = variants.find((v) => v.label === label)!;
    const old = runSim(universe, P, {
      ...(P.family === "winstreak" ? { streakCtx } : {}),
      slugFilter: older,
    });
    const newR = runSim(universe, P, {
      ...(P.family === "winstreak" ? { streakCtx } : {}),
      slugFilter: newer,
    });
    console.log(
      `${label}: OLD fills=${old.fills} PnL=${old.pnl} WR=${old.winRate}% | NEW fills=${newR.fills} PnL=${newR.pnl} WR=${newR.winRate}%`,
    );
    rows.push({ ...old, label: `${label} [OLD-half]` }, { ...newR, label: `${label} [NEW-half]` });
  }

  writeFileSync(
    join(OUT_DIR, `discovery-sim6-${Date.now()}.json`),
    JSON.stringify(
      {
        phase: "discovery-sim6",
        generatedAt: new Date().toISOString(),
        sourceDb: DB,
        universeSize: universe.slugs.size,
        splitHalfBoundary: new Date(medianWs * 1000).toISOString(),
        variants: rows,
      },
      null,
      2,
    ),
  );
  console.log("written:", join(OUT_DIR, `discovery-sim6-${Date.now()}.json`));
}

main();