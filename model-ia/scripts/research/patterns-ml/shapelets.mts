/**
 * Shapelets extraction + k-medoids (PAM) clustering sur chaînes SAX
 * Distance de Hamming, implémentation TS pure sans dépendances
 *
 * Audit fixes 2026-09-26 :
 *  1. CRASH FIX : hammingDistance levait une exception sur longueurs mixtes —
 *     kMedoidsPAM refuse explicitement les longueurs mixtes (groupes séparés
 *     via clusterShapeletsByLength).
 *  2. PERF FIX : matrice de distances précalculée (Uint16, Hamming brut —
 *     monotone équivalent à la version normalisée à longueur homogène) ;
 *     évaluation des swaps en O(n) via best/second-best (PAM standard) ;
 *     swaps échantillonnés CLARA-like au-delà de sampleSwapSize.
 *  3. INIT FIX : seed déterministe (mulberry32), 1er médiod = point central.
 *  4. SILHOUETTE FIX : échantillonnée au-delà de maxSilhouetteSamples.
 */

import { DEFAULT_SAX_CONFIG } from './sax.mts';

export interface ShapeletConfig {
  /** Longueurs de shapelets (informatif — un cluster run = une longueur) */
  lengths: number[];
  /** Nombre de clusters / médiodes (défaut: 8) */
  k: number;
  /** Max itérations PAM (défaut: 20) */
  maxIter: number;
  /** Taille max de l'échantillon de swap par itération PAM (0 = exhaustif) */
  sampleSwapSize: number;
  /** Taille max pour silhouette exacte (échantillonnage au-delà) */
  maxSilhouetteSamples: number;
  /** Seed du RNG déterministe */
  seed: number;
}

export const DEFAULT_SHAPELET_CONFIG: ShapeletConfig = {
  lengths: [20],
  k: 8,
  maxIter: 20,
  sampleSwapSize: 2000,
  maxSilhouetteSamples: 3000,
  seed: 42,
};

export interface ShapeletCandidate {
  shapelet: string;
  length: number;
  start: number;
  windowIndex: number; // index de la fenêtre d'origine
}

export interface Medoid {
  shapelet: string;
  length: number;
  clusterId: number;
  members: number[]; // indices dans le tableau de candidats du groupe
}

export interface KMedoidsResult {
  medoids: Medoid[];
  clusters: Map<number, number[]>; // clé = index du médiod dans candidates
  cost: number;
  silhouette: number;
  stats: { candidates: number; swapEvals: number; elapsedMs: number };
}

/** RNG déterministe mulberry32 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance de Hamming brute (longueurs égales requises) */
function hammingRaw(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) d++;
  return d;
}

/** Matrice de distances aplatie n×n (Uint16) */
function buildDistanceMatrix(candidates: ShapeletCandidate[]): Uint16Array {
  const n = candidates.length;
  const dist = new Uint16Array(n * n);
  for (let i = 0; i < n; i++) {
    const si = candidates[i].shapelet;
    for (let j = i + 1; j < n; j++) {
      const d = hammingRaw(si, candidates[j].shapelet);
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
  }
  return dist;
}

/** Coût d'un ensemble de médiodes : Σ_i min_m dist(i, m) */
function totalCost(dist: Uint16Array, n: number, medoidIndices: number[]): number {
  let cost = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (const m of medoidIndices) {
      const d = dist[i * n + m];
      if (d < best) best = d;
    }
    cost += best;
  }
  return cost;
}

/** Assignation à partir de la matrice */
function assignFromMatrix(
  dist: Uint16Array,
  n: number,
  medoidIndices: number[]
): Map<number, number[]> {
  const clusters = new Map<number, number[]>();
  for (const m of medoidIndices) clusters.set(m, []);
  for (let i = 0; i < n; i++) {
    let best = medoidIndices[0];
    let bestDist = dist[i * n + best];
    for (let j = 1; j < medoidIndices.length; j++) {
      const d = dist[i * n + medoidIndices[j]];
      if (d < bestDist) { bestDist = d; best = medoidIndices[j]; }
    }
    clusters.get(best)!.push(i);
  }
  return clusters;
}

/**
 * K-medoids++ initialisation (déterministe via rng).
 * 1er médiod = point le plus central (distance totale minimale),
 * suivants tirés pondérés par D(x) (distance au médiod le plus proche).
 */
function initMedoids(dist: Uint16Array, n: number, k: number, rng: () => number): number[] {
  if (n === 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);

  let bestFirst = 0;
  let bestTotal = Infinity;
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) total += dist[i * n + j];
    if (total < bestTotal) { bestTotal = total; bestFirst = i; }
  }
  const medoidIndices = [bestFirst];
  const inMedoids = new Set<number>(medoidIndices);

  while (medoidIndices.length < k) {
    const nonMedoid: number[] = [];
    for (let i = 0; i < n; i++) if (!inMedoids.has(i)) nonMedoid.push(i);
    let sum = 0;
    const dOf = new Array<number>(nonMedoid.length);
    for (let idx = 0; idx < nonMedoid.length; idx++) {
      const i = nonMedoid[idx];
      let minD = Infinity;
      for (const m of medoidIndices) {
        const d = dist[i * n + m];
        if (d < minD) minD = d;
      }
      dOf[idx] = minD;
      sum += minD;
    }
    let selected: number;
    if (sum === 0) {
      selected = nonMedoid[0]; // tous identiques : arbitraire
    } else {
      const target = rng() * sum;
      let acc = 0;
      selected = nonMedoid[nonMedoid.length - 1];
      for (let idx = 0; idx < nonMedoid.length; idx++) {
        acc += dOf[idx];
        if (acc >= target) { selected = nonMedoid[idx]; break; }
      }
    }
    medoidIndices.push(selected);
    inMedoids.add(selected);
  }
  return medoidIndices;
}

/**
 * Étape PAM : cherche un swap améliorant.
 * O(n) par swap via best/second-best précalculés (PAM standard).
 * Au-delà de sampleSwapSize, échantillonne les swaps (déterministe).
 */
function pamSwapStep(
  dist: Uint16Array,
  n: number,
  medoidIndices: number[],
  rng: () => number,
  sampleSwapSize: number
): { medoidIndices: number[]; improved: boolean; swapEvals: number } {
  // best / second-best par point
  const best1 = new Array<number>(n).fill(Infinity);
  const best1Idx = new Array<number>(n).fill(-1);
  const best2 = new Array<number>(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    for (const m of medoidIndices) {
      const d = dist[i * n + m];
      if (d < best1[i]) { best2[i] = best1[i]; best1[i] = d; best1Idx[i] = m; }
      else if (d < best2[i]) best2[i] = d;
    }
  }

  // Liste des swaps (médiod m remplacé par candidat c)
  const swaps: Array<{ m: number; c: number }> = [];
  for (const m of medoidIndices) {
    for (let c = 0; c < n; c++) {
      if (!medoidIndices.includes(c)) swaps.push({ m, c });
    }
  }
  if (sampleSwapSize > 0 && swaps.length > sampleSwapSize) {
    const stride = Math.ceil(swaps.length / sampleSwapSize);
    const sampled: Array<{ m: number; c: number }> = [];
    for (let i = 0; i < swaps.length; i += stride) sampled.push(swaps[i]);
    for (let i = sampled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [sampled[i], sampled[j]] = [sampled[j], sampled[i]];
    }
    swaps.length = 0;
    swaps.push(...sampled);
  }

  let swapEvals = 0;
  for (const { m, c } of swaps) {
    swapEvals++;
    // Δ coût en O(n) : si le best du point était m → second-best, sinon best
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const alt = best1Idx[i] === m ? best2[i] : best1[i];
      const dNew = Math.min(alt, dist[i * n + c]);
      delta += dNew - best1[i];
    }
    if (delta < 0) {
      return { medoidIndices: medoidIndices.map((x) => (x === m ? c : x)), improved: true, swapEvals };
    }
  }
  return { medoidIndices, improved: false, swapEvals };
}

/** Silhouette à partir de la matrice (échantillonnée si n grand) */
function silhouetteFromMatrix(
  dist: Uint16Array,
  n: number,
  clusters: Map<number, number[]>,
  maxSamples: number
): number {
  const clusterOf = new Map<number, number>();
  for (const [mIdx, members] of clusters) for (const p of members) clusterOf.set(p, mIdx);

  const all = [...clusterOf.keys()];
  if (all.length < 2) return 0;

  let sample = all;
  if (all.length > maxSamples) {
    const stride = Math.ceil(all.length / maxSamples);
    sample = all.filter((_, i) => i % stride === 0);
  }

  let total = 0;
  let count = 0;
  for (const i of sample) {
    const own = clusterOf.get(i)!;
    const ownMembers = clusters.get(own)!;
    const intraSub = ownMembers.length > 500
      ? ownMembers.filter((_, idx) => idx % Math.ceil(ownMembers.length / 500) === 0)
      : ownMembers;
    let aSum = 0;
    let aCount = 0;
    for (const m of intraSub) {
      if (m === i) continue;
      aSum += dist[i * n + m];
      aCount++;
    }
    const a = aCount > 0 ? aSum / aCount : 0;

    let b = Infinity;
    for (const [mIdx, members] of clusters) {
      if (mIdx === own) continue;
      const inter = members.length > 500
        ? members.filter((_, idx) => idx % Math.ceil(members.length / 500) === 0)
        : members;
      if (inter.length === 0) continue;
      let s = 0;
      for (const m of inter) s += dist[i * n + m];
      const mean = s / inter.length;
      if (mean < b) b = mean;
    }
    if (b === Infinity) continue;
    total += (b - a) / Math.max(a, b);
    count++;
  }
  return count > 0 ? total / count : 0;
}

/**
 * K-medoids (PAM) sur des candidats de MÊME longueur.
 * Garde-fou : longueurs mixtes → erreur explicite.
 */
export function kMedoidsPAM(
  candidates: ShapeletCandidate[],
  config: Partial<ShapeletConfig> = {}
): KMedoidsResult {
  const cfg = { ...DEFAULT_SHAPELET_CONFIG, ...config };
  const rng = mulberry32(cfg.seed);
  const t0 = Date.now();

  if (candidates.length === 0) {
    return { medoids: [], clusters: new Map(), cost: 0, silhouette: 0, stats: { candidates: 0, swapEvals: 0, elapsedMs: 0 } };
  }

  const lengths = new Set(candidates.map((c) => c.length));
  if (lengths.size > 1) {
    throw new Error(
      `kMedoidsPAM: candidats de longueurs mixtes (${[...lengths].join(',')}) — ` +
      `utilisez clusterShapeletsByLength() qui groupe par longueur`
    );
  }

  const n = candidates.length;
  const dist = buildDistanceMatrix(candidates);
  const k = Math.min(cfg.k, n);
  let medoidIndices = initMedoids(dist, n, k, rng);

  let swapEvals = 0;
  for (let iter = 0; iter < cfg.maxIter; iter++) {
    const { medoidIndices: next, improved, swapEvals: evals } = pamSwapStep(
      dist, n, medoidIndices, rng, cfg.sampleSwapSize
    );
    swapEvals += evals;
    medoidIndices = next;
    if (!improved) break;
  }

  const clusters = assignFromMatrix(dist, n, medoidIndices);
  const cost = totalCost(dist, n, medoidIndices);
  const silhouette = silhouetteFromMatrix(dist, n, clusters, cfg.maxSilhouetteSamples);

  const medoids: Medoid[] = medoidIndices.map((mIdx, clusterId) => ({
    shapelet: candidates[mIdx].shapelet,
    length: candidates[mIdx].length,
    clusterId,
    members: clusters.get(mIdx) || [],
  }));

  return {
    medoids,
    clusters,
    cost,
    silhouette,
    stats: { candidates: n, swapEvals, elapsedMs: Date.now() - t0 },
  };
}

/**
 * Clustering par groupes de longueur (Hamming entre longueurs différentes
 * n'a pas de sens). Les clusterId sont globaux et uniques.
 */
export function clusterShapeletsByLength(
  candidates: ShapeletCandidate[],
  config: Partial<ShapeletConfig> = {}
): { medoids: Medoid[]; silhouette: number; byLength: Map<number, KMedoidsResult> } {
  const byLength = new Map<number, KMedoidsResult>();
  const medoids: Medoid[] = [];
  const silhouettes: number[] = [];
  const lengths = [...new Set(candidates.map((c) => c.length))].sort((a, b) => a - b);

  let clusterIdOffset = 0;
  for (const len of lengths) {
    const group = candidates.filter((c) => c.length === len);
    const result = kMedoidsPAM(group, config);
    byLength.set(len, result);
    for (const med of result.medoids) {
      medoids.push({
        shapelet: med.shapelet,
        length: med.length,
        clusterId: clusterIdOffset + med.clusterId,
        members: med.members,
      });
    }
    silhouettes.push(result.silhouette);
    clusterIdOffset += result.medoids.length;
  }

  const silhouette = silhouettes.length ? silhouettes.reduce((a, b) => a + b, 0) / silhouettes.length : 0;
  return { medoids, silhouette, byLength };
}

/**
 * Assigne une fenêtre SAX à son cluster le plus proche (inférence).
 * Sliding du médiod dans la fenêtre ; médiod plus long que la fenêtre → skip.
 */
export function assignWindowToCluster(
  windowSax: string,
  medoids: Medoid[],
  distanceFn?: (a: string, b: string) => number
): { clusterId: number; distance: number; matchedShapelet: string } | null {
  if (medoids.length === 0) return null;

  let bestClusterId = -1;
  let bestDistance = Infinity;
  let bestShapelet = '';

  for (const medoid of medoids) {
    const medoidLen = medoid.shapelet.length;
    if (medoidLen > windowSax.length) continue;
    for (let start = 0; start + medoidLen <= windowSax.length; start++) {
      const subseq = windowSax.slice(start, start + medoidLen);
      let d = 0;
      for (let i = 0; i < subseq.length; i++) {
        if (subseq.charCodeAt(i) !== medoid.shapelet.charCodeAt(i)) d++;
      }
      const norm = d / medoidLen;
      if (norm < bestDistance) {
        bestDistance = norm;
        bestClusterId = medoid.clusterId;
        bestShapelet = subseq;
      }
    }
  }

  if (bestClusterId === -1) return null;
  return { clusterId: bestClusterId, distance: bestDistance, matchedShapelet: bestShapelet };
}