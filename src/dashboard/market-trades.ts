import type { BotConfig } from "../config.js";

interface TradePoint {
  /** Unix timestamp en secondes. */
  timestamp: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
}

/** Fill Data API du wallet, avec identifiants de marché pour le matching chart. */
interface WalletTrade extends TradePoint {
  conditionId: string;
  slug: string;
  eventSlug: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;
const RANGE_PAGE_SIZE = 500;
const RANGE_MAX_OFFSET = 10_000;

interface CacheEntry {
  expiresAt: number;
  value: TradePoint[];
}

interface RangeCacheEntry {
  expiresAt: number;
  value: WalletTrade[];
}

interface RawTrade {
  side?: string;
  price?: number | string;
  size?: number | string;
  timestamp?: number | string;
  outcome?: string;
  outcomeIndex?: number | string;
  conditionId?: string;
  slug?: string;
  eventSlug?: string;
}

const cache = new Map<string, CacheEntry>();
const rangeCache = new Map<string, RangeCacheEntry>();

export function clearMarketTradesCache(): void {
  cache.clear();
  rangeCache.clear();
}

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

function rangeCacheGet(key: string): WalletTrade[] | null {
  const entry = rangeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    rangeCache.delete(key);
    return null;
  }
  return entry.value;
}

function rangeCacheSet(key: string, value: WalletTrade[]): void {
  if (rangeCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = rangeCache.keys().next().value;
    if (oldest !== undefined) rangeCache.delete(oldest);
  }
  rangeCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
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

export function toUnixSec(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
}

export function parseWalletTrade(raw: RawTrade): WalletTrade | null {
  if (raw.side !== "BUY" && raw.side !== "SELL") return null;
  const timestamp = toUnixSec(Number(raw.timestamp ?? 0));
  const price = Number(raw.price ?? 0);
  const size = Number(raw.size ?? 0);
  if (timestamp <= 0 || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
    return null;
  }
  return {
    timestamp,
    price,
    size,
    side: raw.side,
    outcome: String(raw.outcome ?? ""),
    outcomeIndex: Number(raw.outcomeIndex ?? 0),
    conditionId: String(raw.conditionId ?? ""),
    slug: String(raw.slug ?? ""),
    eventSlug: String(raw.eventSlug ?? ""),
  };
}

export function walletTradesUrl(
  host: string,
  user: string,
  startSec: number,
  endSec: number,
  offset: number,
): URL {
  const url = new URL("/trades", host);
  url.searchParams.set("user", user);
  url.searchParams.set("start", String(startSec));
  url.searchParams.set("end", String(endSec));
  url.searchParams.set("takerOnly", "false");
  url.searchParams.set("limit", String(RANGE_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  return url;
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

/**
 * Fills du wallet sur [startSec, endSec] (epoch seconds, inclusif).
 * Un seul filtrage user+fenêtre — pas un HTTP par marché.
 * takerOnly=false : les GTC maker du bot doivent apparaître.
 */
export async function getWalletTradesInRange(
  config: BotConfig,
  startSec: number,
  endSec: number,
): Promise<WalletTrade[]> {
  if (!config.funderAddress) return [];
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) return [];

  const start = Math.floor(startSec);
  const end = Math.floor(endSec) + 1;
  const cacheKey = `wallet-range:${config.funderAddress}:${start}:${end}`;
  const cached = rangeCacheGet(cacheKey);
  if (cached) return cached;

  const trades: WalletTrade[] = [];
  for (let offset = 0; offset <= RANGE_MAX_OFFSET; offset += RANGE_PAGE_SIZE) {
    const url = walletTradesUrl(
      config.dataApiHost,
      config.funderAddress,
      start,
      end,
      offset,
    );
    const raw = await fetchJson<RawTrade[]>(url);
    const page = Array.isArray(raw) ? raw : [];
    for (const row of page) {
      const parsed = parseWalletTrade(row);
      if (parsed) trades.push(parsed);
    }
    if (page.length < RANGE_PAGE_SIZE) break;
  }

  trades.sort((a, b) => a.timestamp - b.timestamp);
  rangeCacheSet(cacheKey, trades);
  return trades;
}
