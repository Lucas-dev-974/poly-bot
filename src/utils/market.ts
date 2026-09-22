import type { GammaMarket } from "../types.js";

export const WINDOW_SECONDS = 15 * 60;

/**
 * Durée (secondes) d'une fenêtre up/down dérivée de son SLUG, plus une
 * constante : le slug porte sa durée ({asset}-updown-{n}{m|h}-{startTs}).
 * Miroir backend de parseSlugWindow (frontend). null si format inconnu
 * (slug legacy sans durée lisible → repli WINDOW_SECONDS côté appelants).
 */
export function windowSecondsFromSlug(slug: string): number | null {
  const match = slug.match(/-(\d+)([mh])-(\d{10})$/);
  if (!match) return null;
  const duration = Number(match[1]) * (match[2] === "h" ? 3600 : 60);
  return duration > 0 && Number.isFinite(duration) ? duration : null;
}

/** Tag Gamma correspondant à une durée de fenêtre en secondes (ex. 900 → "15M"). */
export function gammaTagFromSeconds(durationSec: number): string {
  return `${durationSec / 60}M`;
}

export function parseWindowStart(slug: string): number | null {
  const match = slug.match(/-(\d{10})$/);
  return match ? Number(match[1]) : null;
}

export function matchesSlugPrefixes(slug: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => slug.startsWith(prefix));
}

/** Parse la liste JSON-sérialisée de Gamma (outcomes, clobTokenIds...). */
export function parseGammaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return [];
}

/**
 * Famille (préfixe) d'un slug up/down : le slug se termine toujours par
 * -<windowStart epoch-sec> à 10 chiffres (miroir de parseWindowStart).
 * Ex. "btc-updown-15m-1758000000" -> "btc-updown-15m".
 */
export function prefixOfSlug(slug: string): string {
  return slug.replace(/-\d{10}$/, "");
}

export function tickSizeFromMarket(market: GammaMarket): string {
  const tick = market.orderPriceMinTickSize ?? 0.01;
  if (tick >= 0.1) return "0.1";
  // Le CLOB rejette 0.001 pour les marchés 15m Up/Down ("minimum for the
  // market is 0.01") même quand Gamma expose orderPriceMinTickSize=0.001.
  return "0.01";
}

export function bestPrice(
  levels: Array<{ price: string }> | undefined,
  mode: "bid" | "ask",
): number | null {
  if (!levels || levels.length === 0) return null;
  const prices = levels
    .map((level) => Number(level.price))
    .filter((price) => !Number.isNaN(price));
  if (prices.length === 0) return null;
  return mode === "bid" ? Math.max(...prices) : Math.min(...prices);
}

export function bestSize(
  levels: Array<{ price: string; size: string }> | undefined,
  mode: "bid" | "ask" = "ask",
): number | null {
  if (!levels || levels.length === 0) return null;
  const best = bestPrice(levels, mode);
  if (best === null) return null;
  const level = levels.find((l) => Number(l.price) === best);
  if (!level) return null;
  const size = Number(level.size);
  return Number.isNaN(size) ? null : size;
}

export function l1Spread(
  bid: number | null | undefined,
  ask: number | null | undefined,
): number | null {
  if (bid == null || ask == null) return null;
  const spread = ask - bid;
  return Number.isFinite(spread) ? spread : null;
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isWithinMinutesBeforeClose(
  minutesLeft: number,
  min: number,
  max: number,
): boolean {
  return minutesLeft >= min && minutesLeft <= max;
}

export function gammaMarketStats(market: GammaMarket): {
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  lastTradePrice: number | null;
  spread: number | null;
} {
  return {
    volume: parseOptionalNumber(market.volumeNum) ?? parseOptionalNumber(market.volume),
    volume24hr: parseOptionalNumber(market.volume24hr),
    liquidity:
      parseOptionalNumber(market.liquidityNum) ?? parseOptionalNumber(market.liquidity),
    lastTradePrice: parseOptionalNumber(market.lastTradePrice),
    spread: parseOptionalNumber(market.spread),
  };
}

export function withSeriesVolume24hr(
  market: GammaMarket,
  series: Array<{ volume24hr?: number | string | null }> | undefined,
): GammaMarket {
  if (parseOptionalNumber(market.volume24hr) != null) return market;
  const fallback = parseOptionalNumber(series?.[0]?.volume24hr);
  return fallback == null ? market : { ...market, volume24hr: fallback };
}

export interface RankedBookLevel {
  price: number;
  size: number | null;
}

/** Best `depth` distinct prices, bid high→low / ask low→high. */
export function rankedLevels(
  levels: Array<{ price: string; size: string }> | undefined,
  mode: "bid" | "ask",
  depth: number,
): Array<RankedBookLevel | null> {
  const padded: Array<RankedBookLevel | null> = Array.from({ length: depth }, () => null);
  if (!levels || levels.length === 0 || depth <= 0) return padded;

  const parsed: RankedBookLevel[] = [];
  for (const level of levels) {
    const price = Number(level.price);
    if (!Number.isFinite(price)) continue;
    const size = Number(level.size);
    parsed.push({
      price,
      size: Number.isFinite(size) ? size : null,
    });
  }
  parsed.sort((a, b) => (mode === "bid" ? b.price - a.price : a.price - b.price));

  const unique: RankedBookLevel[] = [];
  for (const level of parsed) {
    const last = unique[unique.length - 1];
    if (last && last.price === level.price) {
      if (level.size != null) last.size = (last.size ?? 0) + level.size;
      continue;
    }
    if (unique.length >= depth) break;
    unique.push({ price: level.price, size: level.size });
  }
  for (let i = 0; i < unique.length; i++) padded[i] = unique[i] ?? null;
  return padded;
}
