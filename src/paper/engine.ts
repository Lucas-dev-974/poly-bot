import { toPublicConfig, type BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import type { SimTradeRow } from "../db/repositories.js";
import { buildEffectiveConfig } from "../backtest/config-builder.js";
import { BacktestLedger, round2 } from "../backtest/ledger.js";
import { BacktestRestingBook } from "../backtest/resting.js";
import { resolveWindowWinner } from "../backtest/resolve.js";
import { VOID_SETTLEMENT_PRICE, VOID_WINNER_INDEX } from "../position-resolver.js";
import { processTick, type TickExecutorSink } from "../backtest/tick-executor.js";
import { createStrategy } from "../strategy/registry.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { StrategyId } from "../strategy/ids.js";
import type { FavBandStrategy, FavBandWhipsawStatus } from "../strategy/fav-band-strategy.js";
import { favBandLossStreak } from "../strategy/whipsaw.js";
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
      // Sémantique du patch :
      //  - preset explicite (ou null) SANS settings → REMPLACE tout : les
      //    settings hérités d'un preset/édition précédent sont purgés, sinon
      //    le vieux patch primerait sur le nouveau preset (bug « panneau ne
      //    suit pas le select »).
      //  - preset + settings ensemble → les settings sont une édition du
      //    nouveau preset (buildEffectiveConfig applique preset puis settings).
      //  - settings seuls → FUSION avec les settings courants (édition runtime
      //    champ par champ, le blob simConfig.settings est cumulatif).
      const presetChanged = patch.presetId !== undefined;
      const inherited = patch.settings
        ? { ...(presetChanged ? {} : (this.simConfig?.settings ?? {})), ...patch.settings }
        : presetChanged
          ? undefined
          : this.simConfig?.settings;
      const settings =
        inherited && Object.keys(inherited).length > 0 ? (inherited as RuntimeSettingsPatch) : undefined;
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

  /**
   * Archive les positions sim résolues (DB), les retire des tables live sim,
   * et vide l'historique résolu en mémoire. Les positions ouvertes, GTC resting,
   * capital et dédup restent intacts.
   */
  reset(): { batchId: string; archived: number } {
    const result = this.repos?.simPositions.archiveResolved() ?? {
      batchId: `sim-archive-${Date.now()}`,
      archived: 0,
    };
    this.repos?.simPairs.deleteResolved();
    this.tracker.clearResolvedHistory();
    this.emitBalance();
    bus.emit({ type: "simConfig", simConfig: this.simConfigState() });
    return result;
  }

  /** Point d'entrée par tick : books temps réel du bot live. */
  onBooks(
    event: UpDownEvent,
    books: TokenBook[],
    nowMs: number,
    opts?: { trading?: boolean },
  ): void {
    if (!this.enabled) return;
    // Mémorise les derniers bids (P&L latent page Simulation) — même sur les
    // familles non-tradables : valorisation P&L sans ouvrir de position.
    for (const book of books) {
      if (book.bestBid !== null) this.lastBids.set(book.tokenId, book.bestBid);
    }

    // Reconstruit le resting book depuis la DB pour ce slug au premier tick
    // après un restart (BacktestRestingBook est mémoire seule, le tracker
    // recharge ses postedOrders depuis sim_posted_orders).
    if (!this.restingSyncedSlugs.has(event.slug)) {
      this.syncRestingFromTracker(event);
      this.restingSyncedSlugs.add(event.slug);
    }

    // trading:false bloque les NOUVELLES entrées (allowNewEntries) mais laisse
    // tourner matchResting + manageRestingPolicy (defend / TP via shouldDefend,
    // edge-sell, cancel GTC) — miroir live manageLiveResting avant le gate
    // `if (!flags.trading) return`.
    // Antiflip TP : plus de boucle dédiée ici ; antiflip-revert.shouldDefend +
    // usesDefendAsExit passent par defendCheapLegs (parité live/paper).
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
      allowNewEntries: opts?.trading !== false,
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
    // Purge des GTC resting dont la fenêtre est passée (miroir closeWindow du
    // backtest) : sans cela ils resteraient en mémoire + dans sim_posted_orders
    // (panneau "Ordres en attente" pollué, reservedNotional capital fantôme).
    // processTick ne les matchera plus (slug non plus scanné après fenêtre).
    const nowSec = Math.floor(nowMs / 1000);
    for (const order of this.resting.listAll()) {
      if (order.context.windowEnd + 60 < nowSec) {
        this.resting.remove(order.key);
        this.tracker.removePostedOrder(order.key);
        this.tracker.unmark(order.key);
      }
    }
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
      // Void 50/50 (winnerOutcomeIndex 2) : remboursement au prix de
      // settlement (0.5) pour les deux jambes, statut "void" (hors winrate).
      const isVoid = winner.winnerOutcomeIndex === VOID_WINNER_INDEX;
      for (const pos of slugPositions) {
        let credit: number;
        if (isVoid) {
          credit = round2(pos.size * VOID_SETTLEMENT_PRICE);
          pos.status = "void";
        } else {
          const won = pos.outcomeIndex === winner.winnerOutcomeIndex;
          credit = won ? pos.size : 0;
          pos.status = won ? "won" : "lost";
        }
        this.ledger.credit(credit);
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

  /** Config effective du moteur (preset + settings appliqués) — pour le panneau config sim. */
  getEffectiveConfig(): BotConfig {
    return this.effectiveConfig;
  }

  getResolvedPositions(): SimulatedPosition[] {
    return this.tracker.getResolvedPositions();
  }

  /**
   * Statut du filtre whipsaw fav-band pour le panneau Simulation (miroir de
   * ReverseBot.getStrategyStatus). Le moteur sim partage FavBandStrategy avec
   * le bot live : la pause est armée par les pertes des positions SIMULÉES
   * (tracker sim), jamais par le live. Null si moteur ≠ fav-band.
   */
  getStrategyStatus(): FavBandWhipsawStatus | null {
    if (this.effectiveConfig.strategyId !== "fav-band") return null;
    const strategy = this.strategy as FavBandStrategy;
    const lossStreak = favBandLossStreak(this.tracker.getResolvedPositions());
    return strategy.getWhipsawStatus(this.effectiveConfig, Date.now(), lossStreak);
  }

  /** Réinitialise manuellement la pause whipsaw du moteur sim (fav-band). */
  resetWhipsawPause(): void {
    if (this.effectiveConfig.strategyId !== "fav-band") return;
    const strategy = this.strategy as FavBandStrategy;
    const lossStreak = favBandLossStreak(this.tracker.getResolvedPositions());
    strategy.resetWhipsawPause(lossStreak);
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
      effectiveConfig: toPublicConfig(this.effectiveConfig),
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

  /** P&L latent des positions ouvertes : Σ (bid live × size − cost). 0 si aucune. */
  private unrealizedPnl(): number {
    let total = 0;
    for (const position of this.tracker.getOpenPositions()) {
      const bid = this.lastBids.get(position.tokenId) ?? position.fillPrice;
      total = round2(total + (bid - position.fillPrice) * position.size);
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
      unrealizedPnl: this.unrealizedPnl(),
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
    // Persiste le cash à chaque émission (5s) : sans cela, les crédits de
    // résolution (ledger.credit dans resolveDue) ne sont jamais écrits en DB
    // (seuls les débits d'entrée l'étaient via onPositionOpened) → au restart,
    // un cash tronqué et des payouts perdus. Écriture idempotente, coût négligeable.
    this.repos?.simState.set("capitalCash", String(this.ledger.getBalance()));
    const state = this.getState();
    bus.emit({
      type: "simBalance",
      balance: { cash: state.cash, positionsValue: state.positionsValue, total: state.total },
    });
    bus.emit({ type: "simEngineStats", stats: state.stats });
    // Statut whipsaw fav-band du moteur sim : émis inconditionnellement (le
    // strategyId peut être swappé à chaud), null pour les moteurs non-fav-band
    // → le panneau Simulation masque l'entry au lieu d'afficher un statut figé.
    bus.emit({ type: "simStrategyStatus", status: this.getStrategyStatus() });
  }

  private pruneTrades(): void {
    // Rétention sim_trades : 7 jours.
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    this.repos?.simTrades.deleteOlderThan(cutoff);
  }
}