import { createSignal } from "solid-js";
import type { FavBandWhipsawStatus } from "../types";

/**
 * Dernier statut whipsaw du moteur paper (event SSE `simStrategyStatus`,
 * émis toutes les 5 s par le moteur sim, comme le live). `receivedAt` ancre
 * le countdown client : remainingMs est mesuré à l'émission, décrémenté par
 * l'horloge locale entre deux events. `null` = moteur sim ≠ fav-band (ou
 * statut non encore reçu) → le panneau Simulation masque l'entry.
 */
interface SimWhipsawSnapshot {
  status: FavBandWhipsawStatus | null;
  receivedAt: number;
}

const [simWhipsaw, setSimWhipsawRaw] = createSignal<SimWhipsawSnapshot | null>(null);

export { simWhipsaw };

export function setSimWhipsaw(status: FavBandWhipsawStatus | null): void {
  setSimWhipsawRaw({ status, receivedAt: Date.now() });
}

/** ResteMs réel, décrémenté par l'horloge locale depuis la réception. */
export function simRemainingMsAt(now: number): number | null {
  const snap = simWhipsaw();
  const s = snap?.status;
  if (!snap || !s) return null;
  const elapsed = Math.max(0, now - snap.receivedAt);
  return Math.max(0, s.remainingMs - elapsed);
}