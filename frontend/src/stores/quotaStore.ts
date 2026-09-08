import { createSignal } from "solid-js";
import type { RelayerQuotaState } from "../types";

export const [relayerQuota, setRelayerQuota] = createSignal<RelayerQuotaState | null>(null);

export function updateRelayerQuota(quota: RelayerQuotaState): void {
  setRelayerQuota(quota);
}
