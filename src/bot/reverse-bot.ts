import type { BotConfig } from "../config.js";
import { toPublicConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import { log } from "../logger.js";
import { MarketScanner } from "../market-scanner.js";
import { PositionResolver } from "../position-resolver.js";
import type { EditableConfigKey } from "../runtime-settings.js";
import { SimulatedBroker } from "../simulated-broker.js";
import { SimulatedLedger } from "../simulated-ledger.js";
import { createStrategy } from "../strategy/registry.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import { TradeTracker } from "../trade-tracker.js";
import { Trader } from "../trader.js";
import type { UpDownEvent } from "../types.js";
import { BalanceGuard } from "./balance-guard.js";
import { LiveOrderLifecycle } from "./live-order-lifecycle.js";
import { OpportunityExecutor } from "./opportunity-executor.js";
import { RestingManager } from "./resting-manager.js";
import { TickSnapshots } from "./tick-snapshots.js";

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
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private strategy: TradingStrategy;
  private readonly lifecycle: LiveOrderLifecycle;
  private readonly resting: RestingManager;
  private readonly balance: BalanceGuard;
  private readonly executor: OpportunityExecutor;
  private readonly snapshots: TickSnapshots;

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
    this.lifecycle = new LiveOrderLifecycle({ config, trader, tracker: this.tracker }, this.strategy);
    this.resting = new RestingManager(
      {
        config,
        trader,
        tracker: this.tracker,
        scanner: this.scanner,
        lifecycle: this.lifecycle,
      },
      this.strategy,
    );
    this.balance = new BalanceGuard({ config, trader });
    this.executor = new OpportunityExecutor(
      {
        config,
        trader,
        tracker: this.tracker,
        scanner: this.scanner,
        repos: this.repos,
        broker: this.broker,
        ledger: this.ledger,
        lifecycle: this.lifecycle,
        balance: this.balance,
        defendPair: (pairId) => this.resting.defendPair(pairId),
        onAttempt: () => {
          this.totalAttempts++;
          this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, this.totalAttempts);
        },
      },
      this.strategy,
    );
    this.snapshots = new TickSnapshots({
      config,
      repos: this.repos,
      tracker: this.tracker,
      ledger: this.ledger,
    });
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
    setInterval(() => this.snapshots.emitStats(this.totalAttempts), 5_000);

    this.snapshots.pruneData();
    setInterval(() => this.snapshots.pruneData(), 3600_000); // 1h
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
      this.lifecycle.setStrategy(this.strategy);
      this.resting.setStrategy(this.strategy);
      this.executor.setStrategy(this.strategy);
      log("Trading engine swapped", {
        strategyId: this.strategy.id,
        label: this.strategy.label,
      });
    }
    bus.emit({ type: "config", config: toPublicConfig(this.config) });
    log("Runtime settings updated", { changed: [...changed] });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const nowSeconds = Date.now() / 1000;
      this.tracker.prunePostedOrders(nowSeconds);
      this.tracker.pruneWindowClaims(nowSeconds);
      if (!this.config.dryRun) {
        await this.lifecycle.cancelStaleOrders(nowSeconds);
        await this.lifecycle.pollOrderFills();
      }
      if (this.paused) {
        return;
      }
      const events = await this.scanner.scan();
      const tickTs = Date.now();
      this.snapshots.insertMarketSnapshots(events, tickTs);
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

  private async processEvent(event: UpDownEvent, tickTs: number): Promise<void> {
    const books = await this.scanner.getTokenBooks(event);
    this.snapshots.insertBooks(event, books, tickTs);
    if (!this.config.dryRun) {
      await this.resting.manageLiveResting(event, books);
    }
    const opportunities = this.strategy.findOpportunities({
      config: this.config,
      tracker: this.tracker,
      event,
      books,
    });
    this.snapshots.insertOpportunities(event, opportunities, tickTs);

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
      await this.executor.executeOpportunity(opportunity);
    }
  }
}
