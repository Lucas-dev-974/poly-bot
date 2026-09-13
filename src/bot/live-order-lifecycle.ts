import type { BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import { log } from "../logger.js";
import type { PostedOrderContext, TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { SimulatedPosition } from "../types.js";
import { shouldCancelOrphanIndependentHedges } from "../strategy/hedge-post.js";
import { confirmedFillSize } from "../utils/order-status.js";

export type LiveOrderLifecycleDeps = {
  config: BotConfig; // shared mutable reference, do not copy
  trader: Trader;
  tracker: TradeTracker;
};

export class LiveOrderLifecycle {
  private strategy: TradingStrategy;
  private readonly orderStatusFailures = new Map<string, number>();
  private readonly fillConfirmFailures = new Map<string, number>();
  private readonly cheapMissingFailures = new Map<string, number>();
  private static readonly ORDER_STATUS_MAX_FAILURES = 10;
  private static readonly FILL_CONFIRM_MAX_ATTEMPTS = 8;
  private static readonly CHEAP_MISSING_MAX_ATTEMPTS = 3;

  constructor(
    private readonly deps: LiveOrderLifecycleDeps,
    strategy: TradingStrategy,
  ) {
    this.strategy = strategy;
  }

  setStrategy(strategy: TradingStrategy): void {
    this.strategy = strategy;
  }

  clearCheapMissing(pairId: string): void {
    this.cheapMissingFailures.delete(pairId);
  }

  async cancelStaleOrders(nowSeconds: number): Promise<void> {
    const stale = this.deps.tracker.getStalePostedOrders(nowSeconds);
    for (const order of stale) {
      if (!order.orderId) {
        this.emitOrderCancelled(order);
        this.deps.tracker.removePostedOrder(order.key);
        await this.cancelOrphanHedgesIfNeeded(order);
        continue;
      }
      const tracked = { ...order, orderId: order.orderId };
      const status = await this.getOrderStatusTracked(tracked);
      if (!status) continue;
      try {
        await this.deps.trader.cancelOrder(tracked.orderId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Live order cancel failed, will retry", {
          orderId: tracked.orderId,
          error: message,
        });
        continue;
      }
      // Re-read the order status AFTER cancel to capture any fills that
      // occurred between the initial status read and the cancel. Without
      // this, a GTC order that kept filling while we were cancelling would
      // be recorded with a stale (smaller) sizeMatched, causing the local
      // position size to be smaller than the actual Polymarket position.
      const finalStatus = await this.getOrderStatusTracked(tracked);
      const sizeMatched = finalStatus?.sizeMatched ?? status.sizeMatched;
      log("Live order cancelled (stale)", {
        orderId: tracked.orderId,
        sizeMatched,
      });
      if (sizeMatched > 0) {
        const outcome = await this.finalizeLiveOrder(tracked, {
          ...status,
          sizeMatched,
        });
        if (outcome === "ghost" || outcome === "none") {
          await this.cancelOrphanHedgesIfNeeded(order);
        }
      } else {
        this.emitOrderCancelled(order);
        this.deps.tracker.removePostedOrder(order.key);
        await this.cancelOrphanHedgesIfNeeded(order);
      }
    }
  }

  async pollOrderFills(): Promise<void> {
    const orders = this.deps.tracker.getPostedOrdersWithOrderId();
    for (const order of orders) {
      const status = await this.getOrderStatusTracked(order);
      if (!status) continue;
      if (status.filled || status.cancelled) {
        if (status.sizeMatched > 0) {
          const outcome = await this.finalizeLiveOrder(order, status);
          if (outcome === "pending") continue;
          if (outcome === "ghost" || outcome === "none") {
            await this.cancelOrphanHedgesIfNeeded(order);
          }
        } else {
          this.emitOrderCancelled(order);
          this.deps.tracker.removePostedOrder(order.key);
          await this.cancelOrphanHedgesIfNeeded(order);
        }
        log("Live order removed from resting exposure", {
          orderId: order.orderId,
          filled: status.filled,
          cancelled: status.cancelled,
          sizeMatched: status.sizeMatched,
        });
      }
    }
  }

  async getOrderStatusTracked(
    order: { key: string; orderId: string } & PostedOrderContext,
  ): Promise<{ filled: boolean; cancelled: boolean; sizeMatched: number } | null> {
    try {
      const status = await this.deps.trader.getOrderStatus(order.orderId);
      this.orderStatusFailures.delete(order.orderId);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = (this.orderStatusFailures.get(order.orderId) ?? 0) + 1;
      this.orderStatusFailures.set(order.orderId, next);
      const missing = /404|not found/i.test(message);
      if (missing || next >= LiveOrderLifecycle.ORDER_STATUS_MAX_FAILURES) {
        log("Live order abandoned after status poll failures", {
          orderId: order.orderId,
          error: message,
          failures: next,
        });
        this.emitOrderCancelled(order);
        this.deps.tracker.removePostedOrder(order.key);
        this.orderStatusFailures.delete(order.orderId);
        await this.cancelOrphanHedgesIfNeeded(order);
        return null;
      }
      log("Live order status poll failed", {
        orderId: order.orderId,
        error: message,
        failures: next,
      });
      return null;
    }
  }

  async cancelOrphanHedgesIfNeeded(
    order: { key: string; pairId: string; kind: "cheap" | "expensive" } & PostedOrderContext,
  ): Promise<void> {
    // Edge-lead gère le GTC edge resting via manageRestingEdgeLead.
    // L'orphan-hedge arb (cheap disparu → cancel le favori) casserait un
    // edge qu'on veut garder in-bande.
    // Reverse (independentHedgeGrid): cancel hedges only when cheap-fill is
    // required, nothing is filled, and no cheap GTC remains on the pair.
    if (this.strategy.leadsWithEdge) return;
    if (order.kind !== "cheap") return;
    const filledCheap = this.deps.tracker.getFilledCheapSizeForPair(order.pairId);
    if (filledCheap > 0) return;
    if (this.strategy.independentHedgeGrid) {
      const restingCheap = this.deps.tracker.getPostedOrdersForPair(
        order.pairId,
        "cheap",
      ).length;
      if (
        !shouldCancelOrphanIndependentHedges({
          filledCheap,
          restingCheapCount: restingCheap,
          requireCheapFillBeforeExpensive:
            this.deps.config.requireCheapFillBeforeExpensive,
        })
      ) {
        return;
      }
      await this.cancelRestingHedgesForPair(
        order.pairId,
        "all cheap legs vanished (independent grid)",
      );
      return;
    }
    await this.cancelRestingHedgesForPair(order.pairId, "cheap leg vanished");
  }

  /**
   * Cancel every resting GTC hedge of a pair. Used when the cheap leg is
   * gone (never filled, or sold by defense): a hedge left on the book
   * would fill later as a naked favorite.
   */
  async cancelRestingHedgesForPair(pairId: string, why: string): Promise<void> {
    const hedges = this.deps.tracker.getPostedOrdersForPair(pairId, "expensive");
    for (const hedge of hedges) {
      if (hedge.orderId) {
        try {
          await this.deps.trader.cancelOrder(hedge.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Orphan hedge cancel failed, will retry", {
            orderId: hedge.orderId,
            error: message,
          });
          continue;
        }
      }
      this.emitOrderCancelled(hedge);
      this.deps.tracker.removePostedOrder(hedge.key);
      log(`Hedge cancelled - ${why}`, {
        pairId,
        orderId: hedge.orderId,
      });
    }
  }

  /**
   * Notifie le dashboard qu'un ordre resting a été annulé (fenêtre expirée
   * ou cancel du exchange) sans avoir été rempli. Sans cet event, le
   * frontend garde l'ordre visuellement "en attente" indéfiniment.
   */
  emitOrderCancelled(
    order: { key: string; orderId?: string } & PostedOrderContext,
  ): void {
    bus.emit({
      type: "order",
      result: {
        dryRun: this.deps.config.dryRun,
        tokenId: order.tokenId,
        side: "BUY",
        price: order.limitPrice,
        size: order.size,
        filled: false,
        reason: "cancelled",
        orderType: "GTC",
        response: order.orderId ? { orderID: order.orderId } : undefined,
      },
      opportunity: {
        kind: order.kind,
        event: {
          title: order.eventTitle,
          slug: order.eventSlug,
          market: {} as never,
          windowStart: 0,
          windowEnd: order.windowEnd,
        },
        token: {
          tokenId: order.tokenId,
          outcome: order.outcome,
          outcomeIndex: order.outcomeIndex,
          bestBid: null,
          bestAsk: order.bestAskAtFill ?? null,
          bestAskSize: null,
          bestBidSize: null,
        },
        price: order.limitPrice,
        size: order.size,
        tickSize: "0.01",
        negRisk: false,
        tradeKey: order.key,
        pairId: order.pairId,
      },
    });
  }

  /**
   * Finalise un ordre live. A CLOB "matched" is not enough: GTC maker
   * orders can report size_matched without delivering CTF tokens. We only
   * open a local position when the funder actually holds the shares.
   */
  async finalizeLiveOrder(
    order: { key: string; orderId: string } & PostedOrderContext,
    status: { filled: boolean; cancelled: boolean; sizeMatched: number },
  ): Promise<"created" | "pending" | "ghost" | "none"> {
    if (status.sizeMatched <= 0) {
      this.deps.tracker.removePostedOrder(order.key);
      this.fillConfirmFailures.delete(order.orderId);
      return "none";
    }

    const held = await this.deps.trader.getConditionalTokenBalance(order.tokenId);
    const confirmedSize = confirmedFillSize(status.sizeMatched, held);
    if (confirmedSize > 0) {
      this.createLivePosition(order, confirmedSize);
      this.deps.tracker.removePostedOrder(order.key);
      this.fillConfirmFailures.delete(order.orderId);
      return "created";
    }

    // Tokens not (yet) visible. The CLOB balance endpoint lagged a real
    // maker fill in production, so a cancelled-with-match order is retried
    // like a live one instead of being dropped as a ghost on the first miss
    // — dropping it would leave real tokens untracked in the wallet.
    const next = (this.fillConfirmFailures.get(order.orderId) ?? 0) + 1;
    this.fillConfirmFailures.set(order.orderId, next);
    if (next >= LiveOrderLifecycle.FILL_CONFIRM_MAX_ATTEMPTS) {
      log("Ghost CLOB match — tokens never appeared, not opening position", {
        orderId: order.orderId,
        sizeMatched: status.sizeMatched,
        cancelled: status.cancelled,
        held,
        attempts: next,
        market: order.eventTitle,
        outcome: order.outcome,
      });
      if (!status.cancelled) {
        try {
          await this.deps.trader.cancelOrder(order.orderId);
        } catch {
          // Already gone (true MATCHED) or network — local cleanup still proceeds.
        }
      }
      this.emitOrderCancelled(order);
      this.deps.tracker.removePostedOrder(order.key);
      this.fillConfirmFailures.delete(order.orderId);
      return "ghost";
    }

    log("Fill not confirmed by token balance, will retry", {
      orderId: order.orderId,
      sizeMatched: status.sizeMatched,
      cancelled: status.cancelled,
      held,
      attempt: next,
      market: order.eventTitle,
      outcome: order.outcome,
    });
    return "pending";
  }

  createLivePosition(
    order: { key: string; orderId: string } & PostedOrderContext,
    filledSize: number,
  ): void {
    if (filledSize <= 0) return;
    // Pour un ordre GTC marketable, le fill se fait au bestAsk (meilleur que le limit).
    // Pour un ordre non marketable, le fill se fait au limit price.
    const marketable =
      order.bestAskAtFill !== null &&
      order.bestAskAtFill !== undefined &&
      order.bestAskAtFill <= order.limitPrice;
    const fillPrice = marketable ? order.bestAskAtFill! : order.limitPrice;
    const position: SimulatedPosition = {
      id: `live:${order.orderId}`,
      eventSlug: order.eventSlug,
      eventTitle: order.eventTitle,
      tokenId: order.tokenId,
      outcome: order.outcome,
      outcomeIndex: order.outcomeIndex,
      kind: order.kind,
      limitPrice: order.limitPrice,
      fillPrice,
      size: filledSize,
      cost: Math.round(fillPrice * filledSize * 100) / 100,
      windowEnd: order.windowEnd,
      status: "open",
      fillReason: marketable ? "marketable" : "resting",
      pairId: order.pairId,
      bestAskAtFill: order.bestAskAtFill,
      orderType: "GTC",
      strategyId: order.strategyId ?? this.strategy.id,
    };
    this.deps.tracker.addOpenPosition(position);
    this.deps.tracker.attachLeg(position);
    bus.emit({ type: "openedPosition", position });
    log("Live position opened (order filled)", {
      orderId: order.orderId,
      market: order.eventTitle,
      outcome: order.outcome,
      kind: order.kind,
      fillPrice: position.fillPrice,
      size: filledSize,
      cost: position.cost,
    });
  }

  /**
   * Confirm the funder still holds the cheap tokens before hedging.
   * Returns held shares, 0 after syncing a vanished position as sold, or
   * null when the balance call failed (caller must fail-closed).
   */
  async confirmCheapTokensForHedge(pairId: string): Promise<number | null> {
    const cheapTokenId = this.deps.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) return 0;
    const held = await this.deps.trader.getConditionalTokenBalance(cheapTokenId);
    if (held === null) return null;
    if (held > 0) {
      this.cheapMissingFailures.delete(pairId);
      return held;
    }
    const next = (this.cheapMissingFailures.get(pairId) ?? 0) + 1;
    this.cheapMissingFailures.set(pairId, next);
    const filled = this.deps.tracker.getFilledCheapSizeForPair(pairId);
    if (filled > 0 && next >= LiveOrderLifecycle.CHEAP_MISSING_MAX_ATTEMPTS) {
      log("Cheap tokens gone — syncing local legs as sold (no hedge)", {
        pairId,
        cheapTokenId,
        filled,
        attempts: next,
      });
      this.deps.tracker.closePairCheapAsSold(pairId, 0, filled);
      this.cheapMissingFailures.delete(pairId);
    } else {
      log("Hedge skipped - cheap token balance is zero, will recheck", {
        pairId,
        cheapTokenId,
        attempt: next,
      });
    }
    return 0;
  }
}
