import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "./config.js";
import { validateConfigCoherence, validateTradingConfig } from "./config.js";
import { parseStrategyId } from "./strategy/ids.js";

export const RUNTIME_SETTINGS_PATH = join(process.cwd(), "data/bot-settings.json");

export const EDITABLE_CONFIG_KEYS = [
  "pollIntervalMs",
  "marketSlugPrefixes",
  "cheapBuyMin",
  "cheapBuyMax",
  "expensiveBuyMin",
  "expensiveBuyMax",
  "enableExpensiveHedge",
  "cheapOrderUsdc",
  "strategyId",
  "barbellHedgeRatio",
  "pairLockMax",
  "expensiveOrderUsdc",
  "expensiveOrderType",
  "maxSharesPerOrder",
  "maxOpenPositionsPerSide",
  "maxExposureUsdc",
  "minutesBeforeCloseMin",
  "minutesBeforeCloseMax",
  "minMinutesBeforeCloseToBuy",
  "simulatedCapital",
  "simFillProbabilityNonMarketable",
  "simResolveDelaySeconds",
  "simResolveRetryIntervalMs",
  "simResolveMaxRetries",
  "simResolveFallback",
  "simMaxRetryAttempts",
  "simRandomSeed",
  "simRequireCoveredPair",
  "edgeBandMin",
  "edgeBandMax",
  "edgeConfirmSamples",
  "edgeMaxDownTick",
  "edgeCheapMargin",
  "edgeOrderUsdc",
  "maxShareEdge",
  "edgeCheapOrderUsdc",
  "edgeCheapBandMin",
  "edgeCheapBandMax",
] as const;

export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];
export type RuntimeSettingsPatch = Partial<Pick<BotConfig, EditableConfigKey>>;

/** Former .env names — still detected so leftover vars can be warned and ignored. */
export const EDITABLE_ENV_ALIASES: Record<EditableConfigKey, string> = {
  pollIntervalMs: "POLL_INTERVAL_MS",
  marketSlugPrefixes: "MARKET_SLUG_PREFIXES",
  cheapBuyMin: "CHEAP_BUY_MIN",
  cheapBuyMax: "CHEAP_BUY_MAX",
  expensiveBuyMin: "EXPENSIVE_BUY_MIN",
  expensiveBuyMax: "EXPENSIVE_BUY_MAX",
  enableExpensiveHedge: "ENABLE_EXPENSIVE_HEDGE",
  cheapOrderUsdc: "CHEAP_ORDER_USDC",
  strategyId: "STRATEGY_ID",
  barbellHedgeRatio: "BARBELL_HEDGE_RATIO",
  pairLockMax: "PAIR_LOCK_MAX",
  expensiveOrderUsdc: "EXPENSIVE_ORDER_USDC",
  expensiveOrderType: "EXPENSIVE_ORDER_TYPE",
  maxSharesPerOrder: "MAX_SHARES_PER_ORDER",
  maxOpenPositionsPerSide: "MAX_OPEN_POSITIONS_PER_SIDE",
  maxExposureUsdc: "MAX_EXPOSURE_USDC",
  minutesBeforeCloseMin: "MINUTES_BEFORE_CLOSE_MIN",
  minutesBeforeCloseMax: "MINUTES_BEFORE_CLOSE_MAX",
  minMinutesBeforeCloseToBuy: "MIN_MINUTES_BEFORE_CLOSE_TO_BUY",
  simulatedCapital: "SIMULATED_CAPITAL",
  simFillProbabilityNonMarketable: "SIM_FILL_PROBABILITY_NON_MARKETABLE",
  simResolveDelaySeconds: "SIM_RESOLVE_DELAY_SECONDS",
  simResolveRetryIntervalMs: "SIM_RESOLVE_RETRY_INTERVAL_MS",
  simResolveMaxRetries: "SIM_RESOLVE_MAX_RETRIES",
  simResolveFallback: "SIM_RESOLVE_FALLBACK",
  simMaxRetryAttempts: "SIM_MAX_RETRY_ATTEMPTS",
  simRandomSeed: "SIM_RANDOM_SEED",
  simRequireCoveredPair: "SIM_REQUIRE_COVERED_PAIR",
  edgeBandMin: "EDGE_BAND_MIN",
  edgeBandMax: "EDGE_BAND_MAX",
  edgeConfirmSamples: "EDGE_CONFIRM_SAMPLES",
  edgeMaxDownTick: "EDGE_MAX_DOWN_TICK",
  edgeCheapMargin: "EDGE_CHEAP_MARGIN",
  edgeOrderUsdc: "EDGE_ORDER_USDC",
  maxShareEdge: "MAX_SHARE_EDGE",
  edgeCheapOrderUsdc: "EDGE_CHEAP_ORDER_USDC",
  edgeCheapBandMin: "EDGE_CHEAP_BAND_MIN",
  edgeCheapBandMax: "EDGE_CHEAP_BAND_MAX",
};

const FORBIDDEN_KEYS = new Set([
  "dryRun",
  "readonlyLive",
  "privateKey",
  "funderAddress",
  "clobApiKey",
  "clobSecret",
  "clobPassphrase",
  "builderApiKey",
  "builderSecret",
  "builderPassphrase",
  "clobHost",
  "gammaApiHost",
  "dataApiHost",
  "relayerHost",
  "dashboardPort",
  "enableDashboard",
  "dbPath",
  "persistenceEnabled",
  "autoRedeemWinners",
  "signatureType",
  "chainId",
]);

function isEditableKey(key: string): key is EditableConfigKey {
  return (EDITABLE_CONFIG_KEYS as readonly string[]).includes(key);
}

function parseBoolean(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new Error(`Invalid boolean for ${key}`);
}

function parseNumber(value: unknown, key: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${key}`);
  }
  return parsed;
}

function parseNullableNumber(value: unknown, key: string): number | null {
  if (value === null || value === "" || value === undefined) return null;
  return parseNumber(value, key);
}

function parseStringArray(value: unknown, key: string): string[] {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    if (items.length === 0) {
      throw new Error(`${key} must contain at least one non-empty slug`);
    }
    return items;
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (items.length === 0) {
      throw new Error(`${key} must contain at least one non-empty slug`);
    }
    return items;
  }
  throw new Error(`Invalid array for ${key}`);
}

function parseOptionalString(value: unknown, key: string): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string") return value;
  throw new Error(`Invalid string for ${key}`);
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  const raw = String(value).trim().toUpperCase();
  const match = allowed.find((item) => item.toUpperCase() === raw);
  if (!match) {
    throw new Error(`Invalid value for ${key}: ${String(value)}. Allowed: ${allowed.join(", ")}`);
  }
  return match;
}

function parseField(key: EditableConfigKey, value: unknown): RuntimeSettingsPatch[EditableConfigKey] {
  switch (key) {
    case "pollIntervalMs":
    case "cheapBuyMin":
    case "cheapBuyMax":
    case "expensiveBuyMin":
    case "expensiveBuyMax":
    case "cheapOrderUsdc":
    case "barbellHedgeRatio":
    case "pairLockMax":
    case "expensiveOrderUsdc":
    case "maxSharesPerOrder":
    case "maxOpenPositionsPerSide":
    case "maxExposureUsdc":
    case "minutesBeforeCloseMin":
    case "minutesBeforeCloseMax":
    case "simulatedCapital":
    case "simFillProbabilityNonMarketable":
    case "simResolveDelaySeconds":
    case "simResolveRetryIntervalMs":
    case "simResolveMaxRetries":
    case "simMaxRetryAttempts":
    case "edgeBandMin":
    case "edgeBandMax":
    case "edgeConfirmSamples":
    case "edgeMaxDownTick":
    case "edgeCheapMargin":
    case "edgeOrderUsdc":
    case "maxShareEdge":
    case "edgeCheapOrderUsdc":
    case "edgeCheapBandMin":
    case "edgeCheapBandMax":
      return parseNumber(value, key);
    case "minMinutesBeforeCloseToBuy":
      return parseNullableNumber(value, key);
    case "enableExpensiveHedge":
    case "simRequireCoveredPair":
      return parseBoolean(value, key);
    case "marketSlugPrefixes":
      return parseStringArray(value, key);
    case "expensiveOrderType":
      return parseEnum(value, ["FOK", "GTC"] as const, key);
    case "strategyId":
      return parseStrategyId(value);
    case "simResolveFallback":
      return parseEnum(value, ["none", "probabilistic"] as const, key);
    case "simRandomSeed":
      return parseOptionalString(value, key);
    default: {
      const _exhaustive: never = key;
      throw new Error(`Unsupported editable key: ${_exhaustive}`);
    }
  }
}

export function sanitizePatch(body: unknown): RuntimeSettingsPatch {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const record = body as Record<string, unknown>;
  const patch: RuntimeSettingsPatch = {};

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Field not editable: ${key}`);
    }
    if (!isEditableKey(key)) {
      throw new Error(`Unknown field: ${key}`);
    }
    (patch as Record<string, unknown>)[key] = parseField(key, record[key]);
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("At least one editable field is required");
  }

  return patch;
}

export function snapshotEditableSettings(config: BotConfig): RuntimeSettingsPatch {
  const snapshot: RuntimeSettingsPatch = {};
  for (const key of EDITABLE_CONFIG_KEYS) {
    (snapshot as Record<string, unknown>)[key] = config[key];
  }
  return snapshot;
}

export async function readRuntimeSettings(path = RUNTIME_SETTINGS_PATH): Promise<RuntimeSettingsPatch> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return sanitizePatch(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in runtime settings file: ${path}`);
    }
    throw error;
  }
}

export function readRuntimeSettingsSync(path = RUNTIME_SETTINGS_PATH): RuntimeSettingsPatch {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return sanitizePatch(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in runtime settings file: ${path}`);
    }
    throw error;
  }
}

async function atomicWriteJson(path: string, data: RuntimeSettingsPatch): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    await rename(tmpPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM") {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      await rename(tmpPath, path);
      return;
    }
    throw error;
  }
}

export async function writeRuntimeSettings(
  settings: RuntimeSettingsPatch,
  path = RUNTIME_SETTINGS_PATH,
): Promise<void> {
  await atomicWriteJson(path, settings);
}

function restoreSnapshot(config: BotConfig, snapshot: RuntimeSettingsPatch): void {
  const target = config as unknown as Record<string, unknown>;
  for (const key of EDITABLE_CONFIG_KEYS) {
    target[key] = snapshot[key];
  }
}

export async function applyRuntimeSettings(
  config: BotConfig,
  patch: RuntimeSettingsPatch,
  path = RUNTIME_SETTINGS_PATH,
): Promise<Set<EditableConfigKey>> {
  const snapshot = snapshotEditableSettings(config);
  const changed = new Set<EditableConfigKey>();

  const target = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(patch) as EditableConfigKey[]) {
    changed.add(key);
    target[key] = patch[key];
  }

  try {
    validateConfigCoherence(config);
    validateTradingConfig(config);
  } catch (error) {
    restoreSnapshot(config, snapshot);
    throw error;
  }

  try {
    await writeRuntimeSettings(snapshotEditableSettings(config), path);
  } catch (error) {
    restoreSnapshot(config, snapshot);
    throw error;
  }

  return changed;
}
