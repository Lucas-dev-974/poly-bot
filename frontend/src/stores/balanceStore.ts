import { createSignal } from "solid-js";
import type { BalanceSnapshot } from "../types";

/**
 * Balance live du bot (event SSE `balance`, ~30 s) — sortait d'App.tsx comme
 * signal local non partagé. Source unique pour Header (badge capital) et tout
 * futur consommateur.
 *
 * Note Phase 3 : l'interception de l'event `balance` reste dans App.tsx (le
 * hook useEventSource est monté par page) — elle écrit désormais ICI. Le
 * singleton transport/sse.ts (architecture cible) migrera l'interception
 * dans le dispatcher à l'identique.
 */
const [liveBalance, setLiveBalanceRaw] = createSignal<BalanceSnapshot | null>(null);

export { liveBalance };

/** Appelé par l'interception App de l'event SSE `balance` et l'hydratation. */
export function setLiveBalance(balance: BalanceSnapshot): void {
  setLiveBalanceRaw(balance);
}