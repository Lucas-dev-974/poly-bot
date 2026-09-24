import type { PostedOrderContext } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { buyFillAgainstBook, type CrossFill } from "./broker.js";
import { round2 } from "./ledger.js";

export interface RestingGtc {
  key: string;
  opportunity: TradeOpportunity;
  context: PostedOrderContext;
  cost: number;
}

export class BacktestRestingBook {
  private readonly orders = new Map<string, RestingGtc>();

  post(opportunity: TradeOpportunity, cost: number, strategyId: string | undefined): void {
    const context: PostedOrderContext = {
      eventSlug: opportunity.event.slug,
      windowEnd: opportunity.event.windowEnd,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      outcomeIndex: opportunity.token.outcomeIndex,
      kind: opportunity.kind,
      limitPrice: opportunity.price,
      size: opportunity.size,
      pairId: opportunity.pairId,
      eventTitle: opportunity.event.title,
      bestAskAtFill: opportunity.token.bestAsk,
      strategyId: strategyId as PostedOrderContext["strategyId"],
    };
    this.orders.set(opportunity.tradeKey, {
      key: opportunity.tradeKey,
      opportunity,
      context,
      cost,
    });
  }

  remove(key: string): RestingGtc | undefined {
    const order = this.orders.get(key);
    if (order) this.orders.delete(key);
    return order;
  }

  listForPair(pairId: string, kind: "cheap" | "expensive"): RestingGtc[] {
    return [...this.orders.values()].filter(
      (order) => order.context.pairId === pairId && order.context.kind === kind,
    );
  }

  listForSlug(eventSlug: string): RestingGtc[] {
    return [...this.orders.values()].filter((order) => order.context.eventSlug === eventSlug);
  }

  /** Tous les GTC resting (tous slugs) — vue globale page Simulation. */
  listAll(): RestingGtc[] {
    return [...this.orders.values()];
  }

  reservedNotional(excludeKey?: string): number {
    let total = 0;
    for (const order of this.orders.values()) {
      if (excludeKey && order.key === excludeKey) continue;
      total = round2(total + order.cost);
    }
    return total;
  }

  /**
   * After a partial fill, shrink the working size/cost. Returns the leftover
   * order, or undefined when the GTC is fully filled and removed.
   */
  reduce(key: string, filledSize: number): RestingGtc | undefined {
    const order = this.orders.get(key);
    if (!order) return undefined;
    const remaining = round2(order.context.size - filledSize);
    if (remaining <= 1e-9) {
      this.orders.delete(key);
      return undefined;
    }
    order.context.size = remaining;
    order.opportunity = { ...order.opportunity, size: remaining };
    order.cost = round2(order.context.limitPrice * remaining);
    return order;
  }

  matchBuys(
    event: UpDownEvent,
    books: TokenBook[],
  ): Array<{ order: RestingGtc; fill: CrossFill }> {
    const hits: Array<{ order: RestingGtc; fill: CrossFill }> = [];
    for (const order of this.listForSlug(event.slug)) {
      const book =
        books.find((candidate) => candidate.tokenId === order.context.tokenId) ??
        books.find((candidate) => candidate.outcome === order.context.outcome);
      const fill = buyFillAgainstBook(order.context.limitPrice, order.context.size, book, "resting");
      if (!fill.filled || fill.size === undefined) continue;
      hits.push({ order, fill });
    }
    return hits;
  }
}

/** Working ask depth per token. Null means unknown / unlimited (legacy snapshots). */
export function remainingAskMap(books: TokenBook[]): Map<string, number | null> {
  const remaining = new Map<string, number | null>();
  for (const book of books) {
    remaining.set(book.tokenId, book.bestAskSize ?? null);
  }
  return remaining;
}

export function takeAskLiquidity(
  remaining: Map<string, number | null>,
  tokenId: string,
  wanted: number,
): number {
  const depth = remaining.get(tokenId);
  if (depth === null || depth === undefined) return wanted;
  if (depth <= 0) return 0;
  return round2(Math.min(wanted, depth));
}

export function consumeAskLiquidity(
  remaining: Map<string, number | null>,
  tokenId: string,
  filled: number,
): void {
  const depth = remaining.get(tokenId);
  if (depth === null || depth === undefined) return;
  remaining.set(tokenId, round2(Math.max(0, depth - filled)));
}
