/**
 * SAX (Symbolic Aggregate Approximation) + PAA
 * Discrétisation de séries temporelles en chaînes de symboles
 * Utilitaire pur, sans dépendances, testable unitairement
 */

export interface SAXConfig {
  /** Taille de l'alphabet (défaut: 8) */
  alphabetSize: number;
  /** Nombre de segments PAA (défaut: 10) */
  paaSegments: number;
  /** Longueur de fenêtre en ticks (défaut: 120 = 2 min à 1 Hz) */
  windowTicks: number;
  /** Stride de la fenêtre glissante (défaut: windowTicks = pas de chevauchement) */
  stride: number;
}

export const DEFAULT_SAX_CONFIG: SAXConfig = {
  alphabetSize: 8,
  paaSegments: 10,
  windowTicks: 120,
  stride: 120,
};

/** Points de rupture pour quantification gaussienne (alphabet 3-20) */
const BREAKPOINTS: Record<number, number[]> = {
  3: [-0.43, 0.43],
  4: [-0.67, 0, 0.67],
  5: [-0.84, -0.25, 0.25, 0.84],
  6: [-0.97, -0.43, 0, 0.43, 0.97],
  7: [-1.07, -0.57, -0.18, 0.18, 0.57, 1.07],
  8: [-1.15, -0.67, -0.32, 0, 0.32, 0.67, 1.15],
  9: [-1.22, -0.76, -0.43, -0.14, 0.14, 0.43, 0.76, 1.22],
  10: [-1.28, -0.84, -0.52, -0.25, 0, 0.25, 0.52, 0.84, 1.28],
  11: [-1.33, -0.89, -0.58, -0.31, -0.06, 0.06, 0.31, 0.58, 0.89, 1.33],
  12: [-1.38, -0.93, -0.63, -0.37, -0.13, 0.13, 0.37, 0.63, 0.93, 1.38],
  13: [-1.42, -0.97, -0.67, -0.41, -0.18, 0, 0.18, 0.41, 0.67, 0.97, 1.42],
  14: [-1.46, -1.01, -0.71, -0.45, -0.22, 0.0, 0.22, 0.45, 0.71, 1.01, 1.46],
  15: [-1.50, -1.04, -0.74, -0.48, -0.25, -0.03, 0.03, 0.25, 0.48, 0.74, 1.04, 1.50],
  16: [-1.53, -1.07, -0.77, -0.51, -0.28, -0.06, 0.06, 0.28, 0.51, 0.77, 1.07, 1.53],
  17: [-1.56, -1.10, -0.79, -0.53, -0.31, -0.09, 0.09, 0.31, 0.53, 0.79, 1.10, 1.56],
  18: [-1.59, -1.12, -0.82, -0.55, -0.33, -0.12, 0.12, 0.33, 0.55, 0.82, 1.12, 1.59],
  19: [-1.62, -1.14, -0.84, -0.57, -0.35, -0.14, 0.14, 0.35, 0.57, 0.84, 1.14, 1.62],
  20: [-1.64, -1.16, -0.86, -0.59, -0.37, -0.16, 0.16, 0.37, 0.59, 0.86, 1.16, 1.64],
};

/**
 * Normalisation z-score d'une série
 */
export function zNormalize(series: number[]): number[] {
  const n = series.length;
  if (n === 0) return [];
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (std === 0) return series.map(() => 0);
  return series.map((v) => (v - mean) / std);
}

/**
 * PAA (Piecewise Aggregate Approximation)
 * Réduit une série de longueur N à M segments par moyennage
 */
export function paa(series: number[], segments: number): number[] {
  const n = series.length;
  if (n === 0 || segments <= 0) return [];
  if (segments >= n) return [...series];

  const result: number[] = new Array(segments);
  const segmentSize = n / segments;

  for (let i = 0; i < segments; i++) {
    const start = Math.floor(i * segmentSize);
    const end = Math.floor((i + 1) * segmentSize);
    const slice = series.slice(start, end);
    result[i] = slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  return result;
}

/**
 * Quantification d'une valeur normalisée en symbole d'alphabet
 */
export function quantize(value: number, alphabetSize: number): string {
  const breakpoints = BREAKPOINTS[alphabetSize];
  if (!breakpoints) {
    throw new Error(`Alphabet size ${alphabetSize} not supported (3-20)`);
  }
  let symbol = 0;
  while (symbol < breakpoints.length && value > breakpoints[symbol]) {
    symbol++;
  }
  return String.fromCharCode(97 + symbol); // 'a' = 97
}

/**
 * Convertit une série PAA en chaîne SAX
 */
export function seriesToSAX(paaSeries: number[], alphabetSize: number): string {
  return paaSeries.map((v) => quantize(v, alphabetSize)).join('');
}

/**
 * Pipeline complet : série brute → chaîne SAX
 *
 * Audit fix 2026-09-26 : le moyennage PAA contracte l'écart-type (proportionnellement
 * à la taille de segment et à l'autocorrélation de la série) — les breakpoints
 * gaussiens standard ne sont alors plus valides (arXiv 1210.5118, IEEE Know 2023).
 * On re-normalise donc APRÈS PAA, directement sur les valeurs PAA.
 */
export function toSAX(series: number[], config: Partial<SAXConfig> = {}): string {
  const cfg = { ...DEFAULT_SAX_CONFIG, ...config };
  const normalized = zNormalize(series);
  const paaSeries = paa(normalized, cfg.paaSegments);
  const renormalized = zNormalize(paaSeries);
  return seriesToSAX(renormalized, cfg.alphabetSize);
}

/**
 * Fenêtrage glissant SAX sur une série longue
 * Retourne tableau de { sax: string, startTick: number, endTick: number }
 */
export function slidingWindowSAX(
  series: number[],
  config: Partial<SAXConfig> = {}
): Array<{ sax: string; startTick: number; endTick: number }> {
  const cfg = { ...DEFAULT_SAX_CONFIG, ...config };
  const results: Array<{ sax: string; startTick: number; endTick: number }> = [];

  for (let start = 0; start + cfg.windowTicks <= series.length; start += cfg.stride) {
    const window = series.slice(start, start + cfg.windowTicks);
    const sax = toSAX(window, cfg);
    results.push({ sax, startTick: start, endTick: start + cfg.windowTicks - 1 });
  }
  return results;
}

/**
 * Distance de Hamming entre deux chaînes SAX de même longueur
 */
export function hammingDistance(sax1: string, sax2: string): number {
  if (sax1.length !== sax2.length) {
    throw new Error(`SAX strings must have same length: ${sax1.length} vs ${sax2.length}`);
  }
  let dist = 0;
  for (let i = 0; i < sax1.length; i++) {
    if (sax1[i] !== sax2[i]) dist++;
  }
  return dist;
}

/**
 * Distance de Hamming normalisée (0-1)
 */
export function normalizedHammingDistance(sax1: string, sax2: string): number {
  return hammingDistance(sax1, sax2) / sax1.length;
}

/**
 * Extrait une sous-séquence SAX (shapelet candidate)
 */
export function extractSubsequence(
  sax: string,
  start: number,
  length: number
): string {
  return sax.slice(start, start + length);
}

/**
 * Génère tous les shapelets candidates d'une fenêtre SAX
 * pour les longueurs données
 */
export function generateShapelets(
  sax: string,
  lengths: number[]
): Array<{ shapelet: string; length: number; start: number }> {
  const results: Array<{ shapelet: string; length: number; start: number }> = [];
  for (const len of lengths) {
    if (len > sax.length) continue;
    for (let start = 0; start + len <= sax.length; start++) {
      results.push({
        shapelet: sax.slice(start, start + len),
        length: len,
        start,
      });
    }
  }
  return results;
}