import type { BotConfig } from "../config.js";

export interface TradePoint {
  /** Unix timestamp en secondes. */
  timestamp: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
}

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;

interface CacheEntry {
  expiresAt: number;
  value: TradePoint[];
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): TradePoint[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: TradePoint[]): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
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

interface RawTrade {
  side?: string;
  price?: number | string;
  size?: number | string;
  timestamp?: number | string;
  outcome?: string;
  outcomeIndex?: number | string;
}

/**
 * Récupère les fills du wallet du bot sur un marché (une tranche horaire).
 * Filtre par user + conditionId : typiquement 2 trades (cheap/expensive, YES/NO).
 * Timestamps normalisés en secondes Unix. Retourne [] si pas de funder configuré.
 */
export async function getMarketTrades(
  config: BotConfig,
  conditionId: string,
): Promise<TradePoint[]> {
  if (!config.funderAddress || !conditionId) return [];

  const cacheKey = `wallet:${config.funderAddress}:${conditionId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = new URL("/trades", config.dataApiHost);
  url.searchParams.set("user", config.funderAddress);
  url.searchParams.set("market", conditionId);
  url.searchParams.set("limit", "50");

  const raw = await fetchJson<RawTrade[]>(url);
  const trades: TradePoint[] = (Array.isArray(raw) ? raw : [])
    .filter((t) => t.side === "BUY" || t.side === "SELL")
    .map((t) => {
      const side: "BUY" | "SELL" = t.side === "SELL" ? "SELL" : "BUY";
      return {
        timestamp: Number(t.timestamp ?? 0),
        price: Number(t.price ?? 0),
        size: Number(t.size ?? 0),
        side,
        outcome: String(t.outcome ?? ""),
        outcomeIndex: Number(t.outcomeIndex ?? 0),
      };
    })
    .filter((t) => t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  cacheSet(cacheKey, trades);
  return trades;
}
