import { createSignal } from "solid-js";
import type { BalanceSnapshot } from "../types";

/**
 * Balance live du bot (event SSE `balance`, ~30 s).
 * Ecrite par le dispatcher (singleton transport/sse.ts).
 */
const [liveBalance, setLiveBalanceRaw] = createSignal<BalanceSnapshot | null>(null);

export { liveBalance };

/** Appele par le dispatcher SSE et l'hydratation initiale (App). */
export function setLiveBalance(balance: BalanceSnapshot): void {
  setLiveBalanceRaw(balance);
}
