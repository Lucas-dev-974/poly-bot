import type { BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import type { SimTradeRow } from "../db/repositories.js";
import { buildEffectiveConfig } from "../backtest/config-builder.js";
import { BacktestLedger, round2 } from "../backtest/ledger.js";
import { BacktestRestingBook } from "../backtest/resting.js";
import { resolveWindowWinner } from "../backtest/resolve.js";
import { processTick, type TickExecutorSink } from "../backtest/tick-executor.js";
import { createStrategy } from "../strategy/registry.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { StrategyId } from "../strategy/ids.js";
import type { RuntimeSettingsPatch } from "../runtime-settings.js";
import { TradeTracker } from "../trade-tracker.js";
import type { SimulatedPosition, SimulatedStats, TokenBook, UpDownEvent } from "../types.js";

// ============================================================
// Simulation live (paper trading) : rejoue la logique d'exécution du
// backtest sur les books temps réel du bot live, avec capital, tracker,
// config et tables DB propres (sim_*). Aucun ordre réel n'est envoyé.
// ============================================================

export interface SimEngineState {
  enabled: boolean;
  cash: number;
  positionsValue: number;
  total: number;
  capitalInitial: number;
  strategyId: StrategyId;
  presetId: string | null;
  stats: SimulatedStats;
}

const SIM_RESOLVE_INTERVAL_MS = 30_000;
const SIM_STATS_INTERVAL_MS = 5_000;
const SIM_PRUNE_INTERVAL_MS = 3_600_000;

export class PaperTradingEngine {
  private ledger!: BacktestLedger;
  private tracker!: TradeTracker;
  private resting = new BacktestRestingBook();
  private strategy: TradingStrategy;
  private effectiveConfig!: BotConfig;
  private enabled = false;
  private presetId: string | null = null;
  private simConfig: { strategyId: StrategyId; presetId?: string; settings?: RuntimeSettingsPatch } | null = null;
  private capitalInitial: number;
  /** Dernier bid connu par slug (positionsValue latente pour simBalance). */
  private lastBids = new Map<string, number>();
  private restingSyncedSlugs = new Set<string>();
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private readonly liveConfig: BotConfig,
    private readonly repos?: Repositories,
  ) {
    this.capitalInitial = liveConfig.simulatedCapital;
    this.strategy = createStrategy(liveConfig.strategyId, repos);
  }

  init(): void {
    // Charge l'état persisté (cash, enabled, config papier).
    const cashRaw = this.repos?.simState.get("capitalCash");
    const initialRaw = this.repos?.simState.get("capitalInitial");
    if (initialRaw) {
      const parsed = Number(initialRaw);
      if (Number.isFinite(parsed) && parsed > 0) this.capitalInitial = parsed;
    }
    const enabledRaw = this.repos?.simState.get("simEnabled");
    this.enabled = enabledRaw === "1";
    const simConfigRaw = this.repos?.simState.get("simConfigJson");
    if (simConfigRaw) {
      try {
        this.simConfig = JSON.parse(simConfigRaw) as typeof this.simConfig;
        this.presetId = this.simConfig?.presetId ?? null;
      } catch {
        this.simConfig = null;
      }
    }
    this.effectiveConfig = this.simConfig
      ? buildEffectiveConfig(this.liveConfig, this.repos, {
        strategyId: this.simConfig.strategyId,
        presetId: this.simConfig.presetId,
        settings: this.simConfig.settings,
        useCurrentConfig: !this.simConfig.presetId && !this.simConfig.settings,
      })
      : this.liveConfig;
    this.strategy = createStrategy(this.effectiveConfig.strategyId, this.repos);

    // Ledger : part du cash persisté (défaut = capital initial).
    this.ledger = new BacktestLedger(cashRaw ? Number(cashRaw) : this.capitalInitial);

    // Tracker sur les 6 repos sim : persistance complète au fill/résolution/
    // vente + reconstruction dédup/paires/GTC au restart.
    this.tracker = new TradeTracker(
      this.repos?.simPositions,
      this.repos?.simPairs,
      this.repos?.simKeys,
      this.repos?.simRetries,
      this.repos?.simWindowClaims,
      this.repos?.simPostedOrders,
    );
    this.tracker.loadFromDb();
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.resolveDue(), SIM_RESOLVE_INTERVAL_MS),
    );
    this.timers.push(setInterval(() => this.emitBalance(), SIM_STATS_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pruneTrades(), SIM_PRUNE_INTERVAL_MS));
    this.emitBalance();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.repos?.simState.set("simEnabled", enabled ? "1" : "0");
    bus.emit({ type: "simConfig", simConfig: this.simConfigState() });
  }

  /**
   * Swap moteur/preset à chaud, ou ajuste le cash (capital) immédiatement.
   * `capital` = nouveau cash (pas seulement l'initial) pour les corrections.
   */
  applyConfig(patch: {
    strategyId?: StrategyId;
    presetId?: string | null;
    settings?: RuntimeSettingsPatch;
    capital?: number;
  }): void {
    if (patch.capital !== undefined && Number.isFinite(patch.capital) && patch.capital >= 0) {
      this.capitalInitial = patch.capital;
      this.ledger = new BacktestLedger(patch.capital);
      this.repos?.simState.set("capitalInitial", String(patch.capital));
      this.repos?.simState.set("capitalCash", String(patch.capital));
    }
    if (patch.strategyId || patch.presetId !== undefined || patch.settings) {
      const strategyId = patch.strategyId ?? this.effectiveConfig.strategyId;
      const presetId = patch.presetId === undefined ? this.simConfig?.presetId : patch.presetId;
      const settings = patch.settings ?? this.simConfig?.settings;
      this.simConfig = { strategyId, presetId: presetId ?? undefined, settings };
      this.presetId = presetId ?? null;
      this.effectiveConfig = buildEffectiveConfig(this.liveConfig, this.repos, {
        strategyId,
        presetId: presetId ?? undefined,
        settings,
        useCurrentConfig: !presetId && !settings,
      });
      this.strategy = createStrategy(this.effectiveConfig.strategyId, this.repos);
      this.repos?.simState.set("simConfigJson", JSON.stringify(this.simConfig));
    }
    bus.emit({ type: "simConfig", simConfig: this.simConfigState() });
  }

  /** Reset complet : wipe tables sim, cash = capital initial, dédup effacée. */
  reset(): void {
    this.tracker.reset();
    this.resting = new BacktestRestingBook();
    this.restingSyncedSlugs.clear();
    this.lastBids.clear();
    this.repos?.simPositions.deleteAll();
    this.repos?.simPairs.deleteAll();
    this.repos?.simTrades.deleteAll();
    this.repos?.simPostedOrders.deleteAll();
    this.repos?.simState.set("capitalCash", String(this.capitalInitial));
    this.ledger = new BacktestLedger(this.capitalInitial);
    this.emitBalance();
    bus.emit({ type: "simConfig", simConfig: this.simConfigState() });
  }

  /** Point d'entrée par tick : books temps réel du bot live. */
  onBooks(event: UpDownEvent, books: TokenBook[], nowMs: number): void {
    if (!this.enabled) return;
    // Reconstruit le resting book depuis la DB pour ce slug au premier tick
    // après un restart (BacktestRestingBook est mémoire seule, le tracker
    // recharge ses postedOrders depuis sim_posted_orders).
    if (!this.restingSyncedSlugs.has(event.slug)) {
      this.syncRestingFromTracker(event);
      this.restingSyncedSlugs.add(event.slug);
    }
    // Mémorise les derniers bids (P&L latent pour la page Simulation).
    for (const book of books) {
      if (book.bestBid !== null) this.lastBids.set(book.tokenId, book.bestBid);
    }

    processTick({
      runId: "sim",
      config: this.effectiveConfig,
      strategy: this.strategy,
      tracker: this.tracker,
      ledger: this.ledger,
      resting: this.resting,
      event,
      books,
      nowMs,
      sink: {
        pushTrade: () => {},
        persistTrade: (row) => this.persistSimTrade(row),
        onPositionOpened: (position) => {
          bus.emit({ type: "simOpenedPosition", position });
          // Persiste le cash après chaque débit : sans cela, un restart
          // restaurerait le capital initial et autoriserait un sur-trading.
          this.repos?.simState.set("capitalCash", String(this.ledger.getBalance()));
        },
      },
    });
  }

  /** Résolution des fenêtres passées (crédit $1/share aux gagnants). */
  async resolveDue(): Promise<void> {
    const nowMs = Date.now();
    for (const position of this.tracker.getOpenPositions()) {
      if (position.windowEnd * 1000 > nowMs) continue;
      const winner = await resolveWindowWinner(
        this.effectiveConfig,
        this.repos,
        position.eventSlug,
        null,
        position.windowEnd,
      );
      if (!winner) continue; // non résolu : reste open, retenté au prochain sweep
      const slugPositions = this.tracker
        .getOpenPositions()
        .filter((p) => p.eventSlug === position.eventSlug && p.windowEnd === position.windowEnd);
      for (const pos of slugPositions) {
        const won = pos.outcomeIndex === winner.winnerOutcomeIndex;
        const credit = won ? pos.size : 0;
        this.ledger.credit(credit);
        pos.status = won ? "won" : "lost";
        pos.resolvedAt = nowMs;
        pos.pnl = round2(credit - pos.cost);
        this.tracker.resolvePosition(pos);
        bus.emit({ type: "simResolvedPosition", position: { ...pos } });
      }
      const pair = this.tracker.getPair(`${position.eventSlug}:${position.windowEnd}`);
      if (pair && pair.status !== "resolved") {
        const allResolved =
          pair.cheapLegs.every((leg) => leg.status !== "open") &&
          pair.expensiveLegs.every((leg) => leg.status !== "open");
        if (allResolved) this.tracker.finalizePair(pair);
      }
    }
    this.emitBalance();
  }

  getState(): SimEngineState {
    return {
      enabled: this.enabled,
      cash: this.ledger.getBalance(),
      positionsValue: this.positionsValue(),
      total: round2(this.ledger.getBalance() + this.positionsValue()),
      capitalInitial: this.capitalInitial,
      strategyId: this.effectiveConfig.strategyId,
      presetId: this.presetId,
      stats: this.computeStats(),
    };
  }

  getOpenPositions(): SimulatedPosition[] {
    return this.tracker.getOpenPositions();
  }

  getResolvedPositions(): SimulatedPosition[] {
    return this.tracker.getResolvedPositions();
  }

  getRestingForSlug(slug: string): Array<{
    key: string;
    tokenId: string;
    outcome: string;
    kind: string;
    limitPrice: number;
    size: number;
    cost: number;
    windowEnd: number;
  }> {
    const orders = slug ? this.resting.listForSlug(slug) : this.resting.listAll();
    return orders.map((order) => ({
      key: order.key,
      tokenId: order.context.tokenId,
      outcome: order.context.outcome,
      kind: order.context.kind,
      limitPrice: order.context.limitPrice,
      size: order.context.size,
      cost: order.cost,
      windowEnd: order.context.windowEnd,
    }));
  }

  getRecentTrades(limit: number): SimTradeRow[] {
    return this.repos?.simTrades.recent(limit) ?? [];
  }

  private simConfigState() {
    return {
      enabled: this.enabled,
      strategyId: this.effectiveConfig.strategyId,
      presetId: this.presetId,
      capitalInitial: this.capitalInitial,
    };
  }

  /**
   * Reconstruit les GTC resting papier d'un slug depuis les postedOrders du
   * tracker (persistés en DB) : sans cela, les ordres survivent au restart
   * dans le tracker mais ne sont plus jamais matchés ni annulés.
   */
  private syncRestingFromTracker(event: UpDownEvent): void {
    const existing = new Set(this.resting.listForSlug(event.slug).map((o) => o.key));
    for (const order of this.tracker.getAllPostedOrders()) {
      if (order.eventSlug !== event.slug || existing.has(order.key)) continue;
      const opportunity = {
        kind: order.kind,
        event,
        token: {
          tokenId: order.tokenId,
          outcome: order.outcome,
          outcomeIndex: order.outcomeIndex,
          bestBid: null,
          bestAsk: null,
          bestAskSize: null,
          bestBidSize: null,
        },
        price: order.limitPrice,
        size: order.size,
        tickSize: "0.01",
        negRisk: event.market.negRisk,
        tradeKey: order.key,
        pairId: order.pairId,
      };
      this.resting.post(opportunity, round2(order.limitPrice * order.size), this.effectiveConfig.strategyId);
    }
  }

  private persistSimTrade(row: {
    ts: number;
    eventSlug: string;
    kind: string;
    outcome: string;
    side: string;
    limitPrice: number;
    fillPrice: number | null;
    size: number;
    filled: number;
    reason: string | null;
    fillReason: string | null;
    orderType: string | null;
    pairId: string | null;
    pnl: number | null;
  }): void {
    const simRow: SimTradeRow = { ...row };
    this.repos?.simTrades.insert(simRow);
  }

  private positionsValue(): number {
    let total = 0;
    for (const position of this.tracker.getOpenPositions()) {
      const bid = this.lastBids.get(position.tokenId) ?? position.fillPrice;
      total = round2(total + bid * position.size);
    }
    return total;
  }

  private computeStats(): SimulatedStats {
    const openPositions = this.tracker.getOpenPositions();
    const wins = this.tracker.getCumulativeWins();
    const losses = this.tracker.getCumulativeLosses();
    const resolved = wins + losses;
    const coveredCount = this.tracker.getCoveredCount();
    const uncoveredCount = this.tracker.getUncoveredCount();
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
      fillRate: 0,
      totalAttempted: 0,
      totalFilled: resolved + openPositions.length,
      coveredCount,
      uncoveredCount,
      coverRate: coveredCount + uncoveredCount > 0 ? coveredCount / (coveredCount + uncoveredCount) : 0,
    };
  }

  private emitBalance(): void {
    const state = this.getState();
    bus.emit({
      type: "simBalance",
      balance: { cash: state.cash, positionsValue: state.positionsValue, total: state.total },
    });
    bus.emit({ type: "simStats", stats: state.stats });
  }

  private pruneTrades(): void {
    // Rétention sim_trades : 7 jours.
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    this.repos?.simTrades.deleteOlderThan(cutoff);
  }
}