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
 * Single-leg FOK BUY on the favorite. No hedge. Hold to resolve.
 * Distinct from edge-lead (no confirm buffer, no cheap follow-up) and from
 * ask-lock (no dual-FOK arb).
 */
export class FavBandStrategy implements TradingStrategy {
  readonly id = "fav-band" as const;
  readonly label =
    "Fav-band: FOK buy favorite when ask in calibrated mid-band after min elapsed; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const fav = pickEdgeToken(books);
    if (!fav || fav.bestAsk === null) return opportunities;

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

    // One directional entry per window: if we already filled (or still hold)
    // a leg on this pair, do not emit another FOK (avoids stacking when the
    // ask walks inside the band and minting new tradeKeys per price).
    const pairId = `${event.slug}:${event.windowEnd}`;
    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    const size = computeSize(
      config.cheapOrderUsdc,
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

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    // FOK-only entries: nothing to manage resting.
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
