#!/usr/bin/env node
// 09b — Calibration focalisée : condition de base "déposé post-flip [0.40-0.45]"
// (meilleure zone EV), et test de filtres additifs pour pousser le WR vers 55 %.
//
// Sortie : WR + EV(5 shares hold) par combinaison, n ≥ 120.
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal] ${windows.length} fenêtres`);

const buckets = new Map();
const newBucket = () => ({ n: 0, wins: 0, pnl5: 0, priceSum: 0 });
function book(key, side, winnerIndex, ask) {
  const b = buckets.get(key) ?? newBucket();
  b.n++;
  if (side === winnerIndex) b.wins++;
  b.pnl5 += (side === winnerIndex ? 5 : 0) - 5 * ask;
  b.priceSum += ask;
  buckets.set(key, b);
}

for (const win of windows) {
  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;
  const windowMs = endMs - startMs;

  let prevLeader = null;
  let leader0 = null;
  let firstFlipT = null;
  let flipsBeforeEntry = 0;
  const preFlipLeaderAsk = { 0: null, 1: null }; // ask du leader juste avant son flip

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const leader = u.ask >= d.ask ? 0 : 1;
    const leaderAsk = leader === 0 ? u.ask : d.ask;
    const otherAsk = leader === 0 ? d.ask : u.ask;
    const frac = (t - startMs) / windowMs;

    if (prevLeader !== null && leader !== prevLeader) {
      preFlipLeaderAsk[prevLeader] = (leader === 0 ? d.ask : u.ask); // l'ancien leader devient l'autre
      if (firstFlipT == null) firstFlipT = t;
      flipsBeforeEntry++;
    }
    if (t > startMs + 10_000 && t <= startMs + 15_000 && leader0 == null) leader0 = leader;
    prevLeader = leader;

    if (firstFlipT == null || frac < 0.20 || frac > 0.75) continue;

    for (const delaySec of [5, 10, 15, 20, 30]) {
      const target = firstFlipT + delaySec * 1000;
      if (Math.abs(t - target) >= 600) continue; // 1 échantillon par (flip, delay), tolérance 600ms
      const side = 1 - leader; // le déposé
      const depAsk = otherAsk;
      const depSeries = side === 0 ? up : down;
      const prePeak = preFlipLeaderAsk[side]; // ask du déposé juste avant le flip

      // Bandes fines.
      if (depAsk < 0.38 || depAsk > 0.48) continue;
      const band = depAsk < 0.40 ? "0.38-0.40" : depAsk < 0.42 ? "0.40-0.42" : depAsk < 0.44 ? "0.42-0.44" : depAsk < 0.46 ? "0.44-0.46" : "0.46-0.48";
      const base = `d${delaySec}s|${band}`;

      book(`BASE ${base}`, side, win.winnerIndex, depAsk);

      // F1/F2 : force du favori pré-flip.
      if (prePeak != null) {
        if (prePeak >= 0.55) book(`F1 pre≥0.55 ${base}`, side, win.winnerIndex, depAsk);
        if (prePeak >= 0.60) book(`F2 pre≥0.60 ${base}`, side, win.winnerIndex, depAsk);
        if (prePeak < 0.55) book(`F1b pre<0.55 ${base}`, side, win.winnerIndex, depAsk);
      }
      // F3 : le nouveau leader pas trop fort.
      if (leaderAsk <= 0.55) book(`F3 newL≤0.55 ${base}`, side, win.winnerIndex, depAsk);
      if (leaderAsk <= 0.60) book(`F3b newL≤0.60 ${base}`, side, win.winnerIndex, depAsk);
      // F4 : pas de second flip avant l'entrée.
      if (flipsBeforeEntry === 1) book(`F4 1flip ${base}`, side, win.winnerIndex, depAsk);
      // F5 : le déposé n'a pas encore rebondi (close du low post-flip).
      let low = null;
      for (let tt = firstFlipT; tt <= t; tt += 1000) {
        const p = seriesAtOrBefore(depSeries, tt);
        if (p?.ask != null && (low == null || p.ask < low)) low = p.ask;
      }
      if (low != null) {
        if (depAsk <= low + 0.02) book(`F5 noBounce ${base}`, side, win.winnerIndex, depAsk);
        if (depAsk >= low + 0.03) book(`F5b bounced+3 ${base}`, side, win.winnerIndex, depAsk);
      }
      // F6 : flip précoce.
      if (frac <= 0.35) book(`F6 flip≤35% ${base}`, side, win.winnerIndex, depAsk);
      if (frac <= 0.25) book(`F6b flip≤25% ${base}`, side, win.winnerIndex, depAsk);
      // F7 : momentum déposé 10 s (chute en cours vs stabilisation).
      const past10 = seriesAtOrBefore(depSeries, t - 10_000);
      if (past10?.ask != null) {
        if (depAsk < past10.ask - 0.01) book(`F7 falling ${base}`, side, win.winnerIndex, depAsk);
        if (depAsk >= past10.ask) book(`F7b stable/up ${base}`, side, win.winnerIndex, depAsk);
      }
      // Combos prometteurs.
      if (prePeak != null && prePeak >= 0.55 && leaderAsk <= 0.55) book(`C1 pre≥0.55+newL≤0.55 ${base}`, side, win.winnerIndex, depAsk);
      if (flipsBeforeEntry === 1 && frac <= 0.35) book(`C2 1flip+early ${base}`, side, win.winnerIndex, depAsk);
      if (prePeak != null && prePeak >= 0.55 && flipsBeforeEntry === 1) book(`C3 pre≥0.55+1flip ${base}`, side, win.winnerIndex, depAsk);
      if (low != null && depAsk <= low + 0.02 && flipsBeforeEntry === 1) book(`C4 noBounce+1flip ${base}`, side, win.winnerIndex, depAsk);
      if (prePeak != null && prePeak >= 0.55 && leaderAsk <= 0.60 && flipsBeforeEntry === 1) book(`C5 pre≥0.55+newL≤0.60+1flip ${base}`, side, win.winnerIndex, depAsk);
    }
  }
}

const rows = [...buckets.entries()]
  .filter(([, b]) => b.n >= 30)
  .map(([k, b]) => ({ key: k, n: b.n, wr: b.wins / b.n, pnl5: b.pnl5 / b.n, avgP: b.priceSum / b.n }))
  .sort((a, b) => b.pnl5 - a.pnl5);

console.log("\n=== Antiflip [0.38-0.48] + filtres — trié par PnL net (5 shares, hold) ===\n");
console.log("condition                                   |    n |   WR   | prixM |  PnL/5sh");
for (const r of rows) {
  console.log(`${r.key.padEnd(43)} | ${String(r.n).padStart(4)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.avgP.toFixed(3)} | ${r.pnl5 >= 0 ? "+" : ""}${r.pnl5.toFixed(3)}$`);
}
db.close();