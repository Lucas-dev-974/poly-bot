import type { BotConfig } from "./config.js";
import { toPublicConfig } from "./config.js";
import { bus } from "./dashboard/events.js";
import type { Repositories } from "./db/index.js";
import { log } from "./logger.js";
import { MarketScanner } from "./market-scanner.js";
import { PositionResolver } from "./position-resolver.js";
import type { EditableConfigKey } from "./runtime-settings.js";
import { SimulatedBroker } from "./simulated-broker.js";
import { SimulatedLedger } from "./simulated-ledger.js";
import { findOpportunities, shouldReplaceRestingCheap } from "./strategy.js";
import { TradeTracker, type PostedOrderContext } from "./trade-tracker.js";
import { Trader } from "./trader.js";
import type { OrderResult, TokenBook, TradeOpportunity, UpDownEvent, SimulatedPosition } from "./types.js";
import { formatReturnPct } from "./utils/prices.js";

const TOTAL_ATTEMPTS_KEY = "totalAttempts";
const PAUSED_KEY = "botPaused";

export class ReverseBot {
  private readonly scanner: MarketScanner;
  readonly tracker: TradeTracker;
  private readonly ledger: SimulatedLedger | null;
  private readonly broker: SimulatedBroker | null;
  private readonly resolver: PositionResolver | null;
  private totalAttempts = 0;
  private paused = false;
  private ticking = false;
  private consecutiveBalanceRejections = 0;
  private balanceBackoffUntil = 0;
  private cachedBalance: number | null = null;
  private cachedBalanceAt = 0;
  private lastStatsSnapshotAt = 0;
  private readonly orderStatusFailures = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly BALANCE_CACHE_MS = 30_000;
  private static readonly ORDER_STATUS_MAX_FAILURES = 10;
  private static readonly STATS_SNAPSHOT_MS = 60_000;

  constructor(
    private readonly config: BotConfig,
    private readonly trader: Trader,
    private readonly repos?: Repositories,
  ) {
    this.tracker = new TradeTracker(
      repos?.positions,
      repos?.pairs,
      repos?.keys,
      repos?.retries,
      repos?.windowClaims,
      repos?.postedOrders,
    );
    this.scanner = new MarketScanner(config);
    this.ledger = config.dryRun
      ? new SimulatedLedger(config.simulatedCapital, repos?.ledger)
      : null;
    this.broker = this.ledger ? new SimulatedBroker(config, this.ledger) : null;
    this.resolver = new PositionResolver(config, this.tracker, this.ledger);
  }

  async init(): Promise<void> {
    this.tracker.loadFromDb();
    this.totalAttempts = this.repos?.botState.get(TOTAL_ATTEMPTS_KEY) ?? 0;
    this.paused = (this.repos?.botState.get(PAUSED_KEY) ?? 0) === 1;
    await this.trader.init();
  }

  reset(): void {
    this.tracker.reset();
    this.totalAttempts = 0;
    this.paused = false;
    this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, 0);
    this.repos?.botState.set(PAUSED_KEY, 0);
    bus.emit({ type: "botControl", enabled: true });
    if (this.ledger) {
      this.ledger.reset(this.config.simulatedCapital);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.repos?.botState.set(PAUSED_KEY, paused ? 1 : 0);
    bus.emit({ type: "botControl", enabled: !paused });
    log(paused ? "Bot paused via dashboard switch" : "Bot resumed via dashboard switch");
  }

  isPaused(): boolean {
    return this.paused;
  }

  async run(): Promise<void> {
    log("Reverse bot starting", {
      strategy: "buy cheap reversal tokens on 15m BTC/ETH markets",
      cheapRange: `${this.config.cheapBuyMin}-${this.config.cheapBuyMax}`,
      expensiveHedge: this.config.enableExpensiveHedge
        ? `${this.config.expensiveBuyMin}-${this.config.expensiveBuyMax}`
        : "disabled",
      markets: this.config.marketSlugPrefixes,
      dryRun: this.config.dryRun,
      pollMs: this.config.pollIntervalMs,
      resolveFallback: this.config.simResolveFallback,
    });
    bus.emit({ type: "config", config: toPublicConfig(this.config) });
    bus.emit({ type: "botControl", enabled: !this.paused });

    await this.tick();
    this.scheduleTick();

    if (this.resolver) {
      setInterval(() => void this.resolver?.resolveDue(), 5_000);
    }
    setInterval(() => this.emitStats(), 5_000);

    this.pruneData();
    setInterval(() => this.pruneData(), 3600_000); // 1h
  }

  private scheduleTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => void this.tick(), this.config.pollIntervalMs);
  }

  onRuntimeSettingsChanged(changed: Set<EditableConfigKey>): void {
    if (changed.has("pollIntervalMs")) {
      this.scheduleTick();
    }
    if (changed.has("simRandomSeed")) {
      this.broker?.reseed(this.config.simRandomSeed);
      this.resolver?.reseed(this.config.simRandomSeed);
    }
    bus.emit({ type: "config", config: toPublicConfig(this.config) });
    log("Runtime settings updated", { changed: [...changed] });
  }

  private pruneData(): void {
    const now = Date.now();
    this.repos?.events.prune(now - 7 * 24 * 3600_000);
    this.repos?.balanceSnapshots.prune(now - 30 * 24 * 3600_000);
    this.repos?.statsSnapshots.prune(now - 30 * 24 * 3600_000);
    this.repos?.keys.prune(now - 24 * 3600_000);
    this.repos?.retries.prune(now - 24 * 3600_000);
    this.repos?.orders.prune(now - 7 * 24 * 3600_000);
    this.repos?.redeems.prune(now - 30 * 24 * 3600_000);
    this.repos?.marketSnapshots.prune(now - this.config.marketSnapshotRetentionMs);
    this.repos?.bookSnapshots.prune(now - this.config.bookSnapshotRetentionMs);
    this.repos?.opportunitySnapshots.prune(now - this.config.opportunitySnapshotRetentionMs);
    this.tracker.pruneMemory(now - 24 * 3600_000);
  }

  private emitStats(): void {
    const stats = this.computeStats();
    const statsType = this.config.dryRun ? "simulatedStats" : "stats";
    bus.emit({ type: statsType, stats });
    const now = Date.now();
    if (now - this.lastStatsSnapshotAt >= ReverseBot.STATS_SNAPSHOT_MS) {
      this.repos?.statsSnapshots.insert(stats);
      this.lastStatsSnapshotAt = now;
    }
    if (this.ledger) {
      const availableCollateral = this.ledger.getBalance();
      const positionsValue = this.tracker.getOpenExposure();
      const totalValue = availableCollateral + positionsValue;
      this.repos?.balanceSnapshots.insert({
        availableCollateral,
        positionsValue,
        totalValue,
        source: "simulated",
      });
      bus.emit({ type: "balance", balance: { availableCollateral, positionsValue, totalValue } });
    }
  }

  private computeStats() {
    const openPositions = this.tracker.getOpenPositions();
    const wins = this.tracker.getCumulativeWins();
    const losses = this.tracker.getCumulativeLosses();
    const resolved = wins + losses;
    const totalAttempted = this.totalAttempts;
    const totalFilled = resolved + openPositions.length;
    const coveredCount = this.tracker.getCoveredCount();
    const uncoveredCount = this.tracker.getUncoveredCount();
    const resolvedPairs = coveredCount + uncoveredCount;

    return {
      realizedPnl: this.tracker.getRealizedPnl(),
      arbRealizedPnl: this.tracker.getArbRealizedPnl(),
      directionalRealizedPnl: this.tracker.getDirectionalRealizedPnl(),
      openExposure: this.tracker.getOpenExposure(),
      coveredExposure: this.tracker.getCoveredExposure(),
      uncoveredExposure: this.tracker.getUncoveredExposure(),
      openPositionsCount: openPositions.length,
      resolvedPositionsCount: this.tracker.getCumulativeResolvedCount(),
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : 0,
      fillRate: totalAttempted > 0 ? totalFilled / totalAttempted : 0,
      totalAttempted,
      totalFilled,
      coveredCount,
      uncoveredCount,
      coverRate: resolvedPairs > 0 ? coveredCount / resolvedPairs : 0,
    };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowSeconds = Date.now() / 1000;
      this.tracker.prunePostedOrders(nowSeconds);
      this.tracker.pruneWindowClaims(nowSeconds);
      if (!this.config.dryRun) {
        await this.cancelStaleOrders(nowSeconds);
        await this.pollOrderFills();
      }
      if (this.paused) {
        return;
      }
      const events = await this.scanner.scan();
      const tickTs = Date.now();
      for (const event of events) {
        this.repos?.marketSnapshots.insert({
          ts: tickTs,
          eventSlug: event.slug,
          eventTitle: event.title,
          conditionId: event.market.conditionId,
          windowStart: event.windowStart,
          windowEnd: event.windowEnd,
        });
      }
      bus.emit({
        type: "scan",
        count: events.length,
        slugs: events.map((event) => event.slug),
      });
      if (events.length === 0) {
        log("No active markets in window");
        return;
      }

      for (const event of events) {
        await this.processEvent(event, tickTs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Scan error", { error: message });
      bus.emit({ type: "error", message });
    } finally {
      this.ticking = false;
    }
  }

  private async cancelStaleOrders(nowSeconds: number): Promise<void> {
    const stale = this.tracker.getStalePostedOrders(nowSeconds);
    for (const order of stale) {
      if (!order.orderId) {
        this.emitOrderCancelled(order);
        this.tracker.removePostedOrder(order.key);
        await this.cancelOrphanHedgesIfNeeded(order);
        continue;
      }
      const tracked = { ...order, orderId: order.orderId };
      const status = await this.getOrderStatusTracked(tracked);
      if (!status) continue;
      try {
        await this.trader.cancelOrder(tracked.orderId);
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
        this.finalizeLiveOrder(tracked, {
          ...status,
          sizeMatched,
        });
      } else {
        this.emitOrderCancelled(order);
        this.tracker.removePostedOrder(order.key);
        await this.cancelOrphanHedgesIfNeeded(order);
      }
    }
  }

  private async pollOrderFills(): Promise<void> {
    const orders = this.tracker.getPostedOrdersWithOrderId();
    for (const order of orders) {
      const status = await this.getOrderStatusTracked(order);
      if (!status) continue;
      if (status.filled || status.cancelled) {
        if (status.sizeMatched > 0) {
          this.finalizeLiveOrder(order, status);
        } else {
          this.emitOrderCancelled(order);
          this.tracker.removePostedOrder(order.key);
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

  private async getOrderStatusTracked(
    order: { key: string; orderId: string } & PostedOrderContext,
  ): Promise<{ filled: boolean; cancelled: boolean; sizeMatched: number } | null> {
    try {
      const status = await this.trader.getOrderStatus(order.orderId);
      this.orderStatusFailures.delete(order.orderId);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = (this.orderStatusFailures.get(order.orderId) ?? 0) + 1;
      this.orderStatusFailures.set(order.orderId, next);
      const missing = /404|not found/i.test(message);
      if (missing || next >= ReverseBot.ORDER_STATUS_MAX_FAILURES) {
        log("Live order abandoned after status poll failures", {
          orderId: order.orderId,
          error: message,
          failures: next,
        });
        this.emitOrderCancelled(order);
        this.tracker.removePostedOrder(order.key);
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

  private async cancelOrphanHedgesIfNeeded(
    order: { key: string; pairId: string; kind: "cheap" | "expensive" } & PostedOrderContext,
  ): Promise<void> {
    if (order.kind !== "cheap") return;
    if (this.tracker.getFilledCheapSizeForPair(order.pairId) > 0) return;
    const hedges = this.tracker.getPostedOrdersForPair(order.pairId, "expensive");
    for (const hedge of hedges) {
      if (hedge.orderId) {
        try {
          await this.trader.cancelOrder(hedge.orderId);
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
      this.tracker.removePostedOrder(hedge.key);
      log("Hedge cancelled - cheap leg vanished", {
        pairId: order.pairId,
        orderId: hedge.orderId,
      });
    }
  }

  /**
   * Type d'ordre qui serait utilisé pour cette opportunity :
   * cheap = toujours GTC ; expensive = FOK ou GTC selon config.
   * Centralise la logique pour les paths de skip/rejet qui émettent un event
   * order avant le dispatch réel (useFOK est calculé plus tard).
   */
  private orderTypeFor(opportunity: TradeOpportunity): "GTC" | "FOK" {
    return opportunity.kind === "expensive" &&
      this.config.expensiveOrderType === "FOK"
      ? "FOK"
      : "GTC";
  }

  /**
   * Notifie le dashboard qu'un ordre resting a été annulé (fenêtre expirée
   * ou cancel du exchange) sans avoir été rempli. Sans cet event, le
   * frontend garde l'ordre visuellement "en attente" indéfiniment.
   */
  private emitOrderCancelled(
    order: { key: string; orderId?: string } & PostedOrderContext,
  ): void {
    bus.emit({
      type: "order",
      result: {
        dryRun: this.config.dryRun,
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
   * Finalise un ordre live : crée une position pour la portion remplie
   * (si sizeMatched > 0), puis supprime l'ordre du tracker.
   */
  private finalizeLiveOrder(
    order: { key: string; orderId: string } & PostedOrderContext,
    status: { filled: boolean; cancelled: boolean; sizeMatched: number },
  ): void {
    if (status.sizeMatched > 0) {
      this.createLivePosition(order, status.sizeMatched);
    }
    this.tracker.removePostedOrder(order.key);
  }

  private createLivePosition(
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
    };
    this.tracker.addOpenPosition(position);
    this.tracker.attachLeg(position);
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

  private async processEvent(event: UpDownEvent, tickTs: number): Promise<void> {
    const books = await this.scanner.getTokenBooks(event);
    for (const book of books) {
      this.repos?.bookSnapshots.insert({
        ts: tickTs,
        eventSlug: event.slug,
        tokenId: book.tokenId,
        outcome: book.outcome,
        outcomeIndex: book.outcomeIndex,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        bestAskSize: book.bestAskSize,
      });
    }
    if (!this.config.dryRun) {
      await this.replaceMarketableCheap(event, books);
    }
    const opportunities = findOpportunities(this.config, this.tracker, event, books);
    for (const opp of opportunities) {
      this.repos?.opportunitySnapshots.insert({
        ts: tickTs,
        eventSlug: event.slug,
        kind: opp.kind,
        tokenId: opp.token.tokenId,
        outcome: opp.token.outcome,
        price: opp.price,
        size: opp.size,
        executed: 0,
        pairId: opp.pairId,
      });
    }

    bus.emit({ type: "watching", event, books });

    if (opportunities.length === 0) {
      log("Watching market", {
        market: event.title,
        slug: event.slug,
        books: books.map((book) => ({
          outcome: book.outcome,
          bestAsk: book.bestAsk,
        })),
      });
      return;
    }

    // Cheap first. FOK hedge is only generated after a cheap fill (later ticks).
    opportunities.sort((a, b) =>
      a.kind === b.kind ? 0 : a.kind === "cheap" ? -1 : 1,
    );
    for (const opportunity of opportunities) {
      await this.executeOpportunity(opportunity);
    }
  }

  /**
   * A resting cheap GTC at $0.15 never matches if makers pull the ask to $0.13
   * without hitting our bid. Cancel it (do not touch the hedge) so this tick
   * can post a marketable cheap at min(target, ask).
   */
  private async replaceMarketableCheap(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const cheapOrders = this.tracker.getPostedOrdersForPair(pairId, "cheap");
    for (const order of cheapOrders) {
      const book =
        books.find((candidate) => candidate.tokenId === order.tokenId) ??
        books.find((candidate) => candidate.outcome === order.outcome);
      if (
        !book ||
        !shouldReplaceRestingCheap(
          order.limitPrice,
          book.bestAsk,
          book.bestBid,
          this.config.cheapBuyMin,
        )
      ) {
        continue;
      }
      if (order.orderId) {
        const tracked = { ...order, orderId: order.orderId };
        const status = await this.getOrderStatusTracked(tracked);
        if (!status) continue;
        // Already matched: record the fill. Repricing would drop the tokens
        // from the local tracker while they stay in the Polymarket wallet.
        if (status.filled || status.sizeMatched > 0) {
          this.finalizeLiveOrder(tracked, status);
          continue;
        }
        try {
          await this.trader.cancelOrder(tracked.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Cheap reprice cancel failed, will retry", {
            orderId: tracked.orderId,
            error: message,
          });
          continue;
        }
      }
      this.emitOrderCancelled(order);
      this.tracker.removePostedOrder(order.key);
      this.tracker.unmark(order.key);
      log("Cheap repriced - taking ask at or below limit", {
        market: event.title,
        outcome: order.outcome,
        limitPrice: order.limitPrice,
        bestAsk: book.bestAsk,
        bestBid: book.bestBid,
      });
    }
  }

  private async executeOpportunity(opportunity: TradeOpportunity): Promise<void> {
    log("Placing limit order", {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      size: opportunity.size,
      potentialReturn: formatReturnPct(opportunity.price),
    });

    // Garde-fou : ne pas acheter si la clôture du marché est dans moins de
    // X minutes (si minMinutesBeforeCloseToBuy est défini et non null).
    if (this.config.minMinutesBeforeCloseToBuy !== null) {
      const nowSec = Date.now() / 1000;
      const minutesLeft = (opportunity.event.windowEnd - nowSec) / 60;
      if (minutesLeft < this.config.minMinutesBeforeCloseToBuy) {
        bus.emit({ type: "order", result: {
          dryRun: this.config.dryRun, tokenId: opportunity.token.tokenId, side: "BUY",
          price: opportunity.price, size: opportunity.size, filled: false,
          reason: "too-close-to-close",
          orderType: this.orderTypeFor(opportunity),
        }, opportunity });
        log("Order skipped - too close to market close", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          minutesLeft: minutesLeft.toFixed(1),
          minRequired: this.config.minMinutesBeforeCloseToBuy,
        });
        return;
      }
    }

    if (Date.now() < this.balanceBackoffUntil) {
      log("Live order skipped - balance backoff active");
      return;
    }

    if (this.config.readonlyLive) {
      if (!this.tracker.has(opportunity.tradeKey)) {
        bus.emit({ type: "order", result: {
          dryRun: false, tokenId: opportunity.token.tokenId, side: "BUY",
          price: opportunity.price, size: opportunity.size, filled: false,
          reason: "readonly-live",
          orderType: this.orderTypeFor(opportunity),
        }, opportunity });
        this.tracker.mark(opportunity.tradeKey);
      }
      log("Order skipped - READONLY_LIVE mode (no trading)", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
      });
      return;
    }

    // Hedge must match a committed cheap leg. FOK fills immediately, so it
    // waits for a cheap fill — not a resting GTC that may never match.
    // GTC hedge may rest beside a posted cheap (same-tick cheap runs first).
    const cheapCommitted =
      opportunity.kind === "expensive" &&
      this.config.expensiveOrderType === "FOK"
        ? this.tracker.getFilledCheapSizeForPair(opportunity.pairId)
        : this.tracker.getCheapSizeForPair(opportunity.pairId);
    if (opportunity.kind === "expensive" && cheapCommitted === 0) {
      // Same-tick cheap was generated but skipped (balance/cap). Do not emit
      // an order event: that would insert a row every 5s until cheap posts.
      log("Hedge skipped - no committed cheap leg", {
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        pairId: opportunity.pairId,
      });
      return;
    }

    if (this.broker && this.ledger) {
      this.executeSimulated(opportunity);
      return;
    }

    const useFOK =
      opportunity.kind === "expensive" && this.config.expensiveOrderType === "FOK";
    const estimatedCost = Math.round(
      (useFOK
        ? Math.min(
            opportunity.token.bestAsk ?? opportunity.price,
            this.config.expensiveBuyMax,
          )
        : opportunity.price) *
        opportunity.size *
        100,
    ) / 100;

    // Garde-fou balance : ne pas poster si le solde CLOB disponible est
    // insuffisant pour couvrir le coût estimé. Le solde est caché 30s pour
    // éviter un appel réseau par opportunity (getAvailableCollateral est async).
    // En dry-run / client non initialisé → available reste null → on saute.
    const available = await this.getCachedAvailableCollateral();
    if (available !== null && estimatedCost > available) {
      this.rejectLiveWithRetry(opportunity, "insufficient-balance", {
        estimatedCost,
        available,
      });
      return;
    }

    if (
      this.config.enableExpensiveHedge &&
      opportunity.kind === "expensive" &&
      (opportunity.token.bestAsk === null ||
        opportunity.token.bestAsk < this.config.expensiveBuyMin ||
        opportunity.token.bestAsk > this.config.expensiveBuyMax)
    ) {
      // Out of band: log only. Emitting every tick flooded orders with killed-fok.
      log("Hedge skipped - favorite ask outside buy band", {
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        bestAsk: opportunity.token.bestAsk,
        band: `${this.config.expensiveBuyMin}-${this.config.expensiveBuyMax}`,
      });
      return;
    }

    if (
      this.tracker.getOpenExposure() +
        this.tracker.getRestingExposure() +
        estimatedCost >
      this.config.maxExposureUsdc
    ) {
      log("Live order skipped - exposure cap", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        size: opportunity.size,
        estimatedCost,
        openExposure: this.tracker.getOpenExposure(),
        restingExposure: this.tracker.getRestingExposure(),
        cap: this.config.maxExposureUsdc,
      });
      return;
    }

    // --- Dispatch: FOK or GTC for expensive hedge, GTC for cheap legs ---
    //
    // Expensive hedge order type is configurable via EXPENSIVE_ORDER_TYPE:
    //  - FOK (default): Fill-or-Kill market order. Either fills entirely at
    //    the best ask (≤ expensiveBuyMax) or is killed instantly. No resting
    //    order to poll or cancel. Fast but rejects when bestAsk > max.
    //  - GTC: limit order resting on the book. Fills when the favorite price
    //    drops to our limit. Survives across ticks until windowEnd + stale.
    //    Trades execution certainty for patience — avoids constant FOK kills.
    //
    // Cheap leg: always GTC limit order (unchanged).
    // useFOK / estimatedCost computed above (FOK-aware notionnel).

    let result: OrderResult;
    try {
      result = useFOK
        ? await this.trader.placeBuyFOK(opportunity)
        : await this.trader.placeBuy(opportunity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not enough balance|insufficient balance/i.test(message)) {
        this.consecutiveBalanceRejections++;
        if (this.consecutiveBalanceRejections >= 3) {
          this.balanceBackoffUntil = Date.now() + 60_000;
          this.consecutiveBalanceRejections = 0;
          log("Live trading paused 60s - repeated balance rejections");
        }
      }
      this.tracker.incrementRetry(opportunity.tradeKey);
      if (this.tracker.getRetryCount(opportunity.tradeKey) >= this.config.simMaxRetryAttempts) {
        this.tracker.mark(opportunity.tradeKey);
        log("Live order abandoned after max retries", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          price: opportunity.price,
        });
      } else {
        log("Live order failed, will retry", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          price: opportunity.price,
          error: message,
          retry: this.tracker.getRetryCount(opportunity.tradeKey),
        });
      }
      bus.emit({ type: "error", message: `Order failed: ${message}` });
      bus.emit({
        type: "order",
        result: {
          dryRun: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          filled: false,
          reason: "order-failed",
          orderType: useFOK ? "FOK" : "GTC",
        },
        opportunity,
      });
      return;
    }

    this.consecutiveBalanceRejections = 0;

    // For FOK: don't mark the trade key if killed — the favorite may rise
    // later in the window and become marketable. Instead, increment the retry
    // count; after simMaxRetryAttempts the key is marked (permanently skipped)
    // to stop spamming a favorite that never reaches our price.
    if (useFOK) {
      // FOK is synchronous: either filled or killed. No resting order.
      const filledSize = result.filledSize ?? 0;
      if (result.filled && filledSize > 0) {
        this.tracker.mark(opportunity.tradeKey);
        this.totalAttempts++;
        this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, this.totalAttempts);

        const orderId = (result.response as { orderID?: string } | undefined)
          ?.orderID;
        const fillPrice = result.fillPrice ?? opportunity.price;
        const position: SimulatedPosition = {
          id: `live:${orderId ?? Date.now()}`,
          eventSlug: opportunity.event.slug,
          eventTitle: opportunity.event.title,
          tokenId: opportunity.token.tokenId,
          outcome: opportunity.token.outcome,
          outcomeIndex: opportunity.token.outcomeIndex,
          kind: opportunity.kind,
          limitPrice: opportunity.price,
          fillPrice,
          size: filledSize,
          cost: Math.round(fillPrice * filledSize * 100) / 100,
          windowEnd: opportunity.event.windowEnd,
          status: "open",
          fillReason: "marketable",
          pairId: opportunity.pairId,
          bestAskAtFill: opportunity.token.bestAsk,
          orderType: "FOK",
        };
        this.tracker.addOpenPosition(position);
        this.tracker.attachLeg(position);
        bus.emit({ type: "openedPosition", position });
        log("FOK hedge filled — position created", {
          orderId,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          fillPrice,
          filledSize,
          cost: position.cost,
        });
      } else if (result.filled && filledSize <= 0) {
        log("FOK reported success with zero size — no position created", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
        });
      } else {
        // FOK killed — no fill. Retry silently; emit at most once so the
        // dashboard is not flooded (was 1 killed-fok row per tick).
        this.tracker.incrementRetry(opportunity.tradeKey);
        const retries = this.tracker.getRetryCount(opportunity.tradeKey);
        if (retries >= this.config.simMaxRetryAttempts) {
          this.tracker.mark(opportunity.tradeKey);
          log("FOK hedge abandoned after max retries (favorite never reached ask)", {
            market: opportunity.event.title,
            outcome: opportunity.token.outcome,
            limitPrice: opportunity.price,
            bestAsk: opportunity.token.bestAsk,
            retries,
          });
        } else {
          log("FOK hedge killed (no fill at current ask)", {
            market: opportunity.event.title,
            outcome: opportunity.token.outcome,
            limitPrice: opportunity.price,
            bestAsk: opportunity.token.bestAsk,
            retry: retries,
          });
        }
        if (retries === 1) {
          bus.emit({ type: "opportunity", opportunity });
          bus.emit({ type: "order", result, opportunity });
        }
      }
      if (result.filled) {
        bus.emit({ type: "opportunity", opportunity });
        bus.emit({ type: "order", result, opportunity });
      }
      return;
    }

    // GTC path (cheap leg): record as resting posted order for later fill polling.
    const orderId = (result.response as { orderID?: string } | undefined)
      ?.orderID;
    this.tracker.recordPostedOrder(
      opportunity.tradeKey,
      opportunity.event.slug,
      opportunity.event.windowEnd,
      estimatedCost,
      orderId,
      {
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
      },
    );

    this.tracker.mark(opportunity.tradeKey);
    this.totalAttempts++;
    this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, this.totalAttempts);

    bus.emit({ type: "opportunity", opportunity });
    bus.emit({ type: "order", result, opportunity });

    log("Live order placed", {
      tokenId: result.tokenId,
      price: result.price,
      size: result.size,
      response: result.response,
    });
  }

  private rejectLiveWithRetry(
    opportunity: TradeOpportunity,
    reason: string,
    extra: Record<string, unknown>,
  ): void {
    this.tracker.incrementRetry(opportunity.tradeKey);
    const retries = this.tracker.getRetryCount(opportunity.tradeKey);
    if (retries === 1) {
      bus.emit({
        type: "order",
        result: {
          dryRun: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          filled: false,
          reason,
          orderType: this.orderTypeFor(opportunity),
        },
        opportunity,
      });
    }
    if (retries >= this.config.simMaxRetryAttempts) {
      this.tracker.mark(opportunity.tradeKey);
      log(`Live order abandoned after max retries (${reason})`, {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        retries,
        ...extra,
      });
      return;
    }
    log(`Live order skipped - ${reason}`, {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      retry: retries,
      ...extra,
    });
  }

  private async getCachedAvailableCollateral(): Promise<number | null> {
    const now = Date.now();
    if (now - this.cachedBalanceAt < ReverseBot.BALANCE_CACHE_MS) {
      return this.cachedBalance;
    }
    try {
      this.cachedBalance = await this.trader.getAvailableCollateral();
      this.cachedBalanceAt = now;
    } catch {
      // Erreur réseau CLOB : garder le cache précédent (ou null si jamais fetché).
    }
    return this.cachedBalance;
  }

  private executeSimulated(opportunity: TradeOpportunity): void {
    if (!this.broker || !this.ledger) return;

    this.totalAttempts++;
    this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, this.totalAttempts);
    const openExposure = this.tracker.getOpenExposure();
    const result = this.broker.attemptFill(opportunity, openExposure);

    if (result.filled && result.position) {
      this.tracker.mark(opportunity.tradeKey);
      this.tracker.addOpenPosition(result.position);
      this.tracker.attachLeg(result.position);
      bus.emit({ type: "openedPosition", position: result.position });

      const orderResult = {
        dryRun: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY" as const,
        price: opportunity.price,
        fillPrice: result.position.fillPrice,
        size: opportunity.size,
        filled: true,
        orderType: "SIM" as const,
      };

      bus.emit({ type: "opportunity", opportunity });
      bus.emit({ type: "order", result: orderResult, opportunity });

      log("Dry-run order filled", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        fillPrice: result.position.fillPrice,
        bestAskAtFill: result.position.bestAskAtFill,
        size: opportunity.size,
        reason: result.reason,
      });
      return;
    }

    const rejectedResult: OrderResult = {
      dryRun: true,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
      filled: false,
      reason: result.reason,
      orderType: "SIM",
    };
    bus.emit({ type: "opportunity", opportunity });
    bus.emit({ type: "order", result: rejectedResult, opportunity });

    if (result.reason === "insufficient-capital") {
      log("Simulated order rejected - insufficient capital", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        balance: this.ledger.getBalance(),
      });
      return;
    }

    if (result.reason === "exposure-cap") {
      log("Simulated order rejected - exposure cap reached", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        openExposure: this.tracker.getOpenExposure(),
        cap: this.config.maxExposureUsdc,
      });
      return;
    }

    if (result.reason === "not-a-favorite") {
      // Structural rejection: the "expensive" token is not a real favorite.
      // The favorite may come back above expensiveBuyMin, so count a retry
      // instead of permanently skipping this level every tick.
      this.tracker.incrementRetry(opportunity.tradeKey);
      if (this.tracker.getRetryCount(opportunity.tradeKey) >= this.config.simMaxRetryAttempts) {
        this.tracker.mark(opportunity.tradeKey);
        log("Simulated hedge abandoned after max retries (not a favorite)", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          bestAsk: opportunity.token.bestAsk,
          expensiveBuyMin: this.config.expensiveBuyMin,
        });
      } else {
        log("Simulated hedge rejected - not a favorite", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          limitPrice: opportunity.price,
          bestAsk: opportunity.token.bestAsk,
          expensiveBuyMin: this.config.expensiveBuyMin,
          retry: this.tracker.getRetryCount(opportunity.tradeKey),
        });
      }
      return;
    }

    this.tracker.incrementRetry(opportunity.tradeKey);
    if (this.tracker.getRetryCount(opportunity.tradeKey) >= this.config.simMaxRetryAttempts) {
      this.tracker.mark(opportunity.tradeKey);
      log("Simulated order abandoned after max retries", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
      });
    }
  }
}
