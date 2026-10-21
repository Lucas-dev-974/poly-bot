/**
 * Fabrique de store pour le statut « filtre whipsaw » (fav-band).
 *
 * Le bot LIVE (`/api/strategy/status`, event SSE `strategyStatus`) et le
 * moteur SIM (`/api/sim/strategy-status`, event SSE `simStrategyStatus`)
 * exposent le même payload `FavBandWhipsawStatus` et le même mécanisme de
 * countdown : le `remainingMs` est mesuré à l'émission par le backend, puis
 * décompté côté client entre deux events (l'event arrive toutes les 5 s).
 *
 * Les deux stores étaient deux copies du même code ; cette fabrique porte la
 * logique commune, chaque store se contente de l'instancier.
 */
import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { FavBandWhipsawStatus } from "../types";

export interface WhipsawSnapshot {
  /** Statut courant ; null = moteur ≠ fav-band (ou pas encore reçu). */
  status: FavBandWhipsawStatus | null;
  /** Instant de réception — ancre du countdown client. */
  receivedAt: number;
}

export interface WhipsawStore {
  snapshot: Accessor<WhipsawSnapshot | null>;
  /** Enregistre un statut reçu (SSE ou REST). */
  set(status: FavBandWhipsawStatus | null): void;
  /** RemainingMs réel, décompté depuis la réception. */
  remainingMsAt(now: number): number | null;
}

export function createWhipsawStore(): WhipsawStore {
  const [snapshot, setSnapshotRaw] = createSignal<WhipsawSnapshot | null>(null);

  return {
    snapshot,
    set(status) {
      setSnapshotRaw({ status, receivedAt: Date.now() });
    },
    remainingMsAt(now) {
      const snap = snapshot();
      const s = snap?.status;
      if (!snap || !s) return null;
      const elapsed = Math.max(0, now - snap.receivedAt);
      return Math.max(0, s.remainingMs - elapsed);
    },
  };
}
