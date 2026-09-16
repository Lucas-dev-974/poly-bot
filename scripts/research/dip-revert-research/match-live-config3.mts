/**
 * Match backtest vs live v3 — config live RÉELLE de la période:
 * les entrées live vont de 181s à 717s, 35/58 entre 180-300s => minElapsed
 * runtime était 180 (le JSON 480 n'a jamais été actif — entrée 228s à 05:18Z).
 * Config: band 0.55-0.63, elapsed 180, drop 0.03, spread 0.04, sizing 5 sh.
 * Périmètre: fenêtres complètes de la période live uniquement.
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

// config live reelle + sizing 5 shares (scale post-hoc: sim size ~15/0.59=25.4sh)
const P: SimParams = { ...BASE, bandMin: 0.55, bandMax: 0.63, minElapsedSec: 180, minDrop: 0.03, maxSpread: 0.04 };
const r = stats(P);
const scale = 5 / (15 / 0.59);
console.log("=== SIM config live REELLE (elapsed 180) + sizing 5sh ===");
console.log(`fills=${r.fills} (live: 53) wr=${r.winRate}% (live: 57.4%)`);
console.log(`pnl(5sh)=${(r.pnl*scale).toFixed(2)} (live: -2.99)`);
console.log(`byDay(5sh):`, JSON.stringify(Object.fromEntries(Object.entries(r.byDay).map(([k,v]) => [k, (v*scale).toFixed(2)]))), `(live: 14:+13.59/15:-16.58 sur TOUTES fenetres)`);
