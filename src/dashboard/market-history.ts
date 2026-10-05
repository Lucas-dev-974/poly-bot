import type { BotConfig } from "../config.js";

interface PricePoint {
  /** Unix timestamp en secondes. */
  t: number;
  /** Prix (probabilité implicite 0-1). */
  p: number;
}

interface MarketHistoryResult {
  history: PricePoint[];
  oppositeHistory: PricePoint[] | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;

interface CacheEntry {
  expiresAt: number;
  value: PricePoint[];
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tokenId: string, startTs: number, endTs: number): string {
  return `${tokenId}|${startTs}|${endTs}`;
}

function cacheGet(key: string): PricePoint[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: PricePoint[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Éviction simple : supprime la première entrée (FIFO).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

async function fetchJson<T>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url.pathname}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTokenHistory(
  clobHost: string,
  tokenId: string,
  startTs: number,
  endTs: number,
): Promise<PricePoint[]> {
  const key = cacheKey(tokenId, startTs, endTs);
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = new URL("/prices-history", clobHost);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("startTs", String(startTs));
  url.searchParams.set("endTs", String(endTs));
  url.searchParams.set("fidelity", "1");

  const data = await fetchJson<{ history?: Array<{ t: number; p: number | string }> }>(url);
  const history = (data.history ?? []).map((pt) => ({
    t: Number(pt.t),
    p: Number(pt.p),
  }));

  cacheSet(key, history);
  return history;
}

/**
 * Récupère l'historique de prix CLOB pour un token et (optionnellement) son
 * outcome opposé. Toujours avec startTs/endTs explicites : le mode `interval`
 * renvoie une réponse vide sur les marchés résolus.
 */
export async function getMarketHistory(
  config: BotConfig,
  params: {
    tokenId: string;
    oppositeTokenId?: string;
    startTs: number;
    endTs: number;
  },
): Promise<MarketHistoryResult> {
  const [history, oppositeHistory] = await Promise.all([
    fetchTokenHistory(config.clobHost, params.tokenId, params.startTs, params.endTs),
    params.oppositeTokenId
      ? fetchTokenHistory(config.clobHost, params.oppositeTokenId, params.startTs, params.endTs)
      : Promise.resolve(null),
  ]);

  return { history, oppositeHistory };
}
