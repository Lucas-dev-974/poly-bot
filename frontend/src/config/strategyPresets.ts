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
  /** true pour les presets utilisateur (localStorage), absent pour bundled. */
  isUser?: boolean;
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

/**
 * Type unifié pour les presets bundled et utilisateur.
 * `isUser` distingue les presets sauvegardés en localStorage.
 */
export type AnyPreset = StrategyPreset & { isUser?: boolean };

/**
 * Fusionne les presets bundled avec les presets utilisateur (localStorage).
 * Les presets utilisateur sont triés par date de modification décroissante
 * et placés après les bundled.
 */
export function allPresetsForStrategy(
  id: string,
  userPresets: Array<{
    id: string;
    name: string;
    description: string;
    strategyId: string;
    settings: Partial<BotConfig>;
  }>,
): AnyPreset[] {
  const bundled = presetsForStrategy(id);
  const user = userPresets
    .filter((p) => p.strategyId === id)
    .map((p) => ({ ...p, isUser: true }) as AnyPreset);
  return [...bundled, ...user];
}

export function findPresetById(id: string, userPresets: Array<{ id: string; strategyId: string; settings: Partial<BotConfig>; name: string; description: string }> = []): AnyPreset | undefined {
  const bundled = STRATEGY_PRESETS.find((p) => p.id === id);
  if (bundled) return bundled;
  return userPresets.find((p) => p.id === id) as AnyPreset | undefined;
}

export function engineUsesEdge(id: string, customLeadsWithEdge?: boolean): boolean {
  if (id === "edge-lead") return true;
  if (id.startsWith("custom:")) return customLeadsWithEdge === true;
  return false;
}
