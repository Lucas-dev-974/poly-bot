// lib/engine-helpers.js — Utilitaires pour le moteur de backtest.

/** Dernier point de la série avec ts ≤ t (série triée asc). */
export function seriesAtOrBefore(series, t) {
  let lo = 0;
  let hi = series.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= t) {
      res = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** Premier point de la série avec ts ≥ t (série triée asc). */
export function seriesAtOrAfter(series, t) {
  let lo = 0;
  let hi = series.length - 1;
  let res = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts >= t) {
      res = series[mid];
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return res;
}

/**
 * Fill d'un ordre MARKET BUY : exécution à l'ask courant du token,
 * taille = min(budget / ask, maxShares), rejetée si < 5 shares.
 */
export function fillMarketBuy(orders, series, t, budget, maxShares) {
  const point = seriesAtOrBefore(series, t);
  if (!point?.ask) return null;
  const raw = budget / point.ask;
  if (raw < 5) return null; // lot minimum CLOB
  const shares = Math.min(Math.floor(raw * 100) / 100, maxShares);
  return { price: point.ask, shares, ts: t };
}

/**
 * Fill d'un ordre LIMIT BUY à P : la première fois où le prix d'exécution
 * (ask) devient ≤ P après le placement, avec assez de liquidité au niveau.
 * Simplification : fill au prix P (maker), taille = budget / P.
 * Si jamais fillé avant la clôture → annulé (pas de coût).
 */
export function fillLimitBuy(series, placedAt, price, budget, maxShares, windowEndMs) {
  // Parcourt les ticks après placement jusqu'à trouver ask ≤ price.
  for (const p of series) {
    if (p.ts < placedAt) continue;
    if (p.ts > windowEndMs - 10_000) break; // pas de fill dans les 10 dernières s
    if (p.ask != null && p.ask <= price) {
      const raw = budget / price;
      if (raw < 5) return null;
      const shares = Math.min(Math.floor(raw * 100) / 100, maxShares);
      return { price, shares, ts: p.ts };
    }
  }
  return null;
}

/**
 * Fill d'un SELL (FOK au bid) : exécution au bid courant du token.
 * Retourne null si pas de bid (pas de sortie).
 */
export function fillSellAtBid(series, t) {
  const point = seriesAtOrBefore(series, t);
  if (!point?.bid) return null;
  return { price: point.bid, ts: t };
}

/**
 * PnL hold-to-resolution pour une position.
 * won = 1 $/share, lost = 0.
 */
export function resolvePnl(position, winnerIndex) {
  const won = position.side === winnerIndex;
  const credit = won ? position.shares : 0;
  return {
    won,
    pnl: round2(credit - position.cost),
  };
}

export function round2(v) {
  return Math.round(v * 100) / 100;
}

export function round4(v) {
  return Math.round(v * 10000) / 10000;
}