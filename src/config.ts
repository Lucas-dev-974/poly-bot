import "dotenv/config";
import { existsSync } from "node:fs";
import {
  EDITABLE_CONFIG_KEYS,
  EDITABLE_ENV_ALIASES,
  readRuntimeSettingsSync,
  RUNTIME_SETTINGS_PATH,
  type EditableConfigKey,
  type RuntimeSettingsPatch,
} from "./runtime-settings.js";
import type { StrategyId } from "./strategy/ids.js";

function envString(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for env var ${key}: ${raw}`);
  }
  return parsed;
}

function envBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

export function envEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[key];
  const value = (raw === undefined || raw === "" ? fallback : raw)
    .trim()
    .toLowerCase();
  const match = allowed.find((item) => item.toLowerCase() === value);
  if (!match) {
    throw new Error(
      `Invalid value for env var ${key}: ${raw}. Allowed: ${allowed.join(", ")}`,
    );
  }
  return match;
}

export interface BotConfig {
  pollIntervalMs: number;
  marketSlugPrefixes: string[];
  cheapBuyMin: number;
  cheapBuyMax: number;
  expensiveBuyMin: number;
  expensiveBuyMax: number;
  enableExpensiveHedge: boolean;
  cheapOrderUsdc: number;
  /** Trading engine: arb = 1:1 + lock; barbell = cheap/hedge ratio, no lock. */
  strategyId: StrategyId;
  /** Target hedge / cheap fill ratio for barbell. Ignored by arb. (0, 1]. */
  barbellHedgeRatio: number;
  /** Verrou profit : bid+hedge à l'entrée et fillPrice+hedge après fill, tous deux ≤ pairLockMax. */
  pairLockMax: number;
  expensiveOrderUsdc: number;
  expensiveOrderType: "FOK" | "GTC";
  maxSharesPerOrder: number;
  maxOpenPositionsPerSide: number;
  maxExposureUsdc: number;
  minutesBeforeCloseMin: number;
  minutesBeforeCloseMax: number;
  dryRun: boolean;
  readonlyLive: boolean;
  privateKey?: `0x${string}`;
  funderAddress?: `0x${string}`;
  signatureType: number;
  clobHost: string;
  chainId: number;
  clobApiKey?: string;
  clobSecret?: string;
  clobPassphrase?: string;
  gammaApiHost: string;
  dataApiHost: string;
  enableDashboard: boolean;
  dashboardPort: number;
  simulatedCapital: number;
  simFillProbabilityNonMarketable: number;
  simResolveDelaySeconds: number;
  simResolveRetryIntervalMs: number;
  simResolveMaxRetries: number;
  simResolveFallback: "probabilistic" | "none";
  simMaxRetryAttempts: number;
  simRandomSeed?: string;
  simRequireCoveredPair: boolean;
  dbPath: string;
  persistenceEnabled: boolean;
  builderApiKey?: string;
  builderSecret?: string;
  builderPassphrase?: string;
  /**
   * Dedicated Relayer API key. When set, the relayer client injects the
   * RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS headers on every request,
   * unlocking unlimited daily relayer transactions for the owning wallet
   * (bypassing the Builder-tier daily quota).
   * Get it from polymarket.com → Settings → API Keys → Relayer API Keys.
   */
  relayerApiKey?: string;
  relayerApiKeyAddress?: string;
  relayerHost: string;
  autoRedeemWinners: boolean;
  minMinutesBeforeCloseToBuy: number | null;
  marketSnapshotRetentionMs: number;
  bookSnapshotRetentionMs: number;
  opportunitySnapshotRetentionMs: number;
  /** Edge-lead : bande de confirmation de l'ask du favori (edge). */
  edgeBandMin: number;
  edgeBandMax: number;
  /** Edge-lead : nombre de ticks consécutifs valides avant d'acheter l'edge. */
  edgeConfirmSamples: number;
  /** Edge-lead : drop tick-à-tick max toléré dans la série de confirmation. */
  edgeMaxDownTick: number;
  /** Edge-lead : marge cheap = 1 − prix_edge − edgeCheapMargin. */
  edgeCheapMargin: number;
  /** Edge-lead : budget USDC de l'ordre edge ; cheap = mêmes shares 1:1. */
  edgeOrderUsdc: number;
  /**
   * Edge-lead : budget USDC de l'ordre cheap (indépendant du budget edge).
   * La taille finale en shares = min(size plafonnée par edgeOrderUsdc,
   * floor(edgeCheapOrderUsdc / cheapLimit)).
   */
  edgeCheapOrderUsdc: number;
}

/**
 * Code defaults for strategy keys. Used when `data/bot-settings.json` is
 * missing (dry-run / tests). Live trading requires that file.
 */
export function strategyDefaults(): RuntimeSettingsPatch &
  Pick<BotConfig, EditableConfigKey> {
  return {
    pollIntervalMs: 5000,
    marketSlugPrefixes: ["btc-updown-15m", "eth-updown-15m"],
    cheapBuyMin: 0.07,
    cheapBuyMax: 0.1,
    expensiveBuyMin: 0.85,
    expensiveBuyMax: 0.95,
    enableExpensiveHedge: true,
    cheapOrderUsdc: 1,
    strategyId: "arb",
    barbellHedgeRatio: 0.5,
    pairLockMax: 0.98,
    // 15 USDC covers a $1 cheap at 0.07 (~14 shares) 1:1 at 0.95.
    // A cap that buys < 5 shares at the hedge price yields no hedge.
    expensiveOrderUsdc: 15,
    expensiveOrderType: "FOK",
    maxSharesPerOrder: 20,
    maxOpenPositionsPerSide: 1,
    maxExposureUsdc: 45,
    minutesBeforeCloseMin: 0,
    minutesBeforeCloseMax: 15,
    minMinutesBeforeCloseToBuy: null,
    simulatedCapital: 50,
    simFillProbabilityNonMarketable: 0.3,
    simResolveDelaySeconds: 5,
    simResolveRetryIntervalMs: 5000,
    simResolveMaxRetries: 5,
    simResolveFallback: "none",
    simMaxRetryAttempts: 20,
    simRandomSeed: undefined,
    simRequireCoveredPair: true,
    edgeBandMin: 0.85,
    edgeBandMax: 0.9,
    edgeConfirmSamples: 5,
    edgeMaxDownTick: 0.01,
    edgeCheapMargin: 0.01,
    edgeOrderUsdc: 15,
    edgeCheapOrderUsdc: 5,
  };
}

function warnIgnoredStrategyEnv(): void {
  const leftover: string[] = [];
  for (const key of EDITABLE_CONFIG_KEYS) {
    const envKey = EDITABLE_ENV_ALIASES[key];
    const raw = process.env[envKey];
    if (raw !== undefined && raw !== "") leftover.push(envKey);
  }
  if (leftover.length === 0) return;
  console.warn(
    `[config] Ignoring ${leftover.length} strategy env var(s); source of truth is ${RUNTIME_SETTINGS_PATH}:\n` +
      leftover.map((name) => `  • ${name}`).join("\n"),
  );
}

export function loadConfig(): BotConfig {
  const dryRun = envBoolean("DRY_RUN", true);
  const readonlyLive = envBoolean("READONLY_LIVE", false);
  const defaults = strategyDefaults();

  const config: BotConfig = {
    ...defaults,
    dryRun,
    readonlyLive,
    privateKey: process.env.PRIVATE_KEY as `0x${string}` | undefined,
    funderAddress: process.env.FUNDER_ADDRESS as `0x${string}` | undefined,
    signatureType: envNumber("SIGNATURE_TYPE", 3),
    clobHost: envString("CLOB_HOST", "https://clob.polymarket.com"),
    chainId: envNumber("CHAIN_ID", 137),
    clobApiKey: process.env.CLOB_API_KEY,
    clobSecret: process.env.CLOB_SECRET,
    clobPassphrase: process.env.CLOB_PASSPHRASE,
    gammaApiHost: envString("GAMMA_API_HOST", "https://gamma-api.polymarket.com"),
    dataApiHost: envString("DATA_API_HOST", "https://data-api.polymarket.com"),
    enableDashboard: envBoolean("ENABLE_DASHBOARD", true),
    dashboardPort: envNumber("DASHBOARD_PORT", 3105),
    dbPath: dryRun
      ? envString("DB_PATH", "data/bot.db")
      : envString("DB_PATH_LIVE", "data/bot-live.db"),
    persistenceEnabled: envBoolean("PERSISTENCE_ENABLED", true),
    builderApiKey: process.env.BUILDER_API_KEY,
    builderSecret: process.env.BUILDER_SECRET,
    builderPassphrase: process.env.BUILDER_PASSPHRASE,
    relayerApiKey: process.env.RELAYER_API_KEY,
    relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS as `0x${string}` | undefined,
    relayerHost: envString("RELAYER_HOST", "https://relayer-v2.polymarket.com"),
    autoRedeemWinners: envBoolean("AUTO_REDEEM_WINNERS", false),
    marketSnapshotRetentionMs: envNumber("MARKET_SNAPSHOT_RETENTION_DAYS", 7) * 24 * 3600_000,
    bookSnapshotRetentionMs: envNumber("BOOK_SNAPSHOT_RETENTION_DAYS", 3) * 24 * 3600_000,
    opportunitySnapshotRetentionMs: envNumber("OPPORTUNITY_SNAPSHOT_RETENTION_DAYS", 7) * 24 * 3600_000,
  };

  warnIgnoredStrategyEnv();

  const settingsPath = RUNTIME_SETTINGS_PATH;
  if (!dryRun && !existsSync(settingsPath)) {
    throw new Error(
      `[config] ${settingsPath} is required when DRY_RUN=false.\n` +
        `  Copy bot-settings.example.json to data/bot-settings.json, or save once from the dashboard.\n` +
        `  Secrets stay in .env; strategy parameters live only in that JSON.`,
    );
  }

  try {
    const overlay = readRuntimeSettingsSync(settingsPath);
    const applied = Object.keys(overlay);
    if (applied.length > 0) {
      console.info(
        `[config] Strategy from ${settingsPath} (${applied.length} key(s))`,
      );
    }
    Object.assign(config, overlay);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!config.dryRun) {
      throw new Error(
        `[config] Runtime settings file is invalid and DRY_RUN=false.\n` +
          `  File: ${settingsPath}\n` +
          `  Error: ${message}\n` +
          `Refusing to start with potentially wrong settings.\n` +
          `Fix data/bot-settings.json, or set DRY_RUN=true to bypass.`,
      );
    }
    console.warn(
      `[config] Ignoring runtime settings (${settingsPath}): ${message}`,
    );
  }

  return config;
}

export type PublicBotConfig = Omit<
  BotConfig,
  | "privateKey"
  | "clobApiKey"
  | "clobSecret"
  | "clobPassphrase"
  | "builderApiKey"
  | "builderSecret"
  | "builderPassphrase"
  | "relayerApiKey"
  | "relayerApiKeyAddress"
>;

export function toPublicConfig(config: BotConfig): PublicBotConfig {
  const {
    privateKey: _privateKey,
    clobApiKey: _clobApiKey,
    clobSecret: _clobSecret,
    clobPassphrase: _clobPassphrase,
    builderApiKey: _builderApiKey,
    builderSecret: _builderSecret,
    builderPassphrase: _builderPassphrase,
    relayerApiKey: _relayerApiKey,
    relayerApiKeyAddress: _relayerApiKeyAddress,
    ...publicConfig
  } = config;
  return publicConfig;
}

export function validateConfigCoherence(config: BotConfig): void {
  if (config.cheapBuyMin > config.cheapBuyMax) {
    throw new Error("CHEAP_BUY_MIN must be <= CHEAP_BUY_MAX");
  }
  if (config.expensiveBuyMin > config.expensiveBuyMax) {
    throw new Error("EXPENSIVE_BUY_MIN must be <= EXPENSIVE_BUY_MAX");
  }
  if (config.cheapBuyMax >= config.expensiveBuyMin) {
    throw new Error("CHEAP_BUY_MAX must be < EXPENSIVE_BUY_MIN");
  }
  if (config.pairLockMax < 0.90 || config.pairLockMax >= 1.00) {
    throw new Error("PAIR_LOCK_MAX must be between 0.90 and 0.99 (profit lock < 1.00)");
  }
  if (!(config.barbellHedgeRatio > 0 && config.barbellHedgeRatio <= 1)) {
    throw new Error("BARBELL_HEDGE_RATIO must be in (0, 1]");
  }
  if (config.minutesBeforeCloseMin > config.minutesBeforeCloseMax) {
    throw new Error("MINUTES_BEFORE_CLOSE_MIN must be <= MINUTES_BEFORE_CLOSE_MAX");
  }
  if (config.pollIntervalMs < 500) {
    throw new Error("POLL_INTERVAL_MS must be >= 500");
  }
  if (config.maxOpenPositionsPerSide < 1) {
    throw new Error("MAX_OPEN_POSITIONS_PER_SIDE must be >= 1");
  }
  if (config.strategyId === "edge-lead") {
    if (config.edgeBandMin >= config.edgeBandMax) {
      throw new Error("EDGE_BAND_MIN must be < EDGE_BAND_MAX");
    }
    if (config.edgeBandMin < 0.50 || config.edgeBandMax > 0.99) {
      throw new Error("EDGE_BAND must be within [0.50, 0.99]");
    }
    if (config.edgeConfirmSamples < 2) {
      throw new Error("EDGE_CONFIRM_SAMPLES must be >= 2");
    }
    if (config.edgeMaxDownTick <= 0) {
      throw new Error("EDGE_MAX_DOWN_TICK must be > 0");
    }
    if (config.edgeCheapMargin < 0) {
      throw new Error("EDGE_CHEAP_MARGIN must be >= 0");
    }
    if (config.edgeOrderUsdc <= 0) {
      throw new Error("EDGE_ORDER_USDC must be > 0");
    }
    if (config.edgeCheapOrderUsdc <= 0) {
      throw new Error("EDGE_CHEAP_ORDER_USDC must be > 0");
    }
  }
}

export function validateTradingConfig(config: BotConfig): void {
  validateConfigCoherence(config);
  if (config.dryRun) return;

  if (config.simResolveFallback !== "none") {
    throw new Error(
      "SIM_RESOLVE_FALLBACK must be none when DRY_RUN=false so live positions are never resolved by RNG.",
    );
  }

  if (config.readonlyLive) {
    if (!config.funderAddress) {
      throw new Error("FUNDER_ADDRESS is required for READONLY_LIVE balance display");
    }
    return;
  }

  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }
  if (!config.funderAddress) {
    throw new Error("FUNDER_ADDRESS is required when DRY_RUN=false");
  }
}
