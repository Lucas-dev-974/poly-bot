import type { BotConfig } from "../config.js";
import { validateConfigCoherence, validateTradingConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { sanitizePatch, type RuntimeSettingsPatch } from "../runtime-settings.js";
import { parseStrategyId, type StrategyId } from "../strategy/ids.js";
import { leadsWithEdgeFor } from "../strategy/registry.js";
import { listStrategyPresets } from "../strategy-presets.js";

// ============================================================
// Construction d'une config effective dérivée de la config live.
// Extrait de BacktestJob.buildConfig (job.ts) pour être réutilisé
// par la simulation live (src/paper/engine.ts).
// ============================================================

export interface EffectiveConfigRequest {
  strategyId: StrategyId;
  presetId?: string;
  useCurrentConfig?: boolean;
  settings?: RuntimeSettingsPatch;
}

/**
 * Construit la config effective : copie de la config live, puis selon la
 * requête : patch de settings explicite / config live telle quelle / preset.
 * Lève une Error si le preset est inconnu ou ne matche pas le moteur.
 */
export function buildEffectiveConfig(
  liveConfig: BotConfig,
  repos: Repositories | undefined,
  body: EffectiveConfigRequest,
): BotConfig {
  const copy: BotConfig = { ...liveConfig, readonlyLive: false };
  const settings = body.settings && Object.keys(body.settings).length > 0 ? body.settings : null;
  if (settings) {
    // Preset d'abord (base), puis settings runtime par-dessus : une édition
    // du panneau sur un preset actif modifie CHAMPS PAR CHAMPS les valeurs du
    // preset (sinon le preset serait écrasé intégralement).
    if (body.presetId) {
      const preset = listStrategyPresets().find((p) => p.id === body.presetId);
      if (!preset) throw new Error(`Preset inconnu: ${body.presetId}`);
      if (preset.strategyId !== body.strategyId) {
        throw new Error(`Le preset ${body.presetId} n'appartient pas au moteur ${body.strategyId}`);
      }
      applyPatch(copy, sanitizePatch({ ...preset.settings, strategyId: body.strategyId }));
    }
    applyPatch(copy, sanitizePatch({ ...settings, strategyId: body.strategyId }));
  } else if (body.useCurrentConfig) {
    copy.strategyId = body.strategyId;
  } else if (body.presetId) {
    const preset = listStrategyPresets().find((p) => p.id === body.presetId);
    if (!preset) throw new Error(`Preset inconnu: ${body.presetId}`);
    if (preset.strategyId !== body.strategyId) {
      throw new Error(`Le preset ${body.presetId} n'appartient pas au moteur ${body.strategyId}`);
    }
    const patch = sanitizePatch({ ...preset.settings, strategyId: body.strategyId });
    applyPatch(copy, patch);
  } else {
    copy.strategyId = parseStrategyId(body.strategyId);
  }
  const leadsWithEdge = leadsWithEdgeFor(copy.strategyId, repos);
  validateConfigCoherence(copy, { leadsWithEdge });
  validateTradingConfig(copy, { leadsWithEdge });
  return copy;
}

function applyPatch(config: BotConfig, patch: RuntimeSettingsPatch): void {
  const target = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
}