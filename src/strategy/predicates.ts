import type { BotConfig } from "../config.js";
import type { TokenBook } from "../types.js";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function pickReverseToken(books: TokenBook[]): TokenBook | null {
  const withAsk = books.filter((book) => book.bestAsk !== null);
  if (withAsk.length === 0) return null;
  return withAsk.reduce((cheapest, book) =>
    (book.bestAsk ?? 1) < (cheapest.bestAsk ?? 1) ? book : cheapest,
  );
}

export function pickFavoriteToken(
  books: TokenBook[],
  reverseToken: TokenBook,
  minAsk: number,
  minHedgeSize: number,
): TokenBook | null {
  const candidate =
    books
      .filter(
        (book) =>
          book.tokenId !== reverseToken.tokenId &&
          book.bestAsk !== null &&
          book.bestAskSize !== null &&
          book.bestAskSize >= minHedgeSize,
      )
      .sort((a, b) => (b.bestAsk ?? 0) - (a.bestAsk ?? 0))[0] ?? null;

  // Strict favorite: only a token priced at/above expensiveBuyMin is a real
  // favorite worth hedging with. Mid-window the favorite often hovers around
  // 0.65-0.75; treating it as a "hedge" would create a naked directional bet,
  // not an arb.
  if (!candidate || candidate.bestAsk === null) return null;
  if (candidate.bestAsk < minAsk) return null;
  return candidate;
}

export function pickTokenByOutcome(
  books: TokenBook[],
  outcome: string,
): TokenBook | null {
  return books.find((book) => book.outcome === outcome) ?? null;
}

/** Favorite is hedgeable only when its ask is already inside the buy band. */
export function isAskInExpensiveBand(
  ask: number | null,
  min: number,
  max: number,
): boolean {
  if (ask === null) return false;
  return ask >= min && ask <= max;
}

/**
 * FOK-sell the cheap only when the favorite is too expensive to hedge.
 * A missing book must not fire defense. An ask below expensiveBuyMin is
 * "don't buy the favorite", not "dump the cheap" (that dumps winners).
 */
export function shouldDefendUncoveredPair(
  favoriteAsk: number | null,
  expensiveBuyMax: number,
): boolean {
  if (favoriteAsk === null) return false;
  return favoriteAsk > expensiveBuyMax;
}

/**
 * A pair is covered 1:1 when the filled expensive size is at least the
 * filled cheap size. Defense must never sell the cheap in that case: the
 * favorite going to $1 is the expected path, not an uncovered book.
 */
export function isPairCovered(
  filledCheap: number,
  filledExpensive: number,
): boolean {
  if (!(filledCheap > 0) || !(filledExpensive > 0)) return false;
  const cheap = round2(filledCheap);
  const expensive = round2(filledExpensive);
  return expensive >= cheap;
}

export function favoriteAskInBuyRange(
  token: TokenBook | null,
  config: BotConfig,
): boolean {
  if (!token) return false;
  return isAskInExpensiveBand(
    token.bestAsk,
    config.expensiveBuyMin,
    config.expensiveBuyMax,
  );
}

/**
 * Resting cheap GTC should be cancelled and replaced when the ask is already
 * at or below our limit (take the better price) or when our bid is missing
 * from the public book (bestBid < limit) while the ask is still takeable.
 */
export function shouldReplaceRestingCheap(
  limitPrice: number,
  bestAsk: number | null,
  bestBid: number | null,
  cheapBuyMin: number,
): boolean {
  if (bestAsk === null || bestAsk < cheapBuyMin || bestAsk > limitPrice) {
    return false;
  }
  if (bestAsk < limitPrice) return true;
  return bestBid !== null && bestBid < limitPrice;
}

/** Favorite left the hedge band. Missing data does not cancel. */
export function shouldCancelRestingCheapOffBand(
  favoriteAsk: number | null,
  config: Pick<
    BotConfig,
    "enableExpensiveHedge" | "expensiveBuyMin" | "expensiveBuyMax"
  >,
): boolean {
  if (!config.enableExpensiveHedge) return false;
  if (favoriteAsk === null) return false;
  return (
    favoriteAsk < config.expensiveBuyMin || favoriteAsk > config.expensiveBuyMax
  );
}

/**
 * A resting cheap maker bid must come off the book when the pair can no
 * longer be locked: the favorite left the hedge band, or our limit is now
 * above pairLockMax − hedge. Leaving it up would fill into an uncovered
 * cheap. Missing favorite data (one-sided book) does not cancel.
 */
export function shouldCancelRestingCheapForLock(
  limitPrice: number,
  favoriteAsk: number | null,
  config: Pick<
    BotConfig,
    | "enableExpensiveHedge"
    | "expensiveBuyMin"
    | "expensiveBuyMax"
    | "pairLockMax"
  >,
): boolean {
  if (shouldCancelRestingCheapOffBand(favoriteAsk, config)) return true;
  if (!config.enableExpensiveHedge) return false;
  if (favoriteAsk === null) return false;
  const hedgePrice = Math.min(favoriteAsk, config.expensiveBuyMax);
  const maxCheapForLock = round2(config.pairLockMax - hedgePrice);
  return limitPrice > maxCheapForLock;
}
