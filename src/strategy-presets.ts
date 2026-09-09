import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizePatch,
  type RuntimeSettingsPatch,
} from "./runtime-settings.js";

export const STRATEGY_PRESETS_DIR = join(process.cwd(), "config/presets");

export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  settings: RuntimeSettingsPatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePresetFile(raw: string, fallbackId: string): StrategyPreset {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Preset ${fallbackId} must be a JSON object`);
  }
  const settingsRaw = isRecord(parsed.settings) ? parsed.settings : parsed;
  const settings = sanitizePatch(settingsRaw);
  const id =
    typeof parsed.id === "string" && parsed.id.trim() !== ""
      ? parsed.id.trim()
      : fallbackId;
  const name =
    typeof parsed.name === "string" && parsed.name.trim() !== ""
      ? parsed.name.trim()
      : id;
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";
  return { id, name, description, settings };
}

export function listStrategyPresets(
  dir = STRATEGY_PRESETS_DIR,
): StrategyPreset[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const presets = files
    .sort()
    .map((name) => {
      const fallbackId = name.replace(/\.json$/i, "");
      const raw = readFileSync(join(dir, name), "utf8");
      return parsePresetFile(raw, fallbackId);
    });

  const seen = new Set<string>();
  for (const preset of presets) {
    if (seen.has(preset.id)) {
      throw new Error(`Duplicate strategy preset id: ${preset.id}`);
    }
    seen.add(preset.id);
  }
  return presets;
}
