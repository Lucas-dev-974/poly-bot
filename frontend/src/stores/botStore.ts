import { createMemo, createSignal } from "solid-js";
import type { BotConfig, BotMode } from "../types";

export const [config, setConfig] = createSignal<BotConfig | null>(null);

export const [botEnabled, setBotEnabled] = createSignal<boolean>(true);

export const mode = createMemo<BotMode>(() => {
  const c = config();
  if (!c) return "dry";
  if (c.dryRun) return "dry";
  if (c.readonlyLive) return "readonly";
  return "live";
});
