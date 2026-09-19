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
  windowSecondsFromSlug,
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

  /**
   * Tags Gamma dérivés de l'univers configuré (ex. btc-updown-15m → "15M").
   * Multi-timeframe : un fetch par tag distinct, puis fusion locale.
   */
  static tagsFromPrefixes(prefixes: string[]): string[] {
    const tags = new Set<string>();
    for (const prefix of prefixes) {
      const match = prefix.match(/-updown-(\d+)([mh])$/);
      if (!match) continue;
      const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : 60);
      if (seconds > 0) tags.add(`${seconds / 60}M`);
    }
    return [...tags];
  }

  async scan(): Promise<UpDownEvent[]> {
    const tags = MarketScanner.tagsFromPrefixes(this.config.marketSlugPrefixes);
    if (tags.length === 0) {
      return [];
    }
    // end_date_min : Gamma laisse les anciennes fenêtres active=true/closed=false
    // sur 5m/15m (66/100 stale constatés à l'audit) — sans ce filtre, les
    // fenêtres vivantes peuvent sortir de la première page.
    const nowSec = Math.floor(Date.now() / 1000);
    const pages = await Promise.all(
      tags.map((tag) => this.fetchTagPage(tag, nowSec)),
    );
    const events = pages.flat();

    const results: UpDownEvent[] = [];

    for (const event of events) {
      if (!matchesSlugPrefixes(event.slug, this.config.marketSlugPrefixes)) continue;

      const market = event.markets[0];
      if (!market || market.closed || market.active === false) continue;

      const windowStart = parseWindowStart(event.slug);
      if (!windowStart) continue;

      // La durée vient du SLUG (multi-timeframe), pas d'une constante.
      const durationSec = windowSecondsFromSlug(event.slug) ?? WINDOW_SECONDS;
      const windowEnd = windowStart + durationSec;
      if (nowSec < windowStart || nowSec > windowEnd) continue;

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

  private async fetchTagPage(
    tag: string,
    nowSec: number,
  ): Promise<
    Array<{
      title: string;
      slug: string;
      markets: GammaMarket[];
      series?: Array<{ volume24hr?: number | string | null }>;
    }>
  > {
    const url = new URL("/events", this.config.gammaApiHost);
    url.searchParams.set("tag_slug", tag);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("end_date_min", new Date(nowSec * 1000).toISOString());
    url.searchParams.set("limit", "50");
    try {
      return await fetchJson(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Gamma scan failed for tag", { tag, error: message });
      return [];
    }
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
