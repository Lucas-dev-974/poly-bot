#!/usr/bin/env node
// 09-calibrate.mjs — Probabilités conditionnelles directes sur le dataset.
//
// Au lieu de sweeper des variantes, on mesure DIRECTEMENT P(win | condition)
// pour chaque condition candidate, avec n. Les conditions avec le meilleur
// ratio P(win)/prix + n suffisant deviennent les stratégies finales.
//
// Conditions testées (côté acheté = celui dont on mesure le win) :
//   R1. "Re-flip"  : leader initial perd la tête puis la REPREND (achat au re-flip).
//   R2. Antiflip   : déposé post-flip (achat X s après le flip), par bande de prix.
//   R3. Sharp+bounce : déposé, décote ≥ d du sommet pré-flip + rebond ≥ b du low post-flip.
//   R4. Momentum underdog : +g¢ en lookback, par bande.
//   R5. Leader fort : leader qui a gagné ≥ g¢ sur lookback (poursuite).
//   R6. Leader stabilité : leader inchangé depuis ≥ L s (pas de flip récent).
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal] ${windows.length} fenêtres`);

// bucket = clé de condition → { n, wins, pnl5 } ; pnl5 = PnL net si achat 5 shares hold.
function newBucket() { return { n: 0, wins: 0, pnl5: 0 }; }
const buckets = new Map();
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
  const windowMs = endMs - startMs;

  let leader0 = null;
  let prevLeader = null;
  let firstFlipT = null;
  let reFlipT = null;
  let lastLeaderChangeT = null;

  const sample = (t) => {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) return null;
    return { u, d };
  };

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const q = sample(t);
    if (!q) continue;
    const leader = q.u.ask >= q.d.ask ? 0 : 1;
    const leaderAsk = leader === 0 ? q.u.ask : q.d.ask;
    const otherAsk = leader === 0 ? q.d.ask : q.u.ask;
    const frac = (t - startMs) / windowMs;

    if (t > startMs + 10_000 && t <= startMs + 15_000 && leader0 == null) leader0 = leader;

    if (prevLeader !== null && leader !== prevLeader) {
      lastLeaderChangeT = t;
      if (firstFlipT == null) firstFlipT = t;
      if (leader0 !== null && leader === leader0 && reFlipT == null) reFlipT = t;
    }
    prevLeader = leader;

    const past = seriesAtOrBefore(leader === 0 ? up : down, t - 45_000);
    const gain45 = past?.ask != null ? leaderAsk - past.ask : null;
    const pastOther = seriesAtOrBefore(leader === 0 ? down : up, t - 45_000);
    const otherGain45 = pastOther?.ask != null ? otherAsk - pastOther.ask : null;

    if (frac < 0.20 || frac > 0.75) continue;

    // R2 — Antiflip simple.
    if (firstFlipT != null && t - firstFlipT >= 5000 && firstFlipT < startMs + 0.6 * windowMs) {
      const band = otherAsk < 0.3 ? "p<0.30" : otherAsk < 0.35 ? "0.30-0.35" : otherAsk < 0.40 ? "0.35-0.40" : otherAsk < 0.45 ? "0.40-0.45" : "0.45+";
      book(`R2-antiflip|${band}`, 1 - leader, win.winnerIndex, otherAsk);
      const ageMin = Math.min(30, Math.round((t - firstFlipT) / 1000 / 10) * 10);
      book(`R2-antiflip|age${ageMin}s|${band}`, 1 - leader, win.winnerIndex, otherAsk);
    }

    // R3 — Sharp drop + bounce du déposé.
    if (firstFlipT != null && t - firstFlipT >= 3000) {
      const depSeries = (1 - leader) === 0 ? up : down;
      let low = null;
      for (let tt = firstFlipT; tt <= t; tt += 2000) {
        const p = seriesAtOrBefore(depSeries, tt);
        if (p?.ask != null && (low == null || p.ask < low)) low = p.ask;
      }
      if (low != null && otherAsk >= low + 0.03) {
        const band = otherAsk < 0.35 ? "0.30-0.35" : otherAsk < 0.40 ? "0.35-0.40" : otherAsk < 0.45 ? "0.40-0.45" : "0.45+";
        book(`R3-sharp-bounce|${band}`, 1 - leader, win.winnerIndex, otherAsk);
      }
    }

    // R1 — Re-flip.
    if (reFlipT != null && t - reFlipT >= 3000 && t < reFlipT + 60_000) {
      const band = leaderAsk < 0.45 ? "0.40-0.45" : leaderAsk < 0.5 ? "0.45-0.50" : leaderAsk < 0.55 ? "0.50-0.55" : "0.55+";
      book(`R1-reflip|${band}`, leader, win.winnerIndex, leaderAsk);
    }

    // R4 — Momentum underdog.
    if (otherGain45 != null) {
      for (const g of [0.06, 0.08, 0.10]) {
        if (otherGain45 >= g && otherAsk >= 0.25 && otherAsk <= 0.45) {
          book(`R4-dogmom|g${g}|${otherAsk < 0.35 ? "0.25-0.35" : "0.35-0.45"}`, 1 - leader, win.winnerIndex, otherAsk);
        }
      }
    }

    // R5 — Leader momentum.
    if (gain45 != null) {
      for (const g of [0.05, 0.08, 0.12]) {
        if (gain45 >= g) {
          const band = leaderAsk < 0.4 ? "<0.40" : leaderAsk < 0.5 ? "0.40-0.50" : leaderAsk < 0.6 ? "0.50-0.60" : "0.60+";
          book(`R5-leadermom|g${g}|${band}`, leader, win.winnerIndex, leaderAsk);
        }
      }
    }

    // R6 — Leader stable.
    if (lastLeaderChangeT != null) {
      const stableSec = Math.round((t - lastLeaderChangeT) / 1000);
      const band = leaderAsk < 0.4 ? "<0.40" : leaderAsk < 0.5 ? "0.40-0.50" : "0.50+";
      if (stableSec >= 30) book(`R6-stable30|${band}`, leader, win.winnerIndex, leaderAsk);
      if (stableSec >= 60) book(`R6-stable60|${band}`, leader, win.winnerIndex, leaderAsk);
    }
  }
}

const rows = [...buckets.entries()]
  .filter(([, b]) => b.n >= 150)
  .map(([k, b]) => ({ key: k, n: b.n, wr: b.wins / b.n, pnl5: b.pnl5 / b.n }))
  .sort((a, b) => b.pnl5 - a.pnl5);

console.log("\n=== P(win | condition) — trié par PnL net (achat 5 shares, hold) ===\n");
console.log("condition                          |    n |   WR   | PnL/5sh");
for (const r of rows) {
  console.log(`${r.key.padEnd(34)} | ${String(r.n).padStart(4)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.pnl5 >= 0 ? "+" : ""}${r.pnl5.toFixed(3)}$`);
}
db.close();