import type { BotConfig, StrategyId } from "../types";
import { engineUsesEdge } from "../config/strategyPresets";

export type ConfigFormState = {
  marketSlugPrefixes: string;
  cheapBuyMin: string;
  cheapBuyMax: string;
  expensiveBuyMin: string;
  expensiveBuyMax: string;
  enableExpensiveHedge: boolean;
  requireCheapFillBeforeExpensive: boolean;
  cheapOrderUsdc: string;
  favBandOrderUsdc: string;
  barbellCheapOrderUsdc: string;
  reverseCheapOrderUsdc: string;
  customOrderUsdc: string;
  strategyId: StrategyId;
  barbellHedgeRatio: string;
  pairLockMax: string;
  arbAskLockOnly: boolean;
  arbAskSumMax: string;
  arbAskLockMinElapsedSec: string;
  arbAskLockMaxImbalance: string;
  expensiveOrderUsdc: string;
  expensiveOrderType: "FOK" | "GTC";
  maxSharesPerOrder: string;
  maxOpenPositionsPerSide: string;
  maxExposureUsdc: string;
  minutesBeforeCloseMin: string;
  minutesBeforeCloseMax: string;
  minMinutesBeforeCloseToBuy: string;
  pollIntervalMs: string;
  simulatedCapital: string;
  simFillProbabilityNonMarketable: string;
  simResolveDelaySeconds: string;
  simResolveRetryIntervalMs: string;
  simResolveMaxRetries: string;
  simResolveFallback: "none" | "probabilistic";
  simMaxRetryAttempts: string;
  simRandomSeed: string;
  edgeBandMin: string;
  edgeBandMax: string;
  edgeConfirmSamples: string;
  edgeMaxDownTick: string;
  edgeOrderUsdc: string;
  maxShareEdge: string;
  edgeCheapOrderUsdc: string;
  edgeCheapBandMin: string;
  edgeCheapBandMax: string;
  edgeSizingMode: "shares" | "pusd" | "dynamic";
  edgeSharesEdge: string;
  edgeSharesCheap: string;
  edgeSellExpensiveEnabled: boolean;
  edgeSellExpensiveAfterMin: string;
  edgeSellExpensiveLossPct: string;
  edgeSellExpensiveLossWindowMs: string;
  edgeRequireCheapReady: boolean;
  edgeAskSumMax: string;
  reverseCancelCheapOffBand: boolean;
  reverseDefendEnabled: boolean;
  reverseMaxGridLevels: string;
  reverseHedgeCapToFilledCheap: boolean;
  favBandAskMin: string;
  favBandAskMax: string;
  favBandMinElapsedSec: string;
  favBandMaxElapsedSec: string;
  favBandInverseEnabled: boolean;
  favBandInverseAskMax: string;
  favBandInverseShareRatio: string;
  favBandInverseOrderUsdc: string;
  favBandWhipsawEnabled: boolean;
  favBandWhipsawPauseAfterLosses: string;
  favBandWhipsawPauseWindows: string;
  favBandWhipsawMaxScore: string;
  favBandWhipsawMaxIntraFlips: string;
  favBandImbalanceEnabled: boolean;
  favBandImbalanceCrossMin: string;
  favBandImbalanceTicks: string;
  favBandImbalanceMaxSpread: string;
  favBandExitEnabled: boolean;
  favBandExitMinLowerHighDrop: string;
  favBandExitRetraceRatio: string;
  favBandExitConsecutive: string;
  favBandExitLookbackMs: string;
  favBandExitMinElapsedSec: string;
  favBandExitLossOnly: boolean;
  favBandExitSwitchEnabled: boolean;
  favBandExitSwitchOrderUsdc: string;
  dipRevertBandMin: string;
  dipRevertBandMax: string;
  dipRevertMinDrop: string;
  dipRevertDropLookbackMs: string;
  dipRevertMinElapsedSec: string;
  dipRevertMaxElapsedSec: string;
  dipRevertMaxSpread: string;
  dipRevertOrderUsdc: string;
  dipRevertExitTakeProfitEnabled: boolean;
  dipRevertExitWinAsk: string;
  antiflipBandMin: string;
  antiflipBandMax: string;
  antiflipDeposedAskMin: string;
  antiflipFlipLookbackMs: string;
  antiflipMinElapsedSec: string;
  antiflipMaxElapsedSec: string;
  antiflipMaxSpread: string;
  antiflipOrderUsdc: string;
  antiflip5mOnly: boolean;
  antiflipEntryDelaySec: string;
  antiflipSharpDropMin: string;
  antiflipBounceMin: string;
  antiflipBounceFloor: string;
  antiflipTakeProfitPct: string;
  antiflipFavAskMin: string;
  antiflipFavAskMax: string;
  flipConfirmBandMin: string;
  flipConfirmBandMax: string;
  flipConfirmFlipLookbackMs: string;
  flipConfirmMinElapsedSec: string;
  flipConfirmMaxElapsedSec: string;
  flipConfirmMaxSpread: string;
  flipConfirmOrderUsdc: string;
  earlyConvictionAskMin: string;
  earlyConvictionAskMax: string;
  earlyConvictionMaxElapsedSec: string;
  earlyConvictionMaxSpread: string;
  earlyConvictionOrderUsdc: string;
  earlyLowBuyAskMin: string;
  earlyLowBuyAskMax: string;
  earlyLowMaxElapsedSec: string;
  earlyLowMaxSpread: string;
  earlyLowOrderUsdc: string;
  earlyLowExitEnabled: boolean;
  earlyLowExitAsk: string;
  earlyLowExitMomentumMin: string;
  earlyLow15mOnly: boolean;
  openEntryLeanTrigger: string;
  openEntryMaxElapsedSec: string;
  openEntryFairAskSumMax: string;
  openEntryMaxSpread: string;
  openEntryOrderUsdc: string;
  openEntrySlStructFlipDist: string;
  openEntrySlStructConfirmSec: string;
  openEntrySlStructDist: string;
  openEntrySlLateAfterSec: string;
  openEntrySlLateDist: string;
  openEntrySlEnabled: boolean;
  repricingFeedMaxAgeMs: string;
  repricingTauMinSec: string;
  repricingSpreadMax: string;
  repricingPEntryMax: string;
  repricingEdgeMin: string;
  repricingOrderUsdc: string;
  repricingTargetAbs: string;
  repricingTargetRel: string;
  repricingStopAbs: string;
  repricingHoldMaxSec: string;
  repricingTauForceExitSec: string;
  repricingSpreadMaxExit: string;
  repricingLateWindowSec: string;
  repricingSignalTtlMs: string;
  repricingDislocationMin: string;
  repricingHistoryWindowMs: string;
  repricingModeAEnabled: boolean;
  repricingFeesRoundtrip: string;
  repricingSlipEntryBuffer: string;
  repricingSlipExitBuffer: string;
  repricingNotionalMaxPerMarket: string;
};

export function configToForm(config: BotConfig): ConfigFormState {
  return {
    marketSlugPrefixes: config.marketSlugPrefixes.join(", "),
    cheapBuyMin: String(config.cheapBuyMin),
    cheapBuyMax: String(config.cheapBuyMax),
    expensiveBuyMin: String(config.expensiveBuyMin),
    expensiveBuyMax: String(config.expensiveBuyMax),
    enableExpensiveHedge: config.enableExpensiveHedge,
    requireCheapFillBeforeExpensive: config.requireCheapFillBeforeExpensive !== false,
    cheapOrderUsdc: String(config.cheapOrderUsdc),
    favBandOrderUsdc: String(config.favBandOrderUsdc ?? 15),
    barbellCheapOrderUsdc: String(config.barbellCheapOrderUsdc ?? 15),
    reverseCheapOrderUsdc: String(config.reverseCheapOrderUsdc ?? 15),
    customOrderUsdc: String(config.customOrderUsdc ?? 15),
    strategyId: config.strategyId ?? "arb",
    barbellHedgeRatio: String(config.barbellHedgeRatio ?? 0.5),
    pairLockMax: String(config.pairLockMax),
    arbAskLockOnly: config.arbAskLockOnly === true,
    arbAskSumMax:
      config.arbAskSumMax === null || config.arbAskSumMax === undefined
        ? ""
        : String(config.arbAskSumMax),
    arbAskLockMinElapsedSec:
      config.arbAskLockMinElapsedSec === null || config.arbAskLockMinElapsedSec === undefined
        ? ""
        : String(config.arbAskLockMinElapsedSec),
    arbAskLockMaxImbalance:
      config.arbAskLockMaxImbalance === null || config.arbAskLockMaxImbalance === undefined
        ? ""
        : String(config.arbAskLockMaxImbalance),
    expensiveOrderUsdc: String(config.expensiveOrderUsdc),
    expensiveOrderType: config.expensiveOrderType,
    maxSharesPerOrder: String(config.maxSharesPerOrder),
    maxOpenPositionsPerSide: String(config.maxOpenPositionsPerSide),
    maxExposureUsdc: String(config.maxExposureUsdc),
    minutesBeforeCloseMin: String(config.minutesBeforeCloseMin),
    minutesBeforeCloseMax: String(config.minutesBeforeCloseMax),
    minMinutesBeforeCloseToBuy:
      config.minMinutesBeforeCloseToBuy === null
        ? ""
        : String(config.minMinutesBeforeCloseToBuy),
    pollIntervalMs: String(config.pollIntervalMs),
    simulatedCapital: String(config.simulatedCapital),
    simFillProbabilityNonMarketable: String(config.simFillProbabilityNonMarketable),
    simResolveDelaySeconds: String(config.simResolveDelaySeconds),
    simResolveRetryIntervalMs: String(config.simResolveRetryIntervalMs),
    simResolveMaxRetries: String(config.simResolveMaxRetries),
    simResolveFallback: config.simResolveFallback,
    simMaxRetryAttempts: String(config.simMaxRetryAttempts),
    simRandomSeed: config.simRandomSeed ?? "",
    edgeBandMin: String(config.edgeBandMin),
    edgeBandMax: String(config.edgeBandMax),
    edgeConfirmSamples: String(config.edgeConfirmSamples),
    edgeMaxDownTick: String(config.edgeMaxDownTick),
    edgeOrderUsdc: String(config.edgeOrderUsdc),
    maxShareEdge: String(config.maxShareEdge ?? config.maxSharesPerOrder ?? 20),
    edgeCheapOrderUsdc: String(config.edgeCheapOrderUsdc),
    edgeCheapBandMin: String(config.edgeCheapBandMin),
    edgeCheapBandMax: String(config.edgeCheapBandMax),
    edgeSizingMode: config.edgeSizingMode ?? "dynamic",
    edgeSharesEdge: String(config.edgeSharesEdge ?? 20),
    edgeSharesCheap: String(config.edgeSharesCheap ?? 20),
    edgeSellExpensiveEnabled: config.edgeSellExpensiveEnabled ?? true,
    edgeSellExpensiveAfterMin: String(config.edgeSellExpensiveAfterMin ?? 8),
    edgeSellExpensiveLossPct: String(config.edgeSellExpensiveLossPct ?? 10),
    edgeSellExpensiveLossWindowMs: String(config.edgeSellExpensiveLossWindowMs ?? 10000),
    edgeRequireCheapReady: config.edgeRequireCheapReady === true,
    edgeAskSumMax: config.edgeAskSumMax == null ? "" : String(config.edgeAskSumMax),
    reverseCancelCheapOffBand: config.reverseCancelCheapOffBand === true,
    reverseDefendEnabled: config.reverseDefendEnabled === true,
    reverseMaxGridLevels:
      config.reverseMaxGridLevels == null ? "" : String(config.reverseMaxGridLevels),
    reverseHedgeCapToFilledCheap: config.reverseHedgeCapToFilledCheap === true,
    favBandAskMin: String(config.favBandAskMin ?? 0.7),
    favBandAskMax: String(config.favBandAskMax ?? 0.85),
    favBandMinElapsedSec: String(config.favBandMinElapsedSec ?? 200),
    favBandMaxElapsedSec:
      config.favBandMaxElapsedSec == null || config.favBandMaxElapsedSec === undefined
        ? ""
        : String(config.favBandMaxElapsedSec),
    favBandInverseEnabled: config.favBandInverseEnabled === true,
    favBandInverseAskMax: String(config.favBandInverseAskMax ?? 0.2),
    favBandInverseShareRatio: String(config.favBandInverseShareRatio ?? 2),
    favBandInverseOrderUsdc: String(config.favBandInverseOrderUsdc ?? 15),
    favBandWhipsawEnabled: config.favBandWhipsawEnabled === true,
    favBandExitEnabled: config.favBandExitEnabled === true,
    favBandExitMinLowerHighDrop: String(config.favBandExitMinLowerHighDrop ?? 0.05),
    favBandExitRetraceRatio: String(config.favBandExitRetraceRatio ?? 0.25),
    favBandExitConsecutive: String(config.favBandExitConsecutive ?? 3),
    favBandExitLookbackMs: String(config.favBandExitLookbackMs ?? 120000),
    favBandExitMinElapsedSec: String(config.favBandExitMinElapsedSec ?? 0),
    favBandExitLossOnly: config.favBandExitLossOnly !== false,
    favBandExitSwitchEnabled: config.favBandExitSwitchEnabled === true,
    favBandExitSwitchOrderUsdc: String(config.favBandExitSwitchOrderUsdc ?? 15),
    favBandWhipsawPauseAfterLosses:
      config.favBandWhipsawPauseAfterLosses == null
        ? ""
        : String(config.favBandWhipsawPauseAfterLosses),
    favBandWhipsawPauseWindows: String(config.favBandWhipsawPauseWindows ?? 8),
    favBandWhipsawMaxScore:
      config.favBandWhipsawMaxScore == null || config.favBandWhipsawMaxScore === undefined
        ? ""
        : String(config.favBandWhipsawMaxScore),
    favBandWhipsawMaxIntraFlips:
      config.favBandWhipsawMaxIntraFlips == null || config.favBandWhipsawMaxIntraFlips === undefined
        ? ""
        : String(config.favBandWhipsawMaxIntraFlips),
    favBandImbalanceEnabled: config.favBandImbalanceEnabled === true,
    favBandImbalanceCrossMin:
      config.favBandImbalanceCrossMin == null || config.favBandImbalanceCrossMin === undefined
        ? ""
        : String(config.favBandImbalanceCrossMin),
    favBandImbalanceTicks:
      config.favBandImbalanceTicks == null || config.favBandImbalanceTicks === undefined
        ? ""
        : String(config.favBandImbalanceTicks),
    favBandImbalanceMaxSpread:
      config.favBandImbalanceMaxSpread == null || config.favBandImbalanceMaxSpread === undefined
        ? ""
        : String(config.favBandImbalanceMaxSpread),
    dipRevertBandMin: String(config.dipRevertBandMin ?? 0.55),
    dipRevertBandMax: String(config.dipRevertBandMax ?? 0.65),
    dipRevertMinDrop: String(config.dipRevertMinDrop ?? 0.03),
    dipRevertDropLookbackMs: String(config.dipRevertDropLookbackMs ?? 60000),
    dipRevertMinElapsedSec: String(config.dipRevertMinElapsedSec ?? 180),
    dipRevertMaxElapsedSec:
      config.dipRevertMaxElapsedSec == null || config.dipRevertMaxElapsedSec === undefined
        ? ""
        : String(config.dipRevertMaxElapsedSec),
    dipRevertMaxSpread: String(config.dipRevertMaxSpread ?? 0.04),
    dipRevertOrderUsdc: String(config.dipRevertOrderUsdc ?? 15),
    dipRevertExitTakeProfitEnabled: config.dipRevertExitTakeProfitEnabled === true,
    dipRevertExitWinAsk: String(config.dipRevertExitWinAsk ?? 0.85),
    antiflipBandMin: String(config.antiflipBandMin ?? 0.35),
    antiflipBandMax: String(config.antiflipBandMax ?? 0.45),
    antiflipDeposedAskMin:
      config.antiflipDeposedAskMin == null ? "" : String(config.antiflipDeposedAskMin),
    antiflipFlipLookbackMs: String(config.antiflipFlipLookbackMs ?? 90000),
    antiflipMinElapsedSec: String(config.antiflipMinElapsedSec ?? 240),
    antiflipMaxElapsedSec:
      config.antiflipMaxElapsedSec == null || config.antiflipMaxElapsedSec === undefined
        ? ""
        : String(config.antiflipMaxElapsedSec),
    antiflipMaxSpread: String(config.antiflipMaxSpread ?? 0.05),
    antiflipOrderUsdc: String(config.antiflipOrderUsdc ?? 15),
    antiflip5mOnly: config.antiflip5mOnly === true,
    antiflipEntryDelaySec: String(config.antiflipEntryDelaySec ?? 0),
    antiflipSharpDropMin: String(config.antiflipSharpDropMin ?? 0),
    antiflipBounceMin: String(config.antiflipBounceMin ?? 0),
    antiflipBounceFloor:
      config.antiflipBounceFloor == null ? "" : String(config.antiflipBounceFloor),
    antiflipTakeProfitPct: String(config.antiflipTakeProfitPct ?? 0),
    antiflipFavAskMin: String(config.antiflipFavAskMin ?? 0.45),
    antiflipFavAskMax: String(config.antiflipFavAskMax ?? 0.65),
    flipConfirmBandMin: String(config.flipConfirmBandMin ?? 0.55),
    flipConfirmBandMax: String(config.flipConfirmBandMax ?? 0.65),
    flipConfirmFlipLookbackMs: String(config.flipConfirmFlipLookbackMs ?? 90000),
    flipConfirmMinElapsedSec: String(config.flipConfirmMinElapsedSec ?? 120),
    flipConfirmMaxElapsedSec:
      config.flipConfirmMaxElapsedSec == null || config.flipConfirmMaxElapsedSec === undefined
        ? ""
        : String(config.flipConfirmMaxElapsedSec),
    flipConfirmMaxSpread: String(config.flipConfirmMaxSpread ?? 0.05),
    flipConfirmOrderUsdc: String(config.flipConfirmOrderUsdc ?? 15),
    earlyConvictionAskMin: String(config.earlyConvictionAskMin ?? 0.6),
    earlyConvictionAskMax: String(config.earlyConvictionAskMax ?? 0.8),
    earlyConvictionMaxElapsedSec: String(config.earlyConvictionMaxElapsedSec ?? 45),
    earlyConvictionMaxSpread: String(config.earlyConvictionMaxSpread ?? 0.05),
    earlyConvictionOrderUsdc: String(config.earlyConvictionOrderUsdc ?? 15),
    earlyLowBuyAskMin: String(config.earlyLowBuyAskMin ?? 0),
    earlyLowBuyAskMax: String(config.earlyLowBuyAskMax ?? 0.12),
    earlyLowMaxElapsedSec: String(config.earlyLowMaxElapsedSec ?? 150),
    earlyLowMaxSpread: String(config.earlyLowMaxSpread ?? 0.06),
    earlyLowOrderUsdc: String(config.earlyLowOrderUsdc ?? 1),
    earlyLowExitEnabled: config.earlyLowExitEnabled === true,
    earlyLowExitAsk: String(config.earlyLowExitAsk ?? 0.4),
    earlyLowExitMomentumMin: String(config.earlyLowExitMomentumMin ?? 0),
    earlyLow15mOnly: config.earlyLow15mOnly !== false,
    openEntryLeanTrigger: String(config.openEntryLeanTrigger ?? 0.15),
    openEntryMaxElapsedSec: String(config.openEntryMaxElapsedSec ?? 300),
    openEntryFairAskSumMax: String(config.openEntryFairAskSumMax ?? 1.02),
    openEntryMaxSpread: String(config.openEntryMaxSpread ?? 0.04),
    openEntryOrderUsdc: String(config.openEntryOrderUsdc ?? 15),
    openEntrySlStructFlipDist: String(config.openEntrySlStructFlipDist ?? 0.2),
    openEntrySlStructConfirmSec: String(config.openEntrySlStructConfirmSec ?? 20),
    openEntrySlStructDist: String(config.openEntrySlStructDist ?? 0.1),
    openEntrySlLateAfterSec: String(config.openEntrySlLateAfterSec ?? 300),
    openEntrySlLateDist: String(config.openEntrySlLateDist ?? 0.06),
    openEntrySlEnabled: config.openEntrySlEnabled !== false,
    repricingFeedMaxAgeMs: String(config.repricingFeedMaxAgeMs ?? 250),
    repricingTauMinSec: String(config.repricingTauMinSec ?? 90),
    repricingSpreadMax: String(config.repricingSpreadMax ?? 0.03),
    repricingPEntryMax: String(config.repricingPEntryMax ?? 0.22),
    repricingEdgeMin: String(config.repricingEdgeMin ?? 0.025),
    repricingOrderUsdc: String(config.repricingOrderUsdc ?? 15),
    repricingTargetAbs: String(config.repricingTargetAbs ?? 0.06),
    repricingTargetRel: String(config.repricingTargetRel ?? 0),
    repricingStopAbs: String(config.repricingStopAbs ?? 0.08),
    repricingHoldMaxSec: String(config.repricingHoldMaxSec ?? 120),
    repricingTauForceExitSec: String(config.repricingTauForceExitSec ?? 25),
    repricingSpreadMaxExit: String(config.repricingSpreadMaxExit ?? 0.05),
    repricingLateWindowSec: String(config.repricingLateWindowSec ?? 45),
    repricingSignalTtlMs: String(config.repricingSignalTtlMs ?? 3000),
    repricingDislocationMin: String(config.repricingDislocationMin ?? 1.0),
    repricingHistoryWindowMs: String(config.repricingHistoryWindowMs ?? 15000),
    repricingModeAEnabled: config.repricingModeAEnabled === true,
    repricingFeesRoundtrip: String(config.repricingFeesRoundtrip ?? 0.002),
    repricingSlipEntryBuffer: String(config.repricingSlipEntryBuffer ?? 0.005),
    repricingSlipExitBuffer: String(config.repricingSlipExitBuffer ?? 0.005),
    repricingNotionalMaxPerMarket: String(config.repricingNotionalMaxPerMarket ?? 30),
  };
}

function parseNum(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} : nombre invalide`);
  }
  return parsed;
}

export function formToSettings(form: ConfigFormState): Partial<BotConfig> {
  const next: Partial<BotConfig> = {
    marketSlugPrefixes: form.marketSlugPrefixes
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
    cheapBuyMin: parseNum(form.cheapBuyMin, "Cheap min"),
    cheapBuyMax: parseNum(form.cheapBuyMax, "Cheap max"),
    expensiveBuyMin: parseNum(form.expensiveBuyMin, "Hedge min"),
    expensiveBuyMax: parseNum(form.expensiveBuyMax, "Hedge max"),
    enableExpensiveHedge:
      form.strategyId === "arb"
        ? true
        : form.strategyId === "fav-band" || form.strategyId === "dip-revert"
          ? false
          : form.enableExpensiveHedge,
    requireCheapFillBeforeExpensive: form.requireCheapFillBeforeExpensive,
    cheapOrderUsdc: parseNum(form.cheapOrderUsdc, "Cheap order USDC"),
    favBandOrderUsdc: parseNum(form.favBandOrderUsdc, "Fav-band order USDC"),
    barbellCheapOrderUsdc: parseNum(form.barbellCheapOrderUsdc, "Barbell cheap USDC"),
    reverseCheapOrderUsdc: parseNum(form.reverseCheapOrderUsdc, "Reverse cheap USDC"),
    customOrderUsdc: parseNum(form.customOrderUsdc, "Custom order USDC"),
    strategyId: form.strategyId,
    barbellHedgeRatio: parseNum(form.barbellHedgeRatio, "Ratio hedge"),
    pairLockMax: parseNum(form.pairLockMax, "Pair lock max"),
    arbAskLockOnly: form.arbAskLockOnly,
    arbAskSumMax:
      form.arbAskSumMax.trim() === ""
        ? null
        : parseNum(form.arbAskSumMax, "Ask-lock sum max"),
    arbAskLockMinElapsedSec:
      form.arbAskLockMinElapsedSec.trim() === ""
        ? null
        : parseNum(form.arbAskLockMinElapsedSec, "Ask-lock min elapsed sec"),
    arbAskLockMaxImbalance:
      form.arbAskLockMaxImbalance.trim() === ""
        ? null
        : parseNum(form.arbAskLockMaxImbalance, "Ask-lock max imbalance"),
    expensiveOrderUsdc: parseNum(form.expensiveOrderUsdc, "Plafond hedge USDC"),
    expensiveOrderType: form.expensiveOrderType,
    maxSharesPerOrder: parseNum(form.maxSharesPerOrder, "Max shares"),
    maxOpenPositionsPerSide: parseNum(form.maxOpenPositionsPerSide, "Max positions"),
    maxExposureUsdc: parseNum(form.maxExposureUsdc, "Max exposure"),
    minutesBeforeCloseMin: parseNum(form.minutesBeforeCloseMin, "Minutes min"),
    minutesBeforeCloseMax: parseNum(form.minutesBeforeCloseMax, "Minutes max"),
    minMinutesBeforeCloseToBuy:
      form.minMinutesBeforeCloseToBuy.trim() === ""
        ? null
        : parseNum(form.minMinutesBeforeCloseToBuy, "Min minutes before close"),
    pollIntervalMs: parseNum(form.pollIntervalMs, "Poll interval"),
    simulatedCapital: parseNum(form.simulatedCapital, "Simulated capital"),
    simFillProbabilityNonMarketable: parseNum(
      form.simFillProbabilityNonMarketable,
      "Fill probability",
    ),
    simResolveDelaySeconds: parseNum(form.simResolveDelaySeconds, "Resolve delay"),
    simResolveRetryIntervalMs: parseNum(
      form.simResolveRetryIntervalMs,
      "Resolve retry interval",
    ),
    simResolveMaxRetries: parseNum(form.simResolveMaxRetries, "Resolve max retries"),
    simResolveFallback: form.simResolveFallback,
    simMaxRetryAttempts: parseNum(form.simMaxRetryAttempts, "Max retry attempts"),
    simRandomSeed: form.simRandomSeed.trim() === "" ? undefined : form.simRandomSeed.trim(),
    edgeBandMin: parseNum(form.edgeBandMin, "Edge band min"),
    edgeBandMax: parseNum(form.edgeBandMax, "Edge band max"),
    edgeConfirmSamples: parseNum(form.edgeConfirmSamples, "Edge confirm samples"),
    edgeMaxDownTick: parseNum(form.edgeMaxDownTick, "Edge max down tick"),
    edgeOrderUsdc: parseNum(form.edgeOrderUsdc, "Edge order USDC"),
    maxShareEdge: parseNum(form.maxShareEdge, "Max shares edge"),
    edgeCheapOrderUsdc: parseNum(form.edgeCheapOrderUsdc, "Budget cheap"),
    edgeCheapBandMin: parseNum(form.edgeCheapBandMin, "Cheap band min"),
    edgeCheapBandMax: parseNum(form.edgeCheapBandMax, "Cheap band max"),
    edgeSizingMode: form.edgeSizingMode,
    edgeSharesEdge: parseNum(form.edgeSharesEdge, "Shares edge"),
    edgeSharesCheap: parseNum(form.edgeSharesCheap, "Shares cheap"),
    edgeSellExpensiveEnabled: form.edgeSellExpensiveEnabled,
    edgeSellExpensiveAfterMin: parseNum(form.edgeSellExpensiveAfterMin, "Vente edge après (min)"),
    edgeSellExpensiveLossPct: parseNum(form.edgeSellExpensiveLossPct, "Perte edge %"),
    edgeSellExpensiveLossWindowMs: parseNum(form.edgeSellExpensiveLossWindowMs, "Fenêtre perte edge (ms)"),
    edgeRequireCheapReady: form.edgeRequireCheapReady === true,
    edgeAskSumMax:
      form.edgeAskSumMax.trim() === "" ? null : parseNum(form.edgeAskSumMax, "Edge ask sum max"),
    reverseCancelCheapOffBand: form.reverseCancelCheapOffBand,
    reverseDefendEnabled: form.reverseDefendEnabled,
    reverseMaxGridLevels:
      form.reverseMaxGridLevels.trim() === ""
        ? null
        : parseNum(form.reverseMaxGridLevels, "Max niveaux grille reverse"),
    reverseHedgeCapToFilledCheap: form.reverseHedgeCapToFilledCheap,
    favBandAskMin: parseNum(form.favBandAskMin, "Fav-band ask min"),
    favBandAskMax: parseNum(form.favBandAskMax, "Fav-band ask max"),
    favBandMinElapsedSec: parseNum(form.favBandMinElapsedSec, "Fav-band min elapsed"),
    favBandMaxElapsedSec:
      form.favBandMaxElapsedSec.trim() === ""
        ? null
        : parseNum(form.favBandMaxElapsedSec, "Fav-band max elapsed"),
    favBandInverseEnabled: form.favBandInverseEnabled === true,
    favBandInverseAskMax: parseNum(form.favBandInverseAskMax, "Fav-band inverse ask max"),
    favBandInverseShareRatio: parseNum(form.favBandInverseShareRatio, "Fav-band inverse share ratio"),
    favBandInverseOrderUsdc: parseNum(form.favBandInverseOrderUsdc, "Fav-band inverse order USDC"),
    favBandWhipsawEnabled: form.favBandWhipsawEnabled === true,
    favBandExitEnabled: form.favBandExitEnabled === true,
    favBandExitMinLowerHighDrop: parseNum(form.favBandExitMinLowerHighDrop, "Fav-band exit min swing"),
    favBandExitRetraceRatio: parseNum(form.favBandExitRetraceRatio, "Fav-band exit retrace ratio"),
    favBandExitConsecutive: parseNum(form.favBandExitConsecutive, "Fav-band exit consecutive"),
    favBandExitLookbackMs: parseNum(form.favBandExitLookbackMs, "Fav-band exit lookback ms"),
    favBandExitMinElapsedSec: parseNum(form.favBandExitMinElapsedSec, "Fav-band exit min elapsed"),
    favBandExitLossOnly: form.favBandExitLossOnly !== false,
    favBandExitSwitchEnabled: form.favBandExitSwitchEnabled === true,
    favBandExitSwitchOrderUsdc: parseNum(form.favBandExitSwitchOrderUsdc, "Fav-band exit switch order USDC"),
    favBandWhipsawPauseAfterLosses:
      form.favBandWhipsawPauseAfterLosses.trim() === ""
        ? null
        : parseNum(form.favBandWhipsawPauseAfterLosses, "Fav-band whipsaw pause after losses"),
    favBandWhipsawPauseWindows: parseNum(form.favBandWhipsawPauseWindows, "Fav-band whipsaw pause windows"),
    favBandWhipsawMaxScore:
      form.favBandWhipsawMaxScore.trim() === ""
        ? null
        : parseNum(form.favBandWhipsawMaxScore, "Fav-band whipsaw max score"),
    favBandWhipsawMaxIntraFlips:
      form.favBandWhipsawMaxIntraFlips.trim() === ""
        ? null
        : parseNum(form.favBandWhipsawMaxIntraFlips, "Fav-band whipsaw max intra flips"),
    favBandImbalanceEnabled: form.favBandImbalanceEnabled === true,
    favBandImbalanceCrossMin:
      form.favBandImbalanceCrossMin.trim() === ""
        ? null
        : parseNum(form.favBandImbalanceCrossMin, "Fav-band imbalance cross min"),
    favBandImbalanceTicks:
      form.favBandImbalanceTicks.trim() === ""
        ? null
        : parseNum(form.favBandImbalanceTicks, "Fav-band imbalance ticks"),
    favBandImbalanceMaxSpread:
      form.favBandImbalanceMaxSpread.trim() === ""
        ? null
        : parseNum(form.favBandImbalanceMaxSpread, "Fav-band imbalance max spread"),
    dipRevertBandMin: parseNum(form.dipRevertBandMin, "Dip-revert band min"),
    dipRevertBandMax: parseNum(form.dipRevertBandMax, "Dip-revert band max"),
    dipRevertMinDrop: parseNum(form.dipRevertMinDrop, "Dip-revert min drop"),
    dipRevertDropLookbackMs: parseNum(
      form.dipRevertDropLookbackMs,
      "Dip-revert drop lookback ms",
    ),
    dipRevertMinElapsedSec: parseNum(
      form.dipRevertMinElapsedSec,
      "Dip-revert min elapsed",
    ),
    dipRevertMaxElapsedSec:
      form.dipRevertMaxElapsedSec.trim() === ""
        ? null
        : parseNum(form.dipRevertMaxElapsedSec, "Dip-revert max elapsed"),
    dipRevertMaxSpread: parseNum(form.dipRevertMaxSpread, "Dip-revert max spread"),
    dipRevertOrderUsdc: parseNum(form.dipRevertOrderUsdc, "Dip-revert order USDC"),
    dipRevertExitTakeProfitEnabled: form.dipRevertExitTakeProfitEnabled === true,
    dipRevertExitWinAsk: parseNum(form.dipRevertExitWinAsk, "Dip-revert take-profit ask"),
    antiflipBandMin: parseNum(form.antiflipBandMin, "Antiflip band min"),
    antiflipBandMax: parseNum(form.antiflipBandMax, "Antiflip band max"),
    antiflipDeposedAskMin:
      form.antiflipDeposedAskMin.trim() === ""
        ? null
        : parseNum(form.antiflipDeposedAskMin, "Antiflip deposed ask floor"),
    antiflipFlipLookbackMs: parseNum(form.antiflipFlipLookbackMs, "Antiflip flip lookback ms"),
    antiflipMinElapsedSec: parseNum(form.antiflipMinElapsedSec, "Antiflip min elapsed"),
    antiflipMaxElapsedSec:
      form.antiflipMaxElapsedSec.trim() === ""
        ? null
        : parseNum(form.antiflipMaxElapsedSec, "Antiflip max elapsed"),
    antiflipMaxSpread: parseNum(form.antiflipMaxSpread, "Antiflip max spread"),
    antiflipOrderUsdc: parseNum(form.antiflipOrderUsdc, "Antiflip order USDC"),
    antiflip5mOnly: form.antiflip5mOnly === true,
    antiflipEntryDelaySec: parseNum(form.antiflipEntryDelaySec, "Antiflip entry delay sec"),
    antiflipSharpDropMin: parseNum(form.antiflipSharpDropMin, "Antiflip sharp drop min"),
    antiflipBounceMin: parseNum(form.antiflipBounceMin, "Antiflip bounce min"),
    antiflipBounceFloor:
      form.antiflipBounceFloor.trim() === ""
        ? null
        : parseNum(form.antiflipBounceFloor, "Antiflip bounce floor"),
    antiflipTakeProfitPct: parseNum(form.antiflipTakeProfitPct, "Antiflip take-profit %"),
    antiflipFavAskMin: parseNum(form.antiflipFavAskMin, "Antiflip fav ask min"),
    antiflipFavAskMax: parseNum(form.antiflipFavAskMax, "Antiflip fav ask max"),
    flipConfirmBandMin: parseNum(form.flipConfirmBandMin, "Flip-confirm band min"),
    flipConfirmBandMax: parseNum(form.flipConfirmBandMax, "Flip-confirm band max"),
    flipConfirmFlipLookbackMs: parseNum(form.flipConfirmFlipLookbackMs, "Flip-confirm lookback ms"),
    flipConfirmMinElapsedSec: parseNum(form.flipConfirmMinElapsedSec, "Flip-confirm min elapsed"),
    flipConfirmMaxElapsedSec:
      form.flipConfirmMaxElapsedSec.trim() === ""
        ? null
        : parseNum(form.flipConfirmMaxElapsedSec, "Flip-confirm max elapsed"),
    flipConfirmMaxSpread: parseNum(form.flipConfirmMaxSpread, "Flip-confirm max spread"),
    flipConfirmOrderUsdc: parseNum(form.flipConfirmOrderUsdc, "Flip-confirm order USDC"),
    earlyConvictionAskMin: parseNum(form.earlyConvictionAskMin, "Early-conviction ask min"),
    earlyConvictionAskMax: parseNum(form.earlyConvictionAskMax, "Early-conviction ask max"),
    earlyConvictionMaxElapsedSec: parseNum(form.earlyConvictionMaxElapsedSec, "Early-conviction max elapsed"),
    earlyConvictionMaxSpread: parseNum(form.earlyConvictionMaxSpread, "Early-conviction max spread"),
    earlyConvictionOrderUsdc: parseNum(form.earlyConvictionOrderUsdc, "Early-conviction order USDC"),
    earlyLowBuyAskMin: parseNum(form.earlyLowBuyAskMin, "Early-low ask min"),
    earlyLowBuyAskMax: parseNum(form.earlyLowBuyAskMax, "Early-low ask max"),
    earlyLowMaxElapsedSec: parseNum(form.earlyLowMaxElapsedSec, "Early-low max elapsed"),
    earlyLowMaxSpread: parseNum(form.earlyLowMaxSpread, "Early-low max spread"),
    earlyLowOrderUsdc: parseNum(form.earlyLowOrderUsdc, "Early-low order USDC"),
    earlyLowExitEnabled: form.earlyLowExitEnabled === true,
    earlyLowExitAsk: parseNum(form.earlyLowExitAsk, "Early-low exit ask"),
    earlyLowExitMomentumMin: parseNum(form.earlyLowExitMomentumMin, "Early-low exit momentum min"),
    earlyLow15mOnly: form.earlyLow15mOnly !== false,
    openEntryLeanTrigger: parseNum(form.openEntryLeanTrigger, "Open-entry lean trigger"),
    openEntryMaxElapsedSec: parseNum(form.openEntryMaxElapsedSec, "Open-entry max elapsed"),
    openEntryFairAskSumMax: parseNum(form.openEntryFairAskSumMax, "Open-entry fair ask sum max"),
    openEntryMaxSpread: parseNum(form.openEntryMaxSpread, "Open-entry max spread"),
    openEntryOrderUsdc: parseNum(form.openEntryOrderUsdc, "Open-entry order USDC"),
    openEntrySlStructFlipDist: parseNum(form.openEntrySlStructFlipDist, "Open-entry SL struct flip dist"),
    openEntrySlStructConfirmSec: parseNum(form.openEntrySlStructConfirmSec, "Open-entry SL struct confirm sec"),
    openEntrySlStructDist: parseNum(form.openEntrySlStructDist, "Open-entry SL struct dist"),
    openEntrySlLateAfterSec: parseNum(form.openEntrySlLateAfterSec, "Open-entry SL late after sec"),
    openEntrySlLateDist: parseNum(form.openEntrySlLateDist, "Open-entry SL late dist"),
    openEntrySlEnabled: form.openEntrySlEnabled !== false,
    repricingFeedMaxAgeMs: parseNum(form.repricingFeedMaxAgeMs, "Repricing feed max age ms"),
    repricingTauMinSec: parseNum(form.repricingTauMinSec, "Repricing tau min sec"),
    repricingSpreadMax: parseNum(form.repricingSpreadMax, "Repricing spread max"),
    repricingPEntryMax: parseNum(form.repricingPEntryMax, "Repricing p entry max"),
    repricingEdgeMin: parseNum(form.repricingEdgeMin, "Repricing edge min"),
    repricingOrderUsdc: parseNum(form.repricingOrderUsdc, "Repricing order USDC"),
    repricingTargetAbs: parseNum(form.repricingTargetAbs, "Repricing target abs"),
    repricingTargetRel: parseNum(form.repricingTargetRel, "Repricing target rel"),
    repricingStopAbs: parseNum(form.repricingStopAbs, "Repricing stop abs"),
    repricingHoldMaxSec: parseNum(form.repricingHoldMaxSec, "Repricing hold max sec"),
    repricingTauForceExitSec: parseNum(form.repricingTauForceExitSec, "Repricing tau force exit sec"),
    repricingSpreadMaxExit: parseNum(form.repricingSpreadMaxExit, "Repricing spread max exit"),
    repricingLateWindowSec: parseNum(form.repricingLateWindowSec, "Repricing late window sec"),
    repricingSignalTtlMs: parseNum(form.repricingSignalTtlMs, "Repricing signal TTL ms"),
    repricingDislocationMin: parseNum(form.repricingDislocationMin, "Repricing dislocation min"),
    repricingHistoryWindowMs: parseNum(form.repricingHistoryWindowMs, "Repricing history window ms"),
    repricingModeAEnabled: form.repricingModeAEnabled === true,
    repricingFeesRoundtrip: parseNum(form.repricingFeesRoundtrip, "Repricing fees roundtrip"),
    repricingSlipEntryBuffer: parseNum(form.repricingSlipEntryBuffer, "Repricing slip entry buffer"),
    repricingSlipExitBuffer: parseNum(form.repricingSlipExitBuffer, "Repricing slip exit buffer"),
    repricingNotionalMaxPerMarket: parseNum(form.repricingNotionalMaxPerMarket, "Repricing notional max per market"),
  };

  if (
    next.strategyId === "fav-band" ||
    next.strategyId === "dip-revert" ||
    next.strategyId === "antiflip-revert" ||
    next.strategyId === "flip-confirm" ||
    next.strategyId === "early-conviction" ||
    next.strategyId === "early-low" ||
    next.strategyId === "open-entry" ||
    next.strategyId === "probability-repricing"
  ) {
    next.enableExpensiveHedge = false;
    next.arbAskLockOnly = false;
  }
  if ((next.marketSlugPrefixes?.length ?? 0) === 0) {
    throw new Error("Au moins un préfixe de marché est requis");
  }
  return next;
}

export function applySettingsToForm(base: BotConfig, settings: Partial<BotConfig>): ConfigFormState {
  return configToForm({ ...base, ...settings });
}

export function formToPatch(
  form: ConfigFormState,
  baseline: BotConfig,
): Partial<BotConfig> {
  const next = formToSettings(form);

  const patch: Partial<BotConfig> = {};
  for (const [key, value] of Object.entries(next) as Array<
    [keyof BotConfig, BotConfig[keyof BotConfig]]
  >) {
    const baselineValue = baseline[key];
    const changed =
      Array.isArray(value) && Array.isArray(baselineValue)
        ? value.join(",") !== baselineValue.join(",")
        : value !== baselineValue;
    if (changed) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }

  return patch;
}

export function validateConfigForm(
  form: ConfigFormState,
  isBacktest: boolean,
  opts?: { leadsWithEdge?: boolean },
): string[] {
  const errors: string[] = [];
  const edge = engineUsesEdge(form.strategyId, opts?.leadsWithEdge);

  try {
    const cheapBuyMin = parseNum(form.cheapBuyMin, "Cheap min");
    const cheapBuyMax = parseNum(form.cheapBuyMax, "Cheap max");
    const expensiveBuyMin = parseNum(form.expensiveBuyMin, "Hedge min");
    const expensiveBuyMax = parseNum(form.expensiveBuyMax, "Hedge max");
    const pairLockMax = parseNum(form.pairLockMax, "Pair lock max");
    const barbellHedgeRatio = parseNum(form.barbellHedgeRatio, "Ratio hedge");
    const minutesBeforeCloseMin = parseNum(form.minutesBeforeCloseMin, "Minutes min");
    const minutesBeforeCloseMax = parseNum(form.minutesBeforeCloseMax, "Minutes max");
    const pollIntervalMs = parseNum(form.pollIntervalMs, "Poll interval");
    const maxOpenPositionsPerSide = parseNum(
      form.maxOpenPositionsPerSide,
      "Max positions",
    );
    const simFillProbability = parseNum(
      form.simFillProbabilityNonMarketable,
      "Fill probability",
    );
    const simResolveRetryIntervalMs = parseNum(
      form.simResolveRetryIntervalMs,
      "Resolve retry interval",
    );

    if (cheapBuyMin > cheapBuyMax) {
      errors.push("Cheap min doit être ≤ cheap max");
    }
    if (expensiveBuyMin > expensiveBuyMax) {
      errors.push("Hedge min doit être ≤ hedge max");
    }
    // Bandes cheap/hedge : arb, barbell, reverse (pas edge-lead).
    // pairLockMax : arb seulement. barbellHedgeRatio : barbell seulement.
    if (!edge) {
      if (
        form.strategyId !== "fav-band" &&
        form.strategyId !== "dip-revert" &&
        form.strategyId !== "antiflip-revert" &&
        form.strategyId !== "flip-confirm" &&
        form.strategyId !== "early-conviction" &&
        form.strategyId !== "open-entry" &&
        form.strategyId !== "probability-repricing" &&
        cheapBuyMax >= expensiveBuyMin
      ) {
        errors.push("Cheap max doit être < hedge min");
      }
      if (form.strategyId === "arb") {
        if (pairLockMax < 0.90 || pairLockMax >= 1.00) {
          errors.push("Pair lock max doit être entre 0.90 et 0.99");
        }
        if (!form.enableExpensiveHedge) {
          errors.push("Le hedge expensive est obligatoire pour arb (B1)");
        }
      }
      if (form.strategyId === "barbell") {
        if (!(barbellHedgeRatio > 0 && barbellHedgeRatio <= 1)) {
          errors.push("Ratio hedge doit être dans (0, 1]");
        }
      }
    }
    if (minutesBeforeCloseMin > minutesBeforeCloseMax) {
      errors.push("Minutes min doit être ≤ minutes max");
    }
    if (pollIntervalMs < 500) {
      errors.push("Poll interval doit être ≥ 500 ms");
    }
    if (maxOpenPositionsPerSide < 1) {
      errors.push("Max positions par côté doit être ≥ 1");
    }
    if (simFillProbability < 0 || simFillProbability > 1) {
      errors.push("Fill probability doit être entre 0 et 1");
    }
    if (simResolveRetryIntervalMs < 500) {
      errors.push("Resolve retry interval doit être ≥ 500 ms");
    }
    if (!isBacktest && form.simResolveFallback === "probabilistic") {
      errors.push("Resolve fallback probabilistic interdit en mode live");
    }
    if (form.marketSlugPrefixes.split(",").map((s) => s.trim()).filter(Boolean).length === 0) {
      errors.push("Au moins un préfixe de marché est requis");
    }

    if (form.strategyId === "fav-band") {
      const lo = Number(form.favBandAskMin);
      const hi = Number(form.favBandAskMax);
      const elapsed = Number(form.favBandMinElapsedSec);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Fav-band: ask min doit être < ask max");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Fav-band: min elapsed entre 0 et 900");
      }
      if (form.favBandMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.favBandMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Fav-band: max elapsed invalide");
        }
      }
      if (form.favBandInverseEnabled) {
        const invAsk = Number(form.favBandInverseAskMax);
        const invRatio = Number(form.favBandInverseShareRatio);
        const invBudget = Number(form.favBandInverseOrderUsdc);
        const maxPos = Number(form.maxOpenPositionsPerSide);
        if (!Number.isFinite(invAsk) || invAsk <= 0 || invAsk >= 0.5) {
          errors.push("Fav-band inverse: ask max entre 0 et 0.5");
        }
        if (!Number.isFinite(invRatio) || invRatio <= 0) {
          errors.push("Fav-band inverse: ratio doit être > 0");
        }
        if (!Number.isFinite(invBudget) || invBudget <= 0) {
          errors.push("Fav-band inverse: budget doit être > 0");
        } else if (Number.isFinite(invAsk) && invAsk > 0 && invAsk < 0.5) {
          const maxShares = Number(form.maxSharesPerOrder);
          const cap = Number.isFinite(maxShares) && maxShares > 0 ? maxShares : Number.MAX_SAFE_INTEGER;
          const sized = Math.floor(Math.min(invBudget / invAsk, cap) * 100) / 100;
          if (sized < 5) {
            errors.push("Fav-band inverse: budget insuffisant (min 5 shares au pire prix)");
          }
        }
        if (Number.isFinite(maxPos) && maxPos < 2) {
          errors.push("Fav-band inverse: max positions par côté doit être ≥ 2");
        }
      }
      if (form.favBandExitEnabled) {
        const exDrop = Number(form.favBandExitMinLowerHighDrop);
        const exRetrace = Number(form.favBandExitRetraceRatio);
        const exConsec = Number(form.favBandExitConsecutive);
        const exLookback = Number(form.favBandExitLookbackMs);
        const exElapsed = Number(form.favBandExitMinElapsedSec);
        if (!Number.isFinite(exDrop) || exDrop <= 0) {
          errors.push("Fav-band exit: swing min d'un plus-bas doit être > 0");
        }
        if (!Number.isFinite(exRetrace) || exRetrace < 0 || exRetrace > 1) {
          errors.push("Fav-band exit: retracement de confirmation doit être dans [0, 1]");
        }
        if (!Number.isFinite(exConsec) || exConsec < 2) {
          errors.push("Fav-band exit: plus-bas consécutifs doit être ≥ 2");
        }
        if (!Number.isFinite(exLookback) || exLookback <= 0) {
          errors.push("Fav-band exit: lookback doit être > 0 ms");
        }
        if (!Number.isFinite(exElapsed) || exElapsed < 0) {
          errors.push("Fav-band exit: min elapsed doit être ≥ 0");
        }
        if (form.favBandExitSwitchEnabled) {
          const swBudget = Number(form.favBandExitSwitchOrderUsdc);
          if (!Number.isFinite(swBudget) || swBudget <= 0) {
            errors.push("Fav-band exit switch: budget doit être > 0");
          }
          const maxPos = Number(form.maxOpenPositionsPerSide);
          if (Number.isFinite(maxPos) && maxPos < 2) {
            errors.push("Fav-band exit switch: max positions par côté doit être ≥ 2");
          }
        }
      }
    }
    if (form.strategyId === "dip-revert") {
      const lo = Number(form.dipRevertBandMin);
      const hi = Number(form.dipRevertBandMax);
      const drop = Number(form.dipRevertMinDrop);
      const lookback = Number(form.dipRevertDropLookbackMs);
      const elapsed = Number(form.dipRevertMinElapsedSec);
      const spread = Number(form.dipRevertMaxSpread);
      const budget = Number(form.dipRevertOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Dip-revert: ask min doit être < ask max");
      }
      if (!Number.isFinite(drop) || drop <= 0) {
        errors.push("Dip-revert: min drop doit être > 0");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Dip-revert: lookback doit être > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Dip-revert: min elapsed entre 0 et 900");
      }
      if (form.dipRevertMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.dipRevertMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Dip-revert: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Dip-revert: max spread doit être >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Dip-revert: budget doit être > 0");
      }
      if (form.dipRevertExitTakeProfitEnabled) {
        const tpAsk = Number(form.dipRevertExitWinAsk);
        if (!Number.isFinite(tpAsk) || tpAsk <= 0 || tpAsk >= 1) {
          errors.push("Dip-revert: take-profit ask entre 0 et 1");
        } else if (Number.isFinite(hi) && tpAsk <= hi) {
          errors.push("Dip-revert: take-profit ask doit être > ask max (bande d'entrée)");
        }
      }
    }
    if (form.strategyId === "antiflip-revert") {
      const lo = Number(form.antiflipBandMin);
      const hi = Number(form.antiflipBandMax);
      const floor = Number(form.antiflipDeposedAskMin);
      const lookback = Number(form.antiflipFlipLookbackMs);
      const elapsed = Number(form.antiflipMinElapsedSec);
      const spread = Number(form.antiflipMaxSpread);
      const budget = Number(form.antiflipOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Antiflip: ask min doit être < ask max");
      }
      if (form.antiflipDeposedAskMin.trim() !== "" && (!Number.isFinite(floor) || floor < lo || floor > hi)) {
        errors.push("Antiflip: floor du déchu doit être dans la bande (ou vide)");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Antiflip: lookback de flip doit être > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Antiflip: min elapsed entre 0 et 900");
      }
      if (form.antiflipMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.antiflipMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Antiflip: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Antiflip: max spread doit être >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Antiflip: budget doit être > 0");
      }
      // Miroir backend (config.ts) : bounceFloor null ou dans la bande.
      if (form.antiflipBounceFloor.trim() !== "") {
        const bFloor = Number(form.antiflipBounceFloor);
        if (!Number.isFinite(bFloor) || bFloor < lo || bFloor > hi) {
          errors.push("Antiflip: bounce floor doit être dans la bande (ou vide)");
        }
      }
    }
    if (form.strategyId === "flip-confirm") {
      const lo = Number(form.flipConfirmBandMin);
      const hi = Number(form.flipConfirmBandMax);
      const lookback = Number(form.flipConfirmFlipLookbackMs);
      const elapsed = Number(form.flipConfirmMinElapsedSec);
      const spread = Number(form.flipConfirmMaxSpread);
      const budget = Number(form.flipConfirmOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Flip-confirm: ask min doit être < ask max");
      }
      if (!Number.isFinite(lookback) || lookback <= 0) {
        errors.push("Flip-confirm: lookback de flip doit être > 0 ms");
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        errors.push("Flip-confirm: min elapsed entre 0 et 900");
      }
      if (form.flipConfirmMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.flipConfirmMaxElapsedSec);
        if (!Number.isFinite(maxE) || maxE < elapsed) {
          errors.push("Flip-confirm: max elapsed invalide");
        }
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Flip-confirm: max spread doit être >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Flip-confirm: budget doit être > 0");
      }
    }
    if (form.strategyId === "early-conviction") {
      const lo = Number(form.earlyConvictionAskMin);
      const hi = Number(form.earlyConvictionAskMax);
      const maxElapsed = Number(form.earlyConvictionMaxElapsedSec);
      const spread = Number(form.earlyConvictionMaxSpread);
      const budget = Number(form.earlyConvictionOrderUsdc);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
        errors.push("Early-conviction: ask min doit être < ask max");
      }
      if (Number.isFinite(lo) && lo < 0.5) {
        errors.push("Early-conviction: ask min doit être >= 0.5");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Early-conviction: max elapsed entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Early-conviction: max spread doit être >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Early-conviction: budget doit être > 0");
      }
    }
    if (form.strategyId === "early-low") {
      const lo = Number(form.earlyLowBuyAskMin);
      const hi = Number(form.earlyLowBuyAskMax);
      const maxElapsed = Number(form.earlyLowMaxElapsedSec);
      const spread = Number(form.earlyLowMaxSpread);
      const budget = Number(form.earlyLowOrderUsdc);
      const exitAsk = Number(form.earlyLowExitAsk);
      const momentum = Number(form.earlyLowExitMomentumMin);
      if (!Number.isFinite(lo) || lo < 0) {
        errors.push("Early-low: ask min doit être >= 0 (0 = off)");
      }
      if (!Number.isFinite(hi) || hi <= lo || hi >= 0.5) {
        errors.push("Early-low: bande max < 0.5 et > ask min (token décoté)");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Early-low: max elapsed entre 1 et 900 s");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Early-low: max spread >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Early-low: budget doit être > 0");
      }
      if (form.earlyLowExitEnabled) {
        if (!Number.isFinite(exitAsk) || exitAsk <= 0 || exitAsk >= 1) {
          errors.push("Early-low: exit ask en (0, 1)");
        }
        if (Number.isFinite(exitAsk) && Number.isFinite(hi) && exitAsk <= hi) {
          errors.push("Early-low: exit ask doit être > bande max d'achat");
        }
        if (!Number.isFinite(momentum) || momentum < 0) {
          errors.push("Early-low: momentum min >= 0");
        }
      }
    }
    if (form.strategyId === "open-entry") {
      const lean = Number(form.openEntryLeanTrigger);
      const maxElapsed = Number(form.openEntryMaxElapsedSec);
      const fair = Number(form.openEntryFairAskSumMax);
      const spread = Number(form.openEntryMaxSpread);
      const budget = Number(form.openEntryOrderUsdc);
      const flipDist = Number(form.openEntrySlStructFlipDist);
      const confirmSec = Number(form.openEntrySlStructConfirmSec);
      const structDist = Number(form.openEntrySlStructDist);
      const lateAfter = Number(form.openEntrySlLateAfterSec);
      const lateDist = Number(form.openEntrySlLateDist);
      if (!Number.isFinite(lean) || lean <= 0 || lean > 0.5) {
        errors.push("Open-entry: lean trigger entre 0 (exclu) et 0.5");
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        errors.push("Open-entry: max elapsed entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(fair) || fair <= 1 || fair > 1.2) {
        errors.push("Open-entry: fair ask sum entre 1 (exclu) et 1.2");
      }
      if (!Number.isFinite(spread) || spread < 0) {
        errors.push("Open-entry: max spread doit être >= 0");
      }
      if (!Number.isFinite(budget) || budget <= 0) {
        errors.push("Open-entry: budget doit être > 0");
      }
      if (!Number.isFinite(flipDist) || flipDist <= 0 || flipDist > 1) {
        errors.push("Open-entry: SL struct flip dist entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(confirmSec) || confirmSec < 0 || confirmSec > 900) {
        errors.push("Open-entry: SL struct confirm sec entre 0 et 900");
      }
      if (!Number.isFinite(structDist) || structDist <= 0 || structDist > 1) {
        errors.push("Open-entry: SL struct dist entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(lateAfter) || lateAfter <= 0 || lateAfter > 900) {
        errors.push("Open-entry: SL late after sec entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(lateDist) || lateDist <= 0 || lateDist > structDist) {
        errors.push("Open-entry: SL late dist doit être <= SL struct dist (le tardif est le plus serré)");
      }
    }
    if (form.strategyId === "probability-repricing") {
      const tauMin = Number(form.repricingTauMinSec);
      const spreadMax = Number(form.repricingSpreadMax);
      const pEntryMax = Number(form.repricingPEntryMax);
      const edgeMin = Number(form.repricingEdgeMin);
      const orderUsdc = Number(form.repricingOrderUsdc);
      const targetAbs = Number(form.repricingTargetAbs);
      const targetRel = Number(form.repricingTargetRel);
      const stopAbs = Number(form.repricingStopAbs);
      const holdMax = Number(form.repricingHoldMaxSec);
      const tauForce = Number(form.repricingTauForceExitSec);
      const spreadMaxExit = Number(form.repricingSpreadMaxExit);
      const lateWindow = Number(form.repricingLateWindowSec);
      const historyMs = Number(form.repricingHistoryWindowMs);
      const dislocationMin = Number(form.repricingDislocationMin);
      const feedAge = Number(form.repricingFeedMaxAgeMs);
      const signalTtl = Number(form.repricingSignalTtlMs);
      const fees = Number(form.repricingFeesRoundtrip);
      const slipEntry = Number(form.repricingSlipEntryBuffer);
      const slipExit = Number(form.repricingSlipExitBuffer);
      const notionalMax = Number(form.repricingNotionalMaxPerMarket);
      if (!Number.isFinite(tauMin) || tauMin <= 0 || tauMin > 900) {
        errors.push("Repricing: tau min sec entre 0 (exclu) et 900");
      }
      if (!Number.isFinite(spreadMax) || spreadMax < 0) {
        errors.push("Repricing: spread max doit être >= 0");
      }
      if (!Number.isFinite(pEntryMax) || pEntryMax <= 0 || pEntryMax > 1) {
        errors.push("Repricing: p entry max entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(edgeMin) || edgeMin < 0) {
        errors.push("Repricing: edge min doit être >= 0");
      }
      if (!Number.isFinite(orderUsdc) || orderUsdc <= 0) {
        errors.push("Repricing: order USDC doit être > 0");
      }
      if (!Number.isFinite(targetAbs) || targetAbs <= 0 || targetAbs > 1) {
        errors.push("Repricing: target abs entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(targetRel) || targetRel < 0) {
        errors.push("Repricing: target rel doit être >= 0");
      }
      if (!Number.isFinite(stopAbs) || stopAbs <= 0 || stopAbs > 1) {
        errors.push("Repricing: stop abs entre 0 (exclu) et 1");
      }
      if (!Number.isFinite(holdMax) || holdMax <= 0) {
        errors.push("Repricing: hold max sec doit être > 0");
      }
      if (!Number.isFinite(tauForce) || tauForce <= 0 || !(Number.isFinite(tauMin) && tauForce < tauMin)) {
        errors.push("Repricing: tau force exit doit être dans (0, tau min)");
      }
      if (!Number.isFinite(spreadMaxExit) || (Number.isFinite(spreadMax) && spreadMaxExit < spreadMax)) {
        errors.push("Repricing: spread max exit doit être >= spread max");
      }
      if (!Number.isFinite(lateWindow) || lateWindow <= 0) {
        errors.push("Repricing: late window sec doit être > 0");
      }
      if (!Number.isFinite(historyMs) || historyMs < 1000) {
        errors.push("Repricing: history window ms doit être >= 1000");
      }
      if (!Number.isFinite(dislocationMin) || dislocationMin <= 0) {
        errors.push("Repricing: dislocation min doit être > 0");
      }
      if (!Number.isFinite(feedAge) || feedAge <= 0) {
        errors.push("Repricing: feed max age ms doit être > 0");
      }
      if (!Number.isFinite(signalTtl) || signalTtl <= 0) {
        errors.push("Repricing: signal TTL ms doit être > 0");
      }
      if (!Number.isFinite(fees) || fees < 0) {
        errors.push("Repricing: fees roundtrip doit être >= 0");
      }
      if (!Number.isFinite(slipEntry) || slipEntry < 0) {
        errors.push("Repricing: slip entry buffer doit être >= 0");
      }
      if (!Number.isFinite(slipExit) || slipExit < 0) {
        errors.push("Repricing: slip exit buffer doit être >= 0");
      }
      if (!Number.isFinite(notionalMax) || notionalMax <= 0) {
        errors.push("Repricing: notional max per market doit être > 0");
      }
    }
    // Edge-lead : validations dédiées. Les champs arb/barbell (cheap/hedge
    // bandes, pairLockMax, barbellHedgeRatio) ne s'appliquent pas à ce moteur.
    if (edge) {
      const edgeBandMin = parseNum(form.edgeBandMin, "Edge band min");
      const edgeBandMax = parseNum(form.edgeBandMax, "Edge band max");
      const edgeConfirmSamples = parseNum(form.edgeConfirmSamples, "Edge confirm samples");
      const edgeMaxDownTick = parseNum(form.edgeMaxDownTick, "Edge max down tick");
      const edgeOrderUsdc = parseNum(form.edgeOrderUsdc, "Edge order USDC");
      const maxShareEdge = parseNum(form.maxShareEdge, "Max shares edge");
      const edgeCheapOrderUsdc = parseNum(form.edgeCheapOrderUsdc, "Budget cheap");
      const edgeCheapBandMin = parseNum(form.edgeCheapBandMin, "Cheap band min");
      const edgeCheapBandMax = parseNum(form.edgeCheapBandMax, "Cheap band max");
      if (edgeBandMin >= edgeBandMax) {
        errors.push("Edge band min doit être < edge band max");
      }
      if (edgeBandMin < 0.50 || edgeBandMax > 0.99) {
        errors.push("Edge band doit être dans [0.50, 0.99]");
      }
      if (edgeConfirmSamples < 2) {
        errors.push("Edge confirm samples doit être ≥ 2");
      }
      if (edgeMaxDownTick <= 0) {
        errors.push("Edge max down tick doit être > 0");
      }
      if (edgeOrderUsdc <= 0) {
        errors.push("Edge order USDC doit être > 0");
      }
      if (maxShareEdge < 1) {
        errors.push("Max shares edge doit être ≥ 1");
      }
      if (edgeCheapOrderUsdc <= 0) {
        errors.push("Budget cheap doit être > 0");
      }
      if (edgeCheapBandMin >= edgeCheapBandMax) {
        errors.push("Cheap band min doit être < cheap band max");
      }
      if (edgeCheapBandMin < 0.01 || edgeCheapBandMax > 0.49) {
        errors.push("Cheap band doit être dans [0.01, 0.49]");
      }
      if (
        form.edgeSizingMode !== "shares" &&
        form.edgeSizingMode !== "pusd" &&
        form.edgeSizingMode !== "dynamic"
      ) {
        errors.push("Mode de sizing doit être shares, pusd ou dynamic");
      }
      if (form.edgeSizingMode === "shares") {
        const edgeSharesEdge = parseNum(form.edgeSharesEdge, "Shares edge");
        const edgeSharesCheap = parseNum(form.edgeSharesCheap, "Shares cheap");
        if (edgeSharesEdge < 5) {
          errors.push("Shares edge doit être ≥ 5 (minimum CLOB)");
        }
        if (edgeSharesCheap < 5) {
          errors.push("Shares cheap doit être ≥ 5 (minimum CLOB)");
        }
      }
      const sellAfterMin = parseNum(form.edgeSellExpensiveAfterMin, "Vente edge après (min)");
      const sellLossPct = parseNum(form.edgeSellExpensiveLossPct, "Perte edge %");
      const sellLossWindowMs = parseNum(form.edgeSellExpensiveLossWindowMs, "Fenêtre perte edge (ms)");
      if (sellAfterMin < 0) {
        errors.push("Vente edge après (min) doit être ≥ 0");
      }
      if (sellLossPct <= 0) {
        errors.push("Perte edge % doit être > 0");
      }
      if (sellLossWindowMs <= 0) {
        errors.push("Fenêtre perte edge (ms) doit être > 0");
      }
    }
    if (form.favBandWhipsawEnabled) {
      if (form.favBandWhipsawPauseAfterLosses.trim() !== "") {
        const n = Number(form.favBandWhipsawPauseAfterLosses);
        if (!Number.isFinite(n) || n < 1) errors.push("Whipsaw: pause apres N pertes doit etre >= 1 (ou vide = off)");
      }
      const pw = Number(form.favBandWhipsawPauseWindows);
      if (!Number.isFinite(pw) || pw < 1) errors.push("Whipsaw: fenetres de pause >= 1");
      if (form.favBandWhipsawMaxScore.trim() !== "") {
        const s = Number(form.favBandWhipsawMaxScore);
        if (!Number.isFinite(s) || s < 0 || s > 100) errors.push("Whipsaw: score max dans [0, 100] (ou vide = off)");
      }
      if (form.favBandWhipsawMaxIntraFlips.trim() !== "") {
        const f = Number(form.favBandWhipsawMaxIntraFlips);
        if (!Number.isFinite(f) || f < 1) errors.push("Whipsaw: max flips >= 1 (ou vide = off)");
      }
    }
    if (form.favBandImbalanceCrossMin.trim() !== "") {
      const v = Number(form.favBandImbalanceCrossMin);
      if (!Number.isFinite(v) || v <= -1 || v >= 1) {
        errors.push("Imbalance: plancher cross dans (-1, 1) (ou vide = off)");
      }
    }
    if (form.favBandImbalanceTicks.trim() !== "") {
      const n = Number(form.favBandImbalanceTicks);
      if (!Number.isFinite(n) || n < 1) errors.push("Imbalance: ticks >= 1 (ou vide = defaut 2)");
    }
    if (form.favBandImbalanceMaxSpread.trim() !== "") {
      const s = Number(form.favBandImbalanceMaxSpread);
      if (!Number.isFinite(s) || s <= 0) errors.push("Imbalance: spread max > 0 (ou vide = off)");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return errors;
}

export function formsEqual(a: ConfigFormState, b: ConfigFormState): boolean {
  return (Object.keys(a) as Array<keyof ConfigFormState>).every((key) => {
    const av = a[key];
    const bv = b[key];
    return av === bv;
  });
}

/**
 * Mappe les erreurs de validateConfigForm aux champs du formulaire concernés.
 * Retourne un Record<key, message> pour affichage inline dans le panel.
 */
export function fieldErrors(
  form: ConfigFormState,
  isBacktest: boolean,
  opts?: { leadsWithEdge?: boolean },
): Partial<Record<keyof ConfigFormState, string>> {
  const result: Partial<Record<keyof ConfigFormState, string>> = {};
  const edge = engineUsesEdge(form.strategyId, opts?.leadsWithEdge);

  try {
    const cheapBuyMin = Number(form.cheapBuyMin);
    const cheapBuyMax = Number(form.cheapBuyMax);
    const expensiveBuyMin = Number(form.expensiveBuyMin);
    const expensiveBuyMax = Number(form.expensiveBuyMax);
    const pairLockMax = Number(form.pairLockMax);
    const barbellHedgeRatio = Number(form.barbellHedgeRatio);
    const minutesBeforeCloseMin = Number(form.minutesBeforeCloseMin);
    const minutesBeforeCloseMax = Number(form.minutesBeforeCloseMax);
    const pollIntervalMs = Number(form.pollIntervalMs);
    const maxOpenPositionsPerSide = Number(form.maxOpenPositionsPerSide);
    const simFillProbability = Number(form.simFillProbabilityNonMarketable);
    const simResolveRetryIntervalMs = Number(form.simResolveRetryIntervalMs);

    // Parse errors (NaN)
    if (!Number.isFinite(cheapBuyMin)) result.cheapBuyMin = "Nombre invalide";
    if (!Number.isFinite(cheapBuyMax)) result.cheapBuyMax = "Nombre invalide";
    if (!Number.isFinite(expensiveBuyMin)) result.expensiveBuyMin = "Nombre invalide";
    if (!Number.isFinite(expensiveBuyMax)) result.expensiveBuyMax = "Nombre invalide";
    if (!Number.isFinite(pairLockMax)) result.pairLockMax = "Nombre invalide";
    if (!Number.isFinite(barbellHedgeRatio)) result.barbellHedgeRatio = "Nombre invalide";
    if (!Number.isFinite(minutesBeforeCloseMin)) result.minutesBeforeCloseMin = "Nombre invalide";
    if (!Number.isFinite(minutesBeforeCloseMax)) result.minutesBeforeCloseMax = "Nombre invalide";
    if (!Number.isFinite(pollIntervalMs)) result.pollIntervalMs = "Nombre invalide";
    if (!Number.isFinite(maxOpenPositionsPerSide)) result.maxOpenPositionsPerSide = "Nombre invalide";
    if (!Number.isFinite(simFillProbability)) result.simFillProbabilityNonMarketable = "Nombre invalide";
    if (!Number.isFinite(simResolveRetryIntervalMs)) result.simResolveRetryIntervalMs = "Nombre invalide";

    // Range / relation errors
    if (Number.isFinite(cheapBuyMin) && Number.isFinite(cheapBuyMax) && cheapBuyMin > cheapBuyMax) {
      result.cheapBuyMax = "Cheap max doit être ≥ cheap min";
    }
    if (Number.isFinite(expensiveBuyMin) && Number.isFinite(expensiveBuyMax) && expensiveBuyMin > expensiveBuyMax) {
      result.expensiveBuyMax = "Hedge max doit être ≥ hedge min";
    }
    if (!edge) {
      if (
        form.strategyId !== "fav-band" &&
        form.strategyId !== "dip-revert" &&
        form.strategyId !== "antiflip-revert" &&
        form.strategyId !== "flip-confirm" &&
        form.strategyId !== "early-conviction" &&
        form.strategyId !== "open-entry" &&
        form.strategyId !== "probability-repricing" &&
        Number.isFinite(cheapBuyMax) &&
        Number.isFinite(expensiveBuyMin) &&
        cheapBuyMax >= expensiveBuyMin
      ) {
        result.expensiveBuyMin = "Hedge min doit être > cheap max";
      }
      if (form.strategyId === "arb") {
        if (Number.isFinite(pairLockMax) && (pairLockMax < 0.9 || pairLockMax >= 1.0)) {
          result.pairLockMax = "Entre 0.90 et 0.99";
        }
        if (form.arbAskSumMax.trim() !== "") {
          const askSum = Number(form.arbAskSumMax);
          if (!Number.isFinite(askSum)) {
            result.arbAskSumMax = "Nombre invalide";
          } else if (askSum < 0.9 || (Number.isFinite(pairLockMax) && askSum > pairLockMax)) {
            result.arbAskSumMax = "Entre 0.90 et pairLockMax";
          }
        }
        if (!form.enableExpensiveHedge) {
          result.enableExpensiveHedge = "Obligatoire pour arb";
        }
      }
      if (form.strategyId === "barbell") {
        if (Number.isFinite(barbellHedgeRatio) && !(barbellHedgeRatio > 0 && barbellHedgeRatio <= 1)) {
          result.barbellHedgeRatio = "Doit être dans (0, 1]";
        }
      }
    }
    if (Number.isFinite(minutesBeforeCloseMin) && Number.isFinite(minutesBeforeCloseMax) && minutesBeforeCloseMin > minutesBeforeCloseMax) {
      result.minutesBeforeCloseMax = "Max doit être ≥ min";
    }
    if (Number.isFinite(pollIntervalMs) && pollIntervalMs < 500) {
      result.pollIntervalMs = "≥ 500 ms";
    }
    if (Number.isFinite(maxOpenPositionsPerSide) && maxOpenPositionsPerSide < 1) {
      result.maxOpenPositionsPerSide = "≥ 1";
    }
    if (Number.isFinite(simFillProbability) && (simFillProbability < 0 || simFillProbability > 1)) {
      result.simFillProbabilityNonMarketable = "Entre 0 et 1";
    }
    if (Number.isFinite(simResolveRetryIntervalMs) && simResolveRetryIntervalMs < 500) {
      result.simResolveRetryIntervalMs = "≥ 500 ms";
    }

    // Validation des champs sim exposés dans le panel
    const simResolveDelaySeconds = Number(form.simResolveDelaySeconds);
    const simResolveMaxRetries = Number(form.simResolveMaxRetries);
    const simMaxRetryAttempts = Number(form.simMaxRetryAttempts);
    const simulatedCapital = Number(form.simulatedCapital);
    const maxExposureUsdc = Number(form.maxExposureUsdc);
    const maxSharesPerOrder = Number(form.maxSharesPerOrder);

    if (!Number.isFinite(simResolveDelaySeconds)) result.simResolveDelaySeconds = "Nombre invalide";
    else if (simResolveDelaySeconds < 0) result.simResolveDelaySeconds = "≥ 0";
    if (!Number.isFinite(simResolveMaxRetries)) result.simResolveMaxRetries = "Nombre invalide";
    else if (simResolveMaxRetries < 0) result.simResolveMaxRetries = "≥ 0";
    if (!Number.isFinite(simMaxRetryAttempts)) result.simMaxRetryAttempts = "Nombre invalide";
    else if (simMaxRetryAttempts < 0) result.simMaxRetryAttempts = "≥ 0";
    if (!Number.isFinite(simulatedCapital)) result.simulatedCapital = "Nombre invalide";
    else if (simulatedCapital <= 0) result.simulatedCapital = "> 0";
    if (!Number.isFinite(maxExposureUsdc)) result.maxExposureUsdc = "Nombre invalide";
    else if (maxExposureUsdc <= 0) result.maxExposureUsdc = "> 0";
    if (!Number.isFinite(maxSharesPerOrder)) result.maxSharesPerOrder = "Nombre invalide";
    else if (maxSharesPerOrder < 1) result.maxSharesPerOrder = "≥ 1";
    if (!isBacktest && form.simResolveFallback === "probabilistic") {
      result.simResolveFallback = "Interdit en live";
    }
    if (form.marketSlugPrefixes.split(",").map((s) => s.trim()).filter(Boolean).length === 0) {
      result.marketSlugPrefixes = "Au moins un préfixe requis";
    }

    // Edge-lead validations
    if (edge) {
      const edgeBandMin = Number(form.edgeBandMin);
      const edgeBandMax = Number(form.edgeBandMax);
      const edgeConfirmSamples = Number(form.edgeConfirmSamples);
      const edgeMaxDownTick = Number(form.edgeMaxDownTick);
      const edgeOrderUsdc = Number(form.edgeOrderUsdc);
      const maxShareEdge = Number(form.maxShareEdge);
      const edgeCheapOrderUsdc = Number(form.edgeCheapOrderUsdc);
      const edgeCheapBandMin = Number(form.edgeCheapBandMin);
      const edgeCheapBandMax = Number(form.edgeCheapBandMax);

      if (!Number.isFinite(edgeBandMin)) result.edgeBandMin = "Nombre invalide";
      if (!Number.isFinite(edgeBandMax)) result.edgeBandMax = "Nombre invalide";
      if (Number.isFinite(edgeBandMin) && Number.isFinite(edgeBandMax)) {
        if (edgeBandMin >= edgeBandMax) result.edgeBandMax = "Max doit être > min";
        if (edgeBandMin < 0.5 || edgeBandMax > 0.99) result.edgeBandMin = "Bande dans [0.50, 0.99]";
      }
      if (Number.isFinite(edgeConfirmSamples) && edgeConfirmSamples < 2) result.edgeConfirmSamples = "≥ 2";
      if (Number.isFinite(edgeMaxDownTick) && edgeMaxDownTick <= 0) result.edgeMaxDownTick = "> 0";
      if (Number.isFinite(edgeOrderUsdc) && edgeOrderUsdc <= 0) result.edgeOrderUsdc = "> 0";
      if (Number.isFinite(maxShareEdge) && maxShareEdge < 1) result.maxShareEdge = "≥ 1";
      if (Number.isFinite(edgeCheapOrderUsdc) && edgeCheapOrderUsdc <= 0) result.edgeCheapOrderUsdc = "> 0";
      if (Number.isFinite(edgeCheapBandMin) && Number.isFinite(edgeCheapBandMax)) {
        if (edgeCheapBandMin >= edgeCheapBandMax) result.edgeCheapBandMax = "Max doit être > min";
        if (edgeCheapBandMin < 0.01 || edgeCheapBandMax > 0.49) result.edgeCheapBandMin = "Bande dans [0.01, 0.49]";
      }
      if (form.edgeSizingMode === "shares") {
        const edgeSharesEdge = Number(form.edgeSharesEdge);
        const edgeSharesCheap = Number(form.edgeSharesCheap);
        if (Number.isFinite(edgeSharesEdge) && edgeSharesEdge < 5) result.edgeSharesEdge = "≥ 5 (min CLOB)";
        if (Number.isFinite(edgeSharesCheap) && edgeSharesCheap < 5) result.edgeSharesCheap = "≥ 5 (min CLOB)";
      }
      const sellAfterMin = Number(form.edgeSellExpensiveAfterMin);
      const sellLossPct = Number(form.edgeSellExpensiveLossPct);
      const sellLossWindowMs = Number(form.edgeSellExpensiveLossWindowMs);
      if (Number.isFinite(sellAfterMin) && sellAfterMin < 0) result.edgeSellExpensiveAfterMin = "≥ 0";
      if (Number.isFinite(sellLossPct) && sellLossPct <= 0) result.edgeSellExpensiveLossPct = "> 0";
      if (Number.isFinite(sellLossWindowMs) && sellLossWindowMs <= 0) result.edgeSellExpensiveLossWindowMs = "> 0";
    }

    if (form.strategyId === "reverse" && form.reverseMaxGridLevels.trim() !== "") {
      const maxLevels = Number(form.reverseMaxGridLevels);
      if (!Number.isFinite(maxLevels) || maxLevels < 1) {
        result.reverseMaxGridLevels = "vide ou ≥ 1";
      }
    }

    if (form.strategyId === "fav-band") {
      const lo = Number(form.favBandAskMin);
      const hi = Number(form.favBandAskMax);
      const elapsed = Number(form.favBandMinElapsedSec);
      if (!Number.isFinite(lo)) result.favBandAskMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.favBandAskMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.favBandAskMin = "Doit être < ask max";
      }
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.favBandMinElapsedSec = "Entre 0 et 900";
      }
      if (form.favBandMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.favBandMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.favBandMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (form.favBandInverseEnabled) {
        const invAsk = Number(form.favBandInverseAskMax);
        const invRatio = Number(form.favBandInverseShareRatio);
        const invBudget = Number(form.favBandInverseOrderUsdc);
        const maxPos = Number(form.maxOpenPositionsPerSide);
        if (!Number.isFinite(invAsk)) {
          result.favBandInverseAskMax = "Nombre invalide";
        } else if (invAsk <= 0 || invAsk >= 0.5) {
          result.favBandInverseAskMax = "Entre 0 et 0.5";
        }
        if (!Number.isFinite(invRatio) || invRatio <= 0) {
          result.favBandInverseShareRatio = "> 0";
        }
        if (!Number.isFinite(invBudget)) {
          result.favBandInverseOrderUsdc = "Nombre invalide";
        } else if (Number.isFinite(invAsk) && invAsk > 0 && invAsk < 0.5) {
          const maxShares = Number(form.maxSharesPerOrder);
          const cap = Number.isFinite(maxShares) && maxShares > 0 ? maxShares : Number.MAX_SAFE_INTEGER;
          const sized = Math.floor(Math.min(invBudget / invAsk, cap) * 100) / 100;
          if (sized < 5) {
            result.favBandInverseOrderUsdc = `Min ${Math.ceil(5 * invAsk * 100) / 100} USDC (5 shares)`;
          }
        }
        if (Number.isFinite(maxPos) && maxPos < 2) {
          result.maxOpenPositionsPerSide = "≥ 2 (jambe inverse)";
        }
      }
      if (form.favBandExitEnabled) {
        const exDrop = Number(form.favBandExitMinLowerHighDrop);
        const exRetrace = Number(form.favBandExitRetraceRatio);
        const exConsec = Number(form.favBandExitConsecutive);
        const exLookback = Number(form.favBandExitLookbackMs);
        const exElapsed = Number(form.favBandExitMinElapsedSec);
        if (!Number.isFinite(exDrop) || exDrop <= 0) {
          result.favBandExitMinLowerHighDrop = "> 0";
        }
        if (!Number.isFinite(exRetrace) || exRetrace < 0 || exRetrace > 1) {
          result.favBandExitRetraceRatio = "[0, 1]";
        }
        if (!Number.isFinite(exConsec) || exConsec < 2) {
          result.favBandExitConsecutive = "≥ 2";
        }
        if (!Number.isFinite(exLookback) || exLookback <= 0) {
          result.favBandExitLookbackMs = "> 0 ms";
        }
        if (!Number.isFinite(exElapsed) || exElapsed < 0) {
          result.favBandExitMinElapsedSec = "≥ 0";
        }
        if (form.favBandExitSwitchEnabled) {
          const swBudget = Number(form.favBandExitSwitchOrderUsdc);
          if (!Number.isFinite(swBudget) || swBudget <= 0) {
            result.favBandExitSwitchOrderUsdc = "> 0";
          }
          const maxPos = Number(form.maxOpenPositionsPerSide);
          if (Number.isFinite(maxPos) && maxPos < 2) {
            result.maxOpenPositionsPerSide = "≥ 2 (jambe switch)";
          }
        }
      }
    }
    if (form.strategyId === "dip-revert") {
      const lo = Number(form.dipRevertBandMin);
      const hi = Number(form.dipRevertBandMax);
      const drop = Number(form.dipRevertMinDrop);
      const lookback = Number(form.dipRevertDropLookbackMs);
      const elapsed = Number(form.dipRevertMinElapsedSec);
      const spread = Number(form.dipRevertMaxSpread);
      const budget = Number(form.dipRevertOrderUsdc);
      if (!Number.isFinite(lo)) result.dipRevertBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.dipRevertBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.dipRevertBandMin = "Doit être < ask max";
      }
      if (!Number.isFinite(drop) || drop <= 0) result.dipRevertMinDrop = "> 0";
      if (!Number.isFinite(lookback) || lookback <= 0) result.dipRevertDropLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.dipRevertMinElapsedSec = "Entre 0 et 900";
      }
      if (form.dipRevertMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.dipRevertMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.dipRevertMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.dipRevertMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.dipRevertOrderUsdc = "> 0";
    }
    if (form.strategyId === "antiflip-revert") {
      const lo = Number(form.antiflipBandMin);
      const hi = Number(form.antiflipBandMax);
      const floor = Number(form.antiflipDeposedAskMin);
      const lookback = Number(form.antiflipFlipLookbackMs);
      const elapsed = Number(form.antiflipMinElapsedSec);
      const spread = Number(form.antiflipMaxSpread);
      const budget = Number(form.antiflipOrderUsdc);
      if (!Number.isFinite(lo)) result.antiflipBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.antiflipBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.antiflipBandMin = "Doit être < ask max";
      }
      if (form.antiflipDeposedAskMin.trim() !== "" && (!Number.isFinite(floor) || floor < lo || floor > hi)) {
        result.antiflipDeposedAskMin = "Dans la bande (ou vide)";
      }
      if (!Number.isFinite(lookback) || lookback <= 0) result.antiflipFlipLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.antiflipMinElapsedSec = "Entre 0 et 900";
      }
      if (form.antiflipMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.antiflipMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.antiflipMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.antiflipMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.antiflipOrderUsdc = "> 0";
      const tp = Number(form.antiflipTakeProfitPct);
      if (!Number.isFinite(tp) || tp < 0 || tp > 0.9) {
        result.antiflipTakeProfitPct = "Entre 0 et 0.9 (0 = hold to resolution)";
      }
      // Miroir backend (config.ts validateConfigCoherence) : bounceFloor null
      // ou dans [bandMin, bandMax] — sinon le backend rejette au Apply.
      if (form.antiflipBounceFloor.trim() !== "") {
        const bFloor = Number(form.antiflipBounceFloor);
        if (
          !Number.isFinite(bFloor) ||
          (Number.isFinite(lo) && bFloor < lo) ||
          (Number.isFinite(hi) && bFloor > hi)
        ) {
          result.antiflipBounceFloor = "Dans la bande (ou vide)";
        }
      }
    }
    if (form.strategyId === "flip-confirm") {
      const lo = Number(form.flipConfirmBandMin);
      const hi = Number(form.flipConfirmBandMax);
      const lookback = Number(form.flipConfirmFlipLookbackMs);
      const elapsed = Number(form.flipConfirmMinElapsedSec);
      const spread = Number(form.flipConfirmMaxSpread);
      const budget = Number(form.flipConfirmOrderUsdc);
      if (!Number.isFinite(lo)) result.flipConfirmBandMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.flipConfirmBandMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.flipConfirmBandMin = "Doit être < ask max";
      }
      if (!Number.isFinite(lookback) || lookback <= 0) result.flipConfirmFlipLookbackMs = "> 0 ms";
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 900) {
        result.flipConfirmMinElapsedSec = "Entre 0 et 900";
      }
      if (form.flipConfirmMaxElapsedSec.trim() !== "") {
        const maxE = Number(form.flipConfirmMaxElapsedSec);
        if (!Number.isFinite(maxE) || (Number.isFinite(elapsed) && maxE < elapsed)) {
          result.flipConfirmMaxElapsedSec = "Vide ou >= min elapsed";
        }
      }
      if (!Number.isFinite(spread) || spread < 0) result.flipConfirmMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.flipConfirmOrderUsdc = "> 0";
    }
    if (form.strategyId === "early-conviction") {
      const lo = Number(form.earlyConvictionAskMin);
      const hi = Number(form.earlyConvictionAskMax);
      const maxElapsed = Number(form.earlyConvictionMaxElapsedSec);
      const spread = Number(form.earlyConvictionMaxSpread);
      const budget = Number(form.earlyConvictionOrderUsdc);
      if (!Number.isFinite(lo)) result.earlyConvictionAskMin = "Nombre invalide";
      if (!Number.isFinite(hi)) result.earlyConvictionAskMax = "Nombre invalide";
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= hi) {
        result.earlyConvictionAskMin = "Doit être < ask max";
      }
      if (Number.isFinite(lo) && lo < 0.5) result.earlyConvictionAskMin = ">= 0.5";
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.earlyConvictionMaxElapsedSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(spread) || spread < 0) result.earlyConvictionMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.earlyConvictionOrderUsdc = "> 0";
    }
    if (form.strategyId === "early-low") {
      const lo = Number(form.earlyLowBuyAskMin);
      const hi = Number(form.earlyLowBuyAskMax);
      const maxElapsed = Number(form.earlyLowMaxElapsedSec);
      const spread = Number(form.earlyLowMaxSpread);
      const budget = Number(form.earlyLowOrderUsdc);
      const exitAsk = Number(form.earlyLowExitAsk);
      const momentum = Number(form.earlyLowExitMomentumMin);
      if (!Number.isFinite(lo) || lo < 0) result.earlyLowBuyAskMin = ">= 0 (0 = off)";
      if (!Number.isFinite(hi) || hi <= lo) result.earlyLowBuyAskMax = "Doit être > ask min";
      else if (hi >= 0.5) result.earlyLowBuyAskMax = "< 0.5";
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.earlyLowMaxElapsedSec = "Entre 1 et 900";
      }
      if (!Number.isFinite(spread) || spread < 0) result.earlyLowMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.earlyLowOrderUsdc = "> 0";
      if (form.earlyLowExitEnabled) {
        if (!Number.isFinite(exitAsk) || exitAsk <= 0 || exitAsk >= 1) { result.earlyLowExitAsk = "En (0, 1)"; }
        else if (Number.isFinite(hi) && exitAsk <= hi) { result.earlyLowExitAsk = "> bande max d'achat"; }
        if (!Number.isFinite(momentum) || momentum < 0) result.earlyLowExitMomentumMin = ">= 0";
      }
    }
    if (form.strategyId === "open-entry") {
      const lean = Number(form.openEntryLeanTrigger);
      const maxElapsed = Number(form.openEntryMaxElapsedSec);
      const fair = Number(form.openEntryFairAskSumMax);
      const spread = Number(form.openEntryMaxSpread);
      const budget = Number(form.openEntryOrderUsdc);
      const flipDist = Number(form.openEntrySlStructFlipDist);
      const confirmSec = Number(form.openEntrySlStructConfirmSec);
      const structDist = Number(form.openEntrySlStructDist);
      const lateAfter = Number(form.openEntrySlLateAfterSec);
      const lateDist = Number(form.openEntrySlLateDist);
      if (!Number.isFinite(lean) || lean <= 0 || lean > 0.5) {
        result.openEntryLeanTrigger = "Entre 0 (exclu) et 0.5";
      }
      if (!Number.isFinite(maxElapsed) || maxElapsed <= 0 || maxElapsed > 900) {
        result.openEntryMaxElapsedSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(fair) || fair <= 1 || fair > 1.2) {
        result.openEntryFairAskSumMax = "Entre 1 (exclu) et 1.2";
      }
      if (!Number.isFinite(spread) || spread < 0) result.openEntryMaxSpread = ">= 0";
      if (!Number.isFinite(budget) || budget <= 0) result.openEntryOrderUsdc = "> 0";
      if (!Number.isFinite(flipDist) || flipDist <= 0 || flipDist > 1) {
        result.openEntrySlStructFlipDist = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(confirmSec) || confirmSec < 0 || confirmSec > 900) {
        result.openEntrySlStructConfirmSec = "Entre 0 et 900";
      }
      if (!Number.isFinite(structDist) || structDist <= 0 || structDist > 1) {
        result.openEntrySlStructDist = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(lateAfter) || lateAfter <= 0 || lateAfter > 900) {
        result.openEntrySlLateAfterSec = "Entre 0 (exclu) et 900";
      }
      if (
        Number.isFinite(lateDist) &&
        Number.isFinite(structDist) &&
        (lateDist <= 0 || lateDist > structDist)
      ) {
        result.openEntrySlLateDist = "Doit être <= SL struct dist";
      }
    }
    if (form.strategyId === "probability-repricing") {
      const tauMin = Number(form.repricingTauMinSec);
      const spreadMax = Number(form.repricingSpreadMax);
      const pEntryMax = Number(form.repricingPEntryMax);
      const edgeMin = Number(form.repricingEdgeMin);
      const orderUsdc = Number(form.repricingOrderUsdc);
      const targetAbs = Number(form.repricingTargetAbs);
      const targetRel = Number(form.repricingTargetRel);
      const stopAbs = Number(form.repricingStopAbs);
      const holdMax = Number(form.repricingHoldMaxSec);
      const tauForce = Number(form.repricingTauForceExitSec);
      const spreadMaxExit = Number(form.repricingSpreadMaxExit);
      const lateWindow = Number(form.repricingLateWindowSec);
      const historyMs = Number(form.repricingHistoryWindowMs);
      const dislocationMin = Number(form.repricingDislocationMin);
      const feedAge = Number(form.repricingFeedMaxAgeMs);
      const signalTtl = Number(form.repricingSignalTtlMs);
      const fees = Number(form.repricingFeesRoundtrip);
      const slipEntry = Number(form.repricingSlipEntryBuffer);
      const slipExit = Number(form.repricingSlipExitBuffer);
      const notionalMax = Number(form.repricingNotionalMaxPerMarket);
      if (!Number.isFinite(tauMin) || tauMin <= 0 || tauMin > 900) {
        result.repricingTauMinSec = "Entre 0 (exclu) et 900";
      }
      if (!Number.isFinite(spreadMax) || spreadMax < 0) result.repricingSpreadMax = ">= 0";
      if (!Number.isFinite(pEntryMax) || pEntryMax <= 0 || pEntryMax > 1) {
        result.repricingPEntryMax = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(edgeMin) || edgeMin < 0) result.repricingEdgeMin = ">= 0";
      if (!Number.isFinite(orderUsdc) || orderUsdc <= 0) result.repricingOrderUsdc = "> 0";
      if (!Number.isFinite(targetAbs) || targetAbs <= 0 || targetAbs > 1) {
        result.repricingTargetAbs = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(targetRel) || targetRel < 0) result.repricingTargetRel = ">= 0";
      if (!Number.isFinite(stopAbs) || stopAbs <= 0 || stopAbs > 1) {
        result.repricingStopAbs = "Entre 0 (exclu) et 1";
      }
      if (!Number.isFinite(holdMax) || holdMax <= 0) result.repricingHoldMaxSec = "> 0";
      if (!Number.isFinite(tauForce) || tauForce <= 0 || !(Number.isFinite(tauMin) && tauForce < tauMin)) {
        result.repricingTauForceExitSec = "Dans (0, tau min)";
      }
      if (!Number.isFinite(spreadMaxExit) || (Number.isFinite(spreadMax) && spreadMaxExit < spreadMax)) {
        result.repricingSpreadMaxExit = ">= spread max";
      }
      if (!Number.isFinite(lateWindow) || lateWindow <= 0) result.repricingLateWindowSec = "> 0";
      if (!Number.isFinite(historyMs) || historyMs < 1000) result.repricingHistoryWindowMs = ">= 1000";
      if (!Number.isFinite(dislocationMin) || dislocationMin <= 0) result.repricingDislocationMin = "> 0";
      if (!Number.isFinite(feedAge) || feedAge <= 0) result.repricingFeedMaxAgeMs = "> 0";
      if (!Number.isFinite(signalTtl) || signalTtl <= 0) result.repricingSignalTtlMs = "> 0";
      if (!Number.isFinite(fees) || fees < 0) result.repricingFeesRoundtrip = ">= 0";
      if (!Number.isFinite(slipEntry) || slipEntry < 0) result.repricingSlipEntryBuffer = ">= 0";
      if (!Number.isFinite(slipExit) || slipExit < 0) result.repricingSlipExitBuffer = ">= 0";
      if (!Number.isFinite(notionalMax) || notionalMax <= 0) result.repricingNotionalMaxPerMarket = "> 0";
    }
  } catch (error) {
    // ignore — validateConfigForm handles this
  }

  return result;
}
