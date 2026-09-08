import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook } from "../types.js";
import { computeSize } from "../utils/prices.js";
import type { SizingContext, SizingResult, SizingStrategy } from "./sizing.js";

/**
 * B1 Sizing Strategy — true arbitrage.
 *
 * The hedge is sized 1:1 with the filled cheap leg (not by budget). This
 * guarantees that every covered pair locks a profit of (1 − pairCost) × size,
 * regardless of which side wins. The budget EXPENSIVE_ORDER_USDC becomes a
 * secondary cap: if it's insufficient to cover the filled cheap at the hedge
 * price, the hedge is limited and the excess cheap is cut via SELL (§4.4).
 *
 * No pair is posted if pairCost > pairLockMax (< 1.00) — a pair costing more
 * than $1 per share-pair is a guaranteed loss, not an arbitrage.
 */
export class ArbSizing implements SizingStrategy {
  readonly name = "arb";

  compute(ctx: SizingContext): SizingResult {
    const { config, tracker, pairId, cheapToken, hedgePrice } = ctx;

    // 1. Cheap price: min(ask, cheapBuyMax), capped to 2 decimals.
    const cheapPrice = Math.round(
      Math.min(cheapToken.bestAsk ?? config.cheapBuyMax, config.cheapBuyMax) * 100,
    ) / 100;

    // 2. Pair cost per share-pair and profit lock check.
    const pairCost = Math.round((cheapPrice + hedgePrice) * 100) / 100;
    const pairLockOk = pairCost <= config.pairLockMax;

    // 3. Cheap size: budget / price, capped by maxShares, CLOB minimums.
    const cheapSize = pairLockOk
      ? computeSize(config.cheapOrderUsdc, cheapPrice, config.maxSharesPerOrder)
      : null;

    // 4. Hedge size: 1:1 with the FILLED cheap (not the budget).
    //    The budget expensiveOrderUsdc becomes a secondary cap.
    const filledCheap = tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheap <= 0) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: null,
        pairCost,
        pairLockOk,
        reason: "no-filled-cheap",
      };
    }
    // Budget cap: if computeSize returns null (budget insufficient for CLOB
    // minimums), the hedge is blocked — NOT silently set to filledCheap
    // (which would bypass the cap, the bug fixed from the plan).
    const budgetMax = computeSize(
      config.expensiveOrderUsdc,
      hedgePrice,
      config.maxSharesPerOrder,
    );
    const hedgeSize = budgetMax !== null
      ? Math.min(filledCheap, budgetMax)
      : 0; // Budget insufficient → hedge blocked, excess cheap to cut via SELL.

    let reason = pairLockOk ? "arb-pair" : "pair-cost-exceeds-lock";
    if (pairLockOk && hedgeSize < filledCheap) {
      reason = "arb-pair-budget-capped";
    } else if (pairLockOk && hedgeSize === 0) {
      reason = "arb-pair-budget-insufficient";
    }

    return {
      cheapPrice,
      cheapSize,
      hedgePrice,
      hedgeSize,
      pairCost,
      pairLockOk,
      reason,
    };
  }
}