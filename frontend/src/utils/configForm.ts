import type { BotConfig, StrategyId } from "../types";
import { engineUsesEdge } from "../config/strategyPresets";

export type ConfigFormState = {
  marketSlugPrefixes: string;
  cheapBuyMin: string;
  cheapBuyMax: string;
  expensiveBuyMin: string;
  expensiveBuyMax: string;
  enableExpensiveHedge: boolean;
  cheapOrderUsdc: string;
  strategyId: StrategyId;
  barbellHedgeRatio: string;
  pairLockMax: string;
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
};

export function configToForm(config: BotConfig): ConfigFormState {
  return {
    marketSlugPrefixes: config.marketSlugPrefixes.join(", "),
    cheapBuyMin: String(config.cheapBuyMin),
    cheapBuyMax: String(config.cheapBuyMax),
    expensiveBuyMin: String(config.expensiveBuyMin),
    expensiveBuyMax: String(config.expensiveBuyMax),
    enableExpensiveHedge: config.enableExpensiveHedge,
    cheapOrderUsdc: String(config.cheapOrderUsdc),
    strategyId: config.strategyId ?? "arb",
    barbellHedgeRatio: String(config.barbellHedgeRatio ?? 0.5),
    pairLockMax: String(config.pairLockMax),
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
    enableExpensiveHedge: form.enableExpensiveHedge,
    cheapOrderUsdc: parseNum(form.cheapOrderUsdc, "Cheap order USDC"),
    strategyId: form.strategyId,
    barbellHedgeRatio: parseNum(form.barbellHedgeRatio, "Ratio hedge"),
    pairLockMax: parseNum(form.pairLockMax, "Pair lock max"),
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
  };

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
  dryRun: boolean,
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
    // Les validations arb/barbell (bandes cheap/hedge, lock, ratio) ne
    // s'appliquent pas à edge-lead : ces champs ne sont pas utilisés.
    if (!edge) {
      if (cheapBuyMax >= expensiveBuyMin) {
        errors.push("Cheap max doit être < hedge min");
      }
      if (pairLockMax < 0.90 || pairLockMax >= 1.00) {
        errors.push("Pair lock max doit être entre 0.90 et 0.99");
      }
      if (!(barbellHedgeRatio > 0 && barbellHedgeRatio <= 1)) {
        errors.push("Ratio hedge doit être dans (0, 1]");
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
    if (!dryRun && form.simResolveFallback === "probabilistic") {
      errors.push("Resolve fallback probabilistic interdit en mode live");
    }
    if (form.marketSlugPrefixes.split(",").map((s) => s.trim()).filter(Boolean).length === 0) {
      errors.push("Au moins un préfixe de marché est requis");
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
