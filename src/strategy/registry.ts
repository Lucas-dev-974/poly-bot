import { ArbStrategy } from "./arb-strategy.js";
import { BarbellStrategy } from "./barbell-strategy.js";
import type { StrategyId } from "./ids.js";
import type { TradingStrategy } from "./trading-strategy.js";

const STRATEGIES: Record<StrategyId, () => TradingStrategy> = {
  arb: () => new ArbStrategy(),
  barbell: () => new BarbellStrategy(),
};

export function createStrategy(id: StrategyId): TradingStrategy {
  const factory = STRATEGIES[id];
  if (!factory) {
    throw new Error(`Unknown strategy: ${id}`);
  }
  return factory();
}
