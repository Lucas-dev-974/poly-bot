import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import type { GammaMarket, OrderBook, TokenBook, UpDownEvent } from "./types.js";
import {
  bestPrice,
  bestSize,
  matchesSlugPrefixes,
  parseWindowStart,
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

      const minutesLeft = (windowEnd - now) / 60;
      if (
        minutesLeft < this.config.minutesBeforeCloseMin ||
        minutesLeft > this.config.minutesBeforeCloseMax
      ) {
        continue;
      }

      results.push({
        title: event.title,
        slug: event.slug,
        market,
        windowStart,
        windowEnd,
      });
    }

    return results;
  }

  async getTokenBooks(event: UpDownEvent): Promise<TokenBook[]> {
    const tokenIds = parseJsonArray<string>(event.market.clobTokenIds);
    const outcomes = parseJsonArray<string>(event.market.outcomes);

    const books = await Promise.all(
      tokenIds.map(async (tokenId, index) => {
        if (!tokenId) return null;
        try {
          const book = await fetchOrderBook(this.config.clobHost, tokenId);
          return {
            tokenId,
            outcome: outcomes[index] ?? `Outcome ${index}`,
            outcomeIndex: index,
            bestBid: bestPrice(book.bids, "bid"),
            bestAsk: bestPrice(book.asks, "ask"),
            bestAskSize: bestSize(book.asks, "ask"),
            bestBidSize: bestSize(book.bids, "bid"),
          } satisfies TokenBook;
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
      return {
        tokenId,
        outcome: "",
        outcomeIndex: 0,
        bestBid: bestPrice(book.bids, "bid"),
        bestAsk: bestPrice(book.asks, "ask"),
        bestAskSize: bestSize(book.asks, "ask"),
        bestBidSize: bestSize(book.bids, "bid"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Single token book fetch failed", { tokenId, error: message });
      return null;
    }
  }
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
