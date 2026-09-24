#!/usr/bin/env node
// 09d — Calibration finale : zone de prix où P(win) > prix (EV > 0) par tranche
// de fenêtre. Objectif : trouver P(win)/prix maximal (edge relatif) avec n.
// Mesure : pour chaque (tranche t, bande de prix du leader), P(win) vs breakeven (= prix).
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal] ${windows.length} fenêtres`);

// Buckets : (fracTranche × priceBand du LEADER) → n, wins, pnl5.
const buckets = new Map();
const newBucket = () => ({ n: 0, wins: 0, pnl5: 0, pnlDog: 0, nDog: 0, winsDog: 0 });
function book(key, side, winnerIndex, ask, b) {
  b.n++;
  if (side === winnerIndex) b.wins++;
  b.pnl5 += (side === winnerIndex ? 5 : 0) - 5 * ask;
}
// Variante : achat de l'AUTRE côté (hedge/couverture) au même instant.
function bookBoth(key, leader, winnerIndex, leaderAsk, otherAsk, bucketsMap) {
  const lb = bucketsMap.get(key + "|LEADER") ?? newBucket();
  book(key + "|LEADER", leader, winnerIndex, leaderAsk, lb);
  bucketsMap.set(key + "|LEADER", lb);
  const ob = bucketsMap.get(key + "|OTHER") ?? newBucket();
  book(key + "|OTHER", 1 - leader, winnerIndex, otherAsk, ob);
  bucketsMap.set(key + "|OTHER", ob);
}

for (const win of windows) {
  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;
  const windowMs = endMs - startMs;

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const leader = u.ask >= d.ask ? 0 : 1;
    const leaderAsk = leader === 0 ? u.ask : d.ask;
    const otherAsk = leader === 0 ? d.ask : u.ask;
    const frac = (t - startMs) / windowMs;

    const fBand = frac < 0.2 ? "00-20%" : frac < 0.4 ? "20-40%" : frac < 0.6 ? "40-60%" : frac < 0.75 ? "60-75%" : "75%+";
    const pBand = leaderAsk < 0.45 ? "L<0.45" : leaderAsk < 0.55 ? "L0.45-0.55" : leaderAsk < 0.65 ? "L0.55-0.65" : "L0.65+";
    bookBoth(`${fBand} ${pBand}`, leader, win.winnerIndex, leaderAsk, leader === 0 ? d.ask : u.ask, buckets);
  }
}

const rows = [...buckets.entries()]
  .filter(([, b]) => b.n >= 300)
  .map(([k, b]) => ({
    key: k, n: b.n,
    wr: b.wins / b.n,
    pnl5: b.pnl5 / b.n,
  }))
  .sort((a, b) => b.pnl5 - a.pnl5);

console.log("\n=== Leader vs Other par tranche de fenêtre × bande de prix (5 shares, hold) ===\n");
console.log("condition                  |     n |   WR   |  PnL/5sh");
for (const r of rows) {
  console.log(`${r.key.padEnd(26)} | ${String(r.n).padStart(5)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.pnl5 >= 0 ? "+" : ""}${r.pnl5.toFixed(3)}$`);
}
db.close();