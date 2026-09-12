import type { BotConfig, StrategyId } from "../types";

/**
 * Preset utilisateur sauvegardé en localStorage.
 * Contrairement aux presets bundled (config/presets/*.json), ceux-ci
 * peuvent être créés, renommés et supprimés depuis la page backtest.
 */
export interface UserPreset {
  id: string;
  name: string;
  description: string;
  strategyId: StrategyId;
  settings: Partial<BotConfig>;
  createdAt: number;
  updatedAt: number;
  isUser: true;
}

const STORAGE_KEY = "polymarket-backtest-presets";

function read(): UserPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is UserPreset =>
        typeof p === "object" &&
        p !== null &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.strategyId === "string",
    );
  } catch {
    return [];
  }
}

function write(presets: UserPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota / disabled — ignore */
  }
}

export function loadUserPresets(): UserPreset[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveUserPreset(
  preset: Omit<UserPreset, "id" | "createdAt" | "updatedAt" | "isUser"> & { id?: string },
): UserPreset {
  const list = read();
  const now = Date.now();
  const existing = preset.id ? list.find((p) => p.id === preset.id) : undefined;
  if (existing) {
    existing.name = preset.name;
    existing.description = preset.description;
    existing.strategyId = preset.strategyId;
    existing.settings = preset.settings;
    existing.updatedAt = now;
    write(list);
    return existing;
  }
  const id =
    preset.id ??
    `user-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const created: UserPreset = {
    id,
    name: preset.name,
    description: preset.description,
    strategyId: preset.strategyId,
    settings: preset.settings,
    createdAt: now,
    updatedAt: now,
    isUser: true,
  };
  list.push(created);
  write(list);
  return created;
}

export function deleteUserPreset(id: string): void {
  write(read().filter((p) => p.id !== id));
}