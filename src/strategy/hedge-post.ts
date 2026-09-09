import { MIN_CLOB_SHARES } from "../utils/prices.js";
import type {
  DefendContext,
  HedgePostContext,
  HedgePostDecision,
} from "./trading-strategy.js";
import { round2 } from "./predicates.js";

export function evaluateHedgeAtPostTime(
  ctx: HedgePostContext,
  options: {
    checkPairLock: boolean;
    shouldDefend: (defend: DefendContext) => boolean;
    defendShares: (defend: DefendContext) => number;
  },
): HedgePostDecision {
  const { config, tracker, pairId, freshAsk } = ctx;
  if (freshAsk === null) {
    return { action: "skip", reason: "favorite-book-missing" };
  }

  const defendCtx: DefendContext = {
    config,
    favoriteAsk: freshAsk,
    filledCheap: tracker.getFilledCheapSizeForPair(pairId),
    filledExpensive: tracker.getFilledExpensiveSizeForPair(pairId),
  };

  if (freshAsk > config.expensiveBuyMax) {
    if (!options.shouldDefend(defendCtx)) {
      return { action: "skip", reason: "already-covered" };
    }
    // Uncovered but below the CLOB minimum: do not SELL (and do not
    // re-enter defendPair every tick). Hold the leftover directional.
    if (options.defendShares(defendCtx) < MIN_CLOB_SHARES) {
      return { action: "skip", reason: "defend-below-clob-min" };
    }
    return { action: "defend", reason: "favorite-ask-above-max" };
  }

  if (freshAsk < config.expensiveBuyMin) {
    return { action: "skip", reason: "outside-band" };
  }

  const price = Math.min(freshAsk, config.expensiveBuyMax);
  if (options.checkPairLock) {
    const fillPrice = tracker.getCheapFillPriceForPair(pairId);
    if (fillPrice !== null && round2(fillPrice + price) > config.pairLockMax) {
      return { action: "skip", reason: "pair-lock-unreachable" };
    }
  }

  return { action: "post", price };
}
