import type { GammaMarket } from "../types.js";

export const WINDOW_SECONDS = 15 * 60;

export function parseWindowStart(slug: string): number | null {
  const match = slug.match(/-(\d{10})$/);
  return match ? Number(match[1]) : null;
}

export function matchesSlugPrefixes(slug: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => slug.startsWith(prefix));
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
