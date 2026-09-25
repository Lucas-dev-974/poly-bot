import { createSignal } from "solid-js";
import { api } from "../api/client";
import { cacheGet, cachePut } from "../data/query";
import type { BacktestSeriesPoint, BacktestWindowMeta, BacktestRunSummary } from "../types";

/**
 * État backtest persistant entre navigations (dashboard ↔ backtest) :
 * - windows : liste des fenêtres complètes/incomplètes selon les filtres
 * - series  : séries de prix par slug (via LRU data/query.ts, dédup + TTL)
 * - runs    : derniers runs affichés dans la sidebar
 * - loadedSlugs : slugs dont la série est déjà chargée (évite refetch)
 *
 * BacktestPage consomme ces signaux ; la page ne recrée plus son état à
 * chaque montage (les séries de prix coûteuses survivent à la navigation).
 */

const [windows, setWindowsRaw] = createSignal<BacktestWindowMeta[]>([]);
const [series, setSeriesRaw] = createSignal<Record<string, BacktestSeriesPoint[]>>({});
const [runs, setRunsRaw] = createSignal<BacktestRunSummary[]>([]);

export { windows, series, runs };

/** Slugs dont la série est déjà dans `series` (miroir côté store). */
const loadedSlugs = new Set<string>();

/** TTL des séries : les fenêtres sont immuables (données enregistrées) — long. */
const SERIES_TTL_MS = 10 * 60_000;

/** Remplace la liste de fenêtres et reset le cache de séries chargées. */
export function setWindows(next: BacktestWindowMeta[]): void {
  setWindowsRaw(next);
  // Les filtres ont changé → la cohérence windows/series n'est plus garantie.
  loadedSlugs.clear();
  setSeriesRaw({});
}

/** Fetch (ou cache) les séries des slugs manquants, les fusionne dans series. */
export async function loadSeriesFor(slugs: string[]): Promise<void> {
  const missing = slugs.filter((s) => !loadedSlugs.has(s));
  if (missing.length === 0) return;

  // 1) Sert depuis le cache LRU ce qui existe (séries immuables, TTL long) —
  //    évite de re-télécharger au retour de navigation après un refiltre.
  const fetched: Record<string, BacktestSeriesPoint[]> = {};
  const needFetch: string[] = [];
  for (const slug of missing) {
    const cached = cacheGet<BacktestSeriesPoint[]>(`bt-series:${slug}`, SERIES_TTL_MS);
    if (cached) fetched[slug] = cached;
    else needFetch.push(slug);
  }

  // 2) Un seul appel batché (endpoint natif multi-slugs) pour le reste —
  //    jamais N requêtes parallèles.
  if (needFetch.length > 0) {
    const res = await api.backtestSeries(needFetch);
    for (const slug of needFetch) {
      fetched[slug] = res.series[slug] ?? [];
      cachePut(`bt-series:${slug}`, fetched[slug]);
    }
  }

  for (const slug of missing) loadedSlugs.add(slug);
  setSeriesRaw((prev) => ({ ...prev, ...fetched }));
}

/** Runs récents (sidebar). Retourne la liste pour l'appelant. */
export async function loadRuns(): Promise<BacktestRunSummary[]> {
  try {
    const res = await api.backtestRuns(20);
    setRunsRaw(res.runs);
    return res.runs;
  } catch {
    return runs();
  }
}