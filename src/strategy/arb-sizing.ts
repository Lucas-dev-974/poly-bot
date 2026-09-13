import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import type { SizingContext, SizingResult, SizingStrategy } from "./sizing.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * B1 Sizing Strategy — true arbitrage (maker cheap).
 *
 * The cheap limit is the highest bid that still locks a profit:
 *   min(ask, cheapBuyMax, pairLockMax − hedgePrice)
 * If the live cheap ask is 0.16 and the favorite asks 0.85 with
 * pairLockMax=0.98, we sit at 0.13 — we do not wait for an already-locked
 * ask+ask (almost never present on 15m books, typically 1.01).
 *
 * The hedge is sized 1:1 with the still-uncovered filled cheap (filled
 * cheap − filled hedge), not by budget. This guarantees that every covered
 * pair locks (1 − pairCost) × size, regardless of which side wins.
 * EXPENSIVE_ORDER_USDC is a secondary cap; a budget that buys fewer than
 * MIN_CLOB_SHARES (5) at the hedge price yields NO hedge at all.
 * After a cheap fill, the hedge is refused when fillPrice + hedge > pairLockMax
 * (Policy A: orchestrate queues a defend stub → FOK-sell cheap; never lock a pair above $1).
 *
 * When the hedge is disabled (or no favorite is in the books), the cheap
 * is directional and the pair lock does not apply.
 */
export class ArbSizing implements SizingStrategy {
  readonly name = "arb";

  compute(ctx: SizingContext): SizingResult {
    const { config, tracker, pairId, cheapToken, expensiveToken, hedgePrice } = ctx;

    const hasPair = config.enableExpensiveHedge && expensiveToken !== null;
    const askCap = cheapToken.bestAsk ?? config.cheapBuyMax;
    const rawCheap = Math.min(askCap, config.cheapBuyMax);

    let cheapPrice = round2(rawCheap);
    let pairLockOk = true;

    if (hasPair) {
      const maxCheapForLock = round2(config.pairLockMax - hedgePrice);
      // Cannot lock a profit inside the cheap band: the hedge is already
      // so expensive that even cheapBuyMin + hedge > pairLockMax.
      if (maxCheapForLock < config.cheapBuyMin) {
        pairLockOk = false;
      } else {
        cheapPrice = round2(Math.min(rawCheap, maxCheapForLock));
        if (cheapPrice < config.cheapBuyMin) {
          pairLockOk = false;
        }
      }
    }

    let pairCost = round2(cheapPrice + hedgePrice);
    if (hasPair && pairCost > config.pairLockMax) {
      pairLockOk = false;
    }

    // Cheap size at the maker lock price. A $1 budget cannot buy the CLOB
    // minimum of 5 shares above ~$0.20 — step down toward cheapBuyMin
    // (still under the lock) rather than silently skip the window.
    let cheapSize = pairLockOk
      ? computeSize(config.cheapOrderUsdc, cheapPrice, config.maxSharesPerOrder)
      : null;
    if (pairLockOk && cheapSize === null) {
      for (
        let p = round2(cheapPrice - 0.01);
        p >= config.cheapBuyMin;
        p = round2(p - 0.01)
      ) {
        const sized = computeSize(
          config.cheapOrderUsdc,
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
        reason: pairLockOk ? "no-filled-cheap" : "pair-lock-unreachable",
      };
    }

    // Hedge lock uses the FILLED cheap price, not the theoretical new bid.
    // A 0.20 fill + 0.83 ask is a locked loss even if a fresh bid at 0.16
    // would still satisfy pairLockMax.
    const fillPrice = tracker.getCheapFillPriceForPair(pairId);
    const filledPairCost =
      fillPrice !== null ? round2(fillPrice + hedgePrice) : pairCost;
    if (hasPair && filledPairCost > config.pairLockMax) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: null,
        pairCost: filledPairCost,
        pairLockOk,
        reason: "pair-lock-unreachable",
      };
    }

    // 1:1 target is the UNCOVERED cheap (filled cheap minus filled hedge).
    // Without this, a budget-capped hedge that already filled would be
    // re-sized against the full cheap every tick and over-hedge the pair.
    const filledExpensive = tracker.getFilledExpensiveSizeForPair(pairId);
    const uncovered = round2(Math.max(0, filledCheap - filledExpensive));
    if (uncovered <= 0) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: 0,
        pairCost,
        pairLockOk,
        reason: "arb-pair-covered",
      };
    }
    // A remainder under the CLOB minimum cannot be posted (rejected by the
    // exchange). Hold the partial pair rather than spamming a 2-share hedge.
    if (uncovered < MIN_CLOB_SHARES) {
      return {
        cheapPrice,
        cheapSize,
        hedgePrice,
        hedgeSize: 0,
        pairCost,
        pairLockOk,
        reason: "arb-pair-remainder-below-clob-min",
      };
    }

    const budgetMax = computeSize(
      config.expensiveOrderUsdc,
      hedgePrice,
      config.maxSharesPerOrder,
    );
    const hedgeSize = budgetMax !== null
      ? Math.min(uncovered, budgetMax)
      : 0;

    let reason = "arb-pair";
    if (hedgeSize === 0) {
      reason = "arb-pair-budget-insufficient";
    } else if (hedgeSize < uncovered) {
      reason = "arb-pair-budget-capped";
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
