import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import type { GammaMarket, OrderBook, TokenBook, UpDownEvent } from "./types.js";
import {
  bestPrice,
  bestSize,
  isWithinMinutesBeforeClose,
  matchesSlugPrefixes,
  parseWindowStart,
  rankedLevels,
  withSeriesVolume24hr,
  WINDOW_SECONDS,
} from "./utils/market.js";

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

const FETCH_TIMEOUT_MS = 10_000;

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

export class MarketScanner {
  constructor(private readonly config: BotConfig) {}

  async scan(): Promise<UpDownEvent[]> {
    const url = new URL("/events", this.config.gammaApiHost);
    url.searchParams.set("tag_slug", "15M");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "50");

    const events = await fetchJson<
      Array<{
        title: string;
        slug: string;
        markets: GammaMarket[];
        series?: Array<{ volume24hr?: number | string | null }>;
      }>
    >(url);

    const now = Math.floor(Date.now() / 1000);
    const results: UpDownEvent[] = [];

    for (const event of events) {
      if (!matchesSlugPrefixes(event.slug, this.config.marketSlugPrefixes)) continue;

      const market = event.markets[0];
      if (!market || market.closed || market.active === false) continue;

      const windowStart = parseWindowStart(event.slug);
      if (!windowStart) continue;

      const windowEnd = windowStart + WINDOW_SECONDS;
      if (now < windowStart || now > windowEnd) continue;

      // Recording covers the full active window. Trading window is applied later.
      results.push({
        title: event.title,
        slug: event.slug,
        market: withSeriesVolume24hr(market, event.series),
        windowStart,
        windowEnd,
      });
    }

    return results;
  }

  /** True when minutes-left is inside the configured trading entry window. */
  inTradingWindow(event: UpDownEvent, nowSec: number = Date.now() / 1000): boolean {
    const minutesLeft = (event.windowEnd - nowSec) / 60;
    return isWithinMinutesBeforeClose(
      minutesLeft,
      this.config.minutesBeforeCloseMin,
      this.config.minutesBeforeCloseMax,
    );
  }

  async getTokenBooks(event: UpDownEvent): Promise<TokenBook[]> {
    const tokenIds = parseJsonArray<string>(event.market.clobTokenIds);
    const outcomes = parseJsonArray<string>(event.market.outcomes);

    const books = await Promise.all(
      tokenIds.map(async (tokenId, index) => {
        if (!tokenId) return null;
        try {
          const book = await fetchOrderBook(this.config.clobHost, tokenId);
          return tokenBookFromClob(
            book,
            tokenId,
            outcomes[index] ?? `Outcome ${index}`,
            index,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Order book fetch failed, skipping token", {
            slug: event.slug,
            tokenId,
            error: message,
          });
          return null;
        }
      }),
    );

    return books.filter((book): book is TokenBook => book !== null);
  }

  /**
   * Fetches a single token's order book. Used for targeted re-validation
   * before posting a hedge (S2.3): the book may have moved since the
   * opportunity was generated.
   */
  async getTokenBook(tokenId: string): Promise<TokenBook | null> {
    try {
      const book = await fetchOrderBook(this.config.clobHost, tokenId);
      return tokenBookFromClob(book, tokenId, "", 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Single token book fetch failed", { tokenId, error: message });
      return null;
    }
  }
}

function tokenBookFromClob(
  book: OrderBook,
  tokenId: string,
  outcome: string,
  outcomeIndex: number,
): TokenBook {
  const asks = rankedLevels(book.asks, "ask", 3);
  const bids = rankedLevels(book.bids, "bid", 3);
  return {
    tokenId,
    outcome,
    outcomeIndex,
    bestBid: bestPrice(book.bids, "bid"),
    bestAsk: bestPrice(book.asks, "ask"),
    bestAskSize: bestSize(book.asks, "ask"),
    bestBidSize: bestSize(book.bids, "bid"),
    ask2: asks[1]?.price ?? null,
    ask2Size: asks[1]?.size ?? null,
    ask3: asks[2]?.price ?? null,
    ask3Size: asks[2]?.size ?? null,
    bid2: bids[1]?.price ?? null,
    bid2Size: bids[1]?.size ?? null,
    bid3: bids[2]?.price ?? null,
    bid3Size: bids[2]?.size ?? null,
  };
}

async function fetchOrderBook(clobHost: string, tokenId: string): Promise<OrderBook> {
  const url = new URL("/book", clobHost);
  url.searchParams.set("token_id", tokenId);

  try {
    return await fetchJson<OrderBook>(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CLOB book API error for token ${tokenId}: ${message}`);
  }
}
