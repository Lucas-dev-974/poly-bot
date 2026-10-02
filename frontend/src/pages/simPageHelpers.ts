/** Pure display helpers for SimulationPage (extracted, no behavior change). */

export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-pos";
  if (pnl < 0) return "pnl-neg";
  return "";
}

/** Classe du countdown selon l'urgence (miroir des seuils ActiveMarkets). */
export function countdownClass(windowEnd: number, now: number): string {
  const left = windowEnd * 1000 - now;
  if (left <= 5 * 60 * 1000) return "am-countdown--hot";
  if (left <= 15 * 60 * 1000) return "am-countdown--warm";
  return "";
}
