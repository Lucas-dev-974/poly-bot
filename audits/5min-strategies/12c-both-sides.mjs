#!/usr/bin/env node
// 12c — Dernière piste : arbitrage pur (acheter les DEUX côtés quand
// askUp + askDown < 1). 5 shares de chaque côté : mise = 5×(askUp+askDown),
// payout garanti = 5 (une seule jambe gagne à $1/share).
//
// Gain garanti = 5 − 5×(askUp+askDown). Pour gain ≥ 3$ ⇒ mise ≤ 2$ ⇒
// askUp+askDown ≤ 0.40 : mesurons si de tels ticks existent.

import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[12c] ${windows.length} fenêtres`);

let n = 0;
let costSum = 0;
let costMin = Infinity;
for (const win of windows) {
  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;
  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const sum = u.ask + d.ask;
    if (sum >= 1) continue; // pas d'arbitrage
    n++;
    const cost = 5 * sum;
    costSum += cost;
    if (cost < costMin) costMin = cost;
  }
}

console.log("\n=== Arbitrage deux-jambes : ticks avec askUp+askDown < 1 ===");
if (n === 0) {
  console.log("aucun tick exploitable : le marché cote toujours askUp+askDown ≥ 1");
} else {
  console.log(
    `ticks exploitables : ${n}, mise moyenne ${(costSum / n).toFixed(2)}$, min ${costMin.toFixed(2)}$`,
  );
  console.log("gain garanti = 5$ − mise ; gain ≥ 3$ ⇔ mise ≤ 2$");
}
db.close();