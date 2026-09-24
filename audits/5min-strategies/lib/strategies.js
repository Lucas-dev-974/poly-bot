// lib/strategies.js — Bibliothèque de stratégies pour BTC Up/Down 5min.
//
// SÉMANTIQUE DES PRIX (calibrée sur données 2026-09-19/23) :
//   - FAVORI  = token au ask le plus ÉLEVÉ (0.90 = 90% de chances de gagner)
//   - UNDERDOG = token au ask le plus BAS (0.10 = 10%)
//   - askUp + askDown ≈ 1.00 (les 2 tokens sont complémentaires)
//
// Ordres émis :
//   - { kind:"market", side, budgetUsdc, ts }  → achat à l'ask courant
//   - { kind:"limit",  side, price, budgetUsdc, ts } → maker, fillé si l'ask
//     descend au niveau (BUY limit à P : fill au 1er tick ask ≤ P)
//   - { kind:"sell",   side, price:null, ts } → vente FOK au bid courant
//
// Contraintes capital : ticket 1-2 $ (max ~4 $) → ≥5 shares CLOB →
// entrée ≤ 0.40 OU maker sur sous-cote. Gain cible 1.50-2.50 $/trade.
//
// NOTE : ticks en millisecondes ; win.startTs/endTs en secondes.

import { seriesAtOrBefore } from "./engine-helpers.js";

/** Construit les séries (ts, bid, ask, price...) par token. ts en millisecondes. */
export function buildSeries(win) {
  const mk = (rows) => rows.map((r) => ({
    ts: r.ts,
    bid: r.bid ?? null,
    ask: r.ask ?? null,
    price: r.price ?? null,
    size: r.size ?? null,
    tradeSide: r.tradeSide ?? null,
  }));
  return {
    up: mk(win.ticksUp),
    down: mk(win.ticksDown),
    startMs: win.startTs * 1000,
    endMs: win.endTs * 1000,
    winnerIndex: win.winnerIndex,
    slug: win.slug,
  };
}

/** FAVORI = ask le plus ÉLEVÉ. @returns {side, favAsk, dogAsk} */
export function favoriteOf(u, d) {
  const fav = (u?.ask ?? 0) >= (d?.ask ?? 0) ? 0 : 1;
  return {
    side: fav,
    favAsk: fav === 0 ? u?.ask : d?.ask,
    dogAsk: fav === 0 ? d?.ask : u?.ask,
  };
}

/**UNDERDOG = ask le plus BAS. */
export function underdogOf(u, d) {
  const f = favoriteOf(u, d);
  return { side: 1 - f.side, dogAsk: f.dogAsk, favAsk: f.favAsk };
}

// ---------------------------------------------------------------------------
// Stratégies — signature : (win, ctx) => orders[]
// ctx = { budgetPerTrade, rng }
// ---------------------------------------------------------------------------

/**
 * S1 — Fav-band mid : achète le favori quand son ask est 0.60-0.80 avec un
 * écart de cote clair (favori − underdog ≥ 15¢), après 60s. Hold.
 * Calibration (t≥20%): 0.60→59%, 0.70→68%, 0.75→73% → EV positif sur la bande.
 */
export const s1FavBand = {
  id: "S1-fav-band-60-80",
  name: "Fav-band 0.60-0.80",
  desc: "Achète le favori (ask max) 0.60-0.80, écart ≥15¢, après 60s. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs + 60_000; t < s.endMs - 20_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      const spread = fav.favAsk - fav.dogAsk;
      if (fav.favAsk >= 0.60 && fav.favAsk <= 0.80 && spread >= 0.15) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk, spread }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S2 — Early lock : le favori cote déjà ≥0.82 dans les 90 premières secondes.
 * Calibration t=20% : 0.85→87%, 0.90→85% → pour 2$ à 0.85 : ~2.35 shares,
 * payout ~2.35$ → +0.35$ si win (1:1.18). Winrate ~86% → EV +0.30$/trade.
 */
export const s2EarlyLock = {
  id: "S2-early-lock",
  name: "Early lock ≥0.82",
  desc: "Favori ask ≥0.82 (≤0.92) dans les 90 premières s. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs; t < s.startMs + 90_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (fav.favAsk >= 0.82 && fav.favAsk <= 0.92) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S3 — Dip-revert : le favori décote (drop ≥8¢ en ≤20s) → achat du favori
 * réduit 0.55-0.75 après 60s. Pari mean-reversion sur le favori.
 */
export const s3DipRevert = {
  id: "S3-dip-revert",
  name: "Dip-revert favori",
  desc: "Favori décote après spike adverse (drop ≥8¢ en 20s), ask 0.55-0.75. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs + 60_000; t < s.endMs - 30_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (fav.favAsk < 0.55 || fav.favAsk > 0.75) continue;
      const favSeries = fav.side === 0 ? s.up : s.down;
      const past = seriesAtOrBefore(favSeries, t - 20_000);
      if (!past?.ask) continue;
      const drop = past.ask - fav.favAsk;
      if (drop >= 0.08) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk, drop }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S4 — Antiflip : après un flip d'identité, achète le DÉPOSÉ (ancien favori)
 * à prix réduit [0.35, 0.55]. Empirique 15m : le marché sur-réagit au flip.
 */
export const s4Antiflip = {
  id: "S4-antiflip",
  name: "Antiflip (ancien favori)",
  desc: "Après un flip, achète l'ancien favori si ask 0.35-0.55. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    let prevFav = null;
    let flipT = null;
    for (let t = s.startMs; t < s.endMs - 60_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
      prevFav = fav.side;
    }
    if (flipT == null) return orders;
    const tEntry = flipT + 5_000;
    const u = seriesAtOrBefore(s.up, tEntry);
    const d = seriesAtOrBefore(s.down, tEntry);
    if (!u?.ask || !d?.ask) return orders;
    const deposedAsk = prevFav === 0 ? u.ask : d.ask;
    if (deposedAsk >= 0.35 && deposedAsk <= 0.55) {
      orders.push({
        side: prevFav, kind: "market", budgetUsdc: ctx.budgetPerTrade,
        signal: { elapsed: (tEntry - s.startMs) / 1000, deposedAsk, flipAgeSec: (tEntry - flipT) / 1000 }, ts: tEntry,
      });
    }
    return orders;
  },
};

/**
 * S5 — Flip-confirm : après un flip précoce (≤150s), achète le NOUVEAU favori
 * à 0.55-0.70.
 */
export const s5FlipConfirm = {
  id: "S5-flip-confirm",
  name: "Flip-confirm (nouveau favori)",
  desc: "Flip avant 150s → achète le nouveau favori si ask 0.55-0.70. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    let prevFav = null;
    let flipT = null;
    for (let t = s.startMs; t < s.startMs + 150_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
      prevFav = fav.side;
    }
    if (flipT == null) return orders;
    const tEntry = flipT + 5_000;
    const u = seriesAtOrBefore(s.up, tEntry);
    const d = seriesAtOrBefore(s.down, tEntry);
    if (!u?.ask || !d?.ask) return orders;
    const fav = favoriteOf(u, d);
    if (fav.favAsk >= 0.55 && fav.favAsk <= 0.70) {
      orders.push({
        side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
        signal: { elapsed: (tEntry - s.startMs) / 1000, favAsk: fav.favAsk, flipAgeSec: (tEntry - flipT) / 1000 }, ts: tEntry,
      });
    }
    return orders;
  },
};

/**
 * S6 — Grille maker underdog à 0.10 : ordre limit placé à t+60s sur
 * l'underdog, fillé si le prix descend à ≤0.10 (crash du favori). Payout 1:9.
 */
export const s6UnderdogGrid = {
  id: "S6-underdog-grid-10",
  name: "Grille maker underdog 0.10",
  desc: "Limit BUY 0.10 sur l'underdog (t+60s). Payout 1:9 si gagnant.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const t = s.startMs + 60_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) return orders;
    const dog = underdogOf(u, d);
    orders.push({
      side: dog.side, kind: "limit", price: 0.10, budgetUsdc: ctx.budgetPerTrade,
      signal: { placedAtSec: 60 }, ts: t,
    });
    return orders;
  },
};

/** S6b — Grille maker underdog 0.20 : fill rate plus élevé, payout 1:4. */
export const s6bUnderdogGrid20 = {
  id: "S6b-underdog-grid-20",
  name: "Grille maker underdog 0.20",
  desc: "Limit BUY 0.20 sur l'underdog (t+60s). Payout 1:4 si gagnant.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const t = s.startMs + 60_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) return orders;
    const dog = underdogOf(u, d);
    orders.push({
      side: dog.side, kind: "limit", price: 0.20, budgetUsdc: ctx.budgetPerTrade,
      signal: { placedAtSec: 60 }, ts: t,
    });
    return orders;
  },
};

/**
 * S7 — Late lock : favori ≥0.88-0.95 après 120s. Ticket 10$ (référence,
 * hors contrainte 1-2$). Calibration : 0.90→88-96% selon l'instant.
 */
export const s7LateLock = {
  id: "S7-late-lock",
  name: "Late lock ≥0.90 (référence)",
  desc: "Favori ask 0.88-0.95 après 120s. Ticket 10$ (référence).",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs + 120_000; t < s.endMs - 20_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (fav.favAsk >= 0.88 && fav.favAsk <= 0.95) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: 10,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S8 — Breakout : le favori a oscillé sous 0.68 puis casse vers le haut
 * 0.70-0.78. Entrée sur la casse.
 */
export const s8Breakout = {
  id: "S8-breakout",
  name: "Breakout du range",
  desc: "Favori casse 0.70 après un range ≤0.68. Entry ask 0.70-0.78. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const seen = new Map();
    for (let t = s.startMs + 30_000; t < s.endMs - 20_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      const hist = seen.get(fav.side) ?? { max: fav.favAsk };
      hist.max = Math.max(hist.max, fav.favAsk);
      seen.set(fav.side, hist);
      if (hist.max <= 0.68 && fav.favAsk >= 0.70 && fav.favAsk <= 0.78) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk, rangeMax: hist.max }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S9 — Underdog momentum : l'underdog gagne ≥8¢ en 60s (le favori décote),
 * ask underdog 0.30-0.45. Pari retournement en cours.
 */
export const s9UnderdogMomentum = {
  id: "S9-underdog-momentum",
  name: "Underdog momentum",
  desc: "Underdog gagne ≥8¢ en 60s, ask 0.30-0.45. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs + 90_000; t < s.endMs - 30_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const dog = underdogOf(u, d);
      if (dog.dogAsk < 0.30 || dog.dogAsk > 0.45) continue;
      const dogSeries = dog.side === 0 ? s.up : s.down;
      const past = seriesAtOrBefore(dogSeries, t - 60_000);
      if (!past?.ask) continue;
      const gain = past.ask - dog.dogAsk;
      if (gain >= 0.08) {
        orders.push({
          side: dog.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, dogAsk: dog.dogAsk, gain }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S10 — Maker limit favori 0.75 : fill si le favori re-teste 0.75 (retracement).
 * Coût 3.75$ pour 5 shares, payout 5$ (+1.25$). Fill ~quand le favori baisse.
 */
export const s10MakerFav75 = {
  id: "S10-maker-fav-75",
  name: "Maker limit favori 0.75",
  desc: "Limit BUY 0.75 sur le favori (t+30s). Fill = dip du favori au niveau.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const t = s.startMs + 30_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask && !d?.ask) return orders;
    const fav = favoriteOf(u, d);
    orders.push({
      side: fav.side, kind: "limit", price: 0.75, budgetUsdc: ctx.budgetPerTrade,
      signal: { placedAtSec: 30 }, ts: t,
    });
    return orders;
  },
};

/** S11 — Maker limit favori 0.65 : plus profond, payout 1:1.54. */
export const s11MakerFav65 = {
  id: "S11-maker-fav-65",
  name: "Maker limit favori 0.65",
  desc: "Limit BUY 0.65 sur le favori (t+30s). Payout 1:1.54.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const t = s.startMs + 30_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask && !d?.ask) return orders;
    const fav = favoriteOf(u, d);
    orders.push({
      side: fav.side, kind: "limit", price: 0.65, budgetUsdc: ctx.budgetPerTrade,
      signal: { placedAtSec: 30 }, ts: t,
    });
    return orders;
  },
};

/** S12 — Double maker 0.70 : limit BUY 0.70 sur Up ET Down (budget split). */
export const s12DoubleMaker70 = {
  id: "S12-double-maker-70",
  name: "Double maker 0.70 Up+Down",
  desc: "Limit BUY 0.70 sur les 2 tokens (budget split). Payout 1:1.43 par fill.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    const t = s.startMs + 30_000;
    orders.push({ side: 0, kind: "limit", price: 0.70, budgetUsdc: ctx.budgetPerTrade / 2, signal: { placedAtSec: 30 }, ts: t });
    orders.push({ side: 1, kind: "limit", price: 0.70, budgetUsdc: ctx.budgetPerTrade / 2, signal: { placedAtSec: 30 }, ts: t });
    return orders;
  },
};

/**
 * S13 — Open blowout : le favori cote ≥0.70 dès les 30 premières secondes
 * (ouverture à sens unique). Calibration t=20% : 0.70→68%, 0.75→73%.
 */
export const s13OpenBlowout = {
  id: "S13-open-blowout",
  name: "Open blowout",
  desc: "Favori ask 0.70-0.80 dans les 30 premières s. Hold.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    for (let t = s.startMs; t < s.startMs + 30_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (fav.favAsk >= 0.70 && fav.favAsk <= 0.80) {
        orders.push({
          side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
          signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk }, ts: t,
        });
        break;
      }
    }
    return orders;
  },
};

/**
 * S14 — Sniper T-60s : à T-60s, favori ask ≥0.90 → quasi-certain.
 * Ticket 10$ (référence). Calibration t=90% : 0.90→96%, 0.95→87%.
 */
export const s14Sniper60 = {
  id: "S14-sniper-60s",
  name: "Sniper T-60s ≥0.90",
  desc: "À T-60s, achète le favori si ask ≥0.90. Ticket 10$ (référence).",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const t = s.endMs - 60_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) return [];
    const fav = favoriteOf(u, d);
    if (fav.favAsk < 0.90 || fav.favAsk >= 0.999) return [];
    return [{ side: fav.side, kind: "market", budgetUsdc: 10, signal: { favAsk: fav.favAsk }, ts: t }];
  },
};

/**
 * S15 — Sniper T-45s : à T-45s, favori ask ≥0.88. Ticket 5$ (référence).
 */
export const s15Sniper45 = {
  id: "S15-sniper-45s",
  name: "Sniper T-45s ≥0.88",
  desc: "À T-45s, achète le favori si ask ≥0.88. Ticket 5$ (référence).",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const t = s.endMs - 45_000;
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) return [];
    const fav = favoriteOf(u, d);
    if (fav.favAsk < 0.88 || fav.favAsk >= 0.999) return [];
    return [{ side: fav.side, kind: "market", budgetUsdc: 5, signal: { favAsk: fav.favAsk }, ts: t }];
  },
};

/**
 * S16 — Momentum + stop-loss : comme S1 mais vend au bid si le favori perd 10¢.
 * Réduit la perte moyenne mais brise le hold-to-resolution.
 */
export const s16MomentumSL = {
  id: "S16-momentum-SL",
  name: "Fav-band + stop-loss -10¢",
  desc: "Comme S1 + SL : vend au bid si l'ask tenu descend de 10¢ sous l'entrée.",
  evaluate(win, ctx) {
    const s = buildSeries(win);
    const orders = [];
    let entry = null;
    for (let t = s.startMs + 60_000; t < s.endMs - 20_000; t += 1000) {
      const u = seriesAtOrBefore(s.up, t);
      const d = seriesAtOrBefore(s.down, t);
      if (!u?.ask || !d?.ask) continue;
      const fav = favoriteOf(u, d);
      if (!entry && fav.favAsk >= 0.60 && fav.favAsk <= 0.80) {
        const spread = fav.favAsk - fav.dogAsk;
        if (spread >= 0.15) {
          entry = { side: fav.side, entryAsk: fav.favAsk };
          orders.push({
            side: fav.side, kind: "market", budgetUsdc: ctx.budgetPerTrade,
            signal: { elapsed: (t - s.startMs) / 1000, favAsk: fav.favAsk, spread }, ts: t,
          });
        }
        continue;
      }
      if (entry) {
        const favSeries = entry.side === 0 ? s.up : s.down;
        const held = seriesAtOrBefore(favSeries, t);
        if (held?.ask != null && held.ask <= entry.entryAsk - 0.10) {
          orders.push({
            side: entry.side, kind: "sell", price: null,
            signal: { reason: "SL", heldAsk: held.ask }, ts: t,
          });
          entry = null;
        }
      }
    }
    return orders;
  },
};

export const ALL_STRATEGIES = [
  s1FavBand, s2EarlyLock, s3DipRevert, s4Antiflip, s5FlipConfirm,
  s6UnderdogGrid, s6bUnderdogGrid20, s7LateLock, s8Breakout, s9UnderdogMomentum,
  s10MakerFav75, s11MakerFav65, s12DoubleMaker70, s13OpenBlowout,
  s14Sniper60, s15Sniper45, s16MomentumSL,
];