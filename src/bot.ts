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
import { createStrategy } from "./strategy/registry.js";
import type { TradingStrategy } from "./strategy/trading-strategy.js";
import { TradeTracker, type PostedOrderContext } from "./trade-tracker.js";
import { Trader } from "./trader.js";
import type { OrderResult, TokenBook, TradeOpportunity, UpDownEvent, SimulatedPosition } from "./types.js";
import { gammaMarketStats } from "./utils/market.js";
import { confirmedFillSize } from "./utils/order-status.js";
import { formatReturnPct, MIN_CLOB_SHARES } from "./utils/prices.js";

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
  private readonly fillConfirmFailures = new Map<string, number>();
  private readonly cheapMissingFailures = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private strategy: TradingStrategy;
  private static readonly BALANCE_CACHE_MS = 30_000;
  private static readonly ORDER_STATUS_MAX_FAILURES = 10;
  private static readonly FILL_CONFIRM_MAX_ATTEMPTS = 8;
  private static readonly CHEAP_MISSING_MAX_ATTEMPTS = 3;
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
    this.strategy = createStrategy(config.strategyId);
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
      strategy: this.strategy.label,
      pairLockMax: this.config.pairLockMax,
      barbellHedgeRatio:
        this.strategy.id === "barbell" ? this.config.barbellHedgeRatio : undefined,
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
    if (changed.has("strategyId")) {
      this.strategy = createStrategy(this.config.strategyId);
      log("Trading engine swapped", {
        strategyId: this.strategy.id,
        label: this.strategy.label,
      });
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
    if (this.config.marketSnapshotRetentionMs > 0) {
      this.repos?.marketSnapshots.prune(now - this.config.marketSnapshotRetentionMs);
    }
    if (this.config.bookSnapshotRetentionMs > 0) {
      this.repos?.bookSnapshots.prune(now - this.config.bookSnapshotRetentionMs);
    }
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
        const stats = gammaMarketStats(event.market);
        this.repos?.marketSnapshots.insert({
          ts: tickTs,
          eventSlug: event.slug,
          eventTitle: event.title,
          conditionId: event.market.conditionId,
          windowStart: event.windowStart,
          windowEnd: event.windowEnd,
          volume: stats.volume,
          volume24hr: stats.volume24hr,
          liquidity: stats.liquidity,
          lastTradePrice: stats.lastTradePrice,
          spread: stats.spread,
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
        const outcome = await this.finalizeLiveOrder(tracked, {
          ...status,
          sizeMatched,
        });
        if (outcome === "ghost" || outcome === "none") {
          await this.cancelOrphanHedgesIfNeeded(order);
        }
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
          const outcome = await this.finalizeLiveOrder(order, status);
          if (outcome === "pending") continue;
          if (outcome === "ghost" || outcome === "none") {
            await this.cancelOrphanHedgesIfNeeded(order);
          }
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
    // Edge-lead gère le GTC edge resting via manageRestingEdgeLead.
    // L'orphan-hedge arb (cheap disparu → cancel le favori) casserait un
    // edge qu'on veut garder in-bande.
    if (this.strategy.leadsWithEdge) return;
    if (order.kind !== "cheap") return;
    if (this.tracker.getFilledCheapSizeForPair(order.pairId) > 0) return;
    await this.cancelRestingHedgesForPair(order.pairId, "cheap leg vanished");
  }

  /**
   * Cancel every resting GTC hedge of a pair. Used when the cheap leg is
   * gone (never filled, or sold by defense): a hedge left on the book
   * would fill later as a naked favorite.
   */
  private async cancelRestingHedgesForPair(pairId: string, why: string): Promise<void> {
    const hedges = this.tracker.getPostedOrdersForPair(pairId, "expensive");
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
      log(`Hedge cancelled - ${why}`, {
        pairId,
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
      this.config.expensiveOrderType === "FOK" &&
      !this.strategy.leadsWithEdge
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
  private async finalizeLiveOrder(
    order: { key: string; orderId: string } & PostedOrderContext,
    status: { filled: boolean; cancelled: boolean; sizeMatched: number },
  ): Promise<"created" | "pending" | "ghost" | "none"> {
    if (status.sizeMatched <= 0) {
      this.tracker.removePostedOrder(order.key);
      this.fillConfirmFailures.delete(order.orderId);
      return "none";
    }

    const held = await this.trader.getConditionalTokenBalance(order.tokenId);
    const confirmedSize = confirmedFillSize(status.sizeMatched, held);
    if (confirmedSize > 0) {
      this.createLivePosition(order, confirmedSize);
      this.tracker.removePostedOrder(order.key);
      this.fillConfirmFailures.delete(order.orderId);
      return "created";
    }

    // Tokens not (yet) visible. The CLOB balance endpoint lagged a real
    // maker fill in production, so a cancelled-with-match order is retried
    // like a live one instead of being dropped as a ghost on the first miss
    // — dropping it would leave real tokens untracked in the wallet.
    const next = (this.fillConfirmFailures.get(order.orderId) ?? 0) + 1;
    this.fillConfirmFailures.set(order.orderId, next);
    if (next >= ReverseBot.FILL_CONFIRM_MAX_ATTEMPTS) {
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
          await this.trader.cancelOrder(order.orderId);
        } catch {
          // Already gone (true MATCHED) or network — local cleanup still proceeds.
        }
      }
      this.emitOrderCancelled(order);
      this.tracker.removePostedOrder(order.key);
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
      strategyId: order.strategyId ?? this.strategy.id,
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
        bestBidSize: book.bestBidSize ?? null,
        ask2: book.ask2 ?? null,
        ask2Size: book.ask2Size ?? null,
        ask3: book.ask3 ?? null,
        ask3Size: book.ask3Size ?? null,
        bid2: book.bid2 ?? null,
        bid2Size: book.bid2Size ?? null,
        bid3: book.bid3 ?? null,
        bid3Size: book.bid3Size ?? null,
      });
    }
    if (!this.config.dryRun) {
      if (this.strategy.leadsWithEdge) {
        await this.manageRestingEdgeLead(event, books);
        await this.replaceMarketableCheap(event, books);
        await this.sellExpensiveEdgeIfNeeded(event, books);
      } else {
        await this.replaceMarketableCheap(event, books);
        await this.defendUncoveredPairs(event, books);
      }
    }
    const opportunities = this.strategy.findOpportunities({
      config: this.config,
      tracker: this.tracker,
      event,
      books,
    });
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
    // Edge-lead inverts: the edge (expensive) is bought first, then the cheap.
    opportunities.sort((a, b) =>
      this.strategy.leadsWithEdge
        ? a.kind === b.kind
          ? 0
          : a.kind === "expensive"
            ? -1
            : 1
        : a.kind === b.kind
          ? 0
          : a.kind === "cheap"
            ? -1
            : 1,
    );
    for (const opportunity of opportunities) {
      await this.executeOpportunity(opportunity);
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
      const favoriteBook =
        books.find((candidate) => candidate.outcome !== order.outcome) ?? null;
      const action = this.strategy.cheapOrderAction({
        config: this.config,
        limitPrice: order.limitPrice,
        cheapBook: book,
        favoriteAsk: favoriteBook?.bestAsk ?? null,
      });
      if (action === "keep") {
        continue;
      }
      if (order.orderId) {
        const tracked = { ...order, orderId: order.orderId };
        const status = await this.getOrderStatusTracked(tracked);
        if (!status) continue;
        // Fully matched or already cancelled by the exchange: record the
        // fill (if any) and leave it to pollOrderFills — nothing to cancel.
        if (status.filled || status.cancelled) {
          if (status.sizeMatched > 0) {
            await this.finalizeLiveOrder(tracked, status);
          }
          continue;
        }
        // Still live (possibly partially matched): cancel FIRST, then read
        // the final matched size. Finalizing a partial fill while the rest
        // of the order rests on the book would orphan the remainder on the
        // exchange (untracked exposure, later fills never recorded).
        try {
          await this.trader.cancelOrder(tracked.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Cheap cancel failed, will retry", {
            orderId: tracked.orderId,
            error: message,
          });
          continue;
        }
        const finalStatus = await this.getOrderStatusTracked(tracked);
        const sizeMatched = finalStatus?.sizeMatched ?? status.sizeMatched;
        if (sizeMatched > 0) {
          const outcome = await this.finalizeLiveOrder(tracked, {
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
      this.emitOrderCancelled(order);
      this.tracker.removePostedOrder(order.key);
      this.tracker.unmark(order.key);
      if (action === "cancel-lock") {
        const cancelWhy =
          this.strategy.id === "arb"
            ? "Cheap cancelled - pair lock no longer achievable"
            : this.strategy.id === "edge-lead"
              ? "Edge-lead cheap cancelled - ask left the cheap band"
              : "Cheap cancelled - favorite left the hedge band";
        log(cancelWhy, {
            market: event.title,
            outcome: order.outcome,
            limitPrice: order.limitPrice,
            favoriteAsk: favoriteBook?.bestAsk ?? null,
            cheapAsk: book?.bestAsk ?? null,
            pairLockMax: this.config.pairLockMax,
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
  private async manageRestingEdgeLead(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const edgeOrders = this.tracker.getPostedOrdersForPair(pairId, "expensive");
    if (edgeOrders.length === 0) return;

    const edgeBook =
      books.find((book) => book.outcome === edgeOrders[0].outcome) ??
      books.find((book) => book.tokenId === edgeOrders[0].tokenId);
    const edgeAsk = edgeBook?.bestAsk ?? null;

    // Hors bande → cancel le GTC edge non fillé.
    const offBand =
      edgeAsk !== null &&
      (edgeAsk < this.config.edgeBandMin || edgeAsk > this.config.edgeBandMax);

    if (!offBand) return;

    for (const order of edgeOrders) {
      if (order.orderId) {
        const tracked = { ...order, orderId: order.orderId };
        const status = await this.getOrderStatusTracked(tracked);
        if (!status) continue;
        if (status.filled || status.cancelled) {
          if (status.sizeMatched > 0) {
            await this.finalizeLiveOrder(tracked, status);
          }
          continue;
        }
        try {
          await this.trader.cancelOrder(tracked.orderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log("Edge-lead cancel failed, will retry", {
            orderId: tracked.orderId,
            error: message,
          });
          continue;
        }
        const finalStatus = await this.getOrderStatusTracked(tracked);
        const sizeMatched = finalStatus?.sizeMatched ?? status.sizeMatched;
        if (sizeMatched > 0) {
          await this.finalizeLiveOrder(tracked, {
            ...status,
            cancelled: true,
            sizeMatched,
          });
          continue;
        }
      }
      this.emitOrderCancelled(order);
      this.tracker.removePostedOrder(order.key);
      this.tracker.unmark(order.key);
      log("Edge-lead order cancelled - edge left the band", {
        market: event.title,
        outcome: order.outcome,
        kind: order.kind,
        limitPrice: order.limitPrice,
        edgeAsk,
        edgeBandMin: this.config.edgeBandMin,
        edgeBandMax: this.config.edgeBandMax,
      });
    }
  }

  /**
   * Pair defense trigger: sell cheap shares the strategy names when the
   * favorite ask is above expensiveBuyMax and the pair is not covered
   * (1:1 for arb, ratio for barbell). Ask below min does not dump the cheap.
   */
  private async defendUncoveredPairs(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    if (!this.config.enableExpensiveHedge) return;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const filledCheap = this.tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheap <= 0) return;

    const cheapTokenId = this.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) return;
    const favoriteBook =
      books.find((book) => book.tokenId !== cheapTokenId) ?? null;
    if (!favoriteBook || favoriteBook.bestAsk === null) {
      return;
    }

    const favoriteAsk = favoriteBook.bestAsk;
    const filledExpensive = this.tracker.getFilledExpensiveSizeForPair(pairId);
    const defendCtx = {
      config: this.config,
      favoriteAsk,
      filledCheap,
      filledExpensive,
    };
    if (!this.strategy.shouldDefend(defendCtx)) {
      return;
    }
    // Remainder under the CLOB minimum cannot be sold. Silent hold — logging
    // here would repeat every tick while the favorite stays above max.
    if (this.strategy.defendShares(defendCtx) < MIN_CLOB_SHARES) {
      return;
    }

    log("Pair uncovered - favorite ask above hedge max, defending", {
      market: event.title,
      pairId,
      favoriteAsk,
      expensiveBuyMax: this.config.expensiveBuyMax,
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
  private async sellExpensiveEdgeIfNeeded(
    event: UpDownEvent,
    books: TokenBook[],
  ): Promise<void> {
    const pairId = `${event.slug}:${event.windowEnd}`;
    const expensiveTokenId = this.tracker.getExpensiveTokenForPair(pairId);
    if (!expensiveTokenId) return;
    const expensiveFillPrice = this.tracker.getExpensiveFillPriceForPair(pairId);
    if (expensiveFillPrice === null) return;
    const expensiveSize = this.tracker.getFilledExpensiveSizeForPair(pairId);
    if (expensiveSize <= 0) return;
    const cheapFilled = this.tracker.getFilledCheapSizeForPair(pairId);

    const expensiveBook =
      books.find((book) => book.tokenId === expensiveTokenId) ??
      books.find((book) => book.outcome === this.tracker.getOpenPositions().find(
        (p) => p.pairId === pairId && p.kind === "expensive",
      )?.outcome) ??
      null;
    const expensiveBid = expensiveBook?.bestBid ?? null;

    const nowSec = Date.now() / 1000;
    const marketAgeMs = Math.max(0, (nowSec - event.windowStart) * 1000);

    if (
      !this.strategy.shouldSellExpensiveEdge({
        config: this.config,
        tracker: this.tracker,
        pairId,
        expensiveBid,
        expensiveFillPrice,
        expensiveSize,
        cheapFilled,
        marketAgeMs,
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

    const pair = this.tracker.getPair(pairId);
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
      },
      price: expensiveBid,
      size: expensiveSize,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: `edge-sell:${pairId}`,
      pairId,
    };

    try {
      const result = await this.trader.placeSell(sellOpportunity);
      if (result.filled && (result.filledSize ?? 0) > 0) {
        const fillPrice = result.fillPrice ?? expensiveBid;
        const soldSize = Math.min(result.filledSize ?? expensiveSize, expensiveSize);
        this.tracker.closePairExpensiveAsSold(pairId, fillPrice, soldSize);
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
        await this.cancelRestingHedgesForPair(pairId, "edge sold by edge-lead");
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

    // Hedge must match a committed cheap leg. A hedge (GTC or FOK) must
    // never be posted without a filled cheap — a hedge on a resting cheap
    // is a naked favorite (C2). The hedge is posted only after the cheap
    // fill is detected by pollOrderFills, at the next tick.
    // Edge-lead inverts this: the edge (expensive) is bought first, then
    // the cheap. C2 is bypassed only for this engine.
    const cheapCommitted =
      opportunity.kind === "expensive"
        ? this.tracker.getFilledCheapSizeForPair(opportunity.pairId)
        : this.tracker.getCheapSizeForPair(opportunity.pairId);
    if (
      opportunity.kind === "expensive" &&
      cheapCommitted === 0 &&
      !this.strategy.leadsWithEdge
    ) {
      // No filled cheap leg: do not post a naked hedge.
      log("Hedge skipped - no committed cheap leg", {
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        pairId: opportunity.pairId,
      });
      return;
    }

    if (
      opportunity.kind === "expensive" &&
      !this.config.dryRun &&
      !this.strategy.leadsWithEdge
    ) {
      const cheapHeld = await this.confirmCheapTokensForHedge(opportunity.pairId);
      if (cheapHeld === null) {
        log("Hedge skipped - cheap token balance unknown (fail-closed)", {
          market: opportunity.event.title,
          pairId: opportunity.pairId,
        });
        return;
      }
      if (cheapHeld <= 0) {
        return;
      }
      if (cheapHeld < opportunity.size) {
        if (cheapHeld < MIN_CLOB_SHARES) {
          log("Hedge skipped - remaining cheap shares below CLOB minimum", {
            market: opportunity.event.title,
            pairId: opportunity.pairId,
            cheapHeld,
          });
          return;
        }
        opportunity = { ...opportunity, size: cheapHeld };
      }
    }

    if (this.broker && this.ledger) {
      this.executeSimulated(opportunity);
      return;
    }

    const useFOK =
      opportunity.kind === "expensive" &&
      this.config.expensiveOrderType === "FOK" &&
      !this.strategy.leadsWithEdge;
    let estimatedCost = Math.round(
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
    // Fail-closed : en mode live, si le solde est inconnu (null = fetch échoué
    // ou jamais réussi), on rejette l'ordre au lieu de poster à l'aveugle.
    // En dry-run, available est toujours null (pas de client CLOB) → on passe.
    const available = await this.getCachedAvailableCollateral();
    if (available === null) {
      if (!this.config.dryRun) {
        log("Live order skipped - balance unknown (fail-closed)", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
        });
        this.rejectLiveWithRetry(opportunity, "balance-unknown", {});
        return;
      }
      // Dry-run: pas de client CLOB, available est toujours null — autoriser.
    } else if (estimatedCost > available) {
      this.rejectLiveWithRetry(opportunity, "insufficient-balance", {
        estimatedCost,
        available,
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

    if (opportunity.kind === "expensive" && !this.config.dryRun && !this.strategy.leadsWithEdge) {
      const freshBook = await this.scanner.getTokenBook(opportunity.token.tokenId);
      const freshAsk = freshBook?.bestAsk ?? null;
      const decision = this.strategy.hedgeAtPostTime({
        config: this.config,
        tracker: this.tracker,
        pairId: opportunity.pairId,
        freshAsk,
      });
      if (decision.action === "defend") {
        log("Hedge skipped - defending uncovered pair at post time", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          reason: decision.reason,
          freshAsk,
        });
        await this.defendPair(opportunity.pairId);
        return;
      }
      if (decision.action === "skip") {
        log("Hedge skipped at post time", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          reason: decision.reason,
          freshAsk,
          originalAsk: opportunity.token.bestAsk,
        });
        return;
      }
      opportunity = {
        ...opportunity,
        price: decision.price,
        token: { ...opportunity.token, bestAsk: freshAsk },
      };
      estimatedCost = Math.round(decision.price * opportunity.size * 100) / 100;
      // Fresh ask can be higher than the snapshot used for the first
      // collateral / exposure checks. Re-evaluate with the POST price.
      if (available !== null && estimatedCost > available) {
        this.rejectLiveWithRetry(opportunity, "insufficient-balance", {
          estimatedCost,
          available,
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
    }

    // --- Dispatch: FOK or GTC for expensive hedge, GTC for cheap legs ---
    //
    // Expensive hedge order type is configurable via EXPENSIVE_ORDER_TYPE:
    //  - FOK (default): Fill-or-Kill. Entire size at min(ask, expensiveBuyMax)
    //    or killed. No resting order. Only after a cheap fill, and only if
    //    fill+hedge ≤ pairLockMax (checked above).
    //  - GTC: same price clamp, also only after a cheap fill. Rests if not
    //    fully filled; cancelled if the cheap vanishes without a fill.
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
          strategyId: this.strategy.id,
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
        strategyId: this.strategy.id,
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

  /**
   * Confirm the funder still holds the cheap tokens before hedging.
   * Returns held shares, 0 after syncing a vanished position as sold, or
   * null when the balance call failed (caller must fail-closed).
   */
  private async confirmCheapTokensForHedge(pairId: string): Promise<number | null> {
    const cheapTokenId = this.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) return 0;
    const held = await this.trader.getConditionalTokenBalance(cheapTokenId);
    if (held === null) return null;
    if (held > 0) {
      this.cheapMissingFailures.delete(pairId);
      return held;
    }
    const next = (this.cheapMissingFailures.get(pairId) ?? 0) + 1;
    this.cheapMissingFailures.set(pairId, next);
    const filled = this.tracker.getFilledCheapSizeForPair(pairId);
    if (filled > 0 && next >= ReverseBot.CHEAP_MISSING_MAX_ATTEMPTS) {
      log("Cheap tokens gone — syncing local legs as sold (no hedge)", {
        pairId,
        cheapTokenId,
        filled,
        attempts: next,
      });
      this.tracker.closePairCheapAsSold(pairId, 0, filled);
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

  /**
   * Pair defense (S2.4): when the favorite ask is above expensiveBuyMax,
   * sell the cheap at the current best bid (FOK) instead of holding it
   * naked to resolution. A CLOB "killed" response is confirmed against
   * token balance before we treat the cheap as still held.
   */
  private async defendPair(pairId: string): Promise<void> {
    const cheapTokenId = this.tracker.getCheapTokenForPair(pairId);
    if (!cheapTokenId) {
      log("defendPair: no cheap token found for pair", { pairId });
      return;
    }
    const filledCheapSize = this.tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheapSize <= 0) {
      log("defendPair: no filled cheap to defend", { pairId });
      return;
    }
    const filledExpensiveSize = this.tracker.getFilledExpensiveSizeForPair(pairId);
    const uncoveredSize = this.strategy.defendShares({
      config: this.config,
      favoriteAsk: null,
      filledCheap: filledCheapSize,
      filledExpensive: filledExpensiveSize,
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

    // Refresh the cheap book to get a current best bid.
    const freshBook = await this.scanner.getTokenBook(cheapTokenId);
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
    const pair = this.tracker.getPair(pairId);
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
      },
      price: bestBid,
      size: uncoveredSize,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: `defend:${pairId}`,
      pairId,
    };

    try {
      const result = await this.trader.placeSell(sellOpportunity);
      if (result.filled && (result.filledSize ?? 0) > 0) {
        const fillPrice = result.fillPrice ?? bestBid;
        const soldSize = Math.min(result.filledSize ?? uncoveredSize, filledCheapSize);
        // Update the tracker FIRST so the sold legs leave openPositions
        // before any new opportunity is generated (exposure, hedge guards).
        this.tracker.closePairCheapAsSold(pairId, fillPrice, soldSize);
        this.cheapMissingFailures.delete(pairId);
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
        await this.cancelRestingHedgesForPair(pairId, "cheap sold by pair defense");
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
    } catch (error) {
      // Erreur réseau CLOB : garder le cache précédent (ou null si jamais fetché).
      const message = error instanceof Error ? error.message : String(error);
      log("Collateral balance fetch failed, keeping cached value", {
        cached: this.cachedBalance,
        error: message,
      });
    }
    // Stamp on failure too: otherwise every opportunity in the next 30 s
    // re-hits a CLOB that is already timing out (10 s each, inside the tick).
    this.cachedBalanceAt = now;
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
