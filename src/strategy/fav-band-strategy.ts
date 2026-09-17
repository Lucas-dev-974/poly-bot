import type { TradeOpportunity } from "../types.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { appendOpportunity, pickEdgeToken } from "./edge-lead-strategy.js";
import { round2 } from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";

/**
 * Fav-band — NEW directional strategy (not ask-lock, not edge-lead).
 *
 * Empirical edge on BTC 15m: after ~200s into the window, the market's
 * favorite (higher ask) in [favBandAskMin, favBandAskMax] (default 0.70–0.85)
 * wins often enough that buying the ask and holding to resolution is +EV,
 * while higher "certainty" favorites (0.90+) are overpriced.
 *
 * Single-leg FOK BUY on the favorite. Hold to resolve.
 * Optional hedge-inverse (favBandInverseEnabled, default off): once the
 * favorite leg is FILLED, post a resting GTC BUY at favBandInverseAskMax on
 * the OPPOSITE token. The order fills INCREMENTALLY while the inverse ask
 * dips to/below the limit; partial fills persist and the order is never
 * cancelled (a flip only stops NEW fills — the limit never crosses back up).
 * Sizing = ratio × filled favorite shares (e.g. 2 = double the favorite
 * shares), capped by budget and maxSharesPerOrder. The leg rides the
 * cheap-GTC pipeline; it can only fill while the favorite stays above
 * 1 − limit, i.e. in the states the band entry is designed for.
 * Distinct from edge-lead (no confirm buffer, no cheap follow-up) and from
 * ask-lock (no dual-FOK arb).
 */
export class FavBandStrategy implements TradingStrategy {
  readonly id = "fav-band" as const;
  readonly label =
    "Fav-band: FOK buy favorite when ask in calibrated mid-band after min elapsed; hold to resolve (optional resting inverse GTC)";
  readonly leadsWithEdge = false;

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const fav = pickEdgeToken(books);
    if (!fav || fav.bestAsk === null) return opportunities;

    const pairId = `${event.slug}:${event.windowEnd}`;
    const favFilled = tracker.getFilledCheapSizeForPair(pairId);

    // Hedge-inverse gate FIRST: once the favorite leg is filled, the entry
    // band/elapsed gates no longer apply — the inverse GTC only looks at the
    // opposite token (the favorite can have walked out of the band after the
    // fill; the resting order then simply keeps working or never fills).
    if (favFilled > 0) {
      // Anti-restack: a posted/working inverse GTC (or any posted cheap leg)
      // on this pair means the order is already on the book — emitting again
      // would stack a second order each tick (tradeKey includes the price,
      // so a stale key never dedupes it).
      if (tracker.getPostedOrdersForPair(pairId, "cheap").length === 0) {
        this.appendInverse(ctx, opportunities, fav, pairId, favFilled);
      }
      return opportunities;
    }

    const ask = fav.bestAsk;
    if (ask < config.favBandAskMin || ask > config.favBandAskMax) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const elapsedSec = nowMs / 1000 - event.windowStart;
    if (elapsedSec < config.favBandMinElapsedSec) {
      return opportunities;
    }
    if (
      config.favBandMaxElapsedSec != null &&
      elapsedSec > config.favBandMaxElapsedSec
    ) {
      return opportunities;
    }

    // One directional entry per window: no posted/working cheap leg on this
    // pair (avoids stacking when the ask walks inside the band and minting
    // new tradeKeys per price).
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    const size = computeSize(
      config.favBandOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Depth preflight: need known size on the ask.
    if (fav.bestAskSize != null && fav.bestAskSize < size * 0.8) {
      return opportunities;
    }

    const before = opportunities.length;
    // kind "cheap" = single BUY leg in the bot's order pipeline (not underdog).
    // orderType FOK lifts the live ask. Must stay independent of arbAskLockOnly.
    appendOpportunity(
      tracker,
      opportunities,
      event,
      fav,
      "cheap",
      round2(ask),
      size,
      config.maxOpenPositionsPerSide,
    );
    // Force FOK take of the live ask (no resting maker below).
    for (let i = before; i < opportunities.length; i++) {
      opportunities[i] = { ...opportunities[i], orderType: "FOK" };
    }
    return opportunities;
  }

  /**
   * Hedge-inverse leg: a resting GTC BUY at the limit on the OPPOSITE token,
   * sized at ratio × the filled favorite shares. Emitted as a cheap-kind GTC
   * so it flows through the shared bot/backtest pipeline (postResting /
   * matchResting, partial fills persist) without touching the arb hedge
   * gates. Posted WITHOUT any marketable take-ask: the ask must come DOWN to
   * the limit for a maker fill (incremental), never chased.
   */
  private appendInverse(
    ctx: StrategyContext,
    opportunities: TradeOpportunity[],
    fav: NonNullable<ReturnType<typeof pickEdgeToken>>,
    pairId: string,
    favFilled: number,
  ): void {
    const { config, tracker, event, books } = ctx;
    if (!config.favBandInverseEnabled) return;

    const inverse = books.find(
      (book) => book.tokenId !== fav.tokenId && book.bestAsk !== null,
    );
    if (!inverse || inverse.bestAsk === null) return;

    // Ratio sizing on the REAL filled favorite shares, capped by budget and
    // maxSharesPerOrder; the same computeSize floors as the entry leg apply
    // (MIN_CLOB_SHARES / min notional). Sized on the LIMIT price (a maker
    // order never pays more than its limit).
    const budgetCapSize = computeSize(
      config.favBandInverseOrderUsdc,
      config.favBandInverseAskMax,
      config.maxSharesPerOrder,
    );
    if (budgetCapSize === null) return;
    const size = round2(
      Math.min(favFilled * config.favBandInverseShareRatio, budgetCapSize),
    );
    if (size < MIN_CLOB_SHARES) return;

    appendOpportunity(
      tracker,
      opportunities,
      event,
      inverse,
      "cheap",
      round2(config.favBandInverseAskMax),
      size,
      config.maxOpenPositionsPerSide,
    );
    // Deliberately NO orderType override: default GTC resting maker at the
    // limit, incremental fills via matchResting (backtest) / pollOrderFills
    // (live). The order is never cancelled: cheapOrderAction returns "keep".
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    // Inverse GTC rests untouched: no take-ask chase, no cancel. Fills are
    // incremental; the window close drops it with the pair.
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  shouldDefend(_ctx: DefendContext): boolean {
    return false;
  }

  defendShares(_ctx: DefendContext): number {
    return 0;
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "fav-band-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}