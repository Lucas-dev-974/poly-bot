import { createSignal } from "solid-js";
import type { FavBandWhipsawStatus } from "../types";

/**
 * Dernier statut whipsaw fav-band reçu (event SSE `strategyStatus`, émis
 * toutes les 5 s par le backend). `receivedAt` ancre le countdown client :
 * remainingMs est mesuré au moment de l'émission, il faut donc le décrémenter
 * avec l'horloge locale entre deux events.
 */
interface StrategyStatusSnapshot {
  status: FavBandWhipsawStatus;
  receivedAt: number;
}

const [strategyStatus, setStrategyStatusRaw] =
  createSignal<StrategyStatusSnapshot | null>(null);

export { strategyStatus };

export function setStrategyStatus(status: FavBandWhipsawStatus): void {
  setStrategyStatusRaw({ status, receivedAt: Date.now() });
}

/** ResteMs réel, décrémenté par l'horloge locale depuis la réception. */
export function remainingMsAt(now: number): number | null {
  const snap = strategyStatus();
  if (!snap) return null;
  const elapsed = Math.max(0, now - snap.receivedAt);
  return Math.max(0, snap.status.remainingMs - elapsed);
}