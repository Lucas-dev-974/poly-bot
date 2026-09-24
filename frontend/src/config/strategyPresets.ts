import type { BotConfig, NativeStrategyId, StrategyId } from "../types";
import coverageMax from "../../../config/presets/coverage-max.json";
import conservative from "../../../config/presets/conservative.json";
import edgeLead from "../../../config/presets/edge-lead.json";
import reverse from "../../../config/presets/reverse.json";
import askLock from "../../../config/presets/ask-lock.json";
import lockHarvest from "../../../config/presets/lock-harvest.json";
import favBand from "../../../config/presets/fav-band.json";
import dipRevert from "../../../config/presets/dip-revert.json";
import antiflipRevert from "../../../config/presets/antiflip-revert.json";
import flipConfirm from "../../../config/presets/flip-confirm.json";
import earlyConviction from "../../../config/presets/early-conviction.json";
import openEntry from "../../../config/presets/open-entry.json";
import probabilityRepricing from "../../../config/presets/probability-repricing.json";
import antiflip5mReentry from "../../../config/presets/antiflip-5m-reentry.json";
import antiflip5mSharp from "../../../config/presets/antiflip-5m-sharp.json";
import antiflip5mBounce from "../../../config/presets/antiflip-5m-bounce.json";
import antiflip5mTp10 from "../../../config/presets/antiflip-5m-tp10.json";
import antiflip5mTp20 from "../../../config/presets/antiflip-5m-tp20.json";

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
  { id: "fav-band", label: "Fav-band (FOK favori mid-band, hold resolve)" },
  { id: "dip-revert", label: "Dip-revert (FOK favori dip + rebond, hold resolve)" },
  { id: "antiflip-revert", label: "Antiflip-revert (FOK favori déchu post-flip, hold resolve)" },
  { id: "flip-confirm", label: "Flip-confirm (FOK nouveau favori post-flip précoce)" },
  { id: "early-conviction", label: "Early-conviction (FOK favori déjà établi <45s)" },
  { id: "open-entry", label: "Open-entry (favori émergent <300s, SL dual-scale)" },
  { id: "probability-repricing", label: "Probability-repricing (dislocation CLOB, exits bid)" },
  { id: "reverse", label: "Reverse bet (underdog 7-10¢ + hedge favori)" },
];

export const STRATEGY_PRESETS: StrategyPreset[] = [
  coverageMax as StrategyPreset,
  conservative as StrategyPreset,
  askLock as StrategyPreset,
  lockHarvest as StrategyPreset,
  edgeLead as StrategyPreset,
  reverse as StrategyPreset,
  favBand as StrategyPreset,
  dipRevert as StrategyPreset,
  antiflipRevert as StrategyPreset,
  flipConfirm as StrategyPreset,
  earlyConviction as StrategyPreset,
  openEntry as StrategyPreset,
  probabilityRepricing as StrategyPreset,
  antiflip5mReentry as StrategyPreset,
  antiflip5mSharp as StrategyPreset,
  antiflip5mBounce as StrategyPreset,
  antiflip5mTp10 as StrategyPreset,
  antiflip5mTp20 as StrategyPreset,
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
