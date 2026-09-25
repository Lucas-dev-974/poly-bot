#!/usr/bin/env node
// 12b — Balayage exhaustif : quel est le WR MAXIMUM atteignable avec un
// d'entrée ≤ 0.40 (5 shares ≤ 2 $, gain ≥ 3 $) ?
//
// Conditions testées (croisements fins) : post-flip × délai × bande, momentum
// du leader/underdog, fenêtre tardive, rebond depuis plancher, dislocation,
// spread. Chaque cellule est validée IS/OOS (split chrono 50/50).

import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";
import { writeFileSync } from "node:fs";

const MIN_N = Number(process.argv[2] ?? 120);

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[cal60b] ${windows.length} fenêtres, min n = ${MIN_N}`);

const B_ALL = new Map(), B_IS = new Map(), B_OOS = new Map();
const midChrono = windows.length / 2;

function bookSide(map, key, side, winnerIndex, ask) {
  let b = map.get(key);
  if (!b) {
    b = { n: 0, wins: 0, pnl5: 0, cost: 0 };
    map.set(key, b);
  }
  const cost = 5 * ask;
  const credit = side === winnerIndex ? 5 : 0;
  b.n++;
  b.cost += cost;
  b.pnl5 += credit - cost;
  if (credit > 0) b.wins++;
}

let windowIndex = 0;
for (const win of windows) {
  const half = windowIndex < midChrono ? "IS" : "OOS";
  windowIndex++;

  const up = win.ticksUp, down = win.ticksDown;
  const startMs = win.startTs * 1000, endMs = win.endTs * 1000;
  const windowMs = endMs - startMs;
  const winnerIndex = win.winnerIndex;

  let prevFav = null;
  let flipTs = null;
  let flipFrac = null;
  let firedA = false;
  let firedH = false;
  let lowSinceFlip = null; // plancher underdog post-flip
  let peakPreFlip = null;  // sommet du leader pré-flip
  const leaderAsks = [];

  for (let t = startMs; t < endMs - 10_000; t += 1000) {
    const u = seriesAtOrBefore(up, t);
    const d = seriesAtOrBefore(down, t);
    if (!u?.ask || !d?.ask) continue;
    const askUp = u.ask, askDown = d.ask;
    const favIdx = askUp >= askDown ? 0 : 1;
    const favAsk = favIdx === 0 ? askUp : askDown;
    const dogAsk = favIdx === 0 ? askDown : askUp;
    const dogSide = 1 - favIdx;
    const frac = (t - startMs) / windowMs;

    if (prevFav !== null && favIdx !== prevFav) {
      flipTs = t;
      flipFrac = frac;
      lowSinceFlip = null;
      // figer le sommet pré-flip du futur déchu (= leader avant flip)
      let peak = null;
      for (const s of leaderAsks) if (peak == null || s.ask > peak) peak = s.ask;
      peakPreFlip = peak;
    }
    prevFav = favIdx;
    leaderAsks.push({ ts: t, ask: favAsk });
    if (leaderAsks.length > 8) leaderAsks.shift();

    const sinceFlipMs = flipTs == null ? null : t - flipTs;
    const dislocation = askUp + askDown;
    // momentum 30s
    const upPast = seriesAtOrBefore(up, t - 30_000);
    const downPast = seriesAtOrBefore(down, t - 30_000);
    const upMom = upPast?.ask != null ? askUp - upPast.ask : null;
    const downMom = downPast?.ask != null ? askDown - downPast.ask : null;
    const dogMom = favIdx === 0 ? downMom : upMom;

    const put = (key, side, ask) => {
      bookSide(B_ALL, key, side, winnerIndex, ask);
      if (half === "IS") bookSide(B_IS, key, side, winnerIndex, ask);
      else bookSide(B_OOS, key, side, winnerIndex, ask);
    };

    // ── Post-flip (antiflip) : déposé ≤ 0.40, délais 5/10/15/30/45/60s ──
    if (sinceFlipMs != null) {
      for (const delaySec of [5, 10, 15, 30, 60]) {
        if (sinceFlipMs >= delaySec * 1000 && sinceFlipMs < (delaySec + 5) * 1000 && dogAsk <= 0.4) {
          put(`AF d${delaySec}s dog${dogAsk < 0.3 ? "<0.30" : "0.30-0.40"}`, dogSide, dogAsk);
        }
      }
      // fenêtre large post-flip
      if (sinceFlipMs >= 5_000 && sinceFlipMs <= 60_000 && dogAsk <= 0.4) {
        put(`AF 5-60s dog${dogAsk < 0.3 ? "<0.30" : "0.30-0.40"}`, dogSide, dogAsk);
      }
      // sharp drop depuis le sommet pré-flip
      if (peakPreFlip != null && dogAsk <= 0.4) {
        const drop = peakPreFlip - dogAsk;
        if (drop >= 0.12) put(`AF sharp≥12¢ dog≤0.40`, dogSide, dogAsk);
        if (drop >= 0.20) put(`AF sharp≥20¢ dog≤0.40`, dogSide, dogAsk);
      }
      // bounce depuis le plancher post-flip
      if (lowSinceFlip == null || dogAsk < lowSinceFlip) lowSinceFlip = dogAsk;
      if (lowSinceFlip != null && dogAsk <= 0.4 && sinceFlipMs != null && sinceFlipMs >= 5_000) {
        const bounce = dogAsk - lowSinceFlip;
        if (bounce >= 0.05 && dogAsk >= 0.3) put(`AF bounce≥5¢ dog0.30-0.40`, dogSide, dogAsk);
        if (bounce >= 0.08 && dogAsk >= 0.3) put(`AF bounce≥8¢ dog0.30-0.40`, dogSide, dogAsk);
        if (bounce >= 0.08 && dogAsk >= 0.35) put(`AF bounce≥8¢ dog0.35-0.40`, dogSide, dogAsk);
      }
    }

    // ── Underdog ≤ 0.40 × momentum × tranche ──
    if (dogAsk <= 0.4) {
      const dmBand = dogMom == null ? "na" : dogMom <= -0.10 ? "≤-10" : dogMom < -0.02 ? "-10..-2" : dogMom <= 0.02 ? "~0" : "+2..10";
      const fBand = frac < 0.2 ? "0-20%" : frac < 0.4 ? "20-40%" : frac < 0.6 ? "40-60%" : frac < 0.8 ? "60-80%" : "80%+";
      const pBand = dogAsk < 0.25 ? "<0.25" : dogAsk < 0.33 ? "0.25-0.33" : "0.33-0.40";
      put(`DOG ${pBand} m${dmBand} ${fBand}`, dogSide, dogAsk);
      // croisement favori fort/faible
      const gap = favAsk - dogAsk;
      const gBand = gap >= 0.35 ? "gap≥35" : gap >= 0.2 ? "gap20-35" : "gap<20";
      put(`DOG ${pBand} ${gBand} ${fBand}`, dogSide, dogAsk);
    }

    // ── Leader faible (favAsk ≤ 0.55) : buy leader pas cher ──
    if (favAsk <= 0.4) {
      const fm = (favIdx === 0 ? upMom : downMom);
      put(`FAV≤0.40 m${fm == null ? "na" : fm >= 0 ? "+" : "-"}`, favIdx, favAsk);
    }

    // ── Dislocation : somme ≤ 0.97, token le moins cher ≤ 0.40 ──
    if (dislocation <= 0.97) {
      const cheaper = askUp <= askDown ? 0 : 1;
      const cheaperAsk = cheaper === 0 ? askUp : askDown;
      if (cheaperAsk <= 0.4) put(`DIS≤0.97 buyCheaper≤0.40`, cheaper, cheaperAsk);
    }

    // ── Combiné : post-flip ≥ 10s + fin de fenêtre (75%+) + dog 0.30-0.40 ──
    if (sinceFlipMs != null && sinceFlipMs >= 10_000 && frac > 0.6 && dogAsk >= 0.3 && dogAsk <= 0.4) {
      put(`AF≥10s late dog0.30-0.40`, dogSide, dogAsk);
    }

    // ── A-EXACT (réplique du preset A) : flip dans les 60% de fenêtre,
    // entrée au 1er tick ≥ flip+5s avec dog ∈ [0.30, 0.45] — 1 seul par fenêtre.
    if (
      sinceFlipMs != null && sinceFlipMs >= 5_000 && !firedA &&
      flipFrac != null && flipFrac <= 0.6 && dogAsk >= 0.3 && dogAsk <= 0.45
    ) {
      firedA = true;
      put(`A-EXACT d5s dog0.30-0.45 flip≤60%`, dogSide, dogAsk);
      if (dogAsk >= 0.33 && dogAsk <= 0.40) {
        put(`A-EXACT d5s dog0.33-0.40`, dogSide, dogAsk);
      }
    }
    // H-EXACT : A + chute ≥ 12¢ du sommet pré-flip.
    if (
      sinceFlipMs != null && sinceFlipMs >= 5_000 && !firedH &&
      flipFrac != null && flipFrac <= 0.6 && dogAsk >= 0.3 && dogAsk <= 0.45 &&
      peakPreFlip != null && peakPreFlip - dogAsk >= 0.12
    ) {
      firedH = true;
      put(`H-EXACT d5s sharp≥12¢ dog0.30-0.45`, dogSide, dogAsk);
    }
  }
}

function rows(map) {
  return [...map.entries()]
    .filter(([, b]) => b.n >= MIN_N)
    .map(([k, b]) => ({ key: k, n: b.n, wr: b.wins / b.n, avgCost: b.cost / b.n, pnl5: b.pnl5 / b.n }))
    .sort((a, b) => b.wr - a.wr);
}

const all = rows(B_ALL);
console.log(`\n=== TOP 30 par WR (n ≥ ${MIN_N}, coût ≤ 2$ ⇒ gain ≥ 3$) ===`);
console.log("condition                                       |     n |    WR  | coût | PnL/5sh");
for (const r of all.slice(0, 30)) {
  console.log(
    `${r.key.padEnd(46)} | ${String(r.n).padStart(5)} | ${(r.wr * 100).toFixed(1).padStart(5)}% | ${r.avgCost.toFixed(2)} | ${(r.pnl5 >= 0 ? "+" : "") + r.pnl5.toFixed(2)}$`,
  );
}

// Validation IS/OOS des candidates WR ≥ 55 %.
const cands = all.filter((r) => r.wr >= 0.55);
console.log(`\n=== Validation IS/OOS des ${cands.length} candidates (WR ≥ 55 %) ===`);
for (const c of cands) {
  const is = B_IS.get(c.key), oos = B_OOS.get(c.key);
  const isWr = is && is.n >= MIN_N / 2 ? is.wins / is.n : null;
  const oosWr = oos && oos.n >= MIN_N / 2 ? oos.wins / oos.n : null;
  const stable = isWr != null && oosWr != null && isWr >= 0.52 && oosWr >= 0.52;
  console.log(
    `${c.key.padEnd(46)} | ALL ${(c.wr * 100).toFixed(1)}% n=${c.n} | IS ${isWr == null ? "—" : (isWr * 100).toFixed(1) + "% n=" + is.n} | OOS ${oosWr == null ? "—" : (oosWr * 100).toFixed(1) + "% n=" + oos.n} ${stable ? "✓" : "✗"}`,
  );
}

// Plafond observé
const maxWr = all[0];
if (maxWr) {
  console.log(`\n[cal60b] PLAFOND observé à coût ≤ 2$ : WR ${(maxWr.wr * 100).toFixed(1)}% (${maxWr.key}, n=${maxWr.n}, coût ${maxWr.avgCost.toFixed(2)}$)`);
}
db.close();