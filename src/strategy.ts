import type { BotConfig } from "./config.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "./types.js";
import { createStrategy } from "./strategy/registry.js";

export {
  isAskInExpensiveBand,
  isPairCovered,
  shouldCancelRestingCheapForLock,
  shouldDefendUncoveredPair,
  shouldReplaceRestingCheap,
} from "./strategy/predicates.js";

/**
 * Test/helper barrel: delegates to `createStrategy(config.strategyId)`.
 * Production trading goes through ReverseBot → createStrategy(config.strategyId, repos).
 * Custom strategies (`custom:<id>`) still require repos — call createStrategy directly.
 */
export function findOpportunities(
  config: BotConfig,
  tracker: TradeTracker,
  event: UpDownEvent,
  books: TokenBook[],
): TradeOpportunity[] {
  return createStrategy(config.strategyId).findOpportunities({
    config,
    tracker,
    event,
    books,
  });
}
