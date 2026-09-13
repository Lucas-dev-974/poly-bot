import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import type { SizingContext, SizingResult, SizingStrategy } from "./sizing.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * B1 Sizing Strategy — true arbitrage (maker cheap, or ask-lock dual-FOK).
 *
 * Default: the cheap limit is the highest bid that still locks a profit:
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
 * A budget-capped hedge must not leave uncovered dust in (0, MIN_CLOB_SHARES):
 * prefer leaving exactly MIN_CLOB_SHARES sellable, or skip the partial hedge so
 * the full uncovered stays Policy-A / band-defendable.
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

    const askLockOnly = config.arbAskLockOnly;

    if (hasPair && askLockOnly) {
      // True market lock: only enter when both asks already sum <= pairLockMax.
      // Take the cheap ask (not a resting bid below). Hedge is planned 1:1 so
      // orchestrate can emit both legs; backtest fills cheap first same tick.
      const cheapAsk = cheapToken.bestAsk;
      const expAsk = expensiveToken?.bestAsk ?? null;
      if (cheapAsk == null || expAsk == null) {
        pairLockOk = false;
      } else {
        const lockCap =
          config.arbAskSumMax !== null ? config.arbAskSumMax : config.pairLockMax;
        const askSum = round2(cheapAsk + expAsk);
        if (askSum > lockCap) {
          pairLockOk = false;
        } else {
          // Optional late-window gate (lock-harvest): wait N sec into the window.
          const minElapsed = config.arbAskLockMinElapsedSec;
          if (minElapsed != null && minElapsed > 0) {
            const ws = ctx.windowStart;
            const t = ctx.nowMs ?? Date.now();
            if (ws == null || (t / 1000 - ws) < minElapsed) {
              pairLockOk = false;
            }
          }
          // Optional imbalance gate: skip extreme skewed locks (e.g. 0.08+0.91).
          const maxImb = config.arbAskLockMaxImbalance;
          if (pairLockOk && maxImb != null && maxImb > 0) {
            if (Math.abs(cheapAsk - expAsk) > maxImb) {
              pairLockOk = false;
            }
          }
          if (pairLockOk) {
            cheapPrice = round2(cheapAsk);
          }
        }
      }
    } else if (hasPair) {
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
    if (hasPair) {
      const costCap =
        askLockOnly && config.arbAskSumMax !== null
          ? config.arbAskSumMax
          : config.pairLockMax;
      if (pairCost > costCap) {
        pairLockOk = false;
      }
    }

    // Cheap size at the maker lock price. A $1 budget cannot buy the CLOB
    // minimum of 5 shares above ~$0.20 — step down toward cheapBuyMin
    // (still under the lock) rather than silently skip the window.
    let cheapSize = pairLockOk
      ? computeSize(config.cheapOrderUsdc, cheapPrice, config.maxSharesPerOrder)
      : null;
    // Ask-lock must take the live ask — never step down into a resting maker bid.
    if (pairLockOk && cheapSize === null && !askLockOnly) {
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
      // Ask-lock: emit planned 1:1 hedge so same-tick cover after cheap ask fill.
      // Size both legs to min(budget, depths, cheapSize) so we never lift more
      // cheap than we can FOK-cover (no intentional one-legged entry).
      if (askLockOnly && pairLockOk && hasPair && cheapSize !== null) {
        const budgetMax = computeSize(
          config.expensiveOrderUsdc,
          hedgePrice,
          config.maxSharesPerOrder,
        );
        let dualSize = cheapSize;
        if (budgetMax !== null) {
          dualSize = Math.min(dualSize, budgetMax);
        } else {
          dualSize = 0;
        }
        const cheapDepth = cheapToken.bestAskSize;
        const expDepth = expensiveToken?.bestAskSize ?? null;
        if (cheapDepth != null) dualSize = Math.min(dualSize, cheapDepth);
        if (expDepth != null) dualSize = Math.min(dualSize, expDepth);
        dualSize = round2(dualSize);
        if (dualSize < MIN_CLOB_SHARES) {
          return {
            cheapPrice,
            cheapSize: null,
            hedgePrice,
            hedgeSize: null,
            pairCost,
            pairLockOk: false,
            reason: "arb-ask-lock-size-below-clob-min",
          };
        }
        return {
          cheapPrice,
          cheapSize: dualSize,
          hedgePrice,
          hedgeSize: dualSize,
          pairCost,
          pairLockOk,
          reason: "arb-ask-lock",
        };
      }
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
    let hedgeSize = budgetMax !== null
      ? Math.min(uncovered, budgetMax)
      : 0;

    let reason = "arb-pair";
    if (hedgeSize === 0) {
      reason = "arb-pair-budget-insufficient";
    } else if (hedgeSize < uncovered) {
      const leftover = round2(uncovered - hedgeSize);
      // Never create unsellable dust (< CLOB min). Keep a sellable remainder
      // for Policy A / band defend, or skip the capped hedge entirely.
      if (leftover > 0 && leftover < MIN_CLOB_SHARES) {
        const adjusted = round2(uncovered - MIN_CLOB_SHARES);
        if (adjusted >= MIN_CLOB_SHARES) {
          hedgeSize = adjusted;
          reason = "arb-pair-budget-capped-sellable-remainder";
        } else {
          hedgeSize = 0;
          reason = "arb-pair-budget-would-leave-unsellable-dust";
        }
      } else {
        reason = "arb-pair-budget-capped";
      }
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
