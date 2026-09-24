#!/usr/bin/env node
// 09c — Calibration "flip marginal" : après le 1er flip, la force du NOUVEAU
// leader (son ask) prédit-elle le retour du déposé ?
// Condition de base : déposé à d10s post-flip, croisé avec bande du nouveau leader.
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal] ${windows.length} fenêtres`);

const buckets = new Map();
const newBucket = () => ({ n: 0, wins: 0, pnl5: 0 });
function book(key, side, winnerIndex, ask) {
  const b = buckets.get(key) ?? newBucket();
  b.n++;
  if (side === winnerIndex) b.wins++;
  b.pnl5 += (side === winnerIndex ? 5 : 0) - 5 * ask;
  buckets.set(key, b);
}

for (const win of windows) {
  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;

  let prevLeader = null;
  let firstFlipT = null;

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const leader = u.ask >= d.ask ? 0 : 1;
    const leaderAsk = leader === 0 ? u.ask : d.ask;
    const otherAsk = leader === 0 ? d.ask : u.ask;

    if (prevLeader !== null && leader !== prevLeader && firstFlipT == null) firstFlipT = t;
    prevLeader = leader;

    if (firstFlipT == null) continue;
    const target = firstFlipT + 10_000;
    if (Math.abs(t - target) >= 600) continue;
    const side = 1 - leader;
    const depAsk = otherAsk;
    if (depAsk < 0.35 || depAsk > 0.52) continue;

    const lBand = leaderAsk < 0.52 ? "L0.50-0.52" : leaderAsk < 0.55 ? "L0.52-0.55" : leaderAsk < 0.60 ? "L0.55-0.60" : leaderAsk < 0.65 ? "L0.60-0.65" : "L0.65+";
    const dBand = depAsk < 0.42 ? "D0.35-0.42" : depAsk < 0.46 ? "D0.42-0.46" : "D0.46-0.52";
    book(`d10s ${lBand} ${dBand}`, side, win.winnerIndex, depAsk);
    book(`d10s ${lBand} ALL`, side, win.winnerIndex, depAsk);
    book(`d10s ALL ${dBand}`, side, win.winnerIndex, depAsk);
    // Marge du flip = 1 - (leader + déposé) si somme proche de 1 → marché incertain.
    const sum = leaderAsk + depAsk;
    book(`d10s sum${sum < 0.98 ? "<0.98" : sum < 1.02 ? "0.98-1.02" : "1.02+"} ${dBand}`, side, win.winnerIndex, depAsk);
  }
}

const rows = [...buckets.entries()]
  .filter(([, b]) => b.n >= 40)
  .map(([k, b]) => ({ key: k, n: b.n, wr: b.wins / b.n, pnl5: b.pnl5 / b.n }))
  .sort((a, b) => b.pnl5 - a.pnl5);

console.log("\n=== Flip marginal — déposé à 10 s post-flip ===\n");
console.log("condition                        |    n |   WR   |  PnL/5sh");
for (const r of rows) {
  console.log(`${r.key.padEnd(32)} | ${String(r.n).padStart(4)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.pnl5 >= 0 ? "+" : ""}${r.pnl5.toFixed(3)}$`);
}
db.close();