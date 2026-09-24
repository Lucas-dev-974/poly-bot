// lib/variants4.js — Variantes v4 issues de la calibration directe (09/09b).
//
// Constat calibration (09b-calibrate-antiflip.mjs) :
//   - Meilleure EV : achat du DÉPOSÉ 10 s après le 1er flip, ask dans [0.44-0.48].
//     WR 55-59 % selon la bande fine, prix moyen 0.468 → EV ≈ +0.45 à +0.59 $/5 sh.
//   - d=5 s est mauvais (40 %) : le flip n'est pas encore "assimilé".
//   - d=20/30 s décroît : l'info est déjà dans le prix.
//
// Stratégie L : hold to resolution, entrée unique par fenêtre.
import { seriesAtOrBefore } from "./engine-helpers.js";
import { buildSeries, favoriteOf } from "./strategies.js";

/**
 * L — Antiflip "re-flip" : après le 1er flip, attend delaySec puis achète le
 * déposé si son ask est dans [bandMin, bandMax]. Hold to resolution.
 */
export function makeAntiflipDelay({ bandMin, bandMax, delayMs, maxFlipFrac }) {
  return {
    id: `L-antiflip-d${delayMs / 1000}s-${bandMin}-${bandMax}`,
    name: `Antiflip ${delayMs / 1000}s post-flip [${bandMin}-${bandMax}]`,
    desc: `1er flip → attend ${delayMs / 1000}s → achète le déposé [${bandMin}-${bandMax}], hold.`,
    params: { bandMin, bandMax, delayMs, maxFlipFrac },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      let prevFav = null;
      let flipT = null;
      const flipSearchEnd = s.startMs + maxFlipFrac * (s.endMs - s.startMs);
      for (let t = s.startMs; t < flipSearchEnd; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
        prevFav = fav.side;
      }
      if (flipT == null) return orders;
      const tEntry = flipT + delayMs;
      const depSeries = prevFav === 0 ? s.up : s.down;
      const p = seriesAtOrBefore(depSeries, tEntry);
      if (!p?.ask) return orders;
      if (p.ask >= bandMin && p.ask <= bandMax) {
        orders.push({
          side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { deposedAsk: p.ask, delayMs }, ts: tEntry,
        });
      }
      return orders;
    },
  };
}

export function buildSweepV4() {
  const variants = [];
  // Bandes fines autour de la zone calibrée [0.44-0.48] ; délais 8-15 s.
  for (const delayMs of [8000, 10000, 12000, 15000]) {
    for (const [bandMin, bandMax] of [
      [0.44, 0.48], [0.42, 0.48], [0.44, 0.50], [0.40, 0.48], [0.46, 0.50], [0.40, 0.45], [0.42, 0.46], [0.38, 0.48],
    ]) {
      variants.push(makeAntiflipDelay({ bandMin, bandMax, delayMs, maxFlipFrac: 0.6 }));
    }
  }
  return variants;
}