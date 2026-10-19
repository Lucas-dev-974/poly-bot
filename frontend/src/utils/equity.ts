import type { SimulatedPosition } from "../types";

/**
 * Série de capital réalisé, reconstruite côté client depuis les positions
 * résolues (DB paginée) + le capital initial du moteur :
 *   courbe(t) = capitalInitial + Σ pnl (par resolvedAt croissant).
 *
 * La liste /api/sim/resolved est plafonnée (page 1, pageSize ≤ 200) — quand
 * elle est tronquée ou incomplète, l'ancre de départ est recalée pour que
 * le DERNIER point de la courbe vaille exactement capitalInitial + P&L
 * réalisé du moteur (Σ disponible), quel que soit le nombre de lignes
 * manquantes. La courbe reste donc cohérente avec les KPI même quand
 * l'historique a été archivé.
 */

export interface EquityPoint {
  /** Timestamp (s) de résolution utilisé pour l'axe (display only). */
  t: number;
  /** Capital réalisé cumulé à ce point. */
  v: number;
}

export interface EquityStats {
  /** Points de la courbe (≥ 2 pour tracer). */
  points: EquityPoint[];
  /** Plus grand creux peak→trough sur la courbe (≥ 0). */
  maxDrawdown: number;
  /** Plus longue série consécutive de gains. */
  bestStreak: number;
  /** Gain moyen des trades gagnants (null si aucun). */
  avgWin: number | null;
  /** Perte moyenne des trades perdants (null si aucun). */
  avgLoss: number | null;
  /** True si la liste source était tronquée (plafond 200). */
  truncated: boolean;
}

const HARD_CAP = 200;

export function buildEquitySeries(
  resolved: readonly SimulatedPosition[],
  capitalInitial: number,
  realizedPnl: number,
): EquityStats {
  const rows = resolved
    .filter((p) => typeof p.pnl === "number" && Number.isFinite(p.pnl))
    .map((p) => ({ t: p.resolvedAt ?? p.windowEnd * 1000, pnl: p.pnl as number }))
    .sort((a, b) => a.t - b.t);
  const truncated = rows.length >= HARD_CAP;

  const sum = rows.reduce((acc, r) => acc + r.pnl, 0);
  // Ancre recalée : dernier point = capitalInitial + P&L réalisé moteur.
  const anchor = capitalInitial + realizedPnl - sum;

  const points: EquityPoint[] = [];
  let v = anchor;
  for (const r of rows) {
    v += r.pnl;
    points.push({ t: r.t, v });
  }

  // Stats dérivées de la courbe.
  let peak = anchor;
  let maxDrawdown = 0;
  for (const p of points) {
    if (p.v > peak) peak = p.v;
    maxDrawdown = Math.max(maxDrawdown, peak - p.v);
  }
  let bestStreak = 0;
  let streak = 0;
  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLoss = 0;
  for (const r of rows) {
    if (r.pnl > 0) {
      streak += 1;
      wins += 1;
      sumWin += r.pnl;
      bestStreak = Math.max(bestStreak, streak);
    } else if (r.pnl < 0) {
      streak = 0;
      losses += 1;
      sumLoss += r.pnl;
    }
  }

  return {
    points,
    maxDrawdown,
    bestStreak,
    avgWin: wins > 0 ? sumWin / wins : null,
    avgLoss: losses > 0 ? sumLoss / losses : null,
    truncated,
  };
}