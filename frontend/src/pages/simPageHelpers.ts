/** Pure display helpers for SimulationPage (extracted, no behavior change). */

export { countdownClass } from "../utils/market";

export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-pos";
  if (pnl < 0) return "pnl-neg";
  return "";
}

