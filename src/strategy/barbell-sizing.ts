import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { round2 } from "./predicates.js";
import type { SizingContext, SizingResult, SizingStrategy } from "./sizing.js";

/**
 * Barbell sizing — explicit cheap/hedge ratio, no pair lock.
 *
 * Cheap limit is min(ask, cheapBuyMax) inside the cheap band.
 * Hedge after fill targets filledCheap × barbellHedgeRatio, sized on the
 * still-uncovered remainder (target − filledExpensive), not the full target.
 * pairLockOk is always true so orchestrate does not refuse the cheap on lock.
 */
export class BarbellSizing implements SizingStrategy {
  readonly name = "barbell";

  compute(ctx: SizingContext): SizingResult {
    const { config, tracker, pairId, cheapToken, hedgePrice } = ctx;

    const askCap = cheapToken.bestAsk ?? config.cheapBuyMax;
    let cheapPrice = round2(Math.min(askCap, config.cheapBuyMax));
    const pairLockOk = true;
    let pairCost = round2(cheapPrice + hedgePrice);

    let cheapSize = computeSize(
      config.barbellCheapOrderUsdc,
      cheapPrice,
      config.maxSharesPerOrder,
    );
    if (cheapSize === null) {
      for (
        let p = round2(cheapPrice - 0.01);
        p >= config.cheapBuyMin;
        p = round2(p - 0.01)
      ) {
        const sized = computeSize(
          config.barbellCheapOrderUsdc,
          p,
          config.maxSharesPerOrder,
        );
        if (sized !== null) {
          cheapPrice = p;
          cheapSize = sized;
          pairCost = round2(cheapPrice + hedgePrice);
          break;
        }
      }
    }

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

    const filledExpensive = tracker.getFilledExpensiveSizeForPair(pairId);
    const target = round2(filledCheap * config.barbellHedgeRatio);
    const uncovered = round2(Math.max(0, target - filledExpensive));
    if (uncovered <= 0) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: 0,
        pairCost,
        pairLockOk,
        reason: "barbell-ratio-met",
      };
    }
    if (uncovered < MIN_CLOB_SHARES) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: 0,
        pairCost,
        pairLockOk,
        reason: "barbell-hedge-below-clob-min",
      };
    }

    const budgetMax = computeSize(
      config.expensiveOrderUsdc,
      hedgePrice,
      config.maxSharesPerOrder,
    );
    const hedgeSize = budgetMax !== null ? Math.min(uncovered, budgetMax) : 0;

    let reason = "barbell-ratio";
    if (hedgeSize === 0) {
      reason = "barbell-hedge-budget-insufficient";
    } else if (hedgeSize < uncovered) {
      reason = "barbell-hedge-budget-capped";
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
