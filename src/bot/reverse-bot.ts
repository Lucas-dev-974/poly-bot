import type { BotConfig } from "../config.js";
import { toPublicConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import { log } from "../logger.js";
import { MarketScanner } from "../market-scanner.js";
import { MarketDataProvider } from "../market-data.js";
import { PositionResolver } from "../position-resolver.js";
import type { EditableConfigKey } from "../runtime-settings.js";
import { createStrategy } from "../strategy/registry.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import { TradeTracker } from "../trade-tracker.js";
import { Trader } from "../trader.js";
import type { TokenBook, UpDownEvent } from "../types.js";
import { BalanceGuard } from "./balance-guard.js";
import { LiveOrderLifecycle } from "./live-order-lifecycle.js";
import { OpportunityExecutor } from "./opportunity-executor.js";
import { RestingManager } from "./resting-manager.js";
import { TickSnapshots } from "./tick-snapshots.js";
import { MarketRuleStore, splitEventsByRules } from "../market-rules.js";
import { favBandLossStreak } from "../strategy/whipsaw.js";
import type { FavBandWhipsawStatus } from "../strategy/fav-band-strategy.js";
import type { FavBandStrategy } from "../strategy/fav-band-strategy.js";

const TOTAL_ATTEMPTS_KEY = "totalAttempts";
const PAUSED_KEY = "botPaused";
/** If a tick's awaits never settle, force the loop to continue after this. */
const TICK_WATCHDOG_MS = 30_000;
/** Log a "slow tick" warning above this duration. */
const TICK_SLOW_MS = 5_000;

/** Thrown when a tick is abandoned after the watchdog supersedes it. */
class TickSupersededError extends Error {
  constructor(session: number) {
    super(`tick session ${session} superseded`);
    this.name = "TickSupersededError";
  }
}

export class ReverseBot {
  private readonly scanner: MarketScanner;
  /** Provider de books : WS primaire (market channel), REST fallback. */
  readonly provider: MarketDataProvider;
  readonly tracker: TradeTracker;
  private readonly resolver: PositionResolver | null;
  private totalAttempts = 0;
  private paused = false;
  private ticking = false;
  /** Bumped to supersede a hung tick after watchdog fire. */
  private tickSession = 0;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickLoopGeneration = 0;
  private strategy: TradingStrategy;
  private readonly lifecycle: LiveOrderLifecycle;
  private readonly resting: RestingManager;
  private readonly balance: BalanceGuard;
  private readonly executor: OpportunityExecutor;
  private readonly snapshots: TickSnapshots;
  /** Règles par famille (market_rules) — rempli dans init(), partagé avec le dashboard. */
  readonly rules = new MarketRuleStore();

  constructor(
    private readonly config: BotConfig,
    private readonly trader: Trader,
    private readonly repos?: Repositories,
    private readonly paper?: {
      isEnabled(): boolean;
      onBooks(event: UpDownEvent, books: TokenBook[], nowMs: number, opts?: { trading?: boolean }): void;
    },
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
    this.provider = new MarketDataProvider(
      config,
      (payload) => bus.emit({ type: "wsStatus", ...payload }),
    );
    this.resolver = new PositionResolver(config, this.tracker);
    this.strategy = createStrategy(config.strategyId, repos);
    this.lifecycle = new LiveOrderLifecycle({ config, trader, tracker: this.tracker }, this.strategy);
    this.resting = new RestingManager(
      {
        config,
        trader,
        tracker: this.tracker,
        scanner: this.provider,
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
        scanner: this.provider,
        repos: this.repos,
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
    });
  }

  async init(): Promise<void> {
    this.tracker.loadFromDb();
    if (this.repos) {
      this.rules.loadFromDb(this.repos);
    }
    this.totalAttempts = this.repos?.botState.get(TOTAL_ATTEMPTS_KEY) ?? 0;
    this.paused = (this.repos?.botState.get(PAUSED_KEY) ?? 0) === 1;
    await this.trader.init();
    // User channel : un fill WS déclenche le finalize immédiat (lookup par
    // orderId dans le tracker ; ordre inconnu → ignoré, réconciliation REST
    // conservée en filet). Idempotent : handleOrderStatus est une no-op sur
    // un ordre déjà finalisé (l'ordre quitte postedOrders au premier finalize).
    this.provider.onUserReconnected = () => {
      // Rattrapage post-reconnexion user channel : passe de réconciliation immédiate.
      void this.lifecycle.pollOrderFills().catch((error) => {
        log("WS reconnect reconciliation failed", { error: String(error) });
      });
    };
    this.provider.onFill = (status) => {
      const order = this.tracker
        .getPostedOrdersWithOrderId()
        .find((o) => o.orderId === status.orderId);
      if (!order) return;
      void this.lifecycle
        .handleOrderStatus(order, {
          filled: status.filled,
          cancelled: status.cancelled,
          sizeMatched: status.sizeMatched,
        })
        .catch((error) =>
          log("WS fill finalize failed", {
            orderId: status.orderId,
            error: String(error),
          }),
        );
    };
  }

  reset(): void {
    this.tracker.reset();
    this.totalAttempts = 0;
    this.paused = false;
    this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, 0);
    this.repos?.botState.set(PAUSED_KEY, 0);
    bus.emit({ type: "botControl", enabled: true });
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

  closePositionManual(positionId: string) {
    return this.resting.closePositionManual(positionId);
  }

  /** Manual BUY from the dashboard (pUSD budget, FOK at the live ask). */
  /** Manual BUY from the dashboard (share count, min = CLOB minimum). */
  manualBuy(
    tokenId: string,
    shares: number,
    mode: "fok" | "resting" = "fok",
  ) {
    return this.resting.manualBuy(tokenId, shares, mode);
  }

  /** Get the current strategy status for the dashboard (fav-band whipsaw pause). */
  getStrategyStatus(): FavBandWhipsawStatus | null {
    if (this.config.strategyId !== "fav-band") return null;
    const strategy = this.strategy as FavBandStrategy;
    const resolved = this.tracker.getResolvedPositions();
    const lossStreak = favBandLossStreak(resolved);
    const nowMs = Date.now();
    return strategy.getWhipsawStatus(this.config, nowMs, lossStreak);
  }

  /** Manually reset the whipsaw pause cooldown (fav-band only). */
  resetWhipsawPause(): void {
    if (this.config.strategyId === "fav-band") {
      const strategy = this.strategy as FavBandStrategy;
      const resolved = this.tracker.getResolvedPositions();
      const lossStreak = favBandLossStreak(resolved);
      strategy.resetWhipsawPause(lossStreak);
    }
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
      pollMs: this.config.pollIntervalMs,
      resolveFallback: this.config.simResolveFallback,
    });
    bus.emit({ type: "config", config: toPublicConfig(this.config) });
    bus.emit({ type: "botControl", enabled: !this.paused });

    // WS market channel : books temps réel (le set d'assets est synchronisé
    // par syncAssets à chaque tick — connexion initiale sans abonnement).
    this.provider.start();

    await this.tickWithWatchdog();
    this.scheduleTick();

    if (this.resolver) {
      setInterval(() => void this.resolver?.resolveDue(), 5_000);
    }
    setInterval(() => this.snapshots.emitStats(this.totalAttempts), 5_000);

    // Emit whipsaw status for fav-band strategy (dashboard indicator).
    // The interval is created UNCONDITIONALLY: strategyId can be swapped at
    // runtime (onRuntimeSettingsChanged), so gating must live INSIDE the
    // callback. getStrategyStatus() returns null for non-fav-band engines
    // (early return), so the cost is negligible.
    setInterval(() => {
      const status = this.getStrategyStatus();
      if (status) {
        bus.emit({ type: "strategyStatus", status });
      }
    }, 5_000);

    this.snapshots.pruneData();
    setInterval(() => this.snapshots.pruneData(), 3600_000); // 1h
  }

  /** Arrêt propre : ferme le socket WS market (shutdown). */
  async stop(): Promise<void> {
    await this.provider.stop();
  }

  private scheduleTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickLoopGeneration++;
    const generation = this.tickLoopGeneration;
    this.tickTimer = setTimeout(
      () => void this.tickAndReschedule(generation),
      this.config.pollIntervalMs,
    );
  }

  private async tickAndReschedule(generation: number): Promise<void> {
    if (generation !== this.tickLoopGeneration) return;
    const started = Date.now();
    await this.tickWithWatchdog();
    if (generation !== this.tickLoopGeneration) return;
    const elapsed = Date.now() - started;
    const delay = Math.max(0, this.config.pollIntervalMs - elapsed);
    this.tickTimer = setTimeout(
      () => void this.tickAndReschedule(generation),
      delay,
    );
  }

  /** Runs tick(); if it hangs past TICK_WATCHDOG_MS, supersede it and keep looping. */
  private async tickWithWatchdog(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sessionBefore = this.tickSession;
    // Always attach a handler so a late tick rejection cannot become unhandled
    // after Promise.race has already settled on the watchdog.
    const tickPromise = this.tick().catch((error) => {
      if (error instanceof TickSupersededError) return;
      const message = error instanceof Error ? error.message : String(error);
      log("Tick late error after watchdog race", { error: message });
    });
    try {
      await Promise.race([
        tickPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`tick watchdog exceeded ${TICK_WATCHDOG_MS}ms`));
          }, TICK_WATCHDOG_MS);
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isWatchdog = message.includes("tick watchdog exceeded");
      if (isWatchdog) {
        // Invalidate the hung tick: its cooperative checks bail, and its finally
        // must not clear ticking for a newer session.
        this.tickSession++;
        this.ticking = false;
        log("Tick watchdog fired — superseding hung tick", {
          ms: TICK_WATCHDOG_MS,
          sessionBefore,
          sessionNow: this.tickSession,
        });
        bus.emit({
          type: "error",
          message: `Tick watchdog ${TICK_WATCHDOG_MS}ms — loop forced to continue`,
        });
      } else {
        log("Tick watchdog wrapper error", { error: message });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertTickActive(session: number): void {
    if (session !== this.tickSession) {
      throw new TickSupersededError(session);
    }
  }

  onRuntimeSettingsChanged(changed: Set<EditableConfigKey>): void {
    if (changed.has("pollIntervalMs")) {
      this.scheduleTick();
    }
    if (changed.has("simRandomSeed")) {
      this.resolver?.reseed(this.config.simRandomSeed);
    }
    if (changed.has("strategyId")) {
      this.strategy = createStrategy(this.config.strategyId, this.repos);
      this.lifecycle.setStrategy(this.strategy);
      this.resting.setStrategy(this.strategy);
      this.executor.setStrategy(this.strategy);
      log("Trading engine swapped", {
        strategyId: this.strategy.id,
        label: this.strategy.label,
      });
      // Push whipsaw status immediately when the new engine is fav-band,
      // instead of waiting for the next 5s interval tick (dashboard indicator).
      const status = this.getStrategyStatus();
      if (status) {
        bus.emit({ type: "strategyStatus", status });
      }
    }
    bus.emit({ type: "config", config: toPublicConfig(this.config) });
    log("Runtime settings updated", { changed: [...changed] });
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      log("Tick heartbeat skipped — previous tick still marked running");
      return;
    }
    const session = ++this.tickSession;
    this.ticking = true;
    const started = Date.now();
    let eventCount = 0;
    log("Tick heartbeat start", { session });
    try {
      const nowSeconds = Date.now() / 1000;
      this.tracker.prunePostedOrders(nowSeconds);
      this.tracker.pruneWindowClaims(nowSeconds);
      await this.lifecycle.cancelStaleOrders(nowSeconds);
      this.assertTickActive(session);
      await this.lifecycle.pollOrderFills();
      this.assertTickActive(session);
      // Keep scanning + market data persistence even while paused; only trading is gated.
      const scanned = await this.scanner.scan();
      this.assertTickActive(session);
      // Règles par famille : recording/trading (table market_rules, défaut = tout ON).
      const flagged = splitEventsByRules(scanned, (p) => this.rules.get(p));
      const events = flagged.filter((f) => f.recording).map((f) => f.event);
      eventCount = events.length;
      const tickTs = Date.now();
      this.snapshots.insertMarketSnapshots(events, tickTs);
      bus.emit({
        type: "scan",
        count: scanned.length,
        slugs: scanned.map((event) => event.slug),
      });
      if (scanned.length === 0) {
        log("No active markets in window");
        this.provider.syncAssets([]);
        return;
      }

      for (const item of flagged) {
        if (!item.recording && !item.trading) continue; // famille 0/0 : pas même de fetch CLOB
        this.assertTickActive(session);
        await this.processEvent(item.event, tickTs, session, {
          recording: item.recording,
          trading: item.trading,
        });
      }

      // WS market channel : le set d'assets suit les fenêtres actives.
      this.provider.syncAssets(scanned);
    } catch (error) {
      if (error instanceof TickSupersededError) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log("Scan error", { error: message, session });
      bus.emit({ type: "error", message });
    } finally {
      const ms = Date.now() - started;
      const superseded = session !== this.tickSession;
      if (!superseded) {
        this.ticking = false;
      }
      log("Tick heartbeat end", {
        session,
        ms,
        events: eventCount,
        superseded,
        slow: ms >= TICK_SLOW_MS,
      });
      if (ms >= TICK_SLOW_MS && !superseded) {
        log("Slow tick", { session, ms, events: eventCount });
      }
    }
  }

  private async processEvent(
    event: UpDownEvent,
    tickTs: number,
    session: number,
    flags: { recording: boolean; trading: boolean },
  ): Promise<void> {
    // Trading-off seul : les books restent nécessaires à la gestion des ordres
    // reposés (manageLiveResting), on fetch donc toujours sauf famille 0/0.
    const books = await this.scanner.getTokenBooks(event);
    this.assertTickActive(session);
    // Paper trading : la sim reçoit les books dès qu'ils sont fetchés, avant
    // les gates trading/pause — elle gère sa propre fenêtre de trading. Le
    // flag `trading` de la famille est respecté : pas d'ouverture de positions
    // sim sur une famille désactivée au trading (miroir du gate live).
    if (this.paper?.isEnabled()) {
      this.paper.onBooks(event, books, Date.now(), { trading: flags.trading });
    }
    if (flags.recording) {
      this.snapshots.insertBooks(event, books, tickTs);
    }
    // Resting management continues outside the entry window (open GTCs still need care).
    // Trading-off seul : les ordres reposés restent gérés (manageLiveResting).
    if (!this.paused) {
      await this.resting.manageLiveResting(event, books);
      this.assertTickActive(session);
    }

    bus.emit({ type: "watching", event, books });

    // Market data is recorded for the full window; new entries only in trading window.
    // Fresh clock for trading gates/strategy: tickTs is shared across events and can
    // be seconds stale after several CLOB book fetches. Snapshots keep tickTs so both
    // outcomes share one bot-tick timestamp.
    const nowMs = Date.now();
    if (!flags.trading) return; // trading off : stop AVANT la fenêtre de trading
    if (!this.scanner.inTradingWindow(event, nowMs / 1000)) {
      return;
    }

    if (this.paused) {
      return;
    }

    this.assertTickActive(session);
    const opportunities = this.strategy.findOpportunities({
      config: this.config,
      tracker: this.tracker,
      event,
      books,
      nowMs,
    });
    this.snapshots.insertOpportunities(event, opportunities, tickTs);

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
      this.assertTickActive(session);
      await this.executor.executeOpportunity(opportunity);
      this.assertTickActive(session);
    }
  }
}
