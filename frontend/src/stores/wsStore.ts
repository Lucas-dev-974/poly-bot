import { createSignal } from "solid-js";
import type { BotEvent } from "../types";

export type WsChannel = "market" | "user";

export interface WsChannelState {
  connected: boolean;
  reconnects: number;
}

export const [wsMarket, setWsMarket] = createSignal<WsChannelState | null>(null);
export const [wsUser, setWsUser] = createSignal<WsChannelState | null>(null);

export function setWsStatus(
  event: Extract<BotEvent, { type: "wsStatus" }>,
): void {
  const state = { connected: event.connected, reconnects: event.reconnects };
  if (event.channel === "market") {
    setWsMarket(state);
  } else {
    setWsUser(state);
  }
}