import { BarbellSizing } from "./barbell-sizing.js";
import { evaluateHedgeAtPostTime } from "./hedge-post.js";
import { orchestrate } from "./orchestrate.js";
import {
  round2,
  shouldCancelRestingCheapOffBand,
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

export class BarbellStrategy implements TradingStrategy {
  readonly id = "barbell" as const;
  readonly label =
    "Barbell: maker cheap GTC, hedge at barbellHedgeRatio after fill (no pair lock)";
  readonly leadsWithEdge = false;
  private readonly sizing = new BarbellSizing();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    return orchestrate(ctx.config, ctx.tracker, ctx.event, ctx.books, this.sizing, ctx.nowMs);
  }

  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    if (shouldCancelRestingCheapOffBand(ctx.favoriteAsk, ctx.config)) {
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
    if (
      !shouldDefendUncoveredPair(ctx.favoriteAsk, ctx.config.expensiveBuyMax)
    ) {
      return false;
    }
    const target = round2(ctx.filledCheap * ctx.config.barbellHedgeRatio);
    return ctx.filledExpensive < target;
  }

  defendShares(ctx: DefendContext): number {
    const missing = round2(
      ctx.filledCheap * ctx.config.barbellHedgeRatio - ctx.filledExpensive,
    );
    return round2(Math.max(0, missing));
  }

  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision {
    return evaluateHedgeAtPostTime(ctx, {
      checkPairLock: false,
      shouldDefend: (defend) => this.shouldDefend(defend),
      defendShares: (defend) => this.defendShares(defend),
    });
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
