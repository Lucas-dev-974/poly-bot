/**
 * Match backtest vs live — simule la config EXACTE du live (band 0.55-0.63,
 * minElapsed 480, drop 0.03, spread 0.04) sur la fenêtre où le bot a tradé
 * (slugs 1789372000+) et compare les métriques aux positions live réelles.
 *
 * Live: 58 pos, WR 57.4%, avg win +2.02, avg loss -2.98, PnL -2.99 (07:45Z).
 * Backtest cible: mêmes gates, même univers (fenêtres complètes >= 801 ticks).
 *
 * Usage: npx tsx scripts/research/dip-revert-research/match-live-config.mts
 */
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";

const liveParams: Partial<SimParams> = {
  bandMin: 0.55,
  bandMax: 0.63,
  minElapsedSec: 480,
  minDrop: 0.03,
  maxSpread: 0.04,
  lookbackMs: 60_000,
};

const u = loadUniverse();
const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);

// Le live a tradé du 14 sept 13:48Z au 15 sept 05:33Z. On filtre l'univers sur
// les fenêtres de cette période (comparaison à périmètre identique).
const LIVE_FROM = 1789372123; // première position live (sec)
const LIVE_TO = 1789450200 + 900; // dernière fenêtre tradée + 15m

function stats(P: SimParams, slugFilter?: (s: string) => boolean) {
  const r = runSim(u, P, { slugFilter });
  const byDay: Record<string, number> = {};
  for (const d of [...new Set([...u.slugs.keys()].map(dayOf))].sort()) {
    const rd = runSim(u, P, { slugFilter: (s) => dayOf(s) === d && (slugFilter ? slugFilter(s) : true) });
    byDay[d] = rd.pnl;
  }
  return { ...r, byDay };
}

const P: SimParams = { ...BASE, ...liveParams };

// périmètre live: fenêtres dont le windowStart est dans la période du live
const inLivePeriod = (slug: string) => {
  const ws = Number(slug.split("-").pop());
  return ws >= LIVE_FROM && ws <= LIVE_TO;
};

const live = stats(P, inLivePeriod);
console.log("=== SIM config live exacte (band 0.55-0.63, elapsed 480, drop 0.03) ===");
console.log(`period: 14 sept 13:48Z -> 15 sept 05:45Z (fenêtres du live)`);
console.log(`sim:    fills=${live.fills} wins=${live.wins} losses=${live.losses} wr=${live.winRate}% pnl=${live.pnl}`);
console.log(`        avgWin=${live.avgWin} avgLoss=${live.avgLoss} maxDD=${live.maxDrawdown}`);
console.log(`byDay:`, JSON.stringify(live.byDay));

// Référence: la config backtest gagnante sur la MÊME période (e150+d050 bande 0.65)
const P2: SimParams = { ...BASE, bandMin: 0.55, bandMax: 0.65, minElapsedSec: 150, minDrop: 0.05 };
const winner = stats(P2, inLivePeriod);
console.log("\n=== SIM config backtest gagnante (band 0.65, elapsed 150, drop 0.05) ===");
console.log(`sim:    fills=${winner.fills} wins=${winner.wins} losses=${winner.losses} wr=${winner.winRate}% pnl=${winner.pnl}`);
console.log(`byDay:`, JSON.stringify(winner.byDay));

// Le LIVE réel (depuis la DB, positions dip-revert closed):
// 57 closed, 31W/23L/3 sold, WR 57.4%, PnL -2.99, avgWin 2.02, avgLoss -2.98
console.log("\n=== LIVE réel (57 closed @ 07:45Z) ===");
console.log("live:   fills=57 wins=31(+3 sold) losses=23 wr=57.4% pnl=-2.99 avgWin=+2.02 avgLoss=-2.98");
console.log(`
CRITÈRE DE MATCH:
  - fills sim vs 57 live (même ordre de grandeur? même période?)
  - WR sim vs 57.4%
  - signe du PnL et magnitude`);