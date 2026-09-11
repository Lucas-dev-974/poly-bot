import type { BotConfig, NativeStrategyId, StrategyId } from "../types";
import coverageMax from "../../../config/presets/coverage-max.json";
import conservative from "../../../config/presets/conservative.json";
import edgeLead from "../../../config/presets/edge-lead.json";

export type { NativeStrategyId, StrategyId };

export interface StrategyPreset {
  id: string;
  strategyId: NativeStrategyId;
  name: string;
  description: string;
  settings: Partial<BotConfig>;
}

export const STRATEGY_ENGINE_OPTIONS: Array<{ id: NativeStrategyId; label: string }> = [
  { id: "arb", label: "B1 arbitrage 1:1 + lock" },
  { id: "barbell", label: "Ratio cheap/hedge (sans lock)" },
  { id: "edge-lead", label: "Edge-lead (edge d'abord, puis cheap)" },
];

export const STRATEGY_PRESETS: StrategyPreset[] = [
  coverageMax as StrategyPreset,
  conservative as StrategyPreset,
  edgeLead as StrategyPreset,
];

export function presetsForStrategy(id: string): StrategyPreset[] {
  return STRATEGY_PRESETS.filter((preset) => preset.strategyId === id);
}

export function engineUsesEdge(id: string, customLeadsWithEdge?: boolean): boolean {
  if (id === "edge-lead") return true;
  if (id.startsWith("custom:")) return customLeadsWithEdge === true;
  return false;
}
