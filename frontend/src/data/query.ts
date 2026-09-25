/**
 * Cache LRU générique pour les requêtes REST coûteuses (séries de prix
 * backtest, snapshots books, historique marché). Évite de re-télécharger
 * les mêmes données après navigation backtest → dashboard → backtest.
 *
 * Propriétés :
 * - LRU : les entrées les plus anciennement utilisées sont évincées au-delà
 *   de `maxEntries`.
 * - Dedup : les appelants concurrents sur la même clé partagent la promesse
 *   (un seul fetch réseau).
 * - TTL : les entrées plus vieilles que `ttlMs` sont considérées expirées et
 *   re-fetch (pas de stale-while-revalidate : la valeur expirée n'est pas
 *   servie). Les données immuables (séries backtest) peuvent utiliser un
 *   TTL long.
 * - Deux modes : `cachedQuery` (lecture auto avec fetcher) et le couple
 *   `cacheGet`/`cachePut` (lecture/écriture manuelles pour les fetchs batchés).
 * - Invalidation explicite par préfixe de clé (ex. config mise à jour →
 *   `invalidate("series:")`).
 */
export interface QueryEntry<T> {
  value: T;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;

const store = new Map<string, QueryEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export interface QueryOptions {
  /** Durée de fraîcheur de l'entrée (défaut 5 min). */
  ttlMs?: number;
  /** Taille max du cache (défaut 100 entrées). */
  maxEntries?: number;
}

export function invalidate(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

export function invalidateAll(): void {
  store.clear();
  inflight.clear();
}

/** Évince les entrées les plus anciennes si le cache dépasse maxEntries. */
function evict(maxEntries: number): void {
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Lecture pure (sans fetch) : renvoie la valeur si l'entrée existe et est
 * fraîche, sinon undefined (et l'entrée expirée est évincée). Utilisé par les
 * appelants qui batchent leurs fetchs et alimentent le cache via `cachePut`.
 */
export function cacheGet<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | undefined {
  const entry = store.get(key) as QueryEntry<T> | undefined;
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= ttlMs) {
    store.delete(key);
    return undefined;
  }
  // Rajeunit la position LRU (delete + set = move-to-back dans une Map).
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

/**
 * Insère (ou rafraîchit) une entrée dans le cache sans passer par un fetch.
 * Utilisé quand le résultat arrive d'un appel batché côté appelant : chaque
 * élément du batch est mis en cache sous sa propre clé pour les lectures
 * ultérieures via `cacheGet`.
 */
export function cachePut<T>(key: string, value: T, maxEntries = DEFAULT_MAX_ENTRIES): void {
  store.delete(key);
  store.set(key, { value, fetchedAt: Date.now() });
  evict(maxEntries);
}

/**
 * Lecture via cache. `fetcher` n'est appelé que si l'entrée est absente ou
 * expirée. Les appelants concurrents sur la même clé partagent la promesse.
 */
export async function cachedQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: QueryOptions = {},
): Promise<T> {
  const { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = opts;
  const now = Date.now();

  const entry = store.get(key) as QueryEntry<T> | undefined;
  if (entry && now - entry.fetchedAt < ttlMs) {
    // Rajeunit la position LRU (delete + set = move-to-back dans une Map).
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = fetcher()
    .then((value) => {
      store.set(key, { value, fetchedAt: Date.now() });
      evict(maxEntries);
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}