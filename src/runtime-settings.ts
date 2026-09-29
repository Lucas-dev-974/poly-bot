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
  "favBandInverseEnabled",
  "favBandInverseAskMax",
  "favBandInverseShareRatio",
  "favBandInverseOrderUsdc",
  "favBandWhipsawEnabled",
  "favBandWhipsawPauseAfterLosses",
  "favBandWhipsawPauseWindows",
  "favBandWhipsawMaxScore",
  "favBandWhipsawMaxIntraFlips",
  "favBandImbalanceEnabled",
  "favBandImbalanceCrossMin",
  "favBandImbalanceTicks",
  "favBandImbalanceMaxSpread",
  "favBandExitEnabled",
  "favBandExitMinLowerHighDrop",
  "favBandExitRetraceRatio",
  "favBandExitConsecutive",
  "favBandExitLookbackMs",
  "favBandExitMinElapsedSec",
  "favBandExitLossOnly",
  "favBandExitSwitchEnabled",
  "favBandExitSwitchOrderUsdc",
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
  "antiflipBandMin",
  "antiflipBandMax",
  "antiflipDeposedAskMin",
  "antiflipFlipLookbackMs",
  "antiflipMinElapsedSec",
  "antiflipMaxElapsedSec",
  "antiflipMaxSpread",
  "antiflipOrderUsdc",
  "antiflip5mOnly",
  "antiflipEntryDelaySec",
  "antiflipSharpDropMin",
  "antiflipBounceMin",
  "antiflipBounceFloor",
  "antiflipFavAskMin",
  "antiflipFavAskMax",
  "antiflipTakeProfitPct",
  "flipConfirmBandMin",
  "flipConfirmBandMax",
  "flipConfirmFlipLookbackMs",
  "flipConfirmMinElapsedSec",
  "flipConfirmMaxElapsedSec",
  "flipConfirmMaxSpread",
  "flipConfirmOrderUsdc",
  "earlyConvictionAskMin",
  "earlyConvictionAskMax",
  "earlyConvictionMaxElapsedSec",
  "earlyConvictionMaxSpread",
  "earlyConvictionOrderUsdc",
  "openEntryLeanTrigger",
  "openEntryMaxElapsedSec",
  "openEntryFairAskSumMax",
  "openEntryMaxSpread",
  "openEntryOrderUsdc",
  "openEntrySlStructFlipDist",
  "openEntrySlStructConfirmSec",
  "openEntrySlStructDist",
  "openEntrySlLateAfterSec",
  "openEntrySlLateDist",
  "openEntrySlEnabled",
  "earlyLowBuyAskMin",
  "earlyLowBuyAskMax",
  "earlyLowMaxElapsedSec",
  "earlyLowMaxSpread",
  "earlyLowOrderUsdc",
  "earlyLowExitEnabled",
  "earlyLowExitAsk",
  "earlyLowExitMomentumMin",
  "earlyLow15mOnly",
  "earlyLowDropEntryEnabled",
  "earlyLowDropEntryPriceMin",
  "earlyLowDropMin",
  "earlyLowDropMinElapsedSec",
  "earlyLowTrailingEnabled",
  "earlyLowTrailingOffset",
  "earlyLowStopLossEnabled",
  "earlyLowStopLossBidMax",
  "earlyLowExitMaxElapsedSec",
  "favBandOrderUsdc",
  "barbellCheapOrderUsdc",
  "reverseCheapOrderUsdc",
  "repricingFeedMaxAgeMs",
  "repricingTauMinSec",
  "repricingSpreadMax",
  "repricingPEntryMax",
  "repricingEdgeMin",
  "repricingOrderUsdc",
  "repricingTargetAbs",
  "repricingTargetRel",
  "repricingStopAbs",
  "repricingHoldMaxSec",
  "repricingTauForceExitSec",
  "repricingSpreadMaxExit",
  "repricingLateWindowSec",
  "repricingSignalTtlMs",
  "repricingDislocationMin",
  "repricingHistoryWindowMs",
  "repricingModeAEnabled",
  "repricingFeesRoundtrip",
  "repricingSlipEntryBuffer",
  "repricingSlipExitBuffer",
  "repricingNotionalMaxPerMarket",
  "customOrderUsdc",
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
  favBandInverseEnabled: "FAV_BAND_INVERSE_ENABLED",
  favBandInverseAskMax: "FAV_BAND_INVERSE_ASK_MAX",
  favBandInverseShareRatio: "FAV_BAND_INVERSE_SHARE_RATIO",
  favBandInverseOrderUsdc: "FAV_BAND_INVERSE_ORDER_USDC",
  favBandWhipsawEnabled: "FAV_BAND_WHIPSAW_ENABLED",
  favBandWhipsawPauseAfterLosses: "FAV_BAND_WHIPSAW_PAUSE_AFTER_LOSSES",
  favBandWhipsawPauseWindows: "FAV_BAND_WHIPSAW_PAUSE_WINDOWS",
  favBandWhipsawMaxScore: "FAV_BAND_WHIPSAW_MAX_SCORE",
  favBandWhipsawMaxIntraFlips: "FAV_BAND_WHIPSAW_MAX_INTRA_FLIPS",
  favBandImbalanceEnabled: "FAV_BAND_IMBALANCE_ENABLED",
  favBandImbalanceCrossMin: "FAV_BAND_IMBALANCE_CROSS_MIN",
  favBandImbalanceTicks: "FAV_BAND_IMBALANCE_TICKS",
  favBandImbalanceMaxSpread: "FAV_BAND_IMBALANCE_MAX_SPREAD",
  favBandExitEnabled: "FAV_BAND_EXIT_ENABLED",
  favBandExitMinLowerHighDrop: "FAV_BAND_EXIT_MIN_LOWER_HIGH_DROP",
  favBandExitRetraceRatio: "FAV_BAND_EXIT_RETRACE_RATIO",
  favBandExitConsecutive: "FAV_BAND_EXIT_CONSECUTIVE",
  favBandExitLookbackMs: "FAV_BAND_EXIT_LOOKBACK_MS",
  favBandExitMinElapsedSec: "FAV_BAND_EXIT_MIN_ELAPSED_SEC",
  favBandExitLossOnly: "FAV_BAND_EXIT_LOSS_ONLY",
  favBandExitSwitchEnabled: "FAV_BAND_EXIT_SWITCH_ENABLED",
  favBandExitSwitchOrderUsdc: "FAV_BAND_EXIT_SWITCH_ORDER_USDC",
  favBandOrderUsdc: "FAV_BAND_ORDER_USDC",
  barbellCheapOrderUsdc: "BARBELL_CHEAP_ORDER_USDC",
  reverseCheapOrderUsdc: "REVERSE_CHEAP_ORDER_USDC",
  customOrderUsdc: "CUSTOM_ORDER_USDC",
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
  antiflipBandMin: "ANTIFLIP_BAND_MIN",
  antiflipBandMax: "ANTIFLIP_BAND_MAX",
  antiflipDeposedAskMin: "ANTIFLIP_DEPOSED_ASK_MIN",
  antiflipFlipLookbackMs: "ANTIFLIP_FLIP_LOOKBACK_MS",
  antiflipMinElapsedSec: "ANTIFLIP_MIN_ELAPSED_SEC",
  antiflipMaxElapsedSec: "ANTIFLIP_MAX_ELAPSED_SEC",
  antiflipMaxSpread: "ANTIFLIP_MAX_SPREAD",
  antiflipOrderUsdc: "ANTIFLIP_ORDER_USDC",
  antiflip5mOnly: "ANTIFLIP_5M_ONLY",
  antiflipEntryDelaySec: "ANTIFLIP_ENTRY_DELAY_SEC",
  antiflipSharpDropMin: "ANTIFLIP_SHARP_DROP_MIN",
  antiflipBounceMin: "ANTIFLIP_BOUNCE_MIN",
  antiflipBounceFloor: "ANTIFLIP_BOUNCE_FLOOR",
  antiflipFavAskMin: "ANTIFLIP_FAV_ASK_MIN",
  antiflipFavAskMax: "ANTIFLIP_FAV_ASK_MAX",
  antiflipTakeProfitPct: "ANTIFLIP_TAKE_PROFIT_PCT",
  flipConfirmBandMin: "FLIP_CONFIRM_BAND_MIN",
  flipConfirmBandMax: "FLIP_CONFIRM_BAND_MAX",
  flipConfirmFlipLookbackMs: "FLIP_CONFIRM_FLIP_LOOKBACK_MS",
  flipConfirmMinElapsedSec: "FLIP_CONFIRM_MIN_ELAPSED_SEC",
  flipConfirmMaxElapsedSec: "FLIP_CONFIRM_MAX_ELAPSED_SEC",
  flipConfirmMaxSpread: "FLIP_CONFIRM_MAX_SPREAD",
  flipConfirmOrderUsdc: "FLIP_CONFIRM_ORDER_USDC",
  earlyConvictionAskMin: "EARLY_CONVICTION_ASK_MIN",
  earlyConvictionAskMax: "EARLY_CONVICTION_ASK_MAX",
  earlyConvictionMaxElapsedSec: "EARLY_CONVICTION_MAX_ELAPSED_SEC",
  earlyConvictionMaxSpread: "EARLY_CONVICTION_MAX_SPREAD",
  earlyConvictionOrderUsdc: "EARLY_CONVICTION_ORDER_USDC",
  openEntryLeanTrigger: "OPEN_ENTRY_LEAN_TRIGGER",
  openEntryMaxElapsedSec: "OPEN_ENTRY_MAX_ELAPSED_SEC",
  openEntryFairAskSumMax: "OPEN_ENTRY_FAIR_ASK_SUM_MAX",
  openEntryMaxSpread: "OPEN_ENTRY_MAX_SPREAD",
  openEntryOrderUsdc: "OPEN_ENTRY_ORDER_USDC",
  openEntrySlStructFlipDist: "OPEN_ENTRY_SL_STRUCT_FLIP_DIST",
  openEntrySlStructConfirmSec: "OPEN_ENTRY_SL_STRUCT_CONFIRM_SEC",
  openEntrySlStructDist: "OPEN_ENTRY_SL_STRUCT_DIST",
  openEntrySlLateAfterSec: "OPEN_ENTRY_SL_LATE_AFTER_SEC",
  openEntrySlLateDist: "OPEN_ENTRY_SL_LATE_DIST",
  openEntrySlEnabled: "OPEN_ENTRY_SL_ENABLED",
  earlyLowBuyAskMin: "EARLY_LOW_BUY_ASK_MIN",
  earlyLowBuyAskMax: "EARLY_LOW_BUY_ASK_MAX",
  earlyLowMaxElapsedSec: "EARLY_LOW_MAX_ELAPSED_SEC",
  earlyLowMaxSpread: "EARLY_LOW_MAX_SPREAD",
  earlyLowOrderUsdc: "EARLY_LOW_ORDER_USDC",
  earlyLowExitEnabled: "EARLY_LOW_EXIT_ENABLED",
  earlyLowExitAsk: "EARLY_LOW_EXIT_ASK",
  earlyLowExitMomentumMin: "EARLY_LOW_EXIT_MOMENTUM_MIN",
  earlyLow15mOnly: "EARLY_LOW_15M_ONLY",
  earlyLowDropEntryEnabled: "EARLY_LOW_DROP_ENTRY_ENABLED",
  earlyLowDropEntryPriceMin: "EARLY_LOW_DROP_ENTRY_PRICE_MIN",
  earlyLowDropMin: "EARLY_LOW_DROP_MIN",
  earlyLowDropMinElapsedSec: "EARLY_LOW_DROP_MIN_ELAPSED_SEC",
  earlyLowTrailingEnabled: "EARLY_LOW_TRAILING_ENABLED",
  earlyLowTrailingOffset: "EARLY_LOW_TRAILING_OFFSET",
  earlyLowStopLossEnabled: "EARLY_LOW_STOP_LOSS_ENABLED",
  earlyLowStopLossBidMax: "EARLY_LOW_STOP_LOSS_BID_MAX",
  earlyLowExitMaxElapsedSec: "EARLY_LOW_EXIT_MAX_ELAPSED_SEC",
  repricingFeedMaxAgeMs: "REPRICING_FEED_MAX_AGE_MS",
  repricingTauMinSec: "REPRICING_TAU_MIN_SEC",
  repricingSpreadMax: "REPRICING_SPREAD_MAX",
  repricingPEntryMax: "REPRICING_PENTRY_MAX",
  repricingEdgeMin: "REPRICING_EDGE_MIN",
  repricingOrderUsdc: "REPRICING_ORDER_USDC",
  repricingTargetAbs: "REPRICING_TARGET_ABS",
  repricingTargetRel: "REPRICING_TARGET_REL",
  repricingStopAbs: "REPRICING_STOP_ABS",
  repricingHoldMaxSec: "REPRICING_HOLD_MAX_SEC",
  repricingTauForceExitSec: "REPRICING_TAU_FORCE_EXIT_SEC",
  repricingSpreadMaxExit: "REPRICING_SPREAD_MAX_EXIT",
  repricingLateWindowSec: "REPRICING_LATE_WINDOW_SEC",
  repricingSignalTtlMs: "REPRICING_SIGNAL_TTL_MS",
  repricingDislocationMin: "REPRICING_DISLOCATION_MIN",
  repricingHistoryWindowMs: "REPRICING_HISTORY_WINDOW_MS",
  repricingModeAEnabled: "REPRICING_MODE_AENABLED",
  repricingFeesRoundtrip: "REPRICING_FEES_ROUNDTRIP",
  repricingSlipEntryBuffer: "REPRICING_SLIP_ENTRY_BUFFER",
  repricingSlipExitBuffer: "REPRICING_SLIP_EXIT_BUFFER",
  repricingNotionalMaxPerMarket: "REPRICING_NOTIONAL_MAX_PER_MARKET",
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
    case "favBandOrderUsdc":
    case "barbellCheapOrderUsdc":
    case "reverseCheapOrderUsdc":
    case "customOrderUsdc":
    case "barbellHedgeRatio":
    case "favBandAskMin":
    case "favBandAskMax":
    case "favBandMinElapsedSec":
    case "favBandInverseAskMax":
    case "favBandInverseShareRatio":
    case "favBandInverseOrderUsdc":
    case "favBandWhipsawPauseWindows":
    case "favBandExitMinLowerHighDrop":
    case "favBandExitRetraceRatio":
    case "favBandExitConsecutive":
    case "favBandExitLookbackMs":
    case "favBandExitMinElapsedSec":
    case "favBandExitSwitchOrderUsdc":
    case "dipRevertBandMin":
    case "dipRevertBandMax":
    case "dipRevertMinDrop":
    case "dipRevertDropLookbackMs":
    case "dipRevertMinElapsedSec":
    case "dipRevertMaxSpread":
    case "dipRevertOrderUsdc":
    case "dipRevertExitWinAsk":
    case "antiflipBandMin":
    case "antiflipBandMax":
    case "antiflipFlipLookbackMs":
    case "antiflipMinElapsedSec":
    case "antiflipMaxSpread":
    case "antiflipOrderUsdc":
    case "antiflipEntryDelaySec":
    case "antiflipSharpDropMin":
    case "antiflipBounceMin":
    case "antiflipFavAskMin":
    case "antiflipFavAskMax":
    case "antiflipTakeProfitPct":
    case "flipConfirmBandMin":
    case "flipConfirmBandMax":
    case "flipConfirmFlipLookbackMs":
    case "flipConfirmMinElapsedSec":
    case "flipConfirmMaxSpread":
    case "flipConfirmOrderUsdc":
    case "earlyConvictionAskMin":
    case "earlyConvictionAskMax":
    case "earlyConvictionMaxElapsedSec":
    case "earlyConvictionMaxSpread":
    case "earlyConvictionOrderUsdc":
    case "earlyLowBuyAskMin":
    case "earlyLowBuyAskMax":
    case "earlyLowMaxElapsedSec":
    case "earlyLowMaxSpread":
    case "earlyLowOrderUsdc":
    case "earlyLowExitAsk":
    case "earlyLowExitMomentumMin":
    case "earlyLowDropEntryPriceMin":
    case "earlyLowDropMin":
    case "earlyLowDropMinElapsedSec":
    case "earlyLowTrailingOffset":
    case "earlyLowStopLossBidMax":
    case "earlyLowExitMaxElapsedSec":
    case "openEntryLeanTrigger":
    case "openEntryMaxElapsedSec":
    case "openEntryFairAskSumMax":
    case "openEntryMaxSpread":
    case "openEntryOrderUsdc":
    case "openEntrySlStructFlipDist":
    case "openEntrySlStructConfirmSec":
    case "openEntrySlStructDist":
    case "openEntrySlLateAfterSec":
    case "repricingFeedMaxAgeMs":
    case "repricingTauMinSec":
    case "repricingSpreadMax":
    case "repricingPEntryMax":
    case "repricingEdgeMin":
    case "repricingOrderUsdc":
    case "repricingTargetAbs":
    case "repricingTargetRel":
    case "repricingStopAbs":
    case "repricingHoldMaxSec":
    case "repricingTauForceExitSec":
    case "repricingSpreadMaxExit":
    case "repricingLateWindowSec":
    case "repricingSignalTtlMs":
    case "repricingDislocationMin":
    case "repricingHistoryWindowMs":
    case "repricingFeesRoundtrip":
    case "repricingSlipEntryBuffer":
    case "repricingSlipExitBuffer":
    case "repricingNotionalMaxPerMarket":
    case "openEntrySlLateDist":
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
    case "favBandWhipsawPauseAfterLosses":
    case "favBandWhipsawMaxScore":
    case "favBandWhipsawMaxIntraFlips":
    case "favBandImbalanceCrossMin":
    case "favBandImbalanceTicks":
    case "favBandImbalanceMaxSpread":
    case "dipRevertMaxElapsedSec":
    case "antiflipMaxElapsedSec":
    case "antiflipDeposedAskMin":
    case "antiflipBounceFloor":
    case "flipConfirmMaxElapsedSec":
      return parseNullableNumber(value, key);
    case "enableExpensiveHedge":
    case "arbAskLockOnly":
    case "requireCheapFillBeforeExpensive":
    case "edgeRequireCheapReady":
    case "edgeSellExpensiveEnabled":
    case "reverseCancelCheapOffBand":
    case "reverseDefendEnabled":
    case "reverseHedgeCapToFilledCheap":
    case "dipRevertExitTakeProfitEnabled":
    case "favBandInverseEnabled":
    case "favBandWhipsawEnabled":
    case "favBandImbalanceEnabled":
    case "favBandExitEnabled":
    case "favBandExitLossOnly":
    case "favBandExitSwitchEnabled":
    case "openEntrySlEnabled":
    case "earlyLowExitEnabled":
    case "earlyLow15mOnly":
    case "earlyLowDropEntryEnabled":
    case "earlyLowTrailingEnabled":
    case "earlyLowStopLossEnabled":
    case "repricingModeAEnabled":
    case "antiflip5mOnly":
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

/**
 * Clés supprimées du schéma (flags morts). Elles sont DROPPÉES au lieu de
 * lever "Unknown field" : une config persistée par une version antérieure
 * (sim_state.simConfigJson, bot-settings.json, presets utilisateur) ne doit
 * pas brickier le boot après un upgrade. Le rejet strict reste voulu pour
 * les clés jamais connues (faute de frappe → erreur visible côté API).
 */
const REMOVED_KEYS = new Set<string>(["simRequireCoveredPair"]);

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
    if (REMOVED_KEYS.has(key)) continue;
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
 */
const BARBELL_KEYS: readonly EditableConfigKey[] = [
  "cheapBuyMin",
  "cheapBuyMax",
  "expensiveBuyMin",
  "expensiveBuyMax",
  "enableExpensiveHedge",
  "barbellCheapOrderUsdc",
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
  "reverseCheapOrderUsdc",
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
  "favBandOrderUsdc",
  "favBandAskMin",
  "favBandAskMax",
  "favBandMinElapsedSec",
  "favBandMaxElapsedSec",
  "favBandInverseEnabled",
  "favBandInverseAskMax",
  "favBandInverseShareRatio",
  "favBandInverseOrderUsdc",
  "favBandWhipsawEnabled",
  "favBandWhipsawPauseAfterLosses",
  "favBandWhipsawPauseWindows",
  "favBandWhipsawMaxScore",
  "favBandWhipsawMaxIntraFlips",
  "favBandImbalanceEnabled",
  "favBandImbalanceCrossMin",
  "favBandImbalanceTicks",
  "favBandImbalanceMaxSpread",
  "favBandExitEnabled",
  "favBandExitMinLowerHighDrop",
  "favBandExitRetraceRatio",
  "favBandExitConsecutive",
  "favBandExitLookbackMs",
  "favBandExitMinElapsedSec",
  "favBandExitLossOnly",
  "favBandExitSwitchEnabled",
  "favBandExitSwitchOrderUsdc",
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

/** Antiflip-revert : bande du déchu, floor, lookback de flip, budget, modes 5m (A/H/K). */
const ANTIFLIP_KEYS: readonly EditableConfigKey[] = [
  "antiflipBandMin",
  "antiflipBandMax",
  "antiflipDeposedAskMin",
  "antiflipFlipLookbackMs",
  "antiflipMinElapsedSec",
  "antiflipMaxElapsedSec",
  "antiflipMaxSpread",
  "antiflipOrderUsdc",
  "antiflip5mOnly",
  "antiflipEntryDelaySec",
  "antiflipSharpDropMin",
  "antiflipBounceMin",
  "antiflipBounceFloor",
  "antiflipFavAskMin",
  "antiflipFavAskMax",
  "antiflipTakeProfitPct",
  "enableExpensiveHedge",
];

/** Flip-confirm : bande du nouveau favori, lookback de flip, fenêtre d'entrée. */
const FLIP_CONFIRM_KEYS: readonly EditableConfigKey[] = [
  "flipConfirmBandMin",
  "flipConfirmBandMax",
  "flipConfirmFlipLookbackMs",
  "flipConfirmMinElapsedSec",
  "flipConfirmMaxElapsedSec",
  "flipConfirmMaxSpread",
  "flipConfirmOrderUsdc",
  "enableExpensiveHedge",
];

/** Early-conviction : bande de conviction précoce, budget. */
const EARLY_CONVICTION_KEYS: readonly EditableConfigKey[] = [
  "earlyConvictionAskMin",
  "earlyConvictionAskMax",
  "earlyConvictionMaxElapsedSec",
  "earlyConvictionMaxSpread",
  "earlyConvictionOrderUsdc",
  "enableExpensiveHedge",
];

/** Probability-repricing : dislocation CLOB, exits bid, fees/slip, budget. */
const PROBABILITY_REPRICING_KEYS: readonly EditableConfigKey[] = [
  "repricingFeedMaxAgeMs",
  "repricingTauMinSec",
  "repricingSpreadMax",
  "repricingPEntryMax",
  "repricingEdgeMin",
  "repricingOrderUsdc",
  "repricingTargetAbs",
  "repricingTargetRel",
  "repricingStopAbs",
  "repricingHoldMaxSec",
  "repricingTauForceExitSec",
  "repricingSpreadMaxExit",
  "repricingLateWindowSec",
  "repricingSignalTtlMs",
  "repricingDislocationMin",
  "repricingHistoryWindowMs",
  "repricingModeAEnabled",
  "repricingFeesRoundtrip",
  "repricingSlipEntryBuffer",
  "repricingSlipExitBuffer",
  "repricingNotionalMaxPerMarket",
  "enableExpensiveHedge",
];

const OPEN_ENTRY_KEYS: readonly EditableConfigKey[] = [
  "openEntryLeanTrigger",
  "openEntryMaxElapsedSec",
  "openEntryFairAskSumMax",
  "openEntryMaxSpread",
  "openEntryOrderUsdc",
  "openEntrySlStructFlipDist",
  "openEntrySlStructConfirmSec",
  "openEntrySlStructDist",
  "openEntrySlLateAfterSec",
  "openEntrySlLateDist",
  "openEntrySlEnabled",
  "enableExpensiveHedge",
];

/** Early-low : bande du token décoté, fenêtre d'entrée, budget, exit TP. */
const EARLY_LOW_KEYS: readonly EditableConfigKey[] = [
  "earlyLowBuyAskMin",
  "earlyLowBuyAskMax",
  "earlyLowMaxElapsedSec",
  "earlyLowMaxSpread",
  "earlyLowOrderUsdc",
  "earlyLowExitEnabled",
  "earlyLowExitAsk",
  "earlyLowExitMomentumMin",
  "earlyLow15mOnly",
  "earlyLowDropEntryEnabled",
  "earlyLowDropEntryPriceMin",
  "earlyLowDropMin",
  "earlyLowDropMinElapsedSec",
  "earlyLowTrailingEnabled",
  "earlyLowTrailingOffset",
  "earlyLowStopLossEnabled",
  "earlyLowStopLossBidMax",
  "earlyLowExitMaxElapsedSec",
  "enableExpensiveHedge",
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

/** Custom (graph) : budget des ordres computeSize des graphs custom. */
const CUSTOM_KEYS: readonly EditableConfigKey[] = [
  "customOrderUsdc",
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
              : strategyId === "antiflip-revert"
                ? ANTIFLIP_KEYS
                : strategyId === "flip-confirm"
                  ? FLIP_CONFIRM_KEYS
                  : strategyId === "early-conviction"
                    ? EARLY_CONVICTION_KEYS
                    : strategyId === "early-low"
                      ? EARLY_LOW_KEYS
                      : strategyId === "open-entry"
                        ? OPEN_ENTRY_KEYS
                        : strategyId === "probability-repricing"
                          ? PROBABILITY_REPRICING_KEYS
                          : String(strategyId).startsWith("custom:")
                            ? CUSTOM_KEYS
                            : ARB_KEYS; // arb seul
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
