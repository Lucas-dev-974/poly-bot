import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { TradeOpportunity, TokenBook, UpDownEvent } from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";
import { MIN_CLOB_SHARES } from "./utils/prices.js";
import { ArbSizing } from "./strategy/arb-sizing.js";
import type { SizingStrategy } from "./strategy/sizing.js";

function pickReverseToken(books: TokenBook[]): TokenBook | null {
  const withAsk = books.filter((book) => book.bestAsk !== null);
  if (withAsk.length === 0) return null;
  return withAsk.reduce((cheapest, book) =>
    (book.bestAsk ?? 1) < (cheapest.bestAsk ?? 1) ? book : cheapest,
  );
}

function pickFavoriteToken(
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

function pickTokenByOutcome(books: TokenBook[], outcome: string): TokenBook | null {
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
 * A pair is covered when the filled expensive size is at least the filled
 * cheap size. Defense must never sell the cheap in that case: the favorite
 * going to $1 is the expected path, not an uncovered book.
 */
export function isPairCovered(
  filledCheap: number,
  filledExpensive: number,
): boolean {
  if (!(filledCheap > 0) || !(filledExpensive > 0)) return false;
  const cheap = Math.round(filledCheap * 100) / 100;
  const expensive = Math.round(filledExpensive * 100) / 100;
  return expensive >= cheap;
}

function favoriteAskInBuyRange(
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

function hedgeDepthSize(): number {
  // Touch size only has to be CLOB-tradable. Scaling off cheapBuyMin
  // asked for the largest possible cheap (e.g. 16 shares at 0.05) and
  // rejected a favorite whose top-of-book was thin but in the buy band.
  return MIN_CLOB_SHARES;
}

function appendLimitOrderForSide(
  tracker: TradeTracker,
  opportunities: TradeOpportunity[],
  event: UpDownEvent,
  token: TokenBook,
  kind: "cheap" | "expensive",
  price: number,
  size: number,
  maxOpenPerSide: number,
  pendingThisTick: number,
): void {
  // Guard mémoire : positions open + ordres GTC restants + générés ce tick.
  if (
    tracker.countOpenPositionsForSide(event.slug, token.outcome) +
    tracker.countPendingOrdersForSide(event.slug, token.outcome) +
    pendingThisTick >= maxOpenPerSide
  ) {
    return;
  }
  // Guard DB-backed : backstop si le Map postedOrders est vide après un
  // restart (tsx watch). Compte toutes les jambes de ce kind déjà
  // enregistrées pour cette fenêtre (open + résolues), empêchant
  // l'empilement de plusieurs jambes cheap sur la même paire.
  const pairId = `${event.slug}:${event.windowEnd}`;
  if (tracker.countLegsByKind(pairId, kind) + pendingThisTick >= maxOpenPerSide) {
    return;
  }
  const tradeKey = tracker.makeKey(event.slug, token.outcome, kind, price);
  if (tracker.has(tradeKey)) return;

  opportunities.push({
    kind,
    event,
    token,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    pairId,
  });
}

export function findOpportunities(
  config: BotConfig,
  tracker: TradeTracker,
  event: UpDownEvent,
  books: TokenBook[],
  sizing: SizingStrategy = new ArbSizing(),
): TradeOpportunity[] {
  const opportunities: TradeOpportunity[] = [];
  const pairId = `${event.slug}:${event.windowEnd}`;
  // One-sided book (failed fetch) must not lock a claim to the only token.
  if (books.filter((book) => book.bestAsk !== null).length < 2) {
    return opportunities;
  }

  let claim = tracker.getWindowClaim(pairId);
  const committedCheapSize = tracker.getCheapSizeForPair(pairId);
  const liveReverse = pickReverseToken(books);
  // Sticky claim after a mid-window flip (or a one-sided first tick) locks
  // the expensive side as "cheap". With requireCovered that yields zero
  // orders for the rest of the window. Re-pick only if nothing is committed.
  if (
    claim &&
    committedCheapSize === 0 &&
    liveReverse &&
    liveReverse.outcome !== claim.cheapOutcome
  ) {
    tracker.clearWindowClaim(pairId);
    claim = undefined;
  }
  const depthSize = hedgeDepthSize();

  let cheapToken: TokenBook | null;
  let expensiveToken: TokenBook | null;

  if (claim) {
    cheapToken = pickTokenByOutcome(books, claim.cheapOutcome);
    if (claim.expensiveOutcome) {
      expensiveToken = pickTokenByOutcome(books, claim.expensiveOutcome);
    } else if (config.enableExpensiveHedge && cheapToken) {
      expensiveToken = pickFavoriteToken(
        books,
        cheapToken,
        config.expensiveBuyMin,
        depthSize,
      );
      if (expensiveToken) {
        tracker.setWindowClaimExpensive(pairId, expensiveToken.outcome);
      }
    } else {
      expensiveToken = null;
    }
  } else {
    const reverseToken = pickReverseToken(books);
    if (!reverseToken) return opportunities;

    cheapToken = reverseToken;
    expensiveToken = config.enableExpensiveHedge
      ? pickFavoriteToken(
          books,
          reverseToken,
          config.expensiveBuyMin,
          depthSize,
        )
      : null;

    if (cheapToken) {
      tracker.claimWindowOutcomes(
        pairId,
        cheapToken.outcome,
        expensiveToken?.outcome ?? "",
      );
    }
  }

  if (!cheapToken || cheapToken.bestAsk === null) return opportunities;

  // Hedge validity is re-evaluated every tick, even for a claimed pair: if the
  // favorite has drifted below the expensive buy range, stop posting a hedge on
  // this window (it would be a directional bet, not an arb).
  if (
    config.enableExpensiveHedge &&
    (!expensiveToken ||
      expensiveToken.bestAsk === null ||
      expensiveToken.bestAsk < config.expensiveBuyMin)
  ) {
    expensiveToken = null;
  }

  // New cheap only when the favorite is already in [expensiveBuyMin,
  // expensiveBuyMax]. A hedge far below a 0.97 ask is not a cover.
  // If cheap is already filled, keep evaluating this tick (hedge still
  // requires fill+lock, and FOK still requires the favorite in band).
  const favoriteInRange =
    !config.enableExpensiveHedge || favoriteAskInBuyRange(expensiveToken, config);

  if (
    (config.simRequireCoveredPair || config.enableExpensiveHedge) &&
    !favoriteInRange &&
    committedCheapSize === 0
  ) {
    return opportunities;
  }

  // Cheap limit is a maker bid: min(ask, cheapBuyMax, pairLockMax − hedge).
  // If Up asks 0.16 and the favorite asks 0.85 with lock 0.98, we sit at
  // 0.13 — we do not wait for ask+ask ≤ lock (rare on 15m books). Taking
  // a live ask below that cap is still required (never post above the ask).
  const hedgePrice =
    expensiveToken?.bestAsk != null
      ? Math.min(expensiveToken.bestAsk, config.expensiveBuyMax)
      : config.expensiveBuyMax;

  // --- Sizing via the injected strategy (B1: ArbSizing 1:1) ---
  // The hedge sizing logic (1:1 with the filled cheap, budget as secondary
  // cap, pair lock) lives in ArbSizing — the single source of truth for B1.
  // strategy.ts only handles orchestration: claims, bands, guards, posting.
  const sizingResult = sizing.compute({
    config,
    pairId,
    tracker,
    cheapToken,
    expensiveToken,
    hedgePrice,
    thisTickCheapSize: 0,
  });

  // Cheap leg posting (price/band checks stay here — orchestration).
  const cheapPrice = sizingResult.cheapPrice;
  const askAlive =
    cheapToken.bestAsk !== null && cheapToken.bestAsk >= config.cheapBuyMin;
  const inCheapBand =
    cheapPrice >= config.cheapBuyMin && cheapPrice <= config.cheapBuyMax;
  if (
    favoriteInRange &&
    inCheapBand &&
    askAlive &&
    sizingResult.pairLockOk &&
    sizingResult.cheapSize !== null
  ) {
    appendLimitOrderForSide(
      tracker,
      opportunities,
      event,
      cheapToken,
      "cheap",
      cheapPrice,
      sizingResult.cheapSize,
      config.maxOpenPositionsPerSide,
      0,
    );
  }

  // Hedge posting: 1:1 with the FILLED cheap leg (B1 arbitrage), via the
  // sizing strategy result. Both FOK and GTC hedges require a filled cheap —
  // no hedge on a resting cheap (anti favori-nu, C2). ArbSizing returns
  // hedgeSize null when fill + hedge > pairLockMax — hold the cheap
  // directional rather than lock a loss.
  const hedgeSize = sizingResult.hedgeSize;
  // GTC rests below the touch; a thin best ask must not block the hedge.
  const hasDepth =
    hedgeSize !== null &&
    hedgeSize > 0 &&
    (config.expensiveOrderType === "GTC" ||
      expensiveToken?.bestAskSize == null ||
      expensiveToken.bestAskSize >= hedgeSize * 0.8);
  // The favorite must be inside the band for BOTH order types. A FOK at the
  // clamp is killed when ask > max (spams killed-fok); a GTC at the clamp
  // would rest below the ask and fill later against a cheap that defense
  // may already have sold. bot.ts re-checks the fresh book at hedge time.
  if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    expensiveToken.bestAsk !== null &&
    hedgeSize !== null &&
    hedgeSize > 0 &&
    hasDepth &&
    favoriteInRange
  ) {
    appendLimitOrderForSide(
      tracker,
      opportunities,
      event,
      expensiveToken,
      "expensive",
      hedgePrice,
      hedgeSize,
      config.maxOpenPositionsPerSide,
      0,
    );
  } else if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    sizingResult.reason === "pair-lock-unreachable" &&
    tracker.getFilledCheapSizeForPair(pairId) > 0
  ) {
    log("Hedge skipped - pair lock unreachable, holding cheap directional", {
      market: event.title,
      cheapFill: tracker.getCheapFillPriceForPair(pairId),
      hedgePrice,
      pairCost: sizingResult.pairCost,
      pairLockMax: config.pairLockMax,
    });
  } else if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    sizingResult.reason === "arb-pair-budget-insufficient"
  ) {
    log("Hedge skipped - below CLOB minimums", {
      market: event.title,
      hedgePrice,
      expensiveOrderUsdc: config.expensiveOrderUsdc,
    });
  }

  return opportunities;
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
  if (!config.enableExpensiveHedge) return false;
  if (favoriteAsk === null) return false;
  if (
    favoriteAsk < config.expensiveBuyMin ||
    favoriteAsk > config.expensiveBuyMax
  ) {
    return true;
  }
  const hedgePrice = Math.min(favoriteAsk, config.expensiveBuyMax);
  const maxCheapForLock =
    Math.round((config.pairLockMax - hedgePrice) * 100) / 100;
  return limitPrice > maxCheapForLock;
}
