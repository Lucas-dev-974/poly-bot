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
  simRequireCoveredPair: boolean;
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
  reverseCancelCheapOffBand: boolean;
  reverseDefendEnabled: boolean;
  reverseMaxGridLevels: string;
  reverseHedgeCapToFilledCheap: boolean;
  favBandAskMin: string;
  favBandAskMax: string;
  favBandMinElapsedSec: string;
  favBandMaxElapsedSec: string;
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
    simRequireCoveredPair: config.simRequireCoveredPair,
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
    simRequireCoveredPair: form.simRequireCoveredPair,
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
  };

  if (next.strategyId === "fav-band" || next.strategyId === "dip-revert") {
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
      if (form.dipRevertExitTakeProfitEnabled) {
        const tpAsk = Number(form.dipRevertExitWinAsk);
        if (!Number.isFinite(tpAsk) || tpAsk <= 0 || tpAsk >= 1) {
          result.dipRevertExitWinAsk = "Entre 0 et 1";
        } else if (Number.isFinite(hi) && tpAsk <= hi) {
          result.dipRevertExitWinAsk = "Doit être > ask max";
        }
      }
    }
  } catch (error) {
    // ignore — validateConfigForm handles this
  }

  return result;
}
