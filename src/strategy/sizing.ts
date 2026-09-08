import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook } from "../types.js";

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
 * Strategy interface for computing leg sizes. B1 implements ArbSizing
 * (1:1 with filled cheap, profit lock). B2 (future) will implement
 * BarbellSizing (explicit ratio, Kelly fractionated). The rest of the
 * pipeline (guards, execution, tracker, DB) is agnostic to the strategy.
 */
export interface SizingStrategy {
  /** Strategy name for logging and dashboard. */
  readonly name: "arb" | "barbell";
  /** Compute sizes and prices for a given opportunity context. */
  compute(ctx: SizingContext): SizingResult;
}