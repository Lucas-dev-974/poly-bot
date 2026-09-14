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
  /** Reverse: n'émettre l'expensive qu'après un cheap fillé sur la paire. */
  requireCheapFillBeforeExpensive: boolean;
  cheapOrderUsdc: number;
  /** Trading engine: arb = 1:1 + lock; barbell = cheap/hedge ratio, no lock. */
  strategyId: StrategyId;
  /** Target hedge / cheap fill ratio for barbell. Ignored by arb. (0, 1]. */
  barbellHedgeRatio: number;
  /** Verrou profit : bid+hedge à l'entrée et fillPrice+hedge après fill, tous deux ≤ pairLockMax. */
  pairLockMax: number;
  /**
   * Arb ask-lock (dual-FOK): only enter when ask_cheap + ask_expensive ≤ lock
   * (pairLockMax, or arbAskSumMax if set). Take both asks FOK same tick; no
   * resting maker bid. Default false = classic maker-cheap Policy A path.
   */
  arbAskLockOnly: boolean;
  /**
   * Optional stricter ask+ask cap for ask-lock (null = use pairLockMax).
   * Must be ≤ pairLockMax when set.
   */
  arbAskSumMax: number | null;
  /**
   * Ask-lock : n'entrer qu'après N secondes depuis windowStart (null = off).
   * Sert à concentrer le harvest en fin de fenêtre où les locks apparaissent plus.
   */
  arbAskLockMinElapsedSec: number | null;
  /**
   * Ask-lock : skip si |ask_cheap - ask_expensive| > seuil (null = off).
   * Filtre les locks extrêmes type 0.08+0.91 (fin de marché / book déséquilibré).
   */
  arbAskLockMaxImbalance: number | null;
  expensiveOrderUsdc: number;
  expensiveOrderType: "FOK" | "GTC";
  maxSharesPerOrder: number;
  maxOpenPositionsPerSide: number;
  maxExposureUsdc: number;
  minutesBeforeCloseMin: number;
  minutesBeforeCloseMax: number;
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
  /** @deprecated No effect in orchestrate (favoriteInRange already true when hedge is off). Kept for JSON backward compat. */
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
  /** 0 = keep forever (analytics / future ML). */
  marketSnapshotRetentionMs: number;
  /** 0 = keep forever (analytics / future ML). */
  bookSnapshotRetentionMs: number;
  opportunitySnapshotRetentionMs: number;
  /** Edge-lead : bande de confirmation de l'ask du favori (edge). */
  edgeBandMin: number;
  edgeBandMax: number;
  /** Edge-lead : nombre de ticks consécutifs valides avant d'acheter l'edge. */
  edgeConfirmSamples: number;
  /** Edge-lead : drop tick-à-tick max toléré dans la série de confirmation. */
  edgeMaxDownTick: number;
  /** Edge-lead : budget USDC de l'ordre edge (size = budget / prix edge). */
  edgeOrderUsdc: number;
  /**
   * Edge-lead : plafond de shares de l'ordre edge.
   * Indépendant de maxSharesPerOrder, qui plafonne encore le cheap.
   */
  maxShareEdge: number;
  /**
   * Edge-lead : budget USDC de l'ordre cheap (size = budget / ask cheap).
   * Indépendant du budget edge ; pas de 1:1 en shares.
   */
  edgeCheapOrderUsdc: number;
  /** Edge-lead : ask cheap minimum pour poster (ex. 0.04). */
  edgeCheapBandMin: number;
  /** Edge-lead : ask cheap maximum pour poster (ex. 0.14). */
  edgeCheapBandMax: number;
  /**
   * Edge-lead : mode de sizing des ordres.
   * - "shares" : nombre fixe de shares par side (edgeSharesEdge / edgeSharesCheap).
   * - "pusd"   : montant USDC fixe par side (edgeOrderUsdc / edgeCheapOrderUsdc), converti en shares.
   * - "dynamic": comportement actuel (budgets USDC + confirmation N ticks + bandes).
   * En mode shares/pusd, la confirmation et les bandes restent appliquées ; seul le calcul de taille change.
   */
  edgeSizingMode: "shares" | "pusd" | "dynamic";
  /** Edge-lead : shares fixes de l'ordre edge en mode "shares". */
  edgeSharesEdge: number;
  /** Edge-lead : shares fixes de l'ordre cheap en mode "shares". */
  edgeSharesCheap: number;
  /** Edge-lead : vendre l'edge (favori nu) si aucun cheap fillé et en perte soutenue. */
  edgeSellExpensiveEnabled: boolean;
  /** Edge-lead : âge du marché (min depuis windowStart) avant déclenchement de la vente. */
  edgeSellExpensiveAfterMin: number;
  /** Edge-lead : perte % sous le fill price pour déclencher la vente (ex. 10 = -10%). */
  edgeSellExpensiveLossPct: number;
  /** Edge-lead : durée de perte continue requise (ms) avant la vente. */
  edgeSellExpensiveLossWindowMs: number;
  /**
   * Edge-lead : n'émettre l'edge que si l'ask cheap est déjà dans
   * [edgeCheapBandMin, edgeCheapBandMax] (hedgeable dès le fill).
   */
  edgeRequireCheapReady: boolean;
  /**
   * Edge-lead : plafond ask_edge + ask_cheap à l'entrée (null = désactivé).
   * Ex. 0.99 pour n'entrer que sur un quasi-lock.
   */
  edgeAskSumMax: number | null;
  /**
   * Reverse (Phase 2, default off): cancel resting cheap GTC when the live
   * underdog ask leaves [cheapBuyMin, cheapBuyMax].
   */
  reverseCancelCheapOffBand: boolean;
  /**
   * Reverse (Phase 2, default off): FOK-sell uncovered cheap when favorite
   * ask > expensiveBuyMax (same trigger as arb defense).
   */
  reverseDefendEnabled: boolean;
  /**
   * Reverse (Phase 2): max price levels per leg from the maker grid.
   * null = unlimited (legacy behaviour).
   */
  reverseMaxGridLevels: number | null;
  /**
   * Reverse (Phase 2, default off): cap cumulative hedge size to
   * filledCheap − (filledExpensive + resting expensive GTC). Independent
   * grid otherwise ignores 1:1.
   */
  reverseHedgeCapToFilledCheap: boolean;
  /**
   * Fav-band: buy favorite when ask in [favBandAskMin, favBandAskMax]
   * after favBandMinElapsedSec into the window. Hold to resolve, no hedge.
   */
  favBandAskMin: number;
  favBandAskMax: number;
  favBandMinElapsedSec: number;
  /** Optional upper elapsed cap (null = until close / minutesBeforeClose). */
  favBandMaxElapsedSec: number | null;
  /**
   * Dip-revert: buy favorite after an intra-window dip + stabilization.
   * Ask must be in [dipRevertBandMin, dipRevertBandMax]; the favorite must
   * have dropped >= dipRevertMinDrop over dipRevertDropLookbackMs then
   * bounced off its local low; entry only after dipRevertMinElapsedSec.
   */
  dipRevertBandMin: number;
  dipRevertBandMax: number;
  dipRevertMinDrop: number;
  dipRevertDropLookbackMs: number;
  dipRevertMinElapsedSec: number;
  /** Optional upper elapsed cap (null = until close / minutesBeforeClose). */
  dipRevertMaxElapsedSec: number | null;
  dipRevertMaxSpread: number;
  dipRevertOrderUsdc: number;
}

/**
 * Code defaults for strategy keys. Used as baseline before overlaying
 * `data/bot-settings.json` (required at startup) and in tests.
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
    requireCheapFillBeforeExpensive: true,
    cheapOrderUsdc: 1,
    strategyId: "arb",
    barbellHedgeRatio: 0.5,
    pairLockMax: 0.98,
    arbAskLockOnly: false,
    arbAskSumMax: null,
    arbAskLockMinElapsedSec: null,
    arbAskLockMaxImbalance: null,
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
    edgeOrderUsdc: 15,
    maxShareEdge: 20,
    edgeCheapOrderUsdc: 5,
    edgeCheapBandMin: 0.04,
    edgeCheapBandMax: 0.14,
    edgeSizingMode: "dynamic",
    edgeSharesEdge: 20,
    edgeSharesCheap: 20,
    edgeSellExpensiveEnabled: true,
    edgeSellExpensiveAfterMin: 8,
    edgeSellExpensiveLossPct: 10,
    edgeSellExpensiveLossWindowMs: 10_000,
    edgeRequireCheapReady: false,
    edgeAskSumMax: null,
    reverseCancelCheapOffBand: false,
    reverseDefendEnabled: false,
    reverseMaxGridLevels: null,
    reverseHedgeCapToFilledCheap: false,
    favBandAskMin: 0.7,
    favBandAskMax: 0.85,
    favBandMinElapsedSec: 200,
    favBandMaxElapsedSec: null,
    dipRevertBandMin: 0.55,
    dipRevertBandMax: 0.65,
    dipRevertMinDrop: 0.03,
    dipRevertDropLookbackMs: 60_000,
    dipRevertMinElapsedSec: 180,
    dipRevertMaxElapsedSec: null,
    dipRevertMaxSpread: 0.04,
    dipRevertOrderUsdc: 15,
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
  const readonlyLive = envBoolean("READONLY_LIVE", false);
  const defaults = strategyDefaults();

  // DB path: DB_PATH, else DB_PATH_LIVE, else data/bot-live.db (live-only bot).
  const dbPath =
    (process.env.DB_PATH && process.env.DB_PATH !== ""
      ? process.env.DB_PATH
      : undefined) ??
    (process.env.DB_PATH_LIVE && process.env.DB_PATH_LIVE !== ""
      ? process.env.DB_PATH_LIVE
      : undefined) ??
    "data/bot-live.db";

  const config: BotConfig = {
    ...defaults,
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
    dbPath,
    persistenceEnabled: envBoolean("PERSISTENCE_ENABLED", true),
    builderApiKey: process.env.BUILDER_API_KEY,
    builderSecret: process.env.BUILDER_SECRET,
    builderPassphrase: process.env.BUILDER_PASSPHRASE,
    relayerApiKey: process.env.RELAYER_API_KEY,
    relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS as `0x${string}` | undefined,
    relayerHost: envString("RELAYER_HOST", "https://relayer-v2.polymarket.com"),
    autoRedeemWinners: envBoolean("AUTO_REDEEM_WINNERS", false),
    marketSnapshotRetentionMs: envNumber("MARKET_SNAPSHOT_RETENTION_DAYS", 0) * 24 * 3600_000,
    bookSnapshotRetentionMs: envNumber("BOOK_SNAPSHOT_RETENTION_DAYS", 0) * 24 * 3600_000,
    opportunitySnapshotRetentionMs: envNumber("OPPORTUNITY_SNAPSHOT_RETENTION_DAYS", 7) * 24 * 3600_000,
  };

  warnIgnoredStrategyEnv();

  const settingsPath = RUNTIME_SETTINGS_PATH;
  if (!existsSync(settingsPath)) {
    throw new Error(
      `[config] ${settingsPath} is required.\n` +
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
    // Anciens JSON sans maxShareEdge : même plafond que maxSharesPerOrder
    // (comportement d'avant, où l'edge réutilisait ce cap).
    if (!Object.prototype.hasOwnProperty.call(overlay, "maxShareEdge")) {
      config.maxShareEdge = config.maxSharesPerOrder;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[config] Runtime settings file is invalid.\n` +
        `  File: ${settingsPath}\n` +
        `  Error: ${message}\n` +
        `Refusing to start with potentially wrong settings.\n` +
        `Fix data/bot-settings.json.`,
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

export function validateConfigCoherence(
  config: BotConfig,
  opts?: { leadsWithEdge?: boolean },
): void {
  if (config.cheapBuyMin > config.cheapBuyMax) {
    throw new Error("CHEAP_BUY_MIN must be <= CHEAP_BUY_MAX");
  }
  if (config.expensiveBuyMin > config.expensiveBuyMax) {
    throw new Error("EXPENSIVE_BUY_MIN must be <= EXPENSIVE_BUY_MAX");
  }
  if (config.cheapBuyMax >= config.expensiveBuyMin) {
    throw new Error("CHEAP_BUY_MAX must be < EXPENSIVE_BUY_MIN");
  }
  // pairLockMax : moteur arb uniquement (barbell / reverse / edge-lead l'ignorent).
  if (config.strategyId === "arb") {
    if (config.pairLockMax < 0.90 || config.pairLockMax >= 1.00) {
      throw new Error("PAIR_LOCK_MAX must be between 0.90 and 0.99 (profit lock < 1.00)");
    }
    if (!config.enableExpensiveHedge) {
      throw new Error(
        "ENABLE_EXPENSIVE_HEDGE must be true when STRATEGY_ID=arb (B1 requires the favorite hedge)",
      );
    }
    if (
      config.arbAskSumMax !== null &&
      (config.arbAskSumMax < 0.90 ||
        config.arbAskSumMax > config.pairLockMax)
    ) {
      throw new Error(
        "ARB_ASK_SUM_MAX must be null or in [0.90, PAIR_LOCK_MAX]",
      );
    }
  }
  // barbellHedgeRatio : moteur barbell uniquement (ne plus bloquer arb).
  if (config.strategyId === "barbell") {
    if (!(config.barbellHedgeRatio > 0 && config.barbellHedgeRatio <= 1)) {
      throw new Error("BARBELL_HEDGE_RATIO must be in (0, 1]");
    }
  }
  if (
    config.strategyId === "reverse" &&
    config.reverseMaxGridLevels !== null &&
    config.reverseMaxGridLevels < 1
  ) {
    throw new Error("REVERSE_MAX_GRID_LEVELS must be null or >= 1");
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
  if (config.strategyId === "fav-band") {
    // Sticky flags from a previous arb/ask-lock profile must not leak:
    // fav-band is single-leg directional (no dual-FOK, no hedge).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (config.favBandAskMin >= config.favBandAskMax) {
      throw new Error("favBandAskMin must be < favBandAskMax");
    }
    if (config.favBandMinElapsedSec < 0) {
      throw new Error("favBandMinElapsedSec must be >= 0");
    }
    if (
      config.favBandMaxElapsedSec != null &&
      config.favBandMaxElapsedSec < config.favBandMinElapsedSec
    ) {
      throw new Error("favBandMaxElapsedSec must be >= favBandMinElapsedSec");
    }
    if (!(config.cheapOrderUsdc > 0)) {
      throw new Error("cheapOrderUsdc must be > 0 for fav-band");
    }
  }
  if (config.strategyId === "dip-revert") {
    // Dip-revert is single-leg directional (no hedge, no dual-FOK).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (config.dipRevertBandMin >= config.dipRevertBandMax) {
      throw new Error("dipRevertBandMin must be < dipRevertBandMax");
    }
    if (config.dipRevertMinDrop <= 0) {
      throw new Error("dipRevertMinDrop must be > 0");
    }
    if (config.dipRevertDropLookbackMs <= 0) {
      throw new Error("dipRevertDropLookbackMs must be > 0");
    }
    if (config.dipRevertMinElapsedSec < 0) {
      throw new Error("dipRevertMinElapsedSec must be >= 0");
    }
    if (config.dipRevertMaxSpread < 0) {
      throw new Error("dipRevertMaxSpread must be >= 0");
    }
    if (
      config.dipRevertMaxElapsedSec != null &&
      config.dipRevertMaxElapsedSec < config.dipRevertMinElapsedSec
    ) {
      throw new Error("dipRevertMaxElapsedSec must be >= dipRevertMinElapsedSec");
    }
    if (!(config.dipRevertOrderUsdc > 0)) {
      throw new Error("dipRevertOrderUsdc must be > 0 for dip-revert");
    }
  }
  const validateEdge =
    opts?.leadsWithEdge === true || config.strategyId === "edge-lead";
  if (validateEdge) {
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
    if (config.edgeOrderUsdc <= 0) {
      throw new Error("EDGE_ORDER_USDC must be > 0");
    }
    if (config.maxShareEdge < 1) {
      throw new Error("MAX_SHARE_EDGE must be >= 1");
    }
    if (config.edgeCheapOrderUsdc <= 0) {
      throw new Error("EDGE_CHEAP_ORDER_USDC must be > 0");
    }
    if (config.edgeCheapBandMin >= config.edgeCheapBandMax) {
      throw new Error("EDGE_CHEAP_BAND_MIN must be < EDGE_CHEAP_BAND_MAX");
    }
    if (config.edgeCheapBandMin < 0.01 || config.edgeCheapBandMax > 0.49) {
      throw new Error("EDGE_CHEAP_BAND must be within [0.01, 0.49]");
    }
    if (
      config.edgeSizingMode !== "shares" &&
      config.edgeSizingMode !== "pusd" &&
      config.edgeSizingMode !== "dynamic"
    ) {
      throw new Error(
        `EDGE_SIZING_MODE must be one of shares, pusd, dynamic (got ${config.edgeSizingMode})`,
      );
    }
    if (config.edgeSizingMode === "shares") {
      if (config.edgeSharesEdge < 5) {
        throw new Error("EDGE_SHARES_EDGE must be >= 5 (CLOB minimum)");
      }
      if (config.edgeSharesCheap < 5) {
        throw new Error("EDGE_SHARES_CHEAP must be >= 5 (CLOB minimum)");
      }
    }
    if (config.edgeSellExpensiveAfterMin < 0) {
      throw new Error("EDGE_SELL_EXPENSIVE_AFTER_MIN must be >= 0");
    }
    if (config.edgeSellExpensiveLossPct <= 0) {
      throw new Error("EDGE_SELL_EXPENSIVE_LOSS_PCT must be > 0");
    }
    if (config.edgeSellExpensiveLossWindowMs <= 0) {
      throw new Error("EDGE_SELL_EXPENSIVE_LOSS_WINDOW_MS must be > 0");
    }
  }
}

export function validateTradingConfig(
  config: BotConfig,
  opts?: { leadsWithEdge?: boolean },
): void {
  validateConfigCoherence(config, opts);

  if (config.simResolveFallback !== "none") {
    throw new Error(
      "SIM_RESOLVE_FALLBACK must be none in live mode so positions are never resolved by RNG.",
    );
  }

  if (config.readonlyLive) {
    if (!config.funderAddress) {
      throw new Error("FUNDER_ADDRESS is required for READONLY_LIVE balance display");
    }
    return;
  }

  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required for live trading");
  }
  if (!config.funderAddress) {
    throw new Error("FUNDER_ADDRESS is required for live trading");
  }
}
