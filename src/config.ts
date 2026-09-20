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
import { validateEngineBudget } from "./utils/prices.js";

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
  /**
   * ARB-ONLY : budget de la jambe cheap arb (calibré pour des prix 0.07-0.13,
   * où 1 USDC dépasse le plancher CLOB de 5 shares). Les autres moteurs ont
   * leur propre clé — ne pas réutiliser celle-ci (incident 2026-09-14 :
   * fav-band muet avec cheapOrderUsdc=1, jamais 5 shares dans la bande 0.70+).
   */
  cheapOrderUsdc: number;
  /** Fav-band : budget FOK favori (taille = budget / ask, plafonnée maxShares). */
  favBandOrderUsdc: number;
  /** Barbell : budget de la jambe cheap. */
  barbellCheapOrderUsdc: number;
  /** Reverse : budget de la jambe cheap (grid maker). */
  reverseCheapOrderUsdc: number;
  /** Custom (graph) : budget des ordres computeSize des graphs custom. */
  customOrderUsdc: number;
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
   * Hedge-inverse (default off): once the favorite leg is filled, post a
   * resting GTC BUY at favBandInverseAskMax on the OPPOSITE token. The order
   * fills INCREMENTALLY while the inverse ask dips to/below the limit
   * (partial fills persist, never cancelled). Size = favBandInverseShareRatio
   * × filled favorite shares (e.g. 2 = double the favorite shares), capped by
   * maxSharesPerOrder and the inverse budget. The leg rides the cheap-GTC
   * pipeline (no arb hedge gates).
   */
  favBandInverseEnabled: boolean;
  /** Hedge-inverse: resting GTC limit on the opposite token (0..0.5). */
  favBandInverseAskMax: number;
  /** Hedge-inverse: shares of the opposite token per filled favorite share. */
  favBandInverseShareRatio: number;
  /** Hedge-inverse: budget cap (USDC) for the opposite-token FOK buy. */
  favBandInverseOrderUsdc: number;
  /**
   * Whipsaw filter (default off). When enabled, fav-band may skip entries
   * based on pause-after-losses, max intra-window flips, and/or max score.
   * Score = flips + ask-range + prior winner flip rate + loss streak (0–100).
   * Research 2026-09-20: pause helps DD; hard score/flips gates often hurt PnL.
   */
  favBandWhipsawEnabled: boolean;
  /** Pause after N consecutive fav-band losses (null = pause off). */
  favBandWhipsawPauseAfterLosses: number | null;
  /** Windows to skip after a pause trigger (default 8). */
  favBandWhipsawPauseWindows: number;
  /** Skip entry when score >= this (null = score gate off). */
  favBandWhipsawMaxScore: number | null;
  /** Skip entry when intra-window favorite flips >= this (null = off). */
  favBandWhipsawMaxIntraFlips: number | null;
  /**
   * Deterioration exit (default off): after the entry fill, track the HELD
   * favorite's ask; when it prints `favBandExitConsecutive` confirmed plus-bas
   * (lower lows: each swing >= favBandExitMinLowerHighDrop, frozen by a
   * bounce of favBandExitRetraceRatio of that drop, capped at the swing and
   * floored at 1 tick), the trend is deteriorating — SELL the whole position
   * (FOK at the bid) instead of holding to resolution. Reclaiming the
   * structure high resets the count. A later extension below the last
   * plus-bas confirms on a 1-tick bounce (stairs / waterfall).
   */
  favBandExitEnabled: boolean;
  /** Deterioration exit: minimum swing size to print a plus-bas (e.g. 0.05 = 5¢). */
  favBandExitMinLowerHighDrop: number;
  /**
   * Deterioration exit: bounce / drop ratio that freezes a plus-bas (0 = 1 tick,
   * 0.5 = 50% retrace). Clamped to [1 tick, minSwing] so large dumps do not wait
   * for a full Fibonacci retrace. Default 0.25.
   */
  favBandExitRetraceRatio: number;
  /** Deterioration exit: consecutive lower lows required (default 3). */
  favBandExitConsecutive: number;
  /** Deterioration exit: sliding sample window (default 120000 = 120 s). */
  favBandExitLookbackMs: number;
  /** Deterioration exit: only fire after this many seconds into the window (0 = always). */
  favBandExitMinElapsedSec: number;
  /** Deterioration exit: only fire when the held ask is below the entry fill price. */
  favBandExitLossOnly: boolean;
  /**
   * Deterioration exit follow-up (default off): right after the exit SELL,
   * FOK-buy the OPPOSITE token at its current ask (switch sides), sized
   * favBandExitSwitchOrderUsdc / ask, capped by maxSharesPerOrder.
   */
  favBandExitSwitchEnabled: boolean;
  /** Deterioration exit follow-up: opposite-token FOK budget cap (USDC). */
  favBandExitSwitchOrderUsdc: number;
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
  /**
   * Dip-revert take-profit (optional, default off): when enabled, FOK-sell
   * the held favorite once ITS OWN ask >= dipRevertExitWin (early exit,
   * no hold to resolution). Priced on the held token's book; killed FOKs
   * hold to resolution.
   */
  dipRevertExitTakeProfitEnabled: boolean;
  /** Dip-revert take-profit threshold on the held favorite's ask (0..1). */
  dipRevertExitWinAsk: number;
  /**
   * Antiflip-revert: buy the DEPOSED favorite right after an identity flip
   * (empirical edge: the market overreacts; old favorite re-wins ~52% at
   * ~0.43). Flip must be fresh (<= flipLookbackMs) and the new favorite
   * uncertain (0.45-0.65); deposed ask must be in [bandMin, bandMax] and
   * >= deposedAskMin. Hold to resolve, no hedge.
   */
  antiflipBandMin: number;
  antiflipBandMax: number;
  antiflipDeposedAskMin: number;
  antiflipFlipLookbackMs: number;
  antiflipMinElapsedSec: number;
  /** Optional upper elapsed cap (null = until close / minutesBeforeClose). */
  antiflipMaxElapsedSec: number | null;
  antiflipMaxSpread: number;
  antiflipOrderUsdc: number;
  /**
   * Flip-confirm: buy the NEW favorite shortly after an early identity flip.
   * Entry window [flipConfirmMinElapsedSec, flipConfirmMaxElapsedSec] (the
   * FLIP itself only has to be <= flipConfirmFlipLookbackMs old); favorite
   * ask must be in [bandMin, bandMax]. Hold to resolve, no hedge.
   */
  flipConfirmBandMin: number;
  flipConfirmBandMax: number;
  flipConfirmFlipLookbackMs: number;
  flipConfirmMinElapsedSec: number;
  /** Optional upper elapsed cap (null = until close / minutesBeforeClose). */
  flipConfirmMaxElapsedSec: number | null;
  flipConfirmMaxSpread: number;
  flipConfirmOrderUsdc: number;
  /**
   * Early-conviction: buy the favorite when it ALREADY prices >= askMin
   * within the first [0, maxElapsedSec] seconds of the window (a market that
   * fixes instantly is a one-way trend). Hold to resolve, no hedge.
   */
  earlyConvictionAskMin: number;
  earlyConvictionAskMax: number;
  earlyConvictionMaxElapsedSec: number;
  earlyConvictionMaxSpread: number;
  earlyConvictionOrderUsdc: number;
  /**
   * Open-entry: buy the EMERGING favorite (|up-down| ask lead >= trigger)
   * within the first [0, maxElapsedSec] seconds of a FAIR open (askSum <=
   * fairAskSumMax at the current tick). Dual-scale stop-loss via the defend
   * pipeline: structural (opposite leads >= flipDist for >= confirmSec AND
   * held ask <= entry - dist) and late (after slLateAfterSec, held ask <=
   * entry - slLateDist). Hold to resolve otherwise, no hedge.
   */
  openEntryLeanTrigger: number;
  openEntryMaxElapsedSec: number;
  openEntryFairAskSumMax: number;
  openEntryMaxSpread: number;
  openEntryOrderUsdc: number;
  openEntrySlStructFlipDist: number;
  openEntrySlStructConfirmSec: number;
  openEntrySlStructDist: number;
  openEntrySlLateAfterSec: number;
  openEntrySlLateDist: number;
  /** Stop-loss dual-scale actif (défaut true = config backtestée). False = hold intégral. */
  openEntrySlEnabled: boolean;
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
    favBandOrderUsdc: 15,
    barbellCheapOrderUsdc: 15,
    reverseCheapOrderUsdc: 15,
    customOrderUsdc: 15,
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
    favBandInverseEnabled: false,
    favBandInverseAskMax: 0.2,
    favBandInverseShareRatio: 2,
    favBandInverseOrderUsdc: 15,
    favBandWhipsawEnabled: false,
    favBandWhipsawPauseAfterLosses: 3,
    favBandWhipsawPauseWindows: 8,
    favBandWhipsawMaxScore: null,
    favBandWhipsawMaxIntraFlips: null,
    favBandExitEnabled: false,
    favBandExitMinLowerHighDrop: 0.05,
    favBandExitRetraceRatio: 0.25,
    favBandExitConsecutive: 3,
    favBandExitLookbackMs: 120_000,
    favBandExitMinElapsedSec: 0,
    favBandExitLossOnly: true,
    favBandExitSwitchEnabled: false,
    favBandExitSwitchOrderUsdc: 15,
    dipRevertBandMin: 0.55,
    dipRevertBandMax: 0.65,
    dipRevertMinDrop: 0.03,
    dipRevertDropLookbackMs: 60_000,
    dipRevertMinElapsedSec: 180,
    dipRevertMaxElapsedSec: null,
    dipRevertMaxSpread: 0.04,
    dipRevertOrderUsdc: 15,
    dipRevertExitTakeProfitEnabled: false,
    dipRevertExitWinAsk: 0.85,
    antiflipBandMin: 0.35,
    antiflipBandMax: 0.45,
    antiflipDeposedAskMin: 0.40,
    antiflipFlipLookbackMs: 90_000,
    antiflipMinElapsedSec: 240,
    antiflipMaxElapsedSec: null,
    antiflipMaxSpread: 0.05,
    antiflipOrderUsdc: 15,
    flipConfirmBandMin: 0.55,
    flipConfirmBandMax: 0.65,
    flipConfirmFlipLookbackMs: 90_000,
    flipConfirmMinElapsedSec: 120,
    flipConfirmMaxElapsedSec: 180,
    flipConfirmMaxSpread: 0.05,
    flipConfirmOrderUsdc: 15,
    earlyConvictionAskMin: 0.60,
    earlyConvictionAskMax: 0.80,
    earlyConvictionMaxElapsedSec: 45,
    earlyConvictionMaxSpread: 0.05,
    earlyConvictionOrderUsdc: 15,
    openEntryLeanTrigger: 0.15,
    openEntryMaxElapsedSec: 300,
    openEntryFairAskSumMax: 1.02,
    openEntryMaxSpread: 0.04,
    openEntryOrderUsdc: 15,
    openEntrySlStructFlipDist: 0.2,
    openEntrySlStructConfirmSec: 20,
    openEntrySlStructDist: 0.1,
    openEntrySlLateAfterSec: 300,
    openEntrySlLateDist: 0.06,
    openEntrySlEnabled: true,
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
    // Migration configs par moteur (2026-09-14) : chaque moteur lit UNIQUEMENT
    // sa propre clé de budget (favBandOrderUsdc, barbellCheapOrderUsdc,
    // reverseCheapOrderUsdc, customOrderUsdc) — aucun héritage de
    // cheapOrderUsdc (ARB-ONLY). Un ancien JSON sans ces clés donne les défauts
    // 15 USDC ; c'est volontaire : 1 USDC était le bug du moteur fav-band muet.
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
    // Jambe cheap barbell : même bande de marché que l'arb, budget propre.
    validateEngineBudget(
      config.barbellCheapOrderUsdc,
      config.cheapBuyMax,
      "barbell cheap",
    );
  }
  if (
    config.strategyId === "reverse" &&
    config.reverseMaxGridLevels !== null &&
    config.reverseMaxGridLevels < 1
  ) {
    throw new Error("REVERSE_MAX_GRID_LEVELS must be null or >= 1");
  }
  if (config.strategyId === "reverse") {
    // Jambe cheap reverse : grid maker dans la bande cheap partagée.
    validateEngineBudget(
      config.reverseCheapOrderUsdc,
      config.cheapBuyMax,
      "reverse cheap",
    );
  }
  if (config.strategyId?.startsWith("custom:")) {
    // Custom (graph) : pas de bande statique → pire cas prix 0.99.
    validateEngineBudget(config.customOrderUsdc, 0.99, "custom graph");
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
    if (!(config.favBandOrderUsdc > 0)) {
      throw new Error("favBandOrderUsdc must be > 0 for fav-band");
    }
    // Viabilité du sizing : le budget doit atteindre MIN_CLOB_SHARES au pire
    // prix de la bande, sinon le moteur est muet silencieusement (incident
    // 2026-09-14 : cheapOrderUsdc=1 → 1/0.85 = 1.18 shares < 5, aucune
    // opportunité émise pendant 1h30).
    validateEngineBudget(
      config.favBandOrderUsdc,
      config.favBandAskMax,
      "fav-band",
    );
    if (config.favBandInverseEnabled) {
      if (
        !(
          config.favBandInverseAskMax > 0 && config.favBandInverseAskMax < 0.5
        )
      ) {
        throw new Error(
          "favBandInverseAskMax must be in (0, 0.5) — above 0.5 the opposite token is no longer the cheap side",
        );
      }
      if (!(config.favBandInverseShareRatio > 0)) {
        throw new Error("favBandInverseShareRatio must be > 0");
      }
      if (!(config.favBandInverseOrderUsdc > 0)) {
        throw new Error("favBandInverseOrderUsdc must be > 0");
      }
      // Budget viability: 5 shares × askMax at the inverse trigger ceiling.
      validateEngineBudget(
        config.favBandInverseOrderUsdc,
        config.favBandInverseAskMax,
        "fav-band inverse",
      );
      // The inverse leg is a SECOND leg per pair: with the directional entry
      // already occupying side slot 1, maxOpenPositionsPerSide = 1 would make
      // the feature silently unreachable (appendOpportunity side-count guard).
      if (config.maxOpenPositionsPerSide < 2) {
        throw new Error(
          "favBandInverseEnabled requires maxOpenPositionsPerSide >= 2 (favorite leg + inverse leg)",
        );
      }
    }

    if (config.favBandWhipsawEnabled) {
      if (
        config.favBandWhipsawPauseAfterLosses != null &&
        !(config.favBandWhipsawPauseAfterLosses >= 1)
      ) {
        throw new Error("favBandWhipsawPauseAfterLosses must be >= 1 when set");
      }
      if (!(config.favBandWhipsawPauseWindows >= 1)) {
        throw new Error("favBandWhipsawPauseWindows must be >= 1");
      }
      if (
        config.favBandWhipsawMaxScore != null &&
        (config.favBandWhipsawMaxScore < 0 || config.favBandWhipsawMaxScore > 100)
      ) {
        throw new Error("favBandWhipsawMaxScore must be in [0, 100] when set");
      }
      if (
        config.favBandWhipsawMaxIntraFlips != null &&
        !(config.favBandWhipsawMaxIntraFlips >= 1)
      ) {
        throw new Error("favBandWhipsawMaxIntraFlips must be >= 1 when set");
      }
    }
    if (config.favBandExitEnabled) {
      if (!(config.favBandExitMinLowerHighDrop > 0)) {
        throw new Error("favBandExitMinLowerHighDrop must be > 0");
      }
      if (
        !(config.favBandExitRetraceRatio >= 0) ||
        config.favBandExitRetraceRatio > 1
      ) {
        throw new Error("favBandExitRetraceRatio must be in [0, 1]");
      }
      if (!(config.favBandExitConsecutive >= 2)) {
        throw new Error("favBandExitConsecutive must be >= 2");
      }
      if (!(config.favBandExitLookbackMs > 0)) {
        throw new Error("favBandExitLookbackMs must be > 0");
      }
      if (!(config.favBandExitMinElapsedSec >= 0)) {
        throw new Error("favBandExitMinElapsedSec must be >= 0");
      }
      if (config.favBandExitSwitchEnabled) {
        if (!(config.favBandExitSwitchOrderUsdc > 0)) {
          throw new Error("favBandExitSwitchOrderUsdc must be > 0");
        }
        // The opposite token can trade anywhere in (0, 1): worst case 0.99.
        validateEngineBudget(
          config.favBandExitSwitchOrderUsdc,
          0.99,
          "fav-band exit switch",
        );
        // The switch leg is a SECOND leg per pair: the sold entry leg keeps
        // counting in countLegsByKind, so with maxOpenPositionsPerSide = 1
        // the emission would be silently blocked (appendOpportunity guard).
        if (config.maxOpenPositionsPerSide < 2) {
          throw new Error(
            "favBandExitSwitchEnabled requires maxOpenPositionsPerSide >= 2 (entry leg + switch leg)",
          );
        }
      }
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
    validateEngineBudget(
      config.dipRevertOrderUsdc,
      config.dipRevertBandMax,
      "dip-revert",
    );
    if (config.dipRevertExitTakeProfitEnabled) {
      if (
        !(config.dipRevertExitWinAsk > 0 && config.dipRevertExitWinAsk < 1)
      ) {
        throw new Error("dipRevertExitWinAsk must be in (0, 1)");
      }
      if (config.dipRevertExitWinAsk <= config.dipRevertBandMax) {
        throw new Error(
          "dipRevertExitWinAsk must be > dipRevertBandMax (exit above entry band)",
        );
      }
    }
  }
  if (config.strategyId === "antiflip-revert") {
    // Single-leg directional (no hedge, no dual-FOK).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (config.antiflipBandMin >= config.antiflipBandMax) {
      throw new Error("antiflipBandMin must be < antiflipBandMax");
    }
    if (
      config.antiflipDeposedAskMin != null &&
      (config.antiflipDeposedAskMin < config.antiflipBandMin ||
        config.antiflipDeposedAskMin > config.antiflipBandMax)
    ) {
      throw new Error(
        "antiflipDeposedAskMin must be null or within [antiflipBandMin, antiflipBandMax]",
      );
    }
    if (config.antiflipFlipLookbackMs <= 0) {
      throw new Error("antiflipFlipLookbackMs must be > 0");
    }
    if (config.antiflipMinElapsedSec < 0) {
      throw new Error("antiflipMinElapsedSec must be >= 0");
    }
    if (
      config.antiflipMaxElapsedSec != null &&
      config.antiflipMaxElapsedSec < config.antiflipMinElapsedSec
    ) {
      throw new Error("antiflipMaxElapsedSec must be >= antiflipMinElapsedSec");
    }
    if (config.antiflipMaxSpread < 0) {
      throw new Error("antiflipMaxSpread must be >= 0");
    }
    if (!(config.antiflipOrderUsdc > 0)) {
      throw new Error("antiflipOrderUsdc must be > 0 for antiflip-revert");
    }
    validateEngineBudget(
      config.antiflipOrderUsdc,
      config.antiflipBandMax,
      "antiflip-revert",
    );
  }
  if (config.strategyId === "flip-confirm") {
    // Single-leg directional (no hedge, no dual-FOK).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (config.flipConfirmBandMin >= config.flipConfirmBandMax) {
      throw new Error("flipConfirmBandMin must be < flipConfirmBandMax");
    }
    if (config.flipConfirmFlipLookbackMs <= 0) {
      throw new Error("flipConfirmFlipLookbackMs must be > 0");
    }
    if (config.flipConfirmMinElapsedSec < 0) {
      throw new Error("flipConfirmMinElapsedSec must be >= 0");
    }
    if (
      config.flipConfirmMaxElapsedSec != null &&
      config.flipConfirmMaxElapsedSec < config.flipConfirmMinElapsedSec
    ) {
      throw new Error(
        "flipConfirmMaxElapsedSec must be >= flipConfirmMinElapsedSec",
      );
    }
    if (config.flipConfirmMaxSpread < 0) {
      throw new Error("flipConfirmMaxSpread must be >= 0");
    }
    if (!(config.flipConfirmOrderUsdc > 0)) {
      throw new Error("flipConfirmOrderUsdc must be > 0 for flip-confirm");
    }
    validateEngineBudget(
      config.flipConfirmOrderUsdc,
      config.flipConfirmBandMax,
      "flip-confirm",
    );
  }
  if (config.strategyId === "early-conviction") {
    // Single-leg directional (no hedge, no dual-FOK).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (config.earlyConvictionAskMin >= config.earlyConvictionAskMax) {
      throw new Error("earlyConvictionAskMin must be < earlyConvictionAskMax");
    }
    if (config.earlyConvictionAskMin < 0.5) {
      throw new Error(
        "earlyConvictionAskMin must be >= 0.5 (a 'favorite' below 0.5 is not a favorite)",
      );
    }
    if (
      !(config.earlyConvictionMaxElapsedSec > 0 && config.earlyConvictionMaxElapsedSec <= 900)
    ) {
      throw new Error("earlyConvictionMaxElapsedSec must be in (0, 900]");
    }
    if (config.earlyConvictionMaxSpread < 0) {
      throw new Error("earlyConvictionMaxSpread must be >= 0");
    }
    if (!(config.earlyConvictionOrderUsdc > 0)) {
      throw new Error("earlyConvictionOrderUsdc must be > 0 for early-conviction");
    }
    validateEngineBudget(
      config.earlyConvictionOrderUsdc,
      config.earlyConvictionAskMax,
      "early-conviction",
    );
  }
  if (config.strategyId === "open-entry") {
    // Single-leg directional (no hedge, no dual-FOK).
    config.arbAskLockOnly = false;
    config.enableExpensiveHedge = false;
    if (
      !(config.openEntryLeanTrigger > 0 && config.openEntryLeanTrigger <= 0.5)
    ) {
      throw new Error("openEntryLeanTrigger must be in (0, 0.5]");
    }
    if (
      !(
        config.openEntryMaxElapsedSec > 0 &&
        config.openEntryMaxElapsedSec <= 900
      )
    ) {
      throw new Error("openEntryMaxElapsedSec must be in (0, 900]");
    }
    if (
      !(
        config.openEntryFairAskSumMax > 1 &&
        config.openEntryFairAskSumMax <= 1.2
      )
    ) {
      throw new Error("openEntryFairAskSumMax must be in (1, 1.2]");
    }
    if (config.openEntryMaxSpread < 0) {
      throw new Error("openEntryMaxSpread must be >= 0");
    }
    if (!(config.openEntryOrderUsdc > 0)) {
      throw new Error("openEntryOrderUsdc must be > 0 for open-entry");
    }
    if (
      !(
        config.openEntrySlStructFlipDist > 0 &&
        config.openEntrySlStructFlipDist <= 1
      )
    ) {
      throw new Error("openEntrySlStructFlipDist must be in (0, 1]");
    }
    if (
      !(
        config.openEntrySlStructConfirmSec >= 0 &&
        config.openEntrySlStructConfirmSec <= 900
      )
    ) {
      throw new Error("openEntrySlStructConfirmSec must be in [0, 900]");
    }
    if (
      !(
        config.openEntrySlStructDist > 0 &&
        config.openEntrySlStructDist <= 1
      )
    ) {
      throw new Error("openEntrySlStructDist must be in (0, 1]");
    }
    if (
      !(
        config.openEntrySlLateAfterSec > 0 &&
        config.openEntrySlLateAfterSec <= 900
      )
    ) {
      throw new Error("openEntrySlLateAfterSec must be in (0, 900]");
    }
    if (
      !(
        config.openEntrySlLateDist > 0 &&
        config.openEntrySlLateDist <= config.openEntrySlStructDist
      )
    ) {
      throw new Error(
        "openEntrySlLateDist must be in (0, openEntrySlStructDist] (the late stop is the TIGHTER one)",
      );
    }
    validateEngineBudget(
      config.openEntryOrderUsdc,
      (config.openEntryFairAskSumMax - 1) / 2 + 0.5,
      "open-entry",
    );
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
    validateEngineBudget(
      config.edgeCheapOrderUsdc,
      config.edgeCheapBandMax,
      "edge-lead cheap",
    );
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
