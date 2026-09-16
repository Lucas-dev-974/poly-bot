/**
 * Match backtest vs live v2 — corrige 2 distorsions de la v1:
 *  1. sizing: live trade 5 shares (maxSharesPerOrder=5, orderUsdc 15 -> taille
 *     min(15/px, 5)), la sim v1 utilisait 30 -> réconcilié: orderUsdc 15 + cap 5.
 *  2. périmètre: fenêtres COMPLÈTES uniquement (>= 801 ticks) — la sim ne peut
 *     pas trader les 5 fenêtres incomplètes où le live a tradé (3 positions).
 *     On compare live-sur-complètes vs sim-sur-complètes.
 *
 * Usage: npx tsx scripts/research/dip-revert-research/match-live-config2.mts
 */
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";
import { DatabaseSync } from "node:sqlite";

const u = loadUniverse();
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

// fenêtres complètes de la période live (même critère que loadUniverse)
const LIVE_FROM = 1789372123;
const LIVE_TO = 1789451100;
const completeRows = db
  .prepare(
    `SELECT eventSlug, COUNT(DISTINCT ts) AS ticks FROM market_snapshots
     WHERE eventSlug LIKE 'btc-updown-15m-%'
       AND CAST(replace(eventSlug,'btc-updown-15m-','') AS INTEGER) BETWEEN ? AND ?
     GROUP BY eventSlug HAVING ticks >= 801`,
  )
  .all(LIVE_FROM, LIVE_TO) as Array<{ eventSlug: string }>;
const completeSet = new Set(completeRows.map((r) => r.eventSlug));
db.close();

const inLive = (slug: string) => completeSet.has(slug);

// positions live réelles sur ces fenêtres complètes: stats précises
const live = {
  fills: 53, // 56 slugs - 3 sur fenêtres incomplètes
  wins: 0,
  losses: 0,
  pnl: 0,
  avgWin: 0,
  avgLoss: 0,
};

function stats(P: SimParams) {
  const r = runSim(u, P, { slugFilter: inLive });
  const byDay: Record<string, number> = {};
  for (const d of ["2026-09-14", "2026-09-15"]) {
    const rd = runSim(u, P, { slugFilter: (s) => inLive(s) && new Date(Number(s.split("-").pop()) * 1000).toISOString().slice(0, 10) === d });
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  return { ...r, byDay };
}

// config live EXACTE, sizing live (5 shares max)
const Plive: SimParams = {
  ...BASE,
  bandMin: 0.55,
  bandMax: 0.63,
  minElapsedSec: 480,
  minDrop: 0.03,
  maxSpread: 0.04,
  lookbackMs: 60_000,
};
// BASE.orderUsdc=15 avec cap: la sim utilise min(orderUsdc/px, 30) -> il faut 5.
// SimParams n'a pas de cap: on scale par un ordreUsdc équivalent? Non: la taille
// live = min(15/px, 5) = 5 shares pour px < 3. Donc fixer orderUsdc ne suffit pas.
// Approximation honnête: runSim calcule size = min(orderUsdc/px, 30). Pour avoir
// 5 shares il faut orderUsdc = 5*px. On post-traite donc le pnl au prorata:
// pnl_5sh = pnl_sim * (5 / avgSize_sim). avgSize = orderUsdc/px moyen.
const liveRun = stats(Plive);
// size moyenne sim (orderUsdc 15): ~15/0.59 ≈ 25.4 shares
const avgSizeSim = 15 / 0.59;
const scale = 5 / avgSizeSim;
console.log("=== SIM config live EXACTE + sizing live (5 shares) ===");
console.log(`fills sim=${liveRun.fills} vs live=53 (sur fenêtres complètes)`);
console.log(
  `wr sim=${liveRun.winRate}% vs live=57.4% (31W/23L/3s)`,
);
console.log(
  `pnl sim(raw 25sh)=${liveRun.pnl} -> scale x${scale.toFixed(3)} => ${(liveRun.pnl * scale).toFixed(2)} vs live -2.99`,
);
console.log(`byDay(5sh):`, JSON.stringify(Object.fromEntries(Object.entries(liveRun.byDay).map(([k, v]) => [k, (v * scale).toFixed(2)]))));

// config backtest gagnante sur le même périmètre
const Pw: SimParams = { ...BASE, bandMin: 0.55, bandMax: 0.65, minElapsedSec: 150, minDrop: 0.05 };
const winRun = stats(Pw);
console.log("\n=== SIM config backtest gagnante (même périmètre, même sizing) ===");
console.log(`fills=${winRun.fills} wr=${winRun.winRate}% pnl(5sh)=${(winRun.pnl * scale).toFixed(2)}`);
console.log(`byDay(5sh):`, JSON.stringify(Object.fromEntries(Object.entries(winRun.byDay).map(([k, v]) => [k, (v * scale).toFixed(2)]))));