import type { SimulatedPosition } from "../types.js";

/** Inputs for the fav-band whipsaw score (0-100). */
export type WhipsawScoreInput = {
  intraFlips: number;
  askRange: number | null;
  priorWinnerFlipRate: number;
  lossStreak: number;
};

/**
 * Heuristic score used in the 2026-09-20 BTC 15m research:
 * intra-window favorite flips + favorite ask range + prior window
 * winner flip rate + consecutive fav-band losses.
 */
export function computeWhipsawScore(input: WhipsawScoreInput): number {
  let s = 0;
  const flips = input.intraFlips;
  if (flips >= 4) s += 35;
  else if (flips >= 2) s += 22;
  else if (flips === 1) s += 10;

  const range = input.askRange;
  if (range != null) {
    if (range >= 0.2) s += 25;
    else if (range >= 0.12) s += 15;
    else if (range >= 0.08) s += 7;
  }

  const rate = input.priorWinnerFlipRate;
  if (rate >= 0.8) s += 20;
  else if (rate >= 0.6) s += 12;
  else if (rate >= 0.4) s += 6;

  const streak = input.lossStreak;
  if (streak >= 5) s += 20;
  else if (streak >= 3) s += 12;
  else if (streak >= 2) s += 5;

  return Math.min(100, s);
}

/** Consecutive fav-band losses at the end of resolved history (newest first). */
export function favBandLossStreak(
  resolved: readonly SimulatedPosition[],
): number {
  const fav = resolved
    .filter((p) => p.strategyId === "fav-band")
    .slice()
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  let streak = 0;
  for (const p of fav) {
    const lost = p.status === "lost" || (p.pnl != null && p.pnl < 0);
    if (lost) streak++;
    else break;
  }
  return streak;
}

/** Winner-index flip rate over the last N resolved windows (chronological). */
export function priorWinnerFlipRate(
  winnersOldestFirst: readonly number[],
): number {
  if (winnersOldestFirst.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < winnersOldestFirst.length; i++) {
    if (winnersOldestFirst[i] !== winnersOldestFirst[i - 1]) flips++;
  }
  return flips / (winnersOldestFirst.length - 1);
}