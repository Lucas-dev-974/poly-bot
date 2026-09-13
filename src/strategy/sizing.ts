import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook } from "../types.js";
import type { StrategyId } from "./ids.js";

/**
 * Context passed to a SizingStrategy to compute the sizes and prices
 * for a single opportunity (cheap + hedge).
 */
export interface SizingContext {
  config: BotConfig;
  pairId: string;
  tracker: TradeTracker;
  cheapToken: TokenBook;
  expensiveToken: TokenBook | null;
  hedgePrice: number;
  thisTickCheapSize: number;
  /** Backtest/live clock. Live may omit — Date.now() used for elapsed gates. */
  nowMs?: number;
  /** Window start (unix sec). Needed for arbAskLockMinElapsedSec. */
  windowStart?: number;
}

/**
 * Result of a sizing computation: the prices and sizes for both legs,
 * plus whether the pair satisfies the profit lock.
 */
export interface SizingResult {
  cheapPrice: number;
  cheapSize: number | null;
  hedgePrice: number;
  hedgeSize: number | null;
  /** Total cost per share-pair (cheapPrice + hedgePrice). */
  pairCost: number;
  /** Whether pairCost <= pairLockMax (profit lock satisfied). */
  pairLockOk: boolean;
  /** Human-readable reason for logging and dashboard. */
  reason: string;
}

/**
 * Strategy interface for computing leg sizes. ArbSizing is 1:1 + lock.
 * BarbellSizing uses an explicit cheap/hedge ratio and always reports
 * pairLockOk. Policy (cancel, defend, hedge-at-post) lives on TradingStrategy.
 */
export interface SizingStrategy {
  /** Strategy name for logging and dashboard. */
  readonly name: StrategyId;
  /** Compute sizes and prices for a given opportunity context. */
  compute(ctx: SizingContext): SizingResult;
}