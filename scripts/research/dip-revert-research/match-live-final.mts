/**
 * Match backtest vs live FINAL — config runtime réelle découverte par les fills:
 * le runtime trade jusqu'à 0.65 (10 fills à 0.64-0.65) et entre dès 181s =>
 * le runtime tourne sur la config BASE officielle (band 0.55-0.65, elapsed 180,
 * drop 0.03). Le JSON bot-settings.json (band 0.63, elapsed 480) a été modifié
 * SANS hot-apply (le bot ne relit pas le fichier; il ne le réécrit que sur PATCH).
 * Sim: BASE exacte + sizing 5 shares, périmètre = fenêtres complètes du live.
 */
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";
import { DatabaseSync } from "node:sqlite";

const u = loadUniverse();
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const LIVE_FROM = 1789372123, LIVE_TO = 1789451100;
const completeSet = new Set(
  (db.prepare(`SELECT eventSlug FROM market_snapshots
     WHERE eventSlug LIKE 'btc-updown-15m-%'
       AND CAST(replace(eventSlug,'btc-updown-15m-','') AS INTEGER) BETWEEN ? AND ?
     GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= 801`).all(LIVE_FROM, LIVE_TO) as any[]).map(r => r.eventSlug)
);
db.close();
const inLive = (slug: string) => completeSet.has(slug);

function stats(P: SimParams) {
  const r = runSim(u, P, { slugFilter: inLive });
  const byDay: Record<string, number> = {};
  for (const d of ["2026-09-14", "2026-09-15"]) {
    const rd = runSim(u, P, { slugFilter: (s) => inLive(s) && new Date(Number(s.split("-").pop())*1000).toISOString().slice(0,10) === d });
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  return { ...r, byDay };
}

const P: SimParams = { ...BASE }; // band 0.55-0.65, elapsed 180, drop 0.03, spread 0.04
const r = stats(P);
const scale = 5 / (15 / 0.59); // sizing live 5 shares vs sim ~25.4
console.log("=== SIM config runtime RÉELLE (BASE officielle) + sizing 5sh ===");
console.log(`fills=${r.fills} (live: 57 closed) wr=${r.winRate}% (live: 57.4%)`);
console.log(`pnl(5sh)=${(r.pnl*scale).toFixed(2)} (live: -2.99)`);
console.log(`byDay(5sh):`, JSON.stringify(Object.fromEntries(Object.entries(r.byDay).map(([k,v]) => [k, (v*scale).toFixed(2)]))));
console.log(`      live byDay: 14:+13.59 / 15:-16.58`);
console.log(`avgWin sim(5sh)=${((r.avgWin ?? 0)*scale).toFixed(2)} (live: +2.02) | avgLoss sim(5sh)=${((r.avgLoss??0)*scale).toFixed(2)} (live: -2.98)`);
