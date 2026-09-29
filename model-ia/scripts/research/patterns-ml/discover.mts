/**
 * Discovery pipeline : clustering + stats conditionnelles + split-half + contrôle causal + filtre MDE
 * Temps 1 de SPEC-patterns §3.1
 *
 * Audit fixes 2026-09-26 (cf. audit + probes exécutées sur bot-live.db) :
 *  1. CLUSTERING : 1 objet = 1 fenêtre complète (SAX homogène de saxPaaSegments
 *     symboles). L'ancien code mélangeait des shapelets de longueurs [10,20,40] →
 *     crash hammingDistance ; et l'ancienne config [30,60,120] sur des chaînes de
 *     10 symboles produisait 0 candidat → rapports vides du 2026-09-26 05:06/05:34.
 *  2. ARI SPLIT-HALF : réellement calculé (clustering jours pairs → médiodes,
 *     assignation de TOUTES les fenêtres aux 2 jeux de médiodes, ARI sur labels
 *     parallèles). L'ancien code renvoyait `ari = 0.5 // placeholder`.
 *  3. CONTRÔLE CAUSAL : régression logistique (Newton-Raphson TS pur, L2 léger)
 *     entraînée HORS cluster, appliquée au cluster. L'ancienne version copiait le
 *     base rate → ΔP ≡ 0 par construction.
 *  4. BASELINE B4 : P(Up | prix favori discretisé en bandes) — le pattern doit
 *     battre le prix lui-même pour avoir un edge (leçon OpenMarket arXiv 2607.26245).
 *  5. BINOMIAL exact (Clopper-Pearson) pour tout n (l'ancien "exact" était une
 *     copie de l'approximation normale).
 *  6. BENJAMINI-HOCHBERG step-up correct (k* = max i tel que p(i) ≤ (i/m)·q).
 *  7. CLI fix : import.meta.url vs process.argv[1] via pathToFileURL (Windows).
 */

import { kMedoidsPAM, assignWindowToCluster, type Medoid, type ShapeletCandidate, type KMedoidsResult } from './shapelets.mts';
import { toSAX, DEFAULT_SAX_CONFIG } from './sax.mts';
import { buildDataset, loadWindowTicks, type ContextFeatures, type WindowMeta, type DatasetConfig } from './dataset.mts';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface DiscoverConfig {
  dataset: DatasetConfig;
  /** Segments PAA par fenêtre complète (= longueur de la chaîne SAX, défaut 120) */
  saxPaaSegments: number;
  /** Taille alphabet SAX */
  alphabetSize: number;
  /** Nombre de clusters (défaut 8 — 4 connus + marge) */
  k: number;
  maxIter: number;
  minClusterSize: number;
  power: number;
  alpha: number;
  fdr: number;
  ariThreshold: number;
  silhouetteThreshold: number;
  seed: number;
}

export const DEFAULT_DISCOVER_CONFIG: DiscoverConfig = {
  dataset: {
    dbPath: '',
    elapsedPct: 0.30,
    maxElapsedPct: 0.75,
    lookbackTicks: 60,
    saxConfig: {},
  },
  saxPaaSegments: 120,
  alphabetSize: 8,
  k: 8,
  maxIter: 10,
  minClusterSize: 50,
  power: 0.8,
  alpha: 0.05,
  fdr: 0.10,
  ariThreshold: 0.6,
  silhouetteThreshold: 0.25,
  seed: 42,
};

export interface ClusterStats {
  clusterId: number;
  medoid: Medoid;
  n: number;
  pUpGivenCluster: number;
  pUpBaseline: number; // max(P(Up|logistique hors-cluster), P(Up|prix B4))
  pUpCausal: number;
  pUpPrice: number;
  deltaP: number;
  direction60sUpRate: number;
  mde: number;
  pValue: number;
  significant: boolean;
  ari: number;
  stable: boolean;
  verdict: 'CANDIDATE' | 'REDUNDANT' | 'UNSTABLE' | 'TOO_SMALL' | 'KNOWN_PATTERN';
  knownPattern?: 'dip-revert' | 'flip-confirm' | 'early-conviction' | 'antiflip';
}

export interface DiscoveryResult {
  config: DiscoverConfig;
  clusters: ClusterStats[];
  medoids: Medoid[];
  silhouette: number;
  splitHalf: { ari: number; stable: boolean; nEarly: number; nLate: number };
  causalControl: { baselinePUp: number; clustersWithEdge: number };
  gateA1: {
    pass: boolean;
    knownPatternsFound: number;
    details: { pattern: string; clusterId: number; deltaP: number; significant: boolean }[];
  };
  timestamp: string;
}

/**
 * MDE (Minimum Detectable Effect) pour un test binomial
 * MDE ≈ (z_{1-α/2} + z_{power}) · sqrt(p0(1-p0)) / sqrt(n)
 */
export function computeMDE(n: number, power: number = 0.8, alpha: number = 0.05, p0: number = 0.5): number {
  const zAlpha = alpha === 0.05 ? 1.96 : alpha === 0.01 ? 2.576 : 1.645;
  const zPower = power === 0.8 ? 0.84 : power === 0.9 ? 1.28 : 0.67;
  return (zAlpha + zPower) * Math.sqrt(p0 * (1 - p0)) / Math.sqrt(n);
}

/** lnGamma (Lanczos) pour le binomial exact */
function lnGamma(x: number): number {
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.5073432786869048,
    -0.13857109526572012, 9.9843685682473e-7, 1.5056327351493116e-7,
  ];
  x -= 1;
  let a = C[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinomialPDF(k: number, n: number, p: number): number {
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/**
 * Test binomial EXACT bilatéral (Clopper-Pearson) vs p0.
 */
export function binomialTest(k: number, n: number, p0: number = 0.5): number {
  if (n === 0) return 1;
  if (p0 <= 0 || p0 >= 1) throw new Error('p0 must be in (0,1)');

  const pdf = (i: number): number => Math.exp(logBinomialPDF(i, n, p0));
  const obs = k / n;
  let pValue: number;
  if (obs >= p0) {
    let upper = 0;
    for (let i = k; i <= n; i++) upper += pdf(i);
    pValue = Math.min(1, upper);
  } else {
    let lower = 0;
    for (let i = 0; i <= k; i++) lower += pdf(i);
    pValue = Math.min(1, lower);
  }
  return Math.min(1, 2 * pValue);
}

/**
 * Benjamini-Hochberg step-up (k* = plus grand i tel que p(i) ≤ (i/m)·q).
 */
export function benjaminiHochberg(
  pValues: number[],
  fdr: number = 0.10
): Array<{ index: number; pValue: number; significant: boolean; threshold: number }> {
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ index: i, pValue: p }));
  indexed.sort((a, b) => a.pValue - b.pValue);

  let kStar = 0;
  for (let i = m; i >= 1; i--) {
    const threshold = (i / m) * fdr;
    if (indexed[i - 1].pValue <= threshold) { kStar = i; break; }
  }

  const results: Array<{ index: number; pValue: number; significant: boolean; threshold: number }> = [];
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    results.push({ ...indexed[i], significant: rank <= kStar, threshold: (rank / m) * fdr });
  }
  results.sort((a, b) => a.index - b.index);
  return results;
}

/**
 * Adjusted Rand Index entre deux clusterings (mêmes objets).
 */
export function adjustedRandIndex(labels1: number[], labels2: number[]): number {
  if (labels1.length !== labels2.length || labels1.length === 0) return 0;
  const n = labels1.length;

  const contingency = new Map<string, number>();
  const c1 = new Map<number, number>();
  const c2 = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const key = `${labels1[i]},${labels2[i]}`;
    contingency.set(key, (contingency.get(key) || 0) + 1);
    c1.set(labels1[i], (c1.get(labels1[i]) || 0) + 1);
    c2.set(labels2[i], (c2.get(labels2[i]) || 0) + 1);
  }

  let sumComb = 0;
  for (const count of contingency.values()) sumComb += count * (count - 1) / 2;
  let sumComb1 = 0;
  for (const v of c1.values()) sumComb1 += v * (v - 1) / 2;
  let sumComb2 = 0;
  for (const v of c2.values()) sumComb2 += v * (v - 1) / 2;

  const totalComb = n * (n - 1) / 2;
  const expected = (sumComb1 * sumComb2) / totalComb;
  const maxComb = (sumComb1 + sumComb2) / 2;

  if (maxComb === expected) return 1;
  return (sumComb - expected) / (maxComb - expected);
}

function computeBaselinePUp(contexts: ContextFeatures[]): number {
  const upCount = contexts.filter((c) => c.label_outcome === 0).length;
  return contexts.length > 0 ? upCount / contexts.length : 0.5;
}

// ---------------------------------------------------------------------------
// Régression logistique TS pure (Newton-Raphson, ridge léger) — contrôle causal
// ---------------------------------------------------------------------------

export interface LogisticModel {
  w: number[];      // w[0] = intercept, w[j+1] = poids de la feature j
  means: number[];
  stds: number[];
}

/**
 * Entraîne une régression logistique (features standardisées, Newton-Raphson).
 * Exportée pour tests unitaires.
 */
export function fitLogistic(
  X: number[][],
  y: number[],
  opts: { iters?: number; l2?: number } = {}
): LogisticModel {
  const iters = opts.iters ?? 15;
  const l2 = opts.l2 ?? 1e-3;
  const n = X.length;
  const dFeat = X[0].length;
  const d = dFeat + 1; // + intercept

  const means = new Array<number>(dFeat).fill(0);
  const stds = new Array<number>(dFeat).fill(0);
  for (const row of X) for (let j = 0; j < dFeat; j++) means[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < dFeat; j++) stds[j] += (row[j] - means[j]) ** 2 / n;
  for (let j = 0; j < dFeat; j++) stds[j] = Math.sqrt(stds[j]) || 1;

  const norm = (row: number[]): number[] => row.map((v, j) => (v - means[j]) / stds[j]);
  const w = new Array<number>(d).fill(0);
  const Xn = X.map(norm);

  for (let iter = 0; iter < iters; iter++) {
    const grad = new Array<number>(d).fill(0);
    const hess = Array.from({ length: d }, () => new Array<number>(d).fill(0));

    for (let i = 0; i < n; i++) {
      const xi = [1, ...Xn[i]];
      let z = 0;
      for (let j = 0; j < d; j++) z += w[j] * xi[j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < d; j++) {
        grad[j] += err * xi[j];
        for (let jj = 0; jj < d; jj++) hess[j][jj] += p * (1 - p) * xi[j] * xi[jj];
      }
    }
    for (let j = 0; j < d; j++) {
      grad[j] += l2 * w[j];
      hess[j][j] += l2;
    }

    // Gauss-Jordan : H · Δw = g → w ← w − Δw
    const A = hess.map((r, i) => [...r, grad[i]]);
    for (let col = 0; col < d; col++) {
      let piv = col;
      for (let r = col + 1; r < d; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) continue;
      [A[col], A[piv]] = [A[piv], A[col]];
      const pv = A[col][col];
      for (let jj = 0; jj <= d; jj++) A[col][jj] /= pv;
      for (let r = 0; r < d; r++) {
        if (r === col) continue;
        const f = A[r][col];
        for (let jj = col; jj <= d; jj++) A[r][jj] -= f * A[col][jj];
      }
    }
    for (let j = 0; j < d; j++) w[j] -= A[j][d];
  }

  return { w, means, stds };
}

/** P(classe=1) pour une ligne, avec le modèle fitLogistic. Exportée pour tests. */
export function logisticP(model: LogisticModel, row: number[]): number {
  let z = model.w[0];
  for (let j = 0; j < row.length; j++) {
    z += model.w[j + 1] * ((row[j] - model.means[j]) / model.stds[j]);
  }
  return 1 / (1 + Math.exp(-z));
}

/**
 * 5 stats par série (mean, std, min, max, last) sur le lookback → 25 features.
 */
function featurize(c: ContextFeatures): number[] {
  const stats = (arr: number[]): number[] => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    return [mean, std, Math.min(...arr), Math.max(...arr), arr[arr.length - 1]];
  };
  return [
    ...stats(c.raw_favAsk), ...stats(c.raw_askSum), ...stats(c.raw_spread),
    ...stats(c.raw_imbalance), ...stats(c.raw_depth),
  ];
}

/**
 * Contrôle causal : P(Up | features brutes) au conditionnement du cluster.
 * Entraîne une régression logistique sur les fenêtres HORS cluster (out-of-cluster)
 * et prédit sur les fenêtres DU cluster. Si le pattern n'ajoute rien au-delà des
 * features brutes, P(Up|cluster) ≈ P(Up|brut) → ΔP ≈ 0.
 */
function computeCausalBaseline(
  contexts: ContextFeatures[],
  clusterAssignments: number[],
  clusterId: number
): number {
  const inCluster: ContextFeatures[] = [];
  const outCluster: ContextFeatures[] = [];
  for (let i = 0; i < contexts.length; i++) {
    if (clusterAssignments[i] === clusterId) inCluster.push(contexts[i]);
    else outCluster.push(contexts[i]);
  }
  if (inCluster.length === 0 || outCluster.length < 20) {
    return computeBaselinePUp(contexts);
  }

  const Xtrain = outCluster.map(featurize);
  const ytrain = outCluster.map((c) => (c.label_outcome === 0 ? 1 : 0));
  const model = fitLogistic(Xtrain, ytrain);

  let sum = 0;
  for (const c of inCluster) {
    sum += logisticP(model, featurize(c));
  }
  return sum / inCluster.length;
}

/**
 * Baseline B4 : P(Up) conditionné au prix favori (discretisé en bandes),
 * taux Up par bande estimé sur TOUT le dataset (pas seulement le cluster).
 */
function computePriceBaseline(
  contexts: ContextFeatures[],
  clusterAssignments: number[],
  clusterId: number,
  bins: number = 5
): number {
  const inCluster = contexts.filter((_, i) => clusterAssignments[i] === clusterId);
  if (inCluster.length === 0) return 0.5;

  const allFav = contexts.map((c) => c.raw_favAsk[c.raw_favAsk.length - 1]).filter(Number.isFinite);
  if (allFav.length === 0) return 0.5;
  const sorted = [...allFav].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < bins; b++) edges.push(sorted[Math.floor((b / bins) * sorted.length)]);

  const binOf = (v: number): number => {
    let bin = 0;
    while (bin < edges.length && v >= edges[bin]) bin++;
    return bin;
  };

  const binUp = new Array<number>(bins).fill(0);
  const binTotal = new Array<number>(bins).fill(0);
  for (const c of contexts) {
    const last = c.raw_favAsk[c.raw_favAsk.length - 1];
    if (!Number.isFinite(last)) continue;
    const b = binOf(last);
    binTotal[b]++;
    if (c.label_outcome === 0) binUp[b]++;
  }

  let sum = 0;
  let count = 0;
  for (const c of inCluster) {
    const last = c.raw_favAsk[c.raw_favAsk.length - 1];
    if (!Number.isFinite(last)) continue;
    const b = binOf(last);
    sum += binTotal[b] > 0 ? binUp[b] / binTotal[b] : 0.5;
    count++;
  }
  return count > 0 ? sum / count : 0.5;
}

/**
 * Mapping cluster → pattern connu (heuristique sur la forme du médiod + stats).
 */
function mapClusterToKnownPattern(
  medoid: string,
  pUp: number,
  dir60: number
): 'dip-revert' | 'flip-confirm' | 'early-conviction' | 'antiflip' | null {
  const hasVShape = /a{2,}[b-f]{1,}[g-h]{2,}|[g-h]{2,}[b-f]{1,}a{2,}/.test(medoid);
  const hasTransition = /a{2,}[b-h]{2,}|[g-h]{2,}[a-f]{2,}/.test(medoid);
  const isFlat = /^a+$|^b+$|^c+$|^d+$|^e+$|^f+$|^g+$|^h+$/.test(medoid);

  if (isFlat && (pUp > 0.62 || pUp < 0.38)) return 'early-conviction';
  if (hasVShape && pUp > 0.55 && dir60 > 0.55) return 'dip-revert';
  if (hasTransition && pUp > 0.55) return 'flip-confirm';
  if (hasVShape && dir60 < 0.45) return 'antiflip';
  return null;
}

/**
 * Pipeline de découverte principal.
 *  - 1 objet de clustering = 1 fenêtre complète (SAX homogène de saxPaaSegments)
 *  - Stats conditionnelles par cluster via les contextes (1 par fenêtre)
 *  - Split-half réel : clustering jours pairs vs impairs, ARI sur labels croisés
 *  - Contrôle causal : logistique hors-cluster + baseline prix B4
 */
export function runDiscovery(config: Partial<DiscoverConfig> = {}): DiscoveryResult {
  const cfg = { ...DEFAULT_DISCOVER_CONFIG, ...config };

  console.log('=== PHASE 1 DISCOVERY START ===');
  console.log('Config:', JSON.stringify({ ...cfg, dataset: { ...cfg.dataset, dbPath: cfg.dataset.dbPath || '(default)' } }, null, 2));

  // 1. Build dataset (contextes + fenêtres)
  const { contexts, windows, stats } = buildDataset(cfg.dataset);
  console.log(`Dataset: ${contexts.length} contexts from ${windows.length} windows (raw windows: ${stats.totalWindows})`);

  if (contexts.length === 0) {
    throw new Error('No contexts generated - check dataset config');
  }

  // 2. SAX full-window pour chaque fenêtre (favAsk, longueur homogène)
  console.log('Generating full-window SAX...');
  const dbPath = cfg.dataset.dbPath || path.resolve(process.cwd(), 'data/bot-live.db');
  const db = new Database(dbPath, { readonly: true });

  const saxByWindowIndex = new Map<number, string>();
  try {
    const saxConfig = { ...DEFAULT_SAX_CONFIG, alphabetSize: cfg.alphabetSize, paaSegments: cfg.saxPaaSegments };
    for (let i = 0; i < windows.length; i++) {
      const ticks = loadWindowTicks(db, windows[i].eventSlug);
      if (ticks.length < cfg.saxPaaSegments) continue; // série trop courte pour PAA homogène
      const series = ticks.map((tick) => (tick.up_bestAsk <= tick.down_bestAsk ? tick.up_bestAsk : tick.down_bestAsk));
      const sax = toSAX(series, { ...saxConfig, windowTicks: series.length, stride: series.length, paaSegments: cfg.saxPaaSegments });
      saxByWindowIndex.set(i, sax);
    }
  } finally {
    db.close();
  }
  console.log(`SAX générés pour ${saxByWindowIndex.size}/${windows.length} fenêtres`);

  // 3. Clustering des fenêtres (1 objet = 1 fenêtre, longueur homogène)
  console.log('Clustering (PAM) sur fenêtres complètes...');
  const candidates: ShapeletCandidate[] = [];
  for (const [idx, sax] of saxByWindowIndex) {
    candidates.push({ shapelet: sax, length: sax.length, start: 0, windowIndex: idx });
  }

  const clustering: KMedoidsResult = kMedoidsPAM(candidates, {
    lengths: [cfg.saxPaaSegments],
    k: cfg.k,
    maxIter: cfg.maxIter,
    seed: cfg.seed,
  });
  console.log(`Clusters: ${clustering.medoids.length}, silhouette=${clustering.silhouette.toFixed(3)}, ${clustering.stats.swapEvals} swap evals en ${(clustering.stats.elapsedMs / 1000).toFixed(1)}s`);

  // 4. Assignation fenêtre → cluster (via médiodes) → contexte
  const windowCluster = new Map<number, number>();
  for (const [idx, sax] of saxByWindowIndex) {
    const assigned = assignWindowToCluster(sax, clustering.medoids);
    windowCluster.set(idx, assigned?.clusterId ?? -1);
  }
  const clusterAssignments: number[] = contexts.map((ctx) => windowCluster.get(ctx.windowIndex) ?? -1);

  // 5. Split-half RÉEL : clustering sur fenêtres des jours pairs, sur jours impairs,
  //    puis ARI entre les 2 jeux de labels (assignation croisée sur TOUTES les fenêtres)
  console.log('Split-half validation (réel)...');
  const dayOf = (idx: number): string => new Date(windows[idx].windowStart).toISOString().split('T')[0];
  const daysSorted = [...new Set(windows.map((_, i) => dayOf(i)))].sort();
  const earlyDaySet = new Set(daysSorted.filter((_, i) => i % 2 === 0));
  const earlyIdx = [...saxByWindowIndex.keys()].filter((idx) => earlyDaySet.has(dayOf(idx)));
  const lateIdx = [...saxByWindowIndex.keys()].filter((idx) => !earlyDaySet.has(dayOf(idx)));

  let ari = 0;
  if (earlyIdx.length >= cfg.k * 5 && lateIdx.length >= cfg.k * 5) {
    const earlyCands = earlyIdx.map((idx) => ({ shapelet: saxByWindowIndex.get(idx)!, length: saxByWindowIndex.get(idx)!.length, start: 0, windowIndex: idx }));
    const earlyResult = kMedoidsPAM(earlyCands, { lengths: [cfg.saxPaaSegments], k: cfg.k, maxIter: cfg.maxIter, seed: cfg.seed });

    const lateCands = lateIdx.map((idx) => ({ shapelet: saxByWindowIndex.get(idx)!, length: saxByWindowIndex.get(idx)!.length, start: 0, windowIndex: idx }));
    const lateResult = kMedoidsPAM(lateCands, { lengths: [cfg.saxPaaSegments], k: cfg.k, maxIter: cfg.maxIter, seed: cfg.seed + 1 });

    // ARI exige les MÊMES objets des deux côtés : assignation croisée de toutes
    // les fenêtres aux médiodes early ET late.
    const allIdx = [...saxByWindowIndex.keys()];
    const labelsEarlyModel = allIdx.map((idx) => assignWindowToCluster(saxByWindowIndex.get(idx)!, earlyResult.medoids)?.clusterId ?? -1);
    const labelsLateModel = allIdx.map((idx) => assignWindowToCluster(saxByWindowIndex.get(idx)!, lateResult.medoids)?.clusterId ?? -1);
    ari = adjustedRandIndex(labelsEarlyModel, labelsLateModel);
    console.log(`ARI split-half: ${ari.toFixed(3)} (seuil ${cfg.ariThreshold})`);
  } else {
    console.log(`Split-half sauté (données insuffisantes: early=${earlyIdx.length}, late=${lateIdx.length})`);
  }
  const splitHalfStable = ari >= cfg.ariThreshold;

  // 6. Stats par cluster + contrôles
  console.log('Cluster stats + contrôle causal + baseline prix...');
  const baselinePUp = computeBaselinePUp(contexts);
  const clusterStats: ClusterStats[] = [];
  const pValues: number[] = [];

  for (const medoid of clustering.medoids) {
    const n = medoid.members.length;
    const clusterId = medoid.clusterId;

    if (n < cfg.minClusterSize) {
      clusterStats.push({
        clusterId, medoid, n,
        pUpGivenCluster: 0.5, pUpBaseline: baselinePUp, pUpCausal: baselinePUp, pUpPrice: baselinePUp, deltaP: 0,
        direction60sUpRate: 0.5, mde: 1, pValue: 1, significant: false,
        ari, stable: splitHalfStable, verdict: 'TOO_SMALL',
      });
      pValues.push(1);
      continue;
    }

    const clusterContexts = contexts.filter((_, i) => clusterAssignments[i] === clusterId);
    const upCount = clusterContexts.filter((c) => c.label_outcome === 0).length;
    const pUpGiven = upCount / n;
    const dir60Up = clusterContexts.filter((c) => c.label_direction60s === 1).length / n;

    const pUpCausal = computeCausalBaseline(contexts, clusterAssignments, clusterId);
    const pUpPrice = computePriceBaseline(contexts, clusterAssignments, clusterId);
    const pUpBaseline = Math.max(pUpCausal, pUpPrice); // contrôle le plus dur
    const deltaP = pUpGiven - pUpBaseline;

    const mde = computeMDE(n, cfg.power, cfg.alpha, baselinePUp);
    const pVal = binomialTest(upCount, n, pUpBaseline);
    pValues.push(pVal);

    clusterStats.push({
      clusterId, medoid, n,
      pUpGivenCluster: pUpGiven,
      pUpBaseline, pUpCausal, pUpPrice, deltaP,
      direction60sUpRate: dir60Up,
      mde, pValue: pVal, significant: false,
      ari, stable: splitHalfStable,
      verdict: 'CANDIDATE',
    });
  }

  // 7. Correction BH step-up + verdicts
  const bhResults = benjaminiHochberg(pValues, cfg.fdr);
  for (let i = 0; i < clusterStats.length; i++) {
    const c = clusterStats[i];
    c.significant = bhResults[i].significant && c.deltaP >= c.mde;
    if (c.verdict === 'TOO_SMALL') continue;
    if (c.significant) {
      c.verdict = 'CANDIDATE';
    } else if (!splitHalfStable) {
      c.verdict = 'UNSTABLE';
    } else {
      c.verdict = 'REDUNDANT';
    }
  }

  // 8. Mapping patterns connus (info, tous clusters assez grands)
  for (const c of clusterStats) {
    if (c.verdict === 'TOO_SMALL') continue;
    const known = mapClusterToKnownPattern(c.medoid.shapelet, c.pUpGivenCluster, c.direction60sUpRate);
    if (known) c.knownPattern = known;
  }

  const knownPatternsFound = clusterStats.filter((c) => c.knownPattern && c.significant).length;
  const gateA1Pass = knownPatternsFound >= 3;

  // 9. Résultat final
  const result: DiscoveryResult = {
    config: cfg,
    clusters: clusterStats,
    medoids: clustering.medoids,
    silhouette: clustering.silhouette,
    splitHalf: { ari, stable: splitHalfStable, nEarly: earlyIdx.length, nLate: lateIdx.length },
    causalControl: {
      baselinePUp,
      clustersWithEdge: clusterStats.filter((c) => c.significant && c.deltaP > 0).length,
    },
    gateA1: {
      pass: gateA1Pass,
      knownPatternsFound,
      details: clusterStats.filter((c) => c.knownPattern).map((c) => ({
        pattern: c.knownPattern!, clusterId: c.clusterId, deltaP: c.deltaP, significant: c.significant,
      })),
    },
    timestamp: new Date().toISOString(),
  };

  console.log('=== DISCOVERY COMPLETE ===');
  console.log(`Gate G-A1: ${gateA1Pass ? 'PASS' : 'FAIL'} (${knownPatternsFound}/4 known patterns rediscovered)`);
  console.log(`Clusters: ${clusterStats.length}, significant: ${clusterStats.filter((c) => c.significant).length}`);
  console.log(`Silhouette: ${clustering.silhouette.toFixed(3)}, split-half ARI: ${ari.toFixed(3)}`);

  return result;
}

/**
 * Génère le rapport Markdown
 */
export function generateReport(result: DiscoveryResult, config: DiscoverConfig): string {
  const lines: string[] = [];
  lines.push('# Phase 1 Discovery Report');
  lines.push('');
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Config:** k=${config.k}, alphabet=${config.alphabetSize}, paa=${config.saxPaaSegments}, minClusterSize=${config.minClusterSize}`);
  lines.push('');
  lines.push('## Gate G-A1 Verdict');
  lines.push('');
  lines.push(`**${result.gateA1.pass ? '✅ PASS' : '❌ FAIL'}** — ${result.gateA1.knownPatternsFound}/4 known patterns rediscovered as significant clusters.`);
  lines.push('');
  if (result.gateA1.details.length > 0) {
    lines.push('| Pattern | Cluster | ΔP | Significant |');
    lines.push('|---------|---------|-----|-------------|');
    for (const d of result.gateA1.details) {
      lines.push(`| ${d.pattern} | ${d.clusterId} | ${d.deltaP.toFixed(4)} | ${d.significant ? '✅' : '❌'} |`);
    }
    lines.push('');
  }

  lines.push('## Cluster Summary');
  lines.push('');
  lines.push('| Cluster | n | P(Up|cluster) | P(Up|logit) | P(Up|prix B4) | ΔP | MDE | p-value | BH Sig | Dir60s | Verdict | Known |');
  lines.push('|---------|---|---------------|-------------|---------------|-----|-----|---------|--------|--------|---------|-------|');
  for (const c of result.clusters) {
    lines.push(`| ${c.clusterId} | ${c.n} | ${c.pUpGivenCluster.toFixed(4)} | ${c.pUpCausal.toFixed(4)} | ${c.pUpPrice.toFixed(4)} | ${c.deltaP.toFixed(4)} | ${c.mde.toFixed(4)} | ${c.pValue.toFixed(4)} | ${c.significant ? '✅' : '❌'} | ${c.direction60sUpRate.toFixed(3)} | ${c.verdict} | ${c.knownPattern || '-'} |`);
  }
  lines.push('');

  lines.push('## Split-Half Validation (réelle)');
  lines.push('');
  lines.push(`- **ARI:** ${result.splitHalf.ari.toFixed(3)} (seuil ${config.ariThreshold})`);
  lines.push(`- **Stable:** ${result.splitHalf.stable ? 'Yes' : 'No'}`);
  lines.push(`- **nEarly/nLate:** ${result.splitHalf.nEarly}/${result.splitHalf.nLate}`);
  lines.push('');

  lines.push('## Causal Control');
  lines.push('');
  lines.push(`- **Baseline P(Up):** ${result.causalControl.baselinePUp.toFixed(4)}`);
  lines.push(`- **Clusters with positive edge (ΔP > 0 & significant):** ${result.causalControl.clustersWithEdge}`);
  lines.push('');

  lines.push('## Global Metrics');
  lines.push('');
  lines.push(`- **Silhouette:** ${result.silhouette.toFixed(3)} (${result.silhouette < config.silhouetteThreshold ? '⚠️ Low — clusters may not be separable' : 'OK'})`);
  lines.push(`- **Non-separability threshold:** ${config.silhouetteThreshold}`);
  lines.push('');

  lines.push('## New Pattern Candidates for Phase 2');
  lines.push('');
  const candidates = result.clusters.filter((c) => c.verdict === 'CANDIDATE' && !c.knownPattern);
  if (candidates.length === 0) {
    lines.push('*None*');
  } else {
    lines.push('| Cluster | n | ΔP | Dir60s | Medoid (début) |');
    lines.push('|---------|---|-----|--------|-----------------|');
    for (const c of candidates) {
      lines.push(`| ${c.clusterId} | ${c.n} | ${c.deltaP.toFixed(4)} | ${c.direction60sUpRate.toFixed(3)} | \`${c.medoid.shapelet.slice(0, 40)}\` |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Sérialisation JSON safe (Medoid.members tronqués) */
function jsonSafe(result: DiscoveryResult): any {
  return {
    config: result.config,
    timestamp: result.timestamp,
    silhouette: result.silhouette,
    splitHalf: result.splitHalf,
    causalControl: result.causalControl,
    gateA1: result.gateA1,
    medoids: result.medoids.map((m) => ({
      clusterId: m.clusterId,
      length: m.length,
      shapelet: m.shapelet,
      nMembers: m.members.length,
      membersSample: m.members.slice(0, 20),
    })),
    clusters: result.clusters.map((c) => ({
      ...c,
      medoid: { clusterId: c.medoid.clusterId, shapelet: c.medoid.shapelet, length: c.medoid.length, nMembers: c.medoid.members.length },
    })),
  };
}

/**
 * Sauvegarde résultats (JSON + MD) + archive audits
 */
export function saveResults(result: DiscoveryResult, config: DiscoverConfig, outputDir: string = 'model-ia/patterns'): void {
  const timestamp = result.timestamp.replace(/[:.]/g, '-');
  const baseName = `report-discovery-${timestamp}`;

  const jsonPath = path.resolve(outputDir, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonSafe(result), null, 2));
  console.log(`Saved JSON: ${jsonPath}`);

  const mdPath = path.resolve(outputDir, `${baseName}.md`);
  const md = generateReport(result, config);
  fs.writeFileSync(mdPath, md);
  console.log(`Saved Markdown: ${mdPath}`);

  const auditDir = path.resolve('audits/backtest/patterns-ml');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  fs.copyFileSync(mdPath, path.resolve(auditDir, `${baseName}.md`));
  console.log(`Archived: ${path.resolve(auditDir, `${baseName}.md`)}`);
}

/**
 * Point d'entrée CLI (compatible Windows : comparaison via pathToFileURL)
 */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config: DiscoverConfig = {
    ...DEFAULT_DISCOVER_CONFIG,
    dataset: {
      ...DEFAULT_DISCOVER_CONFIG.dataset,
      dbPath: path.resolve(process.cwd(), 'data/bot-live.db'),
    },
  };

  try {
    const result = runDiscovery(config);
    saveResults(result, config);
    process.exit(result.gateA1.pass ? 0 : 1);
  } catch (error) {
    console.error('Discovery failed:', error);
    process.exit(1);
  }
}