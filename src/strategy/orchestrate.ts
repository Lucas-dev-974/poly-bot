import type { BotConfig } from "../config.js";
import { log } from "../logger.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { tickSizeFromMarket } from "../utils/market.js";
import { MIN_CLOB_SHARES } from "../utils/prices.js";
import type { SizingStrategy } from "./sizing.js";
import {
  favoriteAskInBuyRange,
  pickFavoriteToken,
  pickReverseToken,
  pickTokenByOutcome,
} from "./predicates.js";

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
  orderType?: "GTC" | "FOK",
): void {
  // Guard mémoire : positions open + ordres GTC restants + générés ce tick.
  if (
    tracker.countOpenPositionsForSide(event.slug, token.outcome) +
      tracker.countPendingOrdersForSide(event.slug, token.outcome) +
      pendingThisTick >=
    maxOpenPerSide
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
    ...(orderType ? { orderType } : {}),
  });
}

/**
 * Shared cheap/favorite claims, bands, and posting. Policy differences live
 * in the injected SizingStrategy (lock vs ratio) and TradingStrategy methods.
 */
export function orchestrate(
  config: BotConfig,
  tracker: TradeTracker,
  event: UpDownEvent,
  books: TokenBook[],
  sizing: SizingStrategy,
  nowMs?: number,
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
  //
  // Note: when enableExpensiveHedge is false, favoriteInRange is true
  // (short-circuit), so this early-return never fires for hedge-off.
  // Gate is hedge-on only.
  const favoriteInRange =
    !config.enableExpensiveHedge || favoriteAskInBuyRange(expensiveToken, config);

  const askLockOnly = config.arbAskLockOnly;

  if (
    config.enableExpensiveHedge &&
    !favoriteInRange &&
    committedCheapSize === 0 &&
    !askLockOnly
  ) {
    return opportunities;
  }

  // Cheap limit is a maker bid. ArbSizing also caps by pairLockMax − hedge;
  // BarbellSizing uses min(ask, cheapBuyMax) only.
  const hedgePrice = askLockOnly
    ? (expensiveToken?.bestAsk ?? config.expensiveBuyMax)
    : expensiveToken?.bestAsk != null
      ? Math.min(expensiveToken.bestAsk, config.expensiveBuyMax)
      : config.expensiveBuyMax;

  const sizingResult = sizing.compute({
    config,
    pairId,
    tracker,
    cheapToken,
    expensiveToken,
    hedgePrice,
    thisTickCheapSize: 0,
    nowMs,
    windowStart: event.windowStart,
  });

  const cheapPrice = sizingResult.cheapPrice;
  const askAlive =
    cheapToken.bestAsk !== null && cheapToken.bestAsk >= config.cheapBuyMin;
  const inCheapBand =
    cheapPrice >= config.cheapBuyMin && cheapPrice <= config.cheapBuyMax;
  // Ask-lock ignores cheap/favorite bands: any ask+ask <= pairLockMax is valid.
  // Also require hedge ask depth so we do not take cheap then fail the FOK cover.
  // Ask-lock dual-FOK: both asks need known size >= order (no optimistic null).
  const askLockDepthOk =
    !askLockOnly ||
    sizingResult.cheapSize === null ||
    (cheapToken.bestAskSize != null &&
      expensiveToken?.bestAskSize != null &&
      cheapToken.bestAskSize >= sizingResult.cheapSize * 0.8 &&
      expensiveToken.bestAskSize >= sizingResult.cheapSize * 0.8);
  const entryOk = askLockOnly
    ? committedCheapSize === 0 &&
      askAlive &&
      sizingResult.pairLockOk &&
      sizingResult.cheapSize !== null &&
      askLockDepthOk
    : favoriteInRange &&
      inCheapBand &&
      askAlive &&
      sizingResult.pairLockOk &&
      sizingResult.cheapSize !== null;
  if (entryOk) {
    appendLimitOrderForSide(
      tracker,
      opportunities,
      event,
      cheapToken,
      "cheap",
      cheapPrice,
      sizingResult.cheapSize as number,
      config.maxOpenPositionsPerSide,
      0,
      askLockOnly ? "FOK" : undefined,
    );
  }

  const hedgeSize = sizingResult.hedgeSize;
  // GTC rests below the touch; a thin best ask must not block the hedge.
  // Ask-lock dual-FOK always needs known depth (never treat null as infinite),
  // even if expensiveOrderType is GTC in settings — legs are posted as FOK.
  const hasDepth =
    hedgeSize !== null &&
    hedgeSize > 0 &&
    (askLockOnly
      ? expensiveToken?.bestAskSize != null &&
        expensiveToken.bestAskSize >= hedgeSize * 0.8
      : config.expensiveOrderType === "GTC" ||
        expensiveToken?.bestAskSize == null ||
        expensiveToken.bestAskSize >= hedgeSize * 0.8);
  if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    expensiveToken.bestAsk !== null &&
    hedgeSize !== null &&
    hedgeSize > 0 &&
    hasDepth &&
    (askLockOnly || favoriteInRange)
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
      askLockOnly ? "FOK" : undefined,
    );
  } else if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    expensiveToken.bestAsk !== null &&
    sizingResult.reason === "pair-lock-unreachable" &&
    tracker.getFilledCheapSizeForPair(pairId) > 0
  ) {
    // Policy A: push a hedge stub that bypasses maxOpen/leg guards (those
    // would silently drop the stub after a partial expensive leg). Execute
    // → hedgeAtPostTime → FOK SELL cheap.
    // tradeKey is stable per pair (NOT priced): a per-tick ask key re-queued
    // and re-logged every book update. Mark on enqueue so later ticks do not
    // spam; Failed defend does not unmark (avoids per-tick spam); band defend still covers ask > max.
    const stubSize = Math.max(
      MIN_CLOB_SHARES,
      tracker.getFilledCheapSizeForPair(pairId) -
        tracker.getFilledExpensiveSizeForPair(pairId),
    );
    const tradeKey = `policy-a-defend:${pairId}`;
    if (!tracker.has(tradeKey)) {
      log("Pair lock unreachable — queuing Policy A defend via hedge post-time", {
        market: event.title,
        cheapFill: tracker.getCheapFillPriceForPair(pairId),
        hedgePrice,
        pairCost: sizingResult.pairCost,
        pairLockMax: config.pairLockMax,
      });
      tracker.mark(tradeKey);
      opportunities.push({
        kind: "expensive",
        event,
        token: expensiveToken,
        price: hedgePrice,
        size: stubSize,
        tickSize: tickSizeFromMarket(event.market),
        negRisk: event.market.negRisk,
        tradeKey,
        pairId,
      });
    }
  } else if (
    config.enableExpensiveHedge &&
    expensiveToken &&
    (sizingResult.reason === "arb-pair-budget-insufficient" ||
      sizingResult.reason === "barbell-hedge-budget-insufficient")
  ) {
    log("Hedge skipped - below CLOB minimums", {
      market: event.title,
      hedgePrice,
      expensiveOrderUsdc: config.expensiveOrderUsdc,
    });
  }

  return opportunities;
}
