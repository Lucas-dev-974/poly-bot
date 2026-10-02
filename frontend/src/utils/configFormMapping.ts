import type { BotConfig } from "../types";
import type { ConfigFormState } from "./configFormTypes";

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
    edgeSellExpensiveAfterMin: parseNum(form.edgeSellExpensiveAfterMin, "Vente edge aprÃ¨s (min)"),
    edgeSellExpensiveLossPct: parseNum(form.edgeSellExpensiveLossPct, "Perte edge %"),
    edgeSellExpensiveLossWindowMs: parseNum(form.edgeSellExpensiveLossWindowMs, "FenÃªtre perte edge (ms)"),
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
    throw new Error("Au moins un prÃ©fixe de marchÃ© est requis");
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

export function formsEqual(a: ConfigFormState, b: ConfigFormState): boolean {
  return (Object.keys(a) as Array<keyof ConfigFormState>).every((key) => {
    const av = a[key];
    const bv = b[key];
    return av === bv;
  });
}
