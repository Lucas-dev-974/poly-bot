import type { BotConfig } from "../types";
import coverageMax from "../../../config/presets/coverage-max.json";
import conservative from "../../../config/presets/conservative.json";

export type StrategyId = "arb" | "barbell";

export interface StrategyPreset {
  id: string;
  strategyId: StrategyId;
  name: string;
  description: string;
  settings: Partial<BotConfig>;
}

export const STRATEGY_ENGINE_OPTIONS: Array<{ id: StrategyId; label: string }> = [
  { id: "arb", label: "B1 arbitrage 1:1 + lock" },
  { id: "barbell", label: "Ratio cheap/hedge (sans lock)" },
];

export const STRATEGY_PRESETS: StrategyPreset[] = [
  coverageMax as StrategyPreset,
  conservative as StrategyPreset,
];

export function presetsForStrategy(id: StrategyId): StrategyPreset[] {
  return STRATEGY_PRESETS.filter((preset) => preset.strategyId === id);
}
