import type { BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import { log } from "../logger.js";
import type { MarketScanner } from "../market-scanner.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { MIN_CLOB_SHARES } from "../utils/prices.js";
import type { LiveOrderLifecycle } from "./live-order-lifecycle.js";

export type RestingManagerDeps = {
  config: BotConfig; // shared mutable ref — do not copy
  trader: Trader;
  tracker: TradeTracker;
  scanner: MarketScanner;
  lifecycle: LiveOrderLifecycle;
};

export class RestingManager {
  private strategy: TradingStrategy;

  constructor(
    private readonly deps: RestingManagerDeps,
    strategy: TradingStrategy,
  ) {
    this.strategy = strategy;
  }

  setStrategy(strategy: TradingStrategy): void {
    this.strategy = strategy;
  }

  /** Exact branch order from bot processEvent — DO NOT reorder */
  async manageLiveResting(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    if (this.strategy.leadsWithEdge) {
      await this.manageRestingEdgeLead(event, books);
      await this.replaceMarketableCheap(event, books);
      await this.sellExpensiveEdgeIfNeeded(event, books);
      // A custom chart-rules strategy with leadsWithEdge may define a
      // "sell cheap" zone. Native edge-lead returns false from shouldDefend,
      // so this is a no-op for the native engine. Custom strategies get
      // their cheap sells evaluated.
      await this.defendUncoveredPairs(event, books);
    } else {
      await this.replaceMarketableCheap(event, books);
      await this.defendUncoveredPairs(event, books);
    }
  }

  /**
   * Manage resting cheap GTC via TradingStrategy.cheapOrderAction:
   *  - take-ask: reprice when the ask is at/below our limit
   *  - cancel-lock: arb = favorite off-band or bid above lock − hedge;
   *    barbell = favorite off-band only;
   *    edge-lead = cheap ask left [edgeCheapBandMin, edgeCheapBandMax]
   * After cancel+unmark, this tick's findOpportunities can post a new bid
   * (edge-lead: only if the ask is back in the cheap band).
   */
  async replaceMarketableCheap(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const cheapOrders = this.deps.tracker.getPostedOrdersForPair(pairId, "cheap");
    for (const order of cheapOrders) {
      const book =
        books.find((candidate) => candidate.tokenId === order.tokenId) ??
        books.find((candidate) => candidate.outcome === order.outcome);
      const favoriteBook =
        books.find((candidate) => candidate.outcome !== order.outcome) ?? null;
      const action = this.strategy.cheapOrderAction({
        config: this.deps.config,
        limitPrice: order.limitPrice,
        cheapBook: book,
        favoriteAsk: favoriteBook?.bestAsk ?? null,
        pairId,
        tracker: this.deps.tracker,
        nowMs: Date.now(),
      });
      if (action === "keep") {
        continue;
      }
      if (order.orderId) {
        const tracked = { ...order, orderId: order.orderId };
        const status = await this.deps.lifecycle.getOrderStatusTracked(tracked);
        if (!status) continue;
        // Fully matched or already cancelled by the exchange: record the
        // fill (if any) and leave it to pollOrderFills — nothing to cancel.
        if (status.filled || status.cancelled) {
          if (status.sizeMatched > 0) {
            await this.deps.lifecycle.finalizeLiveOrder(tracked, status);
          }
          continue;
        }
        // Still live (possibly partially matched): cancel FIRST, then read
        // the final matched size. Finalizing a partial fill while the rest
        // of the order rests on the book would orphan the remainder on the
        // exchange (untracked exposure, later fills never recorded).
        try {
          await this.deps.trader.cancelOrder(tracked.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Cheap cancel failed, will retry", {
            orderId: tracked.orderId,
            error: message,
          });
          continue;
        }
        const finalStatus = await this.deps.lifecycle.getOrderStatusTracked(tracked);
        const sizeMatched = finalStatus?.sizeMatched ?? status.sizeMatched;
        if (sizeMatched > 0) {
          const outcome = await this.deps.lifecycle.finalizeLiveOrder(tracked, {
            ...status,
            cancelled: true,
            sizeMatched,
          });
          if (outcome === "created" || outcome === "pending") {
            log("Cheap partially filled before cancel — fill recorded, remainder cancelled", {
              orderId: tracked.orderId,
              sizeMatched,
              outcome,
            });
            continue;
          }
        }
      }
      this.deps.lifecycle.emitOrderCancelled(order);
      this.deps.tracker.removePostedOrder(order.key);
      this.deps.tracker.unmark(order.key);
      // Same orphan policy as live-order-lifecycle (stale/cancel paths): when
      // the last unfilled cheap vanishes, drop independent-grid / arb hedges.
      await this.deps.lifecycle.cancelOrphanHedgesIfNeeded(order);
      if (action === "cancel-lock") {
        const cancelWhy =
          this.strategy.id === "arb"
            ? "Cheap cancelled - pair lock no longer achievable"
            : this.strategy.id === "edge-lead"
              ? "Edge-lead cheap cancelled - ask left the cheap band"
              : this.strategy.id === "reverse"
                ? "Reverse cheap cancelled - ask left the cheap band"
                : this.strategy.id.startsWith("custom:")
                  ? "Custom cheap cancelled - out of band"
                  : "Cheap cancelled - favorite left the hedge band";
        log(cancelWhy, {
          market: event.title,
          outcome: order.outcome,
          limitPrice: order.limitPrice,
          favoriteAsk: favoriteBook?.bestAsk ?? null,
          cheapAsk: book?.bestAsk ?? null,
          pairLockMax: this.deps.config.pairLockMax,
          strategyId: this.strategy.id,
        },
        );
      } else {
        log("Cheap repriced - taking ask at or below limit", {
          market: event.title,
          outcome: order.outcome,
          limitPrice: order.limitPrice,
          bestAsk: book?.bestAsk ?? null,
          bestBid: book?.bestBid ?? null,
        });
      }
    }
  }

  /**
   * Edge-lead : gère le GTC edge resting. Quand l'ask du token edge claimé
   * sort de la bande [edgeBandMin, edgeBandMax], on annule le GTC edge non
   * fillé (unmark), on garde les fills. Le GTC cheap resting est géré à
   * part (replaceMarketableCheap / cheapOrderAction) : cancel si l'ask
   * cheap sort de sa bande, re-post au tick suivant s'il rentre. Pas de
   * FOK SELL : on n'invente pas la vente du favori nu.
   */
  async manageRestingEdgeLead(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const edgeOrders = this.deps.tracker.getPostedOrdersForPair(pairId, "expensive");
    if (edgeOrders.length === 0) return;

    const edgeBook =
      books.find((book) => book.outcome === edgeOrders[0].outcome) ??
      books.find((book) => book.tokenId === edgeOrders[0].tokenId);
    const edgeAsk = edgeBook?.bestAsk ?? null;

    const action = this.strategy.edgeOrderAction({
      config: this.deps.config,
      edgeBook,
      pairId,
      tracker: this.deps.tracker,
    });
    if (action !== "cancel-lock") return;

    for (const order of edgeOrders) {
      if (order.orderId) {
        const tracked = { ...order, orderId: order.orderId };
        const status = await this.deps.lifecycle.getOrderStatusTracked(tracked);
        if (!status) continue;
        if (status.filled || status.cancelled) {
          if (status.sizeMatched > 0) {
            await this.deps.lifecycle.finalizeLiveOrder(tracked, status);
          }
          continue;
        }
        try {
          await this.deps.trader.cancelOrder(tracked.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Edge-lead cancel failed, will retry", {
            orderId: tracked.orderId,
            error: message,
          });
          continue;
        }
        const finalStatus = await this.deps.lifecycle.getOrderStatusTracked(tracked);
        const sizeMatched = finalStatus?.sizeMatched ?? status.sizeMatched;
        if (sizeMatched > 0) {
          await this.deps.lifecycle.finalizeLiveOrder(tracked, {
            ...status,
            cancelled: true,
            sizeMatched,
          });
          continue;
        }
      }
      this.deps.lifecycle.emitOrderCancelled(order);
      this.deps.tracker.removePostedOrder(order.key);
      this.deps.tracker.unmark(order.key);
      log("Edge-lead order cancelled - edge left the band", {
        market: event.title,
        outcome: order.outcome,
        kind: order.kind,
        limitPrice: order.limitPrice,
        edgeAsk,
        strategyId: this.strategy.id,
      });
    }
  }

  /**
   * Pair defense trigger: sell cheap shares the strategy names when the
   * favorite ask is above expensiveBuyMax and the pair is not covered
   * (1:1 for arb, ratio for barbell). Ask below min does not dump the cheap.
   */
  async defendUncoveredPairs(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    // Native arb/barbell need the hedge flag to defend. A custom chart-rules
    // strategy with leadsWithEdge may define a "sell cheap" zone that is
    // independent of the hedge setting — don't block it here. Strategies with
    // usesDefendAsExit (dip-revert take-profit) reuse this pipeline as their
    // EXIT hook without any hedge; shouldDefend gates the trigger itself.
    if (
      !this.deps.config.enableExpensiveHedge &&
      !this.strategy.id.startsWith("custom:") &&
      this.strategy.usesDefendAsExit !== true
    )
      return;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const filledCheap = this.deps.tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheap <= 0) return;

    const cheapTokenId = this.deps.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) return;
    const favoriteBook =
      books.find((book) => book.tokenId !== cheapTokenId) ?? null;
    if (!favoriteBook || favoriteBook.bestAsk === null) {
      return;
    }

    const favoriteAsk = favoriteBook.bestAsk;
    const filledExpensive = this.deps.tracker.getFilledExpensiveSizeForPair(pairId);
    const cheapBook =
      books.find((book) => book.tokenId === cheapTokenId) ?? undefined;
    const defendCtx = {
      config: this.deps.config,
      favoriteAsk,
      filledCheap,
      filledExpensive,
      pairId,
      cheapAsk: cheapBook?.bestAsk ?? null,
      tracker: this.deps.tracker,
    };
    if (!this.strategy.shouldDefend(defendCtx)) {
      return;
    }
    // Remainder under the CLOB minimum cannot be sold. Silent hold — logging
    // here would repeat every tick while the favorite stays above max.
    if (this.strategy.defendShares(defendCtx) < MIN_CLOB_SHARES) {
      return;
    }

    // Tick-path defense = strategy.shouldDefend (arb: ask > expensiveBuyMax + uncovered).
    // Policy A (pair-lock-unreachable → FOK SELL) is handled in hedgeAtPostTime / orchestrate, not here.
    log("Pair uncovered - defending (favorite ask above max)", {
      market: event.title,
      pairId,
      favoriteAsk,
      expensiveBuyMax: this.deps.config.expensiveBuyMax,
      strategyId: this.strategy.id,
    });
    await this.defendPair(pairId);
  }

  /**
   * Edge-lead : vendre l'edge (favori nu) quand aucun cheap n'est fillé
   * après un délai et que l'edge est en perte soutenue. La politique vit
   * dans TradingStrategy.shouldSellExpensiveEdge ; ici on exécute le FOK
   * SELL au best bid et on marque la jambe expensive comme vendue.
   */
  async sellExpensiveEdgeIfNeeded(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const expensiveTokenId = this.deps.tracker.getExpensiveTokenForPair(pairId);
    if (!expensiveTokenId) return;
    const expensiveFillPrice = this.deps.tracker.getExpensiveFillPriceForPair(pairId);
    if (expensiveFillPrice === null) return;
    const expensiveSize = this.deps.tracker.getFilledExpensiveSizeForPair(pairId);
    if (expensiveSize <= 0) return;
    const cheapFilled = this.deps.tracker.getFilledCheapSizeForPair(pairId);

    const expensiveBook =
      books.find((book) => book.tokenId === expensiveTokenId) ??
      books.find((book) => book.outcome === this.deps.tracker.getOpenPositions().find(
        (p) => p.pairId === pairId && p.kind === "expensive",
      )?.outcome) ??
      null;
    const expensiveBid = expensiveBook?.bestBid ?? null;

    const nowSec = Date.now() / 1000;
    const marketAgeMs = Math.max(0, (nowSec - event.windowStart) * 1000);

    if (
      !this.strategy.shouldSellExpensiveEdge({
        config: this.deps.config,
        tracker: this.deps.tracker,
        pairId,
        expensiveBid,
        expensiveFillPrice,
        expensiveSize,
        cheapFilled,
        marketAgeMs,
        nowMs: Date.now(),
      })
    ) {
      return;
    }

    if (expensiveBid === null || expensiveBid <= 0) {
      log("Edge-lead sell skipped - no bid to sell the edge into", {
        market: event.title,
        pairId,
        expensiveTokenId,
      });
      return;
    }

    const pair = this.deps.tracker.getPair(pairId);
    const sellOpportunity: TradeOpportunity = {
      kind: "expensive",
      event: {
        title: pair?.eventTitle ?? event.title,
        slug: pair?.eventSlug ?? event.slug,
        market: {} as never,
        windowStart: 0,
        windowEnd: pair?.windowEnd ?? event.windowEnd,
      },
      token: {
        tokenId: expensiveTokenId,
        outcome: expensiveBook?.outcome ?? "",
        outcomeIndex: expensiveBook?.outcomeIndex ?? 0,
        bestBid: expensiveBid,
        bestAsk: expensiveBook?.bestAsk ?? null,
        bestAskSize: expensiveBook?.bestAskSize ?? null,
        bestBidSize: expensiveBook?.bestBidSize ?? null,
        bid2: expensiveBook?.bid2 ?? null,
        bid2Size: expensiveBook?.bid2Size ?? null,
        bid3: expensiveBook?.bid3 ?? null,
        bid3Size: expensiveBook?.bid3Size ?? null,
      },
      price: expensiveBid,
      size: expensiveSize,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: `edge-sell:${pairId}`,
      pairId,
    };

    try {
      const result = await this.deps.trader.placeSell(sellOpportunity);
      if (result.filled && (result.filledSize ?? 0) > 0) {
        const fillPrice = result.fillPrice ?? expensiveBid;
        const soldSize = Math.min(result.filledSize ?? expensiveSize, expensiveSize);
        this.deps.tracker.closePairExpensiveAsSold(pairId, fillPrice, soldSize);
        this.strategy.onSellExpensiveCommitted?.(pairId);
        log("Edge-lead: expensive sold via FOK SELL (naked favorite)", {
          market: event.title,
          pairId,
          expensiveTokenId,
          fillPrice,
          soldSize,
          expensiveFillPrice,
          cheapFilled,
        });
        bus.emit({ type: "order", result, opportunity: sellOpportunity });
        await this.deps.lifecycle.cancelRestingHedgesForPair(pairId, "edge sold by edge-lead");
      } else if (result.reason === "sell-unconfirmed") {
        log("Edge-lead: SELL unconfirmed — not treating edge as sold", {
          market: event.title,
          pairId,
          expensiveTokenId,
          bestBid: expensiveBid,
        });
      } else {
        log("Edge-lead: FOK SELL killed — holding edge as directional", {
          market: event.title,
          pairId,
          expensiveTokenId,
          bestBid: expensiveBid,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Edge-lead: SELL failed — holding edge as directional", {
        market: event.title,
        pairId,
        expensiveTokenId,
        error: message,
      });
    }
  }

  /**
   * Pair defense (S2.4): when the favorite ask is above expensiveBuyMax,
   * sell the cheap at the current best bid (FOK) instead of holding it
   * naked to resolution. A CLOB "killed" response is confirmed against
   * token balance before we treat the cheap as still held.
   */
  async defendPair(pairId: string): Promise<void> {
    const cheapTokenId = this.deps.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) {
      log("defendPair: no cheap token found for pair", { pairId });
      return;
    }
    const filledCheapSize = this.deps.tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheapSize <= 0) {
      log("defendPair: no filled cheap to defend", { pairId });
      return;
    }
    const filledExpensiveSize = this.deps.tracker.getFilledExpensiveSizeForPair(pairId);
    const freshBook = await this.deps.scanner.getTokenBook(cheapTokenId);
    const uncoveredSize = this.strategy.defendShares({
      config: this.deps.config,
      favoriteAsk: null,
      filledCheap: filledCheapSize,
      filledExpensive: filledExpensiveSize,
      pairId,
      cheapAsk: freshBook?.bestAsk ?? null,
      tracker: this.deps.tracker,
    });
    if (uncoveredSize <= 0) {
      log("defendPair: pair already covered for this engine — holding both legs", {
        pairId,
        filledCheapSize,
        filledExpensiveSize,
        strategyId: this.strategy.id,
      });
      return;
    }
    if (uncoveredSize < MIN_CLOB_SHARES) {
      log("defendPair: uncovered excess below CLOB minimum — holding", {
        pairId,
        filledCheapSize,
        filledExpensiveSize,
        uncoveredSize,
        strategyId: this.strategy.id,
      });
      return;
    }

    // Current cheap book for bid + chart sell-cheap bands.
    const bestBid = freshBook?.bestBid ?? null;
    if (bestBid === null || bestBid <= 0) {
      log("defendPair: no bid to sell into — holding cheap as directional", {
        pairId,
        cheapTokenId,
        filledCheapSize,
      });
      return;
    }

    // Build a synthetic sell opportunity for the cheap token.
    const pair = this.deps.tracker.getPair(pairId);
    const sellOpportunity: TradeOpportunity = {
      kind: "cheap",
      event: {
        title: pair?.eventTitle ?? "unknown",
        slug: pair?.eventSlug ?? "unknown",
        market: {} as never,
        windowStart: 0,
        windowEnd: pair?.windowEnd ?? 0,
      },
      token: {
        tokenId: cheapTokenId,
        outcome: "",
        outcomeIndex: 0,
        bestBid,
        bestAsk: freshBook?.bestAsk ?? null,
        bestAskSize: freshBook?.bestAskSize ?? null,
        bestBidSize: freshBook?.bestBidSize ?? null,
        bid2: freshBook?.bid2 ?? null,
        bid2Size: freshBook?.bid2Size ?? null,
        bid3: freshBook?.bid3 ?? null,
        bid3Size: freshBook?.bid3Size ?? null,
      },
      price: bestBid,
      size: uncoveredSize,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: `defend:${pairId}`,
      pairId,
    };

    try {
      const result = await this.deps.trader.placeSell(sellOpportunity);
      if (result.filled && (result.filledSize ?? 0) > 0) {
        const fillPrice = result.fillPrice ?? bestBid;
        const soldSize = Math.min(result.filledSize ?? uncoveredSize, filledCheapSize);
        // Update the tracker FIRST so the sold legs leave openPositions
        // before any new opportunity is generated (exposure, hedge guards).
        this.deps.tracker.closePairCheapAsSold(pairId, fillPrice, soldSize);
        this.strategy.onDefendCommitted?.(pairId);
        this.deps.lifecycle.clearCheapMissing(pairId);
        log("defendPair: cheap sold via FOK SELL", {
          pairId,
          cheapTokenId,
          fillPrice,
          filledSize: soldSize,
          uncoveredSize,
        });
        bus.emit({ type: "order", result, opportunity: sellOpportunity });
        // After defense, no further hedge is wanted (arb: cheap covered;
        // barbell: leftover is an intentional bet). A resting GTC would
        // buy a favorite already outside the band.
        await this.deps.lifecycle.cancelRestingHedgesForPair(pairId, "cheap sold by pair defense");
      } else if (result.reason === "sell-unconfirmed") {
        log("defendPair: SELL unconfirmed — not treating cheap as held for hedge", {
          pairId,
          cheapTokenId,
          bestBid,
          filledCheapSize,
        });
      } else {
        log("defendPair: FOK SELL killed — holding cheap as directional", {
          pairId,
          cheapTokenId,
          bestBid,
          filledCheapSize,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("defendPair: SELL failed — holding cheap as directional", {
        pairId,
        cheapTokenId,
        error: message,
      });
    }
  }

  /**
   * Fermeture manuelle d'une position ouverte (dashboard) : FOK SELL au best bid.
   */
  async closePositionManual(positionId: string): Promise<
    | { ok: true; fillPrice: number; soldSize: number; pnl?: number }
    | { ok: false; error: string }
  > {
    const position = this.deps.tracker
      .getOpenPositions()
      .find((p) => p.id === positionId && p.status === "open");
    if (!position) {
      return { ok: false, error: "Position introuvable ou déjà fermée" };
    }
    if (position.size < MIN_CLOB_SHARES) {
      return {
        ok: false,
        error: `Taille ${position.size} sous le minimum CLOB (${MIN_CLOB_SHARES})`,
      };
    }
    const freshBook = await this.deps.scanner.getTokenBook(position.tokenId);
    const bestBid = freshBook?.bestBid ?? null;
    if (bestBid === null || bestBid <= 0) {
      return { ok: false, error: "Pas de bid pour vendre (carnet vide)" };
    }
    // Wallet-truth sync: the CLOB validates the signer's balance BEFORE a
    // SELL posts (order amount vs balance). If a previous sell actually
    // filled on the exchange but the bot booked it as killed (250 ms taker
    // delay / balance-cache lag), the position is phantom: the wallet no
    // longer holds the shares and every later close attempt is rejected
    // with "not enough balance / allowance". Detect it here and reconcile
    // instead of posting an order that is guaranteed to be rejected.
    const held = await this.deps.trader.getConditionalTokenBalance(position.tokenId);
    if (held !== null && held < position.size) {
      // The wallet holds fewer shares than the open position. The gap is a
      // phantom remainder: a previous sell filled on the exchange but was
      // booked as killed (taker delay / balance-cache lag), or the FOK
      // rounded 7.12857 down to 7.12 leaving CLOB-minimum dust. Closing only
      // `held` would leave a dust remainder below MIN_CLOB_SHARES that the
      // CLOB refuses to sell — the row would be stuck open forever. Resolve
      // the whole position at the best bid (best-effort price for the part
      // actually sold) so the dashboard never keeps an unclosable row.
      log("closePositionManual: wallet holds fewer shares than the open position — reconciling", {
        positionId,
        tokenId: position.tokenId,
        held,
        positionSize: position.size,
        action: held < MIN_CLOB_SHARES ? "mark-sold (phantom)" : "reconcile (phantom remainder)",
      });
      this.deps.tracker.closePositionAsSold(positionId, bestBid, position.size);
      await this.deps.lifecycle.cancelRestingHedgesForPair(
        position.pairId,
        "manual close (reconciled)",
      );
      return { ok: true, fillPrice: bestBid, soldSize: position.size };
    }
    // Early depth guard: placeSell walks down at most 3 bid ticks. If the
    // visible 3-level depth cannot cover the position, the FOK would be
    // killed by the CLOB — fail with a clear message instead of a terse
    // killed-fok-sell.
    const depth3 =
      (freshBook?.bestBidSize ?? 0) +
      (freshBook?.bid2Size ?? 0) +
      (freshBook?.bid3Size ?? 0);
    if (depth3 > 0 && depth3 < position.size) {
      const depthShown = Math.round(depth3 * 100) / 100;
      const sizeShown = Math.round(position.size * 100) / 100;
      return {
        ok: false,
        error: `Profondeur au bid insuffisante (${depthShown} shares, position ${sizeShown})`,
      };
    }
    const pair = this.deps.tracker.getPair(position.pairId);
    const sellOpportunity: TradeOpportunity = {
      kind: position.kind,
      event: {
        title: pair?.eventTitle ?? position.eventTitle,
        slug: pair?.eventSlug ?? position.eventSlug,
        market: {} as never,
        windowStart: 0,
        windowEnd: pair?.windowEnd ?? position.windowEnd,
      },
      token: {
        tokenId: position.tokenId,
        outcome: position.outcome,
        outcomeIndex: position.outcomeIndex,
        bestBid,
        bestAsk: freshBook?.bestAsk ?? null,
        bestAskSize: freshBook?.bestAskSize ?? null,
        bestBidSize: freshBook?.bestBidSize ?? null,
        bid2: freshBook?.bid2 ?? null,
        bid2Size: freshBook?.bid2Size ?? null,
        bid3: freshBook?.bid3 ?? null,
        bid3Size: freshBook?.bid3Size ?? null,
      },
      price: bestBid,
      size: position.size,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: `manual-close:${positionId}`,
      pairId: position.pairId,
    };
    try {
      const result = await this.deps.trader.placeSell(sellOpportunity);
      if (result.filled && (result.filledSize ?? 0) > 0) {
        const fillPrice = result.fillPrice ?? bestBid;
        const soldSize = Math.min(result.filledSize ?? position.size, position.size);
        this.deps.tracker.closePositionAsSold(positionId, fillPrice, soldSize);
        await this.deps.lifecycle.cancelRestingHedgesForPair(
          position.pairId,
          "manual close",
        );
        log("closePositionManual: sold via FOK SELL", {
          positionId,
          tokenId: position.tokenId,
          fillPrice,
          soldSize,
        });
        bus.emit({ type: "order", result, opportunity: sellOpportunity });
        const closed = this.deps.tracker
          .getResolvedPositions()
          .find((p) => p.id === positionId || p.id.startsWith(positionId + ":sold-"));
        return {
          ok: true,
          fillPrice,
          soldSize,
          pnl: closed?.pnl,
        };
      }
      if (result.reason === "sell-unconfirmed") {
        return {
          ok: false,
          error: "SELL non confirmé — position laissée ouverte",
        };
      }
      return {
        ok: false,
        error: result.reason
          ? `FOK SELL échoué (${result.reason})`
          : "FOK SELL tué — position laissée ouverte",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("closePositionManual: SELL failed", { positionId, error: message });
      return { ok: false, error: message };
    }
  }

}
