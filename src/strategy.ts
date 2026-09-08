import type { BotConfig } from "./config.js";
import { log } from "./logger.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { TradeOpportunity, TokenBook, UpDownEvent } from "./types.js";
import { tickSizeFromMarket } from "./utils/market.js";
import { MIN_CLOB_SHARES, computeSize } from "./utils/prices.js";

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
function favoriteAskInBuyRange(
  token: TokenBook | null,
  config: BotConfig,
): boolean {
  if (!token || token.bestAsk === null) return false;
  return (
    token.bestAsk >= config.expensiveBuyMin &&
    token.bestAsk <= config.expensiveBuyMax
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
  // If cheap is already committed, still allow the FOK hedge to fire.
  const favoriteInRange =
    !config.enableExpensiveHedge || favoriteAskInBuyRange(expensiveToken, config);

  if (
    (config.simRequireCoveredPair || config.enableExpensiveHedge) &&
    !favoriteInRange &&
    committedCheapSize === 0
  ) {
    return opportunities;
  }

  // Cheap limit is PAIR_TARGET_COST − hedge (0.80 → 0.15 when target is 0.95),
  // then clamped to the live ask. A BUY at 0.15 while Up asks 0.13 must take
  // 0.13 — posting above the ask leaves a ghost bid that never matches.
  // PAIR_COST_MAX still rejects a pair that overshoots after clamps.
  const hedgePrice =
    expensiveToken?.bestAsk != null
      ? Math.min(expensiveToken.bestAsk, config.expensiveBuyMax)
      : config.expensiveBuyMax;
  const pairCostMaxCents = Math.round(config.pairCostMax * 100);

  // disablePairTargetCost : ignore le calcul pairTargetCost − hedgePrice et
  // fixe le prix cheap directement à min(bestAsk, cheapBuyMax), comme dans le
  // chemin sans hedge. La bande cheapBuyMin/cheapBuyMax et le coût de paire
  // pairCostMax restent appliqués. La jambe hedge reste soumise à sa bande
  // (favoriteInRange ci-dessus). Les minimums CLOB (5 shares / $1 notional)
  // restent appliqués par computeSize car exigés par le serveur Polymarket.
  const usePairTarget = config.enableExpensiveHedge && !config.disablePairTargetCost;

  let thisTickCheapSize = 0;
  if (favoriteInRange) {
    const targetPrice = usePairTarget
      ? Math.round((config.pairTargetCost - hedgePrice) * 100) / 100
      : Math.round(Math.min(cheapToken.bestAsk, config.cheapBuyMax) * 100) / 100;
    const price = Math.round(Math.min(targetPrice, cheapToken.bestAsk) * 100) / 100;
    const pairCostCents = Math.round((price + hedgePrice) * 100);
    const pairCostOk =
      !config.enableExpensiveHedge ||
      !expensiveToken ||
      pairCostCents <= pairCostMaxCents;
    const askAlive =
      cheapToken.bestAsk !== null && cheapToken.bestAsk >= config.cheapBuyMin;
    const inCheapBand =
      price >= config.cheapBuyMin && price <= config.cheapBuyMax;
    if (inCheapBand && askAlive && pairCostOk) {
      const size = computeSize(
        config.cheapOrderUsdc,
        price,
        config.maxSharesPerOrder,
      );
      if (size !== null) {
        const before = opportunities.length;
        appendLimitOrderForSide(
          tracker,
          opportunities,
          event,
          cheapToken,
          "cheap",
          price,
          size,
          config.maxOpenPositionsPerSide,
          0,
        );
        if (opportunities.length > before) {
          thisTickCheapSize += size;
        }
      }
    }
  }

  // FOK fills immediately: never post it against an unfilled cheap GTC
  // (that would be a naked favorite). GTC hedge may rest beside a resting cheap.
  // Size is the USDC budget at hedgePrice — same rule as cheap — not 1:1 shares.
  const cheapCommittedForHedge =
    config.expensiveOrderType === "FOK"
      ? tracker.getFilledCheapSizeForPair(pairId)
      : committedCheapSize + thisTickCheapSize;
  const hedgeSize =
    cheapCommittedForHedge > 0
      ? computeSize(
          config.expensiveOrderUsdc,
          hedgePrice,
          config.maxSharesPerOrder,
        )
      : null;
  // GTC rests below the touch; a thin best ask must not block the hedge.
  const hasDepth =
    hedgeSize !== null &&
    (config.expensiveOrderType === "GTC" ||
      expensiveToken?.bestAskSize == null ||
      expensiveToken.bestAskSize >= hedgeSize * 0.8);
  // FOK at clamp is killed if the favorite has already left the band
  // (ask > max). Do not generate that opportunity — it spams killed-fok.
  const fokMarketable =
    config.expensiveOrderType !== "FOK" || favoriteInRange;
  if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    expensiveToken.bestAsk !== null &&
    hedgeSize !== null &&
    hasDepth &&
    fokMarketable
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
    cheapCommittedForHedge > 0 &&
    hedgeSize === null
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
