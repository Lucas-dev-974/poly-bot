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
  "requireCheapFillBeforeExpensive",
  "cheapOrderUsdc",
  "strategyId",
  "barbellHedgeRatio",
  "pairLockMax",
  "arbAskLockOnly",
  "arbAskSumMax",
  "arbAskLockMinElapsedSec",
  "arbAskLockMaxImbalance",
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
  "edgeOrderUsdc",
  "maxShareEdge",
  "edgeCheapOrderUsdc",
  "edgeCheapBandMin",
  "edgeCheapBandMax",
  "edgeSizingMode",
  "edgeSharesEdge",
  "edgeSharesCheap",
  "edgeSellExpensiveEnabled",
  "edgeSellExpensiveAfterMin",
  "edgeSellExpensiveLossPct",
  "edgeSellExpensiveLossWindowMs",
  "edgeRequireCheapReady",
  "edgeAskSumMax",
  "reverseCancelCheapOffBand",
  "reverseDefendEnabled",
  "reverseMaxGridLevels",
  "reverseHedgeCapToFilledCheap",
  "favBandAskMin",
  "favBandAskMax",
  "favBandMinElapsedSec",
  "favBandMaxElapsedSec",
  "dipRevertBandMin",
  "dipRevertBandMax",
  "dipRevertMinDrop",
  "dipRevertDropLookbackMs",
  "dipRevertMinElapsedSec",
  "dipRevertMaxElapsedSec",
  "dipRevertMaxSpread",
  "dipRevertOrderUsdc",
  "dipRevertExitTakeProfitEnabled",
  "dipRevertExitWinAsk",
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
  requireCheapFillBeforeExpensive: "REQUIRE_CHEAP_FILL_BEFORE_EXPENSIVE",
  cheapOrderUsdc: "CHEAP_ORDER_USDC",
  strategyId: "STRATEGY_ID",
  barbellHedgeRatio: "BARBELL_HEDGE_RATIO",
  pairLockMax: "PAIR_LOCK_MAX",
  arbAskLockOnly: "ARB_ASK_LOCK_ONLY",
  arbAskSumMax: "ARB_ASK_SUM_MAX",
  arbAskLockMinElapsedSec: "ARB_ASK_LOCK_MIN_ELAPSED_SEC",
  arbAskLockMaxImbalance: "ARB_ASK_LOCK_MAX_IMBALANCE",
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
  edgeOrderUsdc: "EDGE_ORDER_USDC",
  maxShareEdge: "MAX_SHARE_EDGE",
  edgeCheapOrderUsdc: "EDGE_CHEAP_ORDER_USDC",
  edgeCheapBandMin: "EDGE_CHEAP_BAND_MIN",
  edgeCheapBandMax: "EDGE_CHEAP_BAND_MAX",
  edgeSizingMode: "EDGE_SIZING_MODE",
  edgeSharesEdge: "EDGE_SHARES_EDGE",
  edgeSharesCheap: "EDGE_SHARES_CHEAP",
  edgeSellExpensiveEnabled: "EDGE_SELL_EXPENSIVE_ENABLED",
  edgeSellExpensiveAfterMin: "EDGE_SELL_EXPENSIVE_AFTER_MIN",
  edgeSellExpensiveLossPct: "EDGE_SELL_EXPENSIVE_LOSS_PCT",
  edgeSellExpensiveLossWindowMs: "EDGE_SELL_EXPENSIVE_LOSS_WINDOW_MS",
  edgeRequireCheapReady: "EDGE_REQUIRE_CHEAP_READY",
  edgeAskSumMax: "EDGE_ASK_SUM_MAX",
  reverseCancelCheapOffBand: "REVERSE_CANCEL_CHEAP_OFF_BAND",
  reverseDefendEnabled: "REVERSE_DEFEND_ENABLED",
  reverseMaxGridLevels: "REVERSE_MAX_GRID_LEVELS",
  reverseHedgeCapToFilledCheap: "REVERSE_HEDGE_CAP_TO_FILLED_CHEAP",
  favBandAskMin: "FAV_BAND_ASK_MIN",
  favBandAskMax: "FAV_BAND_ASK_MAX",
  favBandMinElapsedSec: "FAV_BAND_MIN_ELAPSED_SEC",
  favBandMaxElapsedSec: "FAV_BAND_MAX_ELAPSED_SEC",
  dipRevertBandMin: "DIP_REVERT_BAND_MIN",
  dipRevertBandMax: "DIP_REVERT_BAND_MAX",
  dipRevertMinDrop: "DIP_REVERT_MIN_DROP",
  dipRevertDropLookbackMs: "DIP_REVERT_DROP_LOOKBACK_MS",
  dipRevertMinElapsedSec: "DIP_REVERT_MIN_ELAPSED_SEC",
  dipRevertMaxElapsedSec: "DIP_REVERT_MAX_ELAPSED_SEC",
  dipRevertMaxSpread: "DIP_REVERT_MAX_SPREAD",
  dipRevertOrderUsdc: "DIP_REVERT_ORDER_USDC",
  dipRevertExitTakeProfitEnabled: "DIP_REVERT_EXIT_TAKE_PROFIT_ENABLED",
  dipRevertExitWinAsk: "DIP_REVERT_EXIT_WIN_ASK",
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
    case "favBandAskMin":
    case "favBandAskMax":
    case "favBandMinElapsedSec":
    case "dipRevertBandMin":
    case "dipRevertBandMax":
    case "dipRevertMinDrop":
    case "dipRevertDropLookbackMs":
    case "dipRevertMinElapsedSec":
    case "dipRevertMaxSpread":
    case "dipRevertOrderUsdc":
    case "dipRevertExitWinAsk":
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
    case "edgeOrderUsdc":
    case "maxShareEdge":
    case "edgeCheapOrderUsdc":
    case "edgeCheapBandMin":
    case "edgeCheapBandMax":
    case "edgeSharesEdge":
    case "edgeSharesCheap":
    case "edgeSellExpensiveAfterMin":
    case "edgeSellExpensiveLossPct":
    case "edgeSellExpensiveLossWindowMs":
      return parseNumber(value, key);
    case "edgeSizingMode":
      return parseEnum(value, ["shares", "pusd", "dynamic"] as const, key);
    case "minMinutesBeforeCloseToBuy":
    case "edgeAskSumMax":
    case "arbAskSumMax":
    case "arbAskLockMinElapsedSec":
    case "arbAskLockMaxImbalance":
    case "favBandMaxElapsedSec":
    case "dipRevertMaxElapsedSec":
      return parseNullableNumber(value, key);
    case "enableExpensiveHedge":
    case "arbAskLockOnly":
    case "requireCheapFillBeforeExpensive":
    case "simRequireCoveredPair":
    case "edgeRequireCheapReady":
    case "edgeSellExpensiveEnabled":
    case "reverseCancelCheapOffBand":
    case "reverseDefendEnabled":
    case "reverseHedgeCapToFilledCheap":
    case "dipRevertExitTakeProfitEnabled":
      return parseBoolean(value, key);
    case "reverseMaxGridLevels":
      return parseNullableNumber(value, key);
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

/**
 * Clés communes à toutes les stratégies (boucle bot, scanner, risk, résolution).
 */
const SHARED_KEYS: readonly EditableConfigKey[] = [
  "pollIntervalMs",
  "marketSlugPrefixes",
  "strategyId",
  "maxSharesPerOrder",
  "maxOpenPositionsPerSide",
  "maxExposureUsdc",
  "minutesBeforeCloseMin",
  "minutesBeforeCloseMax",
  "minMinutesBeforeCloseToBuy",
  "simResolveDelaySeconds",
  "simResolveRetryIntervalMs",
  "simResolveMaxRetries",
  "simResolveFallback",
  "simMaxRetryAttempts",
];

/**
 * Clés propres à arb (1:1 + lock). Pas de barbellHedgeRatio.
 * enableExpensiveHedge omis : toujours true (validé dans config).
 * simRequireCoveredPair omis : flag mort (voir orchestrate).
 */
const ARB_KEYS: readonly EditableConfigKey[] = [
  "cheapBuyMin",
  "cheapBuyMax",
  "expensiveBuyMin",
  "expensiveBuyMax",
  "cheapOrderUsdc",
  "pairLockMax",
  "arbAskLockOnly",
  "arbAskSumMax",
  "arbAskLockMinElapsedSec",
  "arbAskLockMaxImbalance",
  "expensiveOrderUsdc",
  "expensiveOrderType",
];

/**
 * Clés propres à barbell (ratio, pas de lock). Pas de pairLockMax.
 * simRequireCoveredPair retiré : même redondance qu'arb quand le hedge est on.
 */
const BARBELL_KEYS: readonly EditableConfigKey[] = [
  "cheapBuyMin",
  "cheapBuyMax",
  "expensiveBuyMin",
  "expensiveBuyMax",
  "enableExpensiveHedge",
  "cheapOrderUsdc",
  "barbellHedgeRatio",
  "expensiveOrderUsdc",
  "expensiveOrderType",
];

/** Reverse : mêmes bandes / budgets, sans lock ni ratio barbell. */
const REVERSE_KEYS: readonly EditableConfigKey[] = [
  "cheapBuyMin",
  "cheapBuyMax",
  "expensiveBuyMin",
  "expensiveBuyMax",
  "enableExpensiveHedge",
  "requireCheapFillBeforeExpensive",
  "cheapOrderUsdc",
  "expensiveOrderUsdc",
  "expensiveOrderType",
  "reverseCancelCheapOffBand",
  "reverseDefendEnabled",
  "reverseMaxGridLevels",
  "reverseHedgeCapToFilledCheap",
];

/**
 * Clés propres à edge-lead (bandes edge/cheap, confirmation, sizing edge).
 */

const FAV_BAND_KEYS: readonly EditableConfigKey[] = [
  "cheapOrderUsdc",
  "favBandAskMin",
  "favBandAskMax",
  "favBandMinElapsedSec",
  "favBandMaxElapsedSec",
  "enableExpensiveHedge",
];

/** Dip-revert : bande favori, conditions de dip/rebond, budget, sortie TP. */
const DIP_REVERT_KEYS: readonly EditableConfigKey[] = [
  "dipRevertBandMin",
  "dipRevertBandMax",
  "dipRevertMinDrop",
  "dipRevertDropLookbackMs",
  "dipRevertMinElapsedSec",
  "dipRevertMaxElapsedSec",
  "dipRevertMaxSpread",
  "dipRevertOrderUsdc",
  "dipRevertExitTakeProfitEnabled",
  "dipRevertExitWinAsk",
];

const EDGE_LEAD_KEYS: readonly EditableConfigKey[] = [
  "edgeBandMin",
  "edgeBandMax",
  "edgeConfirmSamples",
  "edgeMaxDownTick",
  "edgeOrderUsdc",
  "maxShareEdge",
  "edgeCheapOrderUsdc",
  "edgeCheapBandMin",
  "edgeCheapBandMax",
  "edgeSizingMode",
  "edgeSharesEdge",
  "edgeSharesCheap",
  "edgeSellExpensiveEnabled",
  "edgeSellExpensiveAfterMin",
  "edgeSellExpensiveLossPct",
  "edgeSellExpensiveLossWindowMs",
  "edgeRequireCheapReady",
  "edgeAskSumMax",
];

/**
 * SIM keys (simulatedCapital, fill probability, seed) stay in EDITABLE_CONFIG_KEYS
 * for backtest presets/sanitizePatch, but are omitted from live keysForStrategy.
 */
export function keysForStrategy(
  strategyId: BotConfig["strategyId"],
  leadsWithEdge?: boolean,
): readonly EditableConfigKey[] {
  const strategyKeys =
    leadsWithEdge === true || strategyId === "edge-lead"
      ? EDGE_LEAD_KEYS
      : strategyId === "reverse"
        ? REVERSE_KEYS
        : strategyId === "barbell"
          ? BARBELL_KEYS
          : strategyId === "fav-band"
            ? FAV_BAND_KEYS
            : strategyId === "dip-revert"
              ? DIP_REVERT_KEYS
              : ARB_KEYS; // arb + custom sans leadsWithEdge
  return [...SHARED_KEYS, ...strategyKeys];
}

export function snapshotEditableSettings(
  config: BotConfig,
  leadsWithEdge?: boolean,
): RuntimeSettingsPatch {
  const snapshot: RuntimeSettingsPatch = {};
  for (const key of keysForStrategy(config.strategyId, leadsWithEdge)) {
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
  // Only restore keys present in the snapshot. snapshotEditableSettings
  // filters by strategy, so iterating all EDITABLE_CONFIG_KEYS would set
  // omitted keys to undefined and corrupt the config.
  for (const key of Object.keys(snapshot) as EditableConfigKey[]) {
    target[key] = snapshot[key];
  }
}

export async function applyRuntimeSettings(
  config: BotConfig,
  patch: RuntimeSettingsPatch,
  path = RUNTIME_SETTINGS_PATH,
  leadsWithEdge?: boolean,
): Promise<Set<EditableConfigKey>> {
  const snapshot = snapshotEditableSettings(config, leadsWithEdge);
  const changed = new Set<EditableConfigKey>();

  // Live settings file / in-memory config only accept keysForStrategy.
  // sanitizePatch still allows backtest-only keys (simulatedCapital, etc.) for
  // JSON/preset compatibility — drop them here so a live PATCH cannot mutate them.
  const nextStrategyId = (patch.strategyId ?? config.strategyId) as BotConfig["strategyId"];
  const allowed = new Set(keysForStrategy(nextStrategyId, leadsWithEdge));
  const target = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(patch) as EditableConfigKey[]) {
    if (!allowed.has(key)) continue;
    changed.add(key);
    target[key] = patch[key];
  }
  if (changed.size === 0) {
    throw new Error("At least one editable field is required");
  }

  try {
    validateConfigCoherence(config, { leadsWithEdge });
    validateTradingConfig(config, { leadsWithEdge });
  } catch (error) {
    restoreSnapshot(config, snapshot);
    throw error;
  }

  try {
    await writeRuntimeSettings(snapshotEditableSettings(config, leadsWithEdge), path);
  } catch (error) {
    restoreSnapshot(config, snapshot);
    throw error;
  }

  return changed;
}
