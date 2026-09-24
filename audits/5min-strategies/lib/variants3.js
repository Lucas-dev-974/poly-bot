// lib/variants3.js — Variantes v3 : antiflip avec confirmation de rebond
// (double-bottom) + filtres de qualité. Objectif WR > 55 %.
//
// Constat v2 : les TP/SL perdent (spread bid/ask), le hold gagne. La voie
// pour monter le WR est un meilleur TIMING d'entrée : attendre que le
// déposé cesse de décote (plus-bas local + rebond de B¢) avant d'acheter.

import { seriesAtOrBefore } from "./engine-helpers.js";
import { buildSeries, favoriteOf } from "./strategies.js";

/**
 * J — Antiflip + confirmation de rebond : après le flip, suit le plancher
 * du déposé ; entre seulement quand son ask a rebondi de ≥ bounce depuis
 * son post-flip low, et reste dans la bande. Hold to resolution.
 */
export function makeAntiflipBounce({ bandMin, bandMax, bounce, delayMs, maxElapsedFrac, maxEntryFrac }) {
  return {
    id: `J-antiflip-bounce${bounce}-${bandMin}-${bandMax}-e${maxEntryFrac}`,
    name: `Antiflip bounce+${bounce} [${bandMin}-${bandMax}]`,
    desc: `Post-flip: attend rebond ≥${bounce} du plancher du déposé, bande [${bandMin}-${bandMax}], entrée avant ${Math.round(maxEntryFrac * 100)}%.`,
    params: { bandMin, bandMax, bounce, delayMs, maxElapsedFrac, maxEntryFrac },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      let prevFav = null;
      let flipT = null;
      const flipSearchEnd = s.startMs + maxElapsedFrac * (s.endMs - s.startMs);
      for (let t = s.startMs; t < flipSearchEnd; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
        prevFav = fav.side;
      }
      if (flipT == null) return orders;
      const depSeries = prevFav === 0 ? s.up : s.down;
      const entryDeadline = s.startMs + maxEntryFrac * (s.endMs - s.startMs);
      let low = null;
      for (let t = flipT + delayMs; t < Math.min(entryDeadline, s.endMs - 15_000); t += 1000) {
        const p = seriesAtOrBefore(depSeries, t);
        if (!p?.ask) continue;
        if (low == null || p.ask < low) low = p.ask;
        if (p.ask >= low + bounce && p.ask >= bandMin && p.ask <= bandMax) {
          orders.push({
            side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { deposedAsk: p.ask, low, bounce }, ts: t,
          });
          return orders;
        }
      }
      return orders;
    },
  };
}

/**
 * K — Antiflip bounce + prix plancher : rebond ≥ bounce ET ask ≥ floor.
 * (Le déposé ne doit pas être condamné : ≥ 0.33.)
 */
export function makeAntiflipBounceFloor({ bounce, floor, bandMax, delayMs, maxElapsedFrac }) {
  return {
    id: `K-antiflip-bounce${bounce}-floor${floor}-m${bandMax}`,
    name: `Antiflip bounce+${bounce} floor ${floor}`,
    desc: `Post-flip: rebond ≥${bounce} du plancher, ask ≥${floor} et ≤${bandMax}.`,
    params: { bounce, floor, bandMax, delayMs, maxElapsedFrac },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      let prevFav = null;
      let flipT = null;
      const flipSearchEnd = s.startMs + maxElapsedFrac * (s.endMs - s.startMs);
      for (let t = s.startMs; t < flipSearchEnd; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
        prevFav = fav.side;
      }
      if (flipT == null) return orders;
      const depSeries = prevFav === 0 ? s.up : s.down;
      let low = null;
      for (let t = flipT + delayMs; t < s.endMs - 15_000; t += 1000) {
        const p = seriesAtOrBefore(depSeries, t);
        if (!p?.ask) continue;
        if (low == null || p.ask < low) low = p.ask;
        if (p.ask >= low + bounce && p.ask >= floor && p.ask <= bandMax) {
          orders.push({
            side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { deposedAsk: p.ask, low, bounce }, ts: t,
          });
          return orders;
        }
      }
      return orders;
    },
  };
}

export function buildSweepV3() {
  const variants = [];

  // J — bounce × bandes × délai d'entrée max.
  for (const bounce of [0.03, 0.05, 0.08]) {
    for (const [bandMin, bandMax] of [[0.30, 0.40], [0.30, 0.45], [0.33, 0.48], [0.35, 0.50]]) {
      for (const maxEntryFrac of [0.7, 0.9]) {
        variants.push(makeAntiflipBounce({ bandMin, bandMax, bounce, delayMs: 3000, maxElapsedFrac: 0.6, maxEntryFrac }));
      }
    }
  }

  // K — bounce + floor strict.
  for (const bounce of [0.03, 0.05, 0.08]) {
    for (const floor of [0.33, 0.36, 0.40]) {
      variants.push(makeAntiflipBounceFloor({ bounce, floor, bandMax: 0.52, delayMs: 3000, maxElapsedFrac: 0.6 }));
      variants.push(makeAntiflipBounceFloor({ bounce, floor, bandMax: 0.60, delayMs: 3000, maxElapsedFrac: 0.6 }));
    }
  }

  return variants;
}