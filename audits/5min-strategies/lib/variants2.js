// lib/variants2.js — Variantes v2 : antiflip avec exits TP/SL + momentum
// filtré. Objectif : WR > 55 % avec gain net 1,5-2,5 $ par trade.
//
// Constat v1 (836 fenêtres BTC 5m 2026-09-19/23, budget 4$) :
//   - A-antiflip 0.30-0.40 d5s : WR 50.7%, avg +1.54$/trade (4$), +0.77$ (2$)
//   - B-dogmom 0.30-0.45 g0.10 : WR 43%, avg +0.60$/trade, PnL total 343$
//   - Acheter le favori 0.70-0.82 : WR 74% mais EV ≈ 0 (prix juste)
//
// Hypothèse TP/SL : acheter le déposé post-flip 0.30-0.50, TP quand son ask
// remonte de +20¢ (recovery), SL à −10¢. Le TP capture le rebond (le marché
// over-réagit au flip) et augmente le WR des trades soldés.

import { seriesAtOrBefore } from "./engine-helpers.js";
import { buildSeries, favoriteOf, underdogOf } from "./strategies.js";

/**
 * G1 — Antiflip TP/SL : achète le déposé post-flip, sort en TP quand son ask
 * gagne `tp` (vente au bid), SL si perte `sl`. Hold sinon.
 */
export function makeAntiflipTPSL({ bandMin, bandMax, delayMs, tp, sl, maxElapsedFrac }) {
  return {
    id: `G-antiflip-tp${tp}-sl${sl}-${bandMin}-${bandMax}`,
    name: `Antiflip TP+${tp}/SL-${sl} bande ${bandMin}-${bandMax}`,
    desc: `Déposé post-flip [${bandMin}-${bandMax}], TP si ask +${tp} (sell bid), SL si −${sl}.`,
    params: { bandMin, bandMax, delayMs, tp, sl, maxElapsedFrac },
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
      const tEntry = flipT + delayMs;
      const uE = seriesAtOrBefore(s.up, tEntry);
      const dE = seriesAtOrBefore(s.down, tEntry);
      if (!uE?.ask || !dE?.ask) return orders;
      const deposedAsk = prevFav === 0 ? uE.ask : dE.ask;
      if (deposedAsk < bandMin || deposedAsk > bandMax) return orders;
      orders.push({
        side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
        signal: { deposedAsk }, ts: tEntry,
      });
      // Exit loop : TP/SL sur la série tenue.
      const held = prevFav === 0 ? s.up : s.down;
      const tpTarget = deposedAsk + tp;
      const slTarget = deposedAsk - sl;
      for (let t = tEntry + 2000; t < s.endMs - 10_000; t += 1000) {
        const p = seriesAtOrBefore(held, t);
        if (!p?.ask) continue;
        if (p.ask >= tpTarget) {
          orders.push({ side: prevFav, kind: "sell", price: null, signal: { reason: "TP", heldAsk: p.ask }, ts: t });
          return orders;
        }
        if (p.ask <= slTarget) {
          orders.push({ side: prevFav, kind: "sell", price: null, signal: { reason: "SL", heldAsk: p.ask }, ts: t });
          return orders;
        }
      }
      return orders; // hold to resolution
    },
  };
}

/**
 * G2 — Underdog momentum TP/SL : achète l'underdog en momentum, TP +X¢.
 */
export function makeDogMomentumTPSL({ dogMin, dogMax, gainMin, lookbackMs, tp, sl }) {
  return {
    id: `G-dogmom-tp${tp}-sl${sl}-${dogMin}-${dogMax}-g${gainMin}`,
    name: `Dog-momentum TP+${tp} SL-${sl}`,
    desc: `Underdog ${dogMin}-${dogMax} +${gainMin}¢ en ${lookbackMs / 1000}s. TP ask +${tp}, SL −${sl}.`,
    params: { dogMin, dogMax, gainMin, lookbackMs, tp, sl },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      for (let t = s.startMs + 60_000; t < s.endMs - 30_000; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const dog = underdogOf(u, d);
        if (dog.dogAsk < dogMin || dog.dogAsk > dogMax) continue;
        const dogSeries = dog.side === 0 ? s.up : s.down;
        const past = seriesAtOrBefore(dogSeries, t - lookbackMs);
        if (!past?.ask) continue;
        if (past.ask - dog.dogAsk >= gainMin) {
          orders.push({
            side: dog.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { dogAsk: dog.dogAsk, gain: past.ask - dog.dogAsk }, ts: t,
          });
          const tpTarget = dog.dogAsk + tp;
          const slTarget = dog.dogAsk - sl;
          for (let te = t + 2000; te < s.endMs - 10_000; te += 1000) {
            const p = seriesAtOrBefore(dogSeries, te);
            if (!p?.ask) continue;
            if (p.ask >= tpTarget) {
              orders.push({ side: dog.side, kind: "sell", price: null, signal: { reason: "TP", heldAsk: p.ask }, ts: te });
              return orders;
            }
            if (p.ask <= slTarget) {
              orders.push({ side: dog.side, kind: "sell", price: null, signal: { reason: "SL", heldAsk: p.ask }, ts: te });
              return orders;
            }
          }
          return orders; // hold
        }
      }
      return orders;
    },
  };
}

/**
 * H — Antiflip "qualité" : exige un flip NET (le déposé décote de ≥ 12¢
 * après le flip) et un déposé encore ≥ 0.33 (pas un rejet total).
 */
export function makeAntiflipSharp({ bandMin, bandMax, dropMin, delayMs, maxElapsedFrac }) {
  return {
    id: `H-antiflip-sharp-d${dropMin}-${bandMin}-${bandMax}`,
    name: `Antiflip sharp drop≥${dropMin} [${bandMin}-${bandMax}]`,
    desc: `Post-flip: déposé décote ≥${dropMin}¢ du sommet, bande [${bandMin}-${bandMax}].`,
    params: { bandMin, bandMax, dropMin, delayMs, maxElapsedFrac },
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
      // Sommet du déposé avant le flip (5 s avant).
      const depSeries = prevFav === 0 ? s.up : s.down;
      const peak = seriesAtOrBefore(depSeries, flipT - 3000);
      const tEntry = flipT + delayMs;
      const uE = seriesAtOrBefore(s.up, tEntry);
      const dE = seriesAtOrBefore(s.down, tEntry);
      if (!uE?.ask || !dE?.ask) return orders;
      const deposedAsk = prevFav === 0 ? uE.ask : dE.ask;
      const drop = (peak?.ask ?? 1) - deposedAsk;
      if (deposedAsk < bandMin || deposedAsk > bandMax) return orders;
      if (drop < dropMin) return orders;
      orders.push({
        side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
        signal: { deposedAsk, drop }, ts: tEntry,
      });
      return orders;
    },
  };
}

/**
 * I — Late flip-ride : flip tardif (entre 45% et 75% de la fenêtre), achète
 * le déposé 0.33-0.48. Les flips précoces sont bruit, les tardifs sont des
 * vrais retournements — et il reste assez de temps pour un re-winner.
 */
export function makeLateAntiflip({ bandMin, bandMax, fracMin, fracMax, delayMs }) {
  return {
    id: `I-lateflip-${fracMin}-${fracMax}-${bandMin}-${bandMax}`,
    name: `Antiflip tardif (flip à ${Math.round(fracMin * 100)}-${Math.round(fracMax * 100)}%)`,
    desc: `Flip entre ${Math.round(fracMin * 100)}% et ${Math.round(fracMax * 100)}% de la fenêtre, déposé [${bandMin}-${bandMax}].`,
    params: { bandMin, bandMax, fracMin, fracMax, delayMs },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      let prevFav = null;
      let flipT = null;
      const windowMs = s.endMs - s.startMs;
      const searchStart = s.startMs + fracMin * windowMs;
      const searchEnd = s.startMs + fracMax * windowMs;
      // Le "leader avant le flip" doit être suivi dès le début de fenêtre :
      // on re-derive le favori d'avant-flip en regardant juste avant searchStart.
      let prevFavAtStart = null;
      const pre = seriesAtOrBefore(s.up, searchStart - 1000);
      const preD = seriesAtOrBefore(s.down, searchStart - 1000);
      if (pre?.ask && preD?.ask) prevFavAtStart = favoriteOf(pre, preD).side;
      for (let t = searchStart; t < searchEnd; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        if (prevFavAtStart !== null && fav.side !== prevFavAtStart) { flipT = t; break; }
      }
      if (flipT == null) return orders;
      const tEntry = flipT + delayMs;
      const uE = seriesAtOrBefore(s.up, tEntry);
      const dE = seriesAtOrBefore(s.down, tEntry);
      if (!uE?.ask || !dE?.ask) return orders;
      const deposedAsk = prevFavAtStart === 0 ? uE.ask : dE.ask;
      if (deposedAsk < bandMin || deposedAsk > bandMax) return orders;
      orders.push({
        side: prevFavAtStart, kind: "market", budgetUsdc: ctx.budgetPerTrade,
        signal: { deposedAsk, flipAtFrac: (flipT - s.startMs) / windowMs }, ts: tEntry,
      });
      return orders;
    },
  };
}

export function buildSweepV2() {
  const variants = [];

  // G1 — Antiflip TP/SL : bandes × TP × SL.
  for (const [bandMin, bandMax] of [[0.30, 0.40], [0.30, 0.45], [0.35, 0.50], [0.30, 0.50]]) {
    for (const tp of [0.15, 0.20, 0.25, 0.30]) {
      for (const sl of [0.08, 0.10, 0.15]) {
        variants.push(makeAntiflipTPSL({ bandMin, bandMax, delayMs: 5000, tp, sl, maxElapsedFrac: 0.6 }));
      }
    }
  }

  // G2 — Dog-momentum TP/SL.
  for (const [dogMin, dogMax] of [[0.25, 0.40], [0.30, 0.45]]) {
    for (const gainMin of [0.08, 0.10]) {
      for (const tp of [0.15, 0.20, 0.25]) {
        for (const sl of [0.08, 0.10]) {
          variants.push(makeDogMomentumTPSL({ dogMin, dogMax, gainMin, lookbackMs: 60_000, tp, sl }));
        }
      }
    }
  }

  // H — Antiflip sharp.
  for (const [bandMin, bandMax] of [[0.30, 0.40], [0.30, 0.45], [0.35, 0.50]]) {
    for (const dropMin of [0.12, 0.18, 0.25]) {
      variants.push(makeAntiflipSharp({ bandMin, bandMax, dropMin, delayMs: 5000, maxElapsedFrac: 0.6 }));
    }
  }

  // I — Late antiflip.
  for (const [fracMin, fracMax] of [[0.4, 0.75], [0.45, 0.8], [0.3, 0.6]]) {
    for (const [bandMin, bandMax] of [[0.30, 0.40], [0.30, 0.45], [0.33, 0.48], [0.35, 0.50]]) {
      variants.push(makeLateAntiflip({ bandMin, bandMax, fracMin, fracMax, delayMs: 5000 }));
    }
  }

  return variants;
}