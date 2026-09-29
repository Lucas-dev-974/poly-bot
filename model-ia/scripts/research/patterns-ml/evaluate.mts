/**
 * Utilitaires d'évaluation partagés entre patterns-ml et next-market-ml
 * Walk-forward splitter, baselines B1-B3, anti-leak test
 */

import { type ContextFeatures, type WindowMeta } from './dataset.mts';

export interface BaselineResult {
  name: string;
  logLoss: number;
  accuracy: number;
  brier: number;
  predictions: number[]; // P(Up) pour chaque test sample
}

export interface WalkForwardSplit {
  train: ContextFeatures[];
  test: ContextFeatures[];
  day: string;
}

/**
 * Baseline B1 : Constante 0.50
 */
export function baselineConstant(train: ContextFeatures[], test: ContextFeatures[]): BaselineResult {
  const predictions = test.map(() => 0.5);
  return evaluatePredictions('B1_Constant_0.50', test, predictions);
}

/**
 * Baseline B2 : Base rate global (fréquence Up sur train)
 */
export function baselineGlobalRate(train: ContextFeatures[], test: ContextFeatures[]): BaselineResult {
  const upCount = train.filter((c) => c.label_outcome === 0).length;
  const pUp = upCount / train.length;
  const predictions = test.map(() => pUp);
  return evaluatePredictions('B2_Global_Rate', test, predictions);
}

/**
 * Baseline B3 : Base rate conditionnel par session
 * Session basée sur l'heure UTC du tick
 */
export function baselineSessionRate(train: ContextFeatures[], test: ContextFeatures[]): BaselineResult {
  // Calcule P(Up) par session sur train
  const sessionRates = new Map<string, { up: number; total: number }>();

  for (const ctx of train) {
    const hour = new Date(ctx.tickTs).getUTCHours();
    let session: string;
    if (hour >= 0 && hour < 8) session = 'Asia';
    else if (hour >= 8 && hour < 16) session = 'Europe';
    else session = 'US';

    const current = sessionRates.get(session) || { up: 0, total: 0 };
    if (ctx.label_outcome === 0) current.up++;
    current.total++;
    sessionRates.set(session, current);
  }

  // Prédictions sur test
  const predictions = test.map((ctx) => {
    const hour = new Date(ctx.tickTs).getUTCHours();
    let session: string;
    if (hour >= 0 && hour < 8) session = 'Asia';
    else if (hour >= 8 && hour < 16) session = 'Europe';
    else session = 'US';

    const rate = sessionRates.get(session);
    return rate ? rate.up / rate.total : 0.5;
  });

  return evaluatePredictions('B3_Session_Rate', test, predictions);
}

/**
 * Évalue un ensemble de prédictions vs labels réels
 */
export function evaluatePredictions(
  name: string,
  test: ContextFeatures[],
  predictions: number[]
): BaselineResult {
  if (test.length !== predictions.length) {
    throw new Error(`Length mismatch: ${test.length} vs ${predictions.length}`);
  }

  let logLoss = 0;
  let correct = 0;
  let brier = 0;

  for (let i = 0; i < test.length; i++) {
    const p = Math.max(1e-15, Math.min(1 - 1e-15, predictions[i])); // Clip pour log
    const y = test[i].label_outcome === 0 ? 1 : 0; // 1 = Up gagne

    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    brier += (p - y) ** 2;
    if ((p >= 0.5 && y === 1) || (p < 0.5 && y === 0)) correct++;
  }

  const n = test.length;
  return {
    name,
    logLoss: logLoss / n,
    accuracy: correct / n,
    brier: brier / n,
    predictions,
  };
}

/**
 * Lance toutes les baselines B1-B3 sur un split walk-forward
 */
export function runAllBaselines(
  train: ContextFeatures[],
  test: ContextFeatures[]
): BaselineResult[] {
  return [
    baselineConstant(train, test),
    baselineGlobalRate(train, test),
    baselineSessionRate(train, test),
  ];
}

/**
 * Compare modèle vs baselines
 * Retourte true si modèle bat TOUTES les baselines en log-loss
 */
export function modelBeatsBaselines(
  modelResult: BaselineResult,
  baselines: BaselineResult[]
): { beatsAll: boolean; details: Array<{ baseline: string; modelBetter: boolean; diff: number }> } {
  const details = baselines.map((b) => ({
    baseline: b.name,
    modelBetter: modelResult.logLoss < b.logLoss,
    diff: b.logLoss - modelResult.logLoss, // positif = modèle meilleur
  }));
  const beatsAll = details.every((d) => d.modelBetter);
  return { beatsAll, details };
}

/**
 * Test anti-fuite : vérifie feature.ts < decision.ts pour tous contextes
 */
export function antiLeakTest(contexts: ContextFeatures[], windows: WindowMeta[]): {
  pass: boolean;
  violations: Array<{ eventSlug: string; featureTs: number; decisionTs: number; windowEnd: number }>;
} {
  const windowMap = new Map(windows.map((w) => [w.eventSlug, w]));
  const violations: Array<{ eventSlug: string; featureTs: number; decisionTs: number; windowEnd: number }> = [];

  for (const ctx of contexts) {
    const window = windowMap.get(ctx.eventSlug);
    if (!window) continue;

    // Feature timestamp = contexte tickTs
    // Decision timestamp = contexte tickTs (on décide à ce tick)
    // Resolution timestamp = window.windowEnd
    // Doit avoir : featureTs <= decisionTs < windowEnd
    if (ctx.tickTs >= window.windowEnd) {
      violations.push({
        eventSlug: ctx.eventSlug,
        featureTs: ctx.tickTs,
        decisionTs: ctx.tickTs,
        windowEnd: window.windowEnd,
      });
    }
  }

  return { pass: violations.length === 0, violations };
}

/**
 * Split walk-forward par jour (expanding window)
 * Identique à dataset.walkForwardSplitByDay mais ici pour réutilisation
 */
export function walkForwardSplitByDay(
  contexts: ContextFeatures[]
): WalkForwardSplit[] {
  const byDay = new Map<string, ContextFeatures[]>();
  for (const ctx of contexts) {
    const date = new Date(ctx.tickTs).toISOString().split('T')[0];
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push(ctx);
  }

  const days = Array.from(byDay.keys()).sort();
  const splits: WalkForwardSplit[] = [];

  for (let i = 1; i < days.length; i++) {
    const trainDays = days.slice(0, i);
    const testDay = days[i];

    const train: ContextFeatures[] = [];
    for (const d of trainDays) train.push(...byDay.get(d)!);
    const test = byDay.get(testDay)!;

    splits.push({ train, test, day: testDay });
  }

  return splits;
}

/**
 * Calcule métriques par jour pour attribution
 */
export function computeDailyAttribution(
  splits: WalkForwardSplit[],
  modelPredictions: Map<string, number[]> // day -> predictions
): Array<{ day: string; logLoss: number; accuracy: number; brier: number; n: number; pnl?: number }> {
  const results: Array<{ day: string; logLoss: number; accuracy: number; brier: number; n: number; pnl?: number }> = [];

  for (const split of splits) {
    const preds = modelPredictions.get(split.day);
    if (!preds || preds.length !== split.test.length) continue;

    let logLoss = 0;
    let correct = 0;
    let brier = 0;

    for (let i = 0; i < split.test.length; i++) {
      const p = Math.max(1e-15, Math.min(1 - 1e-15, preds[i]));
      const y = split.test[i].label_outcome === 0 ? 1 : 0;

      logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      brier += (p - y) ** 2;
      if ((p >= 0.5 && y === 1) || (p < 0.5 && y === 0)) correct++;
    }

    const n = split.test.length;
    results.push({
      day: split.day,
      logLoss: logLoss / n,
      accuracy: correct / n,
      brier: brier / n,
      n,
    });
  }

  return results;
}

/**
 * t-stat empirique sur PnL par trade (pour validation économique)
 */
export function empiricalTStat(pnlPerTrade: number[]): { tStat: number; mean: number; std: number; n: number } {
  const n = pnlPerTrade.length;
  if (n < 2) return { tStat: 0, mean: 0, std: 0, n };
  const mean = pnlPerTrade.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(pnlPerTrade.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const tStat = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  return { tStat, mean, std, n };
}