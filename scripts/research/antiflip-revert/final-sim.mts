/**
 * Final sim — les 3 stratégies retenues sur l'univers OFFICIEL-aligned
 * (book_snapshots ticks, fenêtre inclusive, 801+/60s, résolution connue).
 *
 * Stratégies retenues après discovery rounds 1-6 :
 *   1. ANTIFLIP  (anti-flip-revert) : minElapsed 240s, flip <= 90s,
 *      nouveau favori 0.45-0.65, déchu 0.35-0.45 + floor 0.40
 *   2. FIRSTFAV  (early-conviction) : favori >= 0.60 dans les 45 premières s
 *   3. FLIPCONFIRM (flip-confirm)   : flip en elapsed [120,180], nouveau
 *      favori acheté <= 90s après le flip, bande 0.55-0.65
 *
 * Chaque stratégie : UN entry/fenêtre, FOK ask brut + depth guard,
 * hold-to-resolution, $15/order, maxShares 30, MIN_CLOB_SHARES 5.
 * Sortie : PnL, WR (fenêtres tradées), DD, EV/share, byDay, split-half.
 *
 * npx tsx scripts/research/research-new-strats/final-sim.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type Tick, type Universe } from "./universe.mts";

const OUT_DIR = join("audits", "backtest", "research-new-strats");

export interface StratConfig {
  label: string;
  family: "antiflip" | "firstfav" | "flipconfirm";
  minElapsedSec: number;
  maxElapsedSec: number | null;
  bandMin: number;
  bandMax: number;
  maxSpread: number;
  orderUsdc: number;
  maxShares: number;
  flipLookbackMs?: number;
  deposedAskMin?: number;
}

export const ANTIFLIP: StratConfig = {
  label: "antiflip-revert",
  family: "antiflip",
  minElapsedSec: 240,
  maxElapsedSec: null,
  bandMin: 0.35,
  bandMax: 0.45,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
  flipLookbackMs: 90_000,
  deposedAskMin: 0.40,
};

export const FIRSTFAV: StratConfig = {
  label: "early-conviction",
  family: "firstfav",
  minElapsedSec: 0,
  maxElapsedSec: 45,
  bandMin: 0.60,
  bandMax: 0.80,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
};

export const FLIPCONFIRM: StratConfig = {
  label: "flip-confirm",
  family: "flipconfirm",
  minElapsedSec: 120,
  maxElapsedSec: 180,
  bandMin: 0.55,
  bandMax: 0.65,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
  flipLookbackMs: 90_000,
};

export interface SimResult {
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
  avgWin: number | null;
  avgLoss: number | null;
  shares: number;
  notionalUsdc: number;
  byDay: Record<string, number>;
}

export function runStratSim(
  universe: Universe,
  P: StratConfig,
  opts?: { slugFilter?: (slug: string) => boolean },
): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;
  const winPnls: number[] = [];
  const lossPnls: number[] = [];
  const byDay: Record<string, number> = {};

  for (const [slug, ticks] of universe.slugs) {
    if (opts?.slugFilter && !opts.slugFilter(slug)) continue;
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

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
      if (elapsedSec < P.minElapsedSec) continue;
      if (P.maxElapsedSec != null && elapsedSec > P.maxElapsedSec) continue;

      let targetIdx: 0 | 1;
      let targetBook: { ask: number | null; bid: number | null; askSize: number | null };

      if (P.family === "antiflip") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 90_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        const dAsk = targetBook.ask;
        if (dAsk == null) continue;
        if (P.deposedAskMin != null && dAsk < P.deposedAskMin) continue;
      } else if (P.family === "firstfav") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
      } else {
        // flipconfirm
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 90_000)) continue;
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
      }

      const targetAsk = targetBook.ask;
      if (targetAsk == null) continue;
      if (targetAsk < P.bandMin || targetAsk > P.bandMax) continue;
      const targetBid = targetBook.bid;
      if (targetBid != null && targetAsk - targetBid > P.maxSpread) continue;
      const size = Math.min(P.orderUsdc / targetAsk, P.maxShares);
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
    if (p > 0) {
      wins++;
      winPnls.push(p);
    } else {
      losses++;
      lossPnls.push(p);
    }
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    const day = new Date(wsMs).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + p;
  }

  pnl = Math.round(pnl * 100) / 100;
  const avg = (a: number[]) =>
    a.length
      ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000
      : null;
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
    avgWin: avg(winPnls),
    avgLoss: avg(lossPnls),
    shares: Math.round(shares * 100) / 100,
    notionalUsdc: Math.round(notional * 100) / 100,
    byDay: Object.fromEntries(
      Object.entries(byDay).map(([d, v]) => [d, Math.round(v * 100) / 100]),
    ),
  };
}

// ---------- CLI ----------
const isMain = process.argv[1]?.endsWith("final-sim.mts");
if (isMain) {
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows (official-aligned)`);
  const allWs = [...universe.wsMap.values()].sort((a, b) => a - b);
  const medianWs = allWs[Math.floor(allWs.length / 2)];
  const older = (slug: string) => (universe.wsMap.get(slug) ?? 0) < medianWs;
  const newer = (slug: string) => (universe.wsMap.get(slug) ?? 0) >= medianWs;

  mkdirSync(OUT_DIR, { recursive: true });
  const results: Record<string, unknown> = {};
  for (const S of [ANTIFLIP, FIRSTFAV, FLIPCONFIRM]) {
    const full = runStratSim(universe, S);
    const old = runStratSim(universe, S, { slugFilter: older });
    const newR = runStratSim(universe, S, { slugFilter: newer });
    console.log(
      `${S.label.padEnd(18)} fills=${String(full.fills).padStart(3)} WR=${String(full.winRate).padStart(5)}% PnL=${String(full.pnl).padStart(8)} DD=${String(full.maxDrawdown).padStart(7)} EV/sh=${full.evPerShare}c px=${full.avgEntryPrice}`,
    );
    console.log(
      `  split-half: OLD fills=${old.fills} PnL=${old.pnl} WR=${old.winRate}% | NEW fills=${newR.fills} PnL=${newR.pnl} WR=${newR.winRate}%`,
    );
    results[S.label] = { full, oldHalf: old, newHalf: newR };
  }
  const outPath = join(OUT_DIR, `final-sim-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: "final-sim",
        generatedAt: new Date().toISOString(),
        universeSize: universe.slugs.size,
        splitHalfBoundary: new Date(medianWs * 1000).toISOString(),
        strategies: results,
      },
      null,
      2,
    ),
  );
  console.log("written:", outPath);
}