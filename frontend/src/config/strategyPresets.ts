import type { BotConfig } from "../types";
import coverageMax from "../../../config/presets/coverage-max.json";
import conservative from "../../../config/presets/conservative.json";

export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  settings: Partial<BotConfig>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  coverageMax as StrategyPreset,
  conservative as StrategyPreset,
];
