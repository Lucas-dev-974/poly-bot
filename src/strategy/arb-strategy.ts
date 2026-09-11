import { ArbSizing } from "./arb-sizing.js";
import { evaluateHedgeAtPostTime } from "./hedge-post.js";
import { orchestrate } from "./orchestrate.js";
import {
  isPairCovered,
  round2,
  shouldCancelRestingCheapForLock,
  shouldDefendUncoveredPair,
  shouldReplaceRestingCheap,
} from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";
import type { TradeOpportunity } from "../types.js";

export class ArbStrategy implements TradingStrategy {
  readonly id = "arb" as const;
  readonly label =
    "B1 arb: maker cheap GTC, 1:1 hedge after fill if fill+hedge <= pairLockMax";
  readonly leadsWithEdge = false;
  private readonly sizing = new ArbSizing();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    return orchestrate(ctx.config, ctx.tracker, ctx.event, ctx.books, this.sizing);
  }

  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    if (
      shouldCancelRestingCheapForLock(
        ctx.limitPrice,
        ctx.favoriteAsk,
        ctx.config,
      )
    ) {
      return "cancel-lock";
    }
    const book = ctx.cheapBook;
    if (
      book &&
      shouldReplaceRestingCheap(
        ctx.limitPrice,
        book.bestAsk,
        book.bestBid,
        ctx.config.cheapBuyMin,
      )
    ) {
      return "take-ask";
    }
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  shouldDefend(ctx: DefendContext): boolean {
    return (
      shouldDefendUncoveredPair(ctx.favoriteAsk, ctx.config.expensiveBuyMax) &&
      !isPairCovered(ctx.filledCheap, ctx.filledExpensive)
    );
  }

  defendShares(ctx: DefendContext): number {
    return round2(Math.max(0, ctx.filledCheap - ctx.filledExpensive));
  }

  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision {
    return evaluateHedgeAtPostTime(ctx, {
      checkPairLock: true,
      shouldDefend: (defend) => this.shouldDefend(defend),
      defendShares: (defend) => this.defendShares(defend),
    });
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
