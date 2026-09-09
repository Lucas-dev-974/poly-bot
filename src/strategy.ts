import type { BotConfig } from "./config.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "./types.js";
import { ArbStrategy } from "./strategy/arb-strategy.js";

export {
  isAskInExpensiveBand,
  isPairCovered,
  shouldCancelRestingCheapForLock,
  shouldDefendUncoveredPair,
  shouldReplaceRestingCheap,
} from "./strategy/predicates.js";

/**
 * Barrel findOpportunities always uses ArbStrategy. Production trading goes
 * through ReverseBot → createStrategy(config.strategyId). Tests that need
 * barbell must call createStrategy("barbell") / new BarbellStrategy().
 */
export function findOpportunities(
  config: BotConfig,
  tracker: TradeTracker,
  event: UpDownEvent,
  books: TokenBook[],
): TradeOpportunity[] {
  return new ArbStrategy().findOpportunities({
    config,
    tracker,
    event,
    books,
  });
}
