// lib/variants.js — Variantes paramétrées des stratégies pour le sweep.
// Chaque variante est générée par une factory avec des paramètres serrés,
// puis backtestée par 03-sweep.mjs pour trouver les optima.
//
// Contexte de contrainte (constaté en backtest) :
//   - CLOB : 5 shares minimum par ordre → ticket 1-2 $ ⇒ prix d'entrée ≤ 0.40
//   - Acheter le favori 0.60-0.80 exige 3-5 $ (5 shares)
//   - Gains : à 0.30, 2 $ = 6.67 shares → payout 6.67 $ (+4.67 $, 1:3.3)
//            à 0.40, 2 $ = 5 shares → payout 5 $ (+3 $, 1:1.5)

import { seriesAtOrBefore } from "./engine-helpers.js";
import { buildSeries, favoriteOf, underdogOf } from "./strategies.js";

// ---------------------------------------------------------------------------
// Famille A — ANTIFLIP (achète l'ancien favori après un flip) : la base la
// plus rentable. Sweep sur la bande de prix et le délai post-flip.
// ---------------------------------------------------------------------------

/** Fabrique une variante antiflip. */
export function makeAntiflip({ bandMin, bandMax, flipMaxAgeSec, delayMs, maxElapsedFrac }) {
  return {
    id: `A-antiflip-${bandMin}-${bandMax}-d${delayMs / 1000}s-w${maxElapsedFrac}`,
    name: `Antiflip ${bandMin}-${bandMax} +${delayMs / 1000}s`,
    desc: `Après flip: achète l'ancien favori [${bandMin}-${bandMax}], délai ${delayMs / 1000}s.`,
    params: { bandMin, bandMax, flipMaxAgeSec, delayMs, maxElapsedFrac: maxElapsedFrac },
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
      const u = seriesAtOrBefore(s.up, tEntry);
      const d = seriesAtOrBefore(s.down, tEntry);
      if (!u?.ask || !d?.ask) return orders;
      const deposedAsk = prevFav === 0 ? u.ask : d.ask;
      if (deposedAsk >= bandMin && deposedAsk <= bandMax) {
        orders.push({
          side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { deposedAsk, flipAgeSec: (tEntry - flipT) / 1000 }, ts: tEntry,
        });
      }
      return orders;
    },
  };
}

// ---------------------------------------------------------------------------
// Famille B — UNDERDOG MOMENTUM (2e base rentable). Sweep sur le gain
// requis, la bande de prix et l'instant d'entrée.
// ---------------------------------------------------------------------------

export function makeUnderdogMomentum({ dogMin, dogMax, gainMin, lookbackMs, startSec, endSecFromClose }) {
  return {
    id: `B-dogmom-${dogMin}-${dogMax}-g${gainMin}-l${lookbackMs}`,
    name: `Underdog momentum ${dogMin}-${dogMax} gain≥${gainMin}`,
    desc: `Underdog +${gainMin}¢ en ${lookbackMs / 1000}s, ask ${dogMin}-${dogMax}.`,
    params: { dogMin, dogMax, gainMin, lookbackMs, startSec, endSecFromClose },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      for (let t = s.startMs + startSec * 1000; t < s.endMs - endSecFromClose * 1000; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const dog = underdogOf(u, d);
        if (dog.dogAsk < dogMin || dog.dogAsk > dogMax) continue;
        const dogSeries = dog.side === 0 ? s.up : s.down;
        const past = seriesAtOrBefore(dogSeries, t - lookbackMs);
        if (!past?.ask) continue;
        const gain = past.ask - dog.dogAsk;
        if (gain >= gainMin) {
          orders.push({
            side: dog.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { dogAsk: dog.dogAsk, gain }, ts: t,
          });
          break;
        }
      }
      return orders;
    },
  };
}

// ---------------------------------------------------------------------------
// Famille C — FAV-BAND (favori ask élevé). Rentable seulement si le prix est
// sous la probabilité réelle (edge). Sweep sur la bande + écart minimum.
// ---------------------------------------------------------------------------

export function makeFavBand({ favMin, favMax, minSpread, startSec, maxElapsedSec }) {
  return {
    id: `C-favband-${favMin}-${favMax}-sp${minSpread}-t${startSec}`,
    name: `Fav-band ${favMin}-${favMax} écart≥${minSpread}`,
    desc: `Favori ask ${favMin}-${favMax}, écart ≥${minSpread}¢, après ${startSec}s.`,
    params: { favMin, favMax, minSpread, startSec, maxElapsedSec },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      const tEnd = maxElapsedSec != null ? s.startMs + maxElapsedSec * 1000 : s.endMs - 20_000;
      for (let t = s.startMs + startSec * 1000; t < tEnd; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        const spread = fav.favAsk - fav.dogAsk;
        if (fav.favAsk >= favMin && fav.favAsk <= favMax && spread >= minSpread) {
          orders.push({
            side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { favAsk: fav.favAsk, spread }, ts: t,
          });
          break;
        }
      }
      return orders;
    },
  };
}

// ---------------------------------------------------------------------------
// Famille D — UNDERDOG LIMIT maker (fill sur crash du favori).
// ---------------------------------------------------------------------------

export function makeUnderdogLimit({ price, placeSec }) {
  return {
    id: `D-doglimit-${price}-t${placeSec}`,
    name: `Underdog limit ${price} (t+${placeSec}s)`,
    desc: `Limit BUY ${price} sur l'underdog (placé t+${placeSec}s). Payout 1:${(1 / price - 1).toFixed(1)}.`,
    params: { price, placeSec },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const t = s.startMs + placeSec * 1000;
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) return [];
      const dog = underdogOf(u, d);
      return [{
        side: dog.side, kind: "limit", price, budgetUsdc: ctx.budgetPerTrade,
        signal: { placedAtSec: placeSec }, ts: t,
      }];
    },
  };
}

// ---------------------------------------------------------------------------
// Famille E — FAVORI LIMIT maker (fill sur retracement du favori).
// ---------------------------------------------------------------------------

export function makeFavLimit({ price, placeSec }) {
  return {
    id: `E-favlimit-${price}-t${placeSec}s`,
    name: `Favori limit ${price} (t+${placeSec}s)`,
    desc: `Limit BUY ${price} sur le favori (placé t+${placeSec}s).`,
    params: { price, placeSec },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const t = s.startMs + placeSec * 1000;
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask && !d?.ask) return [];
      const fav = favoriteOf(u, d);
      return [{
        side: fav.side, kind: "limit", price, budgetUsdc: ctx.budgetPerTrade,
        signal: { placedAtSec: placeSec }, ts: t,
      }];
    },
  };
}

// ---------------------------------------------------------------------------
// Famille F — DIP-REVERT favori (achat du favori après sa décote).
// ---------------------------------------------------------------------------

export function makeDipRevert({ favMin, favMax, dropMin, lookbackMs, startSec }) {
  return {
    id: `F-diprev-${favMin}-${favMax}-d${dropMin}-l${lookbackMs}`,
    name: `Dip-revert favori ${favMin}-${favMax} drop≥${dropMin}`,
    desc: `Favori décote ${dropMin}¢ en ${lookbackMs / 1000}s puis racheté ${favMin}-${favMax}.`,
    params: { favMin, favMax, dropMin, lookbackMs, startSec },
    evaluate(win, ctx) {
      const s = buildSeries(win);
      const orders = [];
      for (let t = s.startMs + startSec * 1000; t < s.endMs - 30_000; t += 1000) {
        const u = seriesAtOrBefore(s.up, t);
        const d = seriesAtOrBefore(s.down, t);
        if (!u?.ask || !d?.ask) continue;
        const fav = favoriteOf(u, d);
        if (fav.favAsk < favMin || fav.favAsk > favMax) continue;
        const favSeries = fav.side === 0 ? s.up : s.down;
        const past = seriesAtOrBefore(favSeries, t - lookbackMs);
        if (!past?.ask) continue;
        if (past.ask - fav.favAsk >= dropMin) {
          orders.push({
            side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { favAsk: fav.favAsk, drop: past.ask - fav.favAsk }, ts: t,
          });
          break;
        }
      }
      return orders;
    },
  };
}

// ---------------------------------------------------------------------------
// Génération de la grille de variants à tester.
// ---------------------------------------------------------------------------

export function buildSweep() {
  const variants = [];

  // A — Antiflip : bandes de prix, délai post-flip, fenêtre de flip.
  for (const [bandMin, bandMax] of [[0.30, 0.45], [0.30, 0.50], [0.35, 0.50], [0.35, 0.55], [0.40, 0.55], [0.30, 0.40]]) {
    for (const delayMs of [0, 5000, 10000]) {
      for (const maxElapsedFrac of [0.6, 1.0]) {
        variants.push(makeAntiflip({ bandMin, bandMax, flipMaxAgeSec: 999, delayMs, maxElapsedFrac }));
      }
    }
  }

  // B — Underdog momentum : bandes + gain requis.
  for (const [dogMin, dogMax] of [[0.25, 0.40], [0.30, 0.45], [0.35, 0.50], [0.25, 0.45]]) {
    for (const gainMin of [0.06, 0.08, 0.10, 0.12]) {
      for (const lookbackMs of [45_000, 60_000, 90_000]) {
        variants.push(makeUnderdogMomentum({ dogMin, dogMax, gainMin, lookbackMs, startSec: 60, endSecFromClose: 30 }));
      }
    }
  }

  // C — Fav-band : bandes calibrées sur la courbe de calibration.
  for (const [favMin, favMax] of [[0.55, 0.70], [0.60, 0.75], [0.55, 0.80], [0.65, 0.80], [0.52, 0.65], [0.70, 0.82]]) {
    for (const minSpread of [0.10, 0.15, 0.20]) {
      for (const startSec of [45, 60, 90]) {
        variants.push(makeFavBand({ favMin, favMax, minSpread, startSec, maxElapsedSec: null }));
      }
    }
  }

  // D — Underdog limit : prix + instant.
  for (const price of [0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25]) {
    for (const placeSec of [30, 60, 120]) {
      variants.push(makeUnderdogLimit({ price, placeSec }));
    }
  }

  // E — Favori limit : prix + instant.
  for (const price of [0.60, 0.65, 0.70, 0.75, 0.80]) {
    for (const placeSec of [30, 60]) {
      variants.push(makeFavLimit({ price, placeSec }));
    }
  }

  // F — Dip-revert favori.
  for (const [favMin, favMax] of [[0.55, 0.70], [0.60, 0.75], [0.55, 0.65]]) {
    for (const dropMin of [0.06, 0.08, 0.10]) {
      for (const lookbackMs of [30_000, 60_000]) {
        variants.push(makeDipRevert({ favMin, favMax, dropMin, lookbackMs, startSec: 60 }));
      }
    }
  }

  return variants;
}