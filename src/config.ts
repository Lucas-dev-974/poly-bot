import "dotenv/config";
import { readRuntimeSettingsSync, RUNTIME_SETTINGS_PATH } from "./runtime-settings.js";

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

function envNumberOrNull(key: string): number | null {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for env var ${key}: ${raw}`);
  }
  return parsed;
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
  pairCostMax: number;
  pairTargetCost: number;
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
  /**
   * Désactive le calcul du prix cheap via PAIR_TARGET_COST − hedgePrice.
   * Quand activé, le prix cheap est défini par min(bestAsk, cheapBuyMax),
   * comme dans le chemin sans hedge. La garde cheapBuyMax < expensiveBuyMin
   * et le coût de paire pairCostMax restent appliqués.
   */
  disablePairTargetCost: boolean;
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
}

export function loadConfig(): BotConfig {
  const dryRun = envBoolean("DRY_RUN", true);
  const readonlyLive = envBoolean("READONLY_LIVE", false);

  const config: BotConfig = {
    pollIntervalMs: envNumber("POLL_INTERVAL_MS", 5000),
    marketSlugPrefixes: envList("MARKET_SLUG_PREFIXES", [
      "btc-updown-15m",
      "eth-updown-15m",
    ]),
    cheapBuyMin: envNumber("CHEAP_BUY_MIN", 0.07),
    cheapBuyMax: envNumber("CHEAP_BUY_MAX", 0.1),
    expensiveBuyMin: envNumber("EXPENSIVE_BUY_MIN", 0.85),
    expensiveBuyMax: envNumber("EXPENSIVE_BUY_MAX", 0.95),
    enableExpensiveHedge: envBoolean("ENABLE_EXPENSIVE_HEDGE", true),
    cheapOrderUsdc: envNumber("CHEAP_ORDER_USDC", 1),
    pairCostMax: envNumber("PAIR_COST_MAX", 1.02),
    pairTargetCost: envNumber("PAIR_TARGET_COST", 0.95),
    expensiveOrderUsdc: envNumber("EXPENSIVE_ORDER_USDC", 3),
    expensiveOrderType: envEnum("EXPENSIVE_ORDER_TYPE", ["FOK", "GTC"] as const, "FOK"),
    maxSharesPerOrder: envNumber("MAX_SHARES_PER_ORDER", 20),
    maxOpenPositionsPerSide: envNumber("MAX_OPEN_POSITIONS_PER_SIDE", 1),
    maxExposureUsdc: envNumber("MAX_EXPOSURE_USDC", 45),
    minutesBeforeCloseMin: envNumber("MINUTES_BEFORE_CLOSE_MIN", 0),
    minutesBeforeCloseMax: envNumber("MINUTES_BEFORE_CLOSE_MAX", 15),
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
    simulatedCapital: envNumber("SIMULATED_CAPITAL", 50),
    simFillProbabilityNonMarketable: envNumber(
      "SIM_FILL_PROBABILITY_NON_MARKETABLE",
      0.3,
    ),
    simResolveDelaySeconds: envNumber("SIM_RESOLVE_DELAY_SECONDS", 5),
    simResolveRetryIntervalMs: envNumber("SIM_RESOLVE_RETRY_INTERVAL_MS", 5000),
    simResolveMaxRetries: envNumber("SIM_RESOLVE_MAX_RETRIES", 5),
    simResolveFallback: envEnum(
      "SIM_RESOLVE_FALLBACK",
      ["none", "probabilistic"] as const,
      "none",
    ),
    simMaxRetryAttempts: envNumber("SIM_MAX_RETRY_ATTEMPTS", 20),
    simRandomSeed: process.env.SIM_RANDOM_SEED || undefined,
    simRequireCoveredPair: envBoolean("SIM_REQUIRE_COVERED_PAIR", true),
    disablePairTargetCost: envBoolean("DISABLE_PAIR_TARGET_COST", false),
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
    minMinutesBeforeCloseToBuy: envNumberOrNull("MIN_MINUTES_BEFORE_CLOSE_TO_BUY"),
    marketSnapshotRetentionMs: envNumber("MARKET_SNAPSHOT_RETENTION_DAYS", 7) * 24 * 3600_000,
    bookSnapshotRetentionMs: envNumber("BOOK_SNAPSHOT_RETENTION_DAYS", 3) * 24 * 3600_000,
    opportunitySnapshotRetentionMs: envNumber("OPPORTUNITY_SNAPSHOT_RETENTION_DAYS", 7) * 24 * 3600_000,
  };

  try {
    const overlay = readRuntimeSettingsSync(RUNTIME_SETTINGS_PATH);
    Object.assign(config, overlay);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[config] Ignoring runtime settings overlay (${RUNTIME_SETTINGS_PATH}): ${message}`);
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
  if (config.pairCostMax < 1 || config.pairCostMax > 1.1) {
    throw new Error("PAIR_COST_MAX must be between 1.00 and 1.10");
  }
  if (config.pairTargetCost < 0.85 || config.pairTargetCost > 1) {
    throw new Error("PAIR_TARGET_COST must be between 0.85 and 1.00");
  }
  if (config.pairTargetCost > config.pairCostMax) {
    throw new Error("PAIR_TARGET_COST must be <= PAIR_COST_MAX");
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
