import type {
  ArbPairStatus,
  PositionKind,
  SimulatedArbPair,
  SimulatedPosition,
} from "./types.js";
import { log } from "./logger.js";
import { asStrategyId, type StrategyId } from "./strategy/ids.js";
import { MIN_CLOB_SHARES } from "./utils/prices.js";
import { VOID_SETTLEMENT_PRICE } from "./position-resolver.js";
import type {
  PostedOrderRow,
  WindowClaimRow,
} from "./db/repositories.js";

// Interfaces structurelles : le tracker accepte aussi bien les repos live
// (PositionRepository...) que leurs miroirs paper trading (SimPositionRepository...).
interface TrackerPositionsRepo {
  open(): SimulatedPosition[];
  recentResolved(limit: number): SimulatedPosition[];
  byPairIds(ids: string[]): SimulatedPosition[];
  countLegsByKind(pairId: string, kind: string): number;
  getAggregateStats(): { pnl: number; wins: number; losses: number };
  insert(position: SimulatedPosition): void;
  updateStatus(position: SimulatedPosition): void;
}

interface TrackerPairsRepo {
  unresolved(): SimulatedArbPair[];
  recentResolved(limit: number): SimulatedArbPair[];
  getAggregateStats(): {
    arbPnl: number;
    directionalPnl: number;
    coveredCount: number;
    uncoveredCount: number;
  };
  upsert(pair: SimulatedArbPair): void;
}

interface TrackerKeysRepo {
  all(): Array<{ key: string; createdAt: number }>;
  mark(key: string): void;
  delete(key: string): void;
}

interface TrackerRetriesRepo {
  all(): Map<string, { count: number; updatedAt: number }>;
  increment(key: string): number;
}

interface TrackerWindowClaimsRepo {
  all(): Map<string, WindowClaimRow>;
  set(pairId: string, claim: WindowClaimRow): void;
  delete(pairId: string): void;
}

interface TrackerPostedOrdersRepo {
  all(): PostedOrderRow[];
  insert(order: PostedOrderRow): void;
  delete(key: string): void;
  pruneStale(nowSeconds: number): void;
}

interface WindowClaim {
  cheapOutcome: string;
  expensiveOutcome: string;
}

// Contexte complet d'un ordre placé, suffisant pour recréer une position live
// au moment où l'ordre est détecté rempli (GTC). Réutilisé par le dashboard et
// par le bot pour émettre un événement openedPosition.
export interface PostedOrderContext {
  eventSlug: string;
  windowEnd: number;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: PositionKind;
  limitPrice: number;
  size: number;
  pairId: string;
  eventTitle: string;
  bestAskAtFill: number | null;
  strategyId?: StrategyId;
}

export type PostedOrderEntry = PostedOrderContext & {
  cost: number;
  orderId?: string;
};

const MAX_RESOLVED_IN_MEMORY = 500;

export class TradeTracker {
  private readonly keys = new Map<string, number>();
  private readonly openPositions: SimulatedPosition[] = [];
  private readonly resolvedPositions: SimulatedPosition[] = [];
  private readonly pairs = new Map<string, SimulatedArbPair>();
  private readonly retryCounts = new Map<string, { count: number; updatedAt: number }>();
  private readonly windowClaims = new Map<string, WindowClaim>();
  private readonly postedOrders = new Map<string, PostedOrderEntry>();
  private cumulativeRealizedPnl = 0;
  private cumulativeWins = 0;
  private cumulativeLosses = 0;
  private pairStats = {
    arbPnl: 0,
    directionalPnl: 0,
    coveredCount: 0,
    uncoveredCount: 0,
  };

  constructor(
    private readonly positionsRepo?: TrackerPositionsRepo,
    private readonly pairsRepo?: TrackerPairsRepo,
    private readonly keysRepo?: TrackerKeysRepo,
    private readonly retriesRepo?: TrackerRetriesRepo,
    private readonly windowClaimsRepo?: TrackerWindowClaimsRepo,
    private readonly postedOrdersRepo?: TrackerPostedOrdersRepo,
  ) {}

  loadFromDb(): void {
    if (!this.positionsRepo || !this.pairsRepo) return;

    const openPositions = this.positionsRepo.open();
    this.openPositions.push(...openPositions);
    // Ne garder en mémoire que les MAX_RESOLVED_IN_MEMORY plus récentes résolues.
    // Les compteurs globaux (PnL/wins/losses) sont calculés via SQL pour ne pas
    // perdre l'historique complet.
    const recentResolved = this.positionsRepo.recentResolved(MAX_RESOLVED_IN_MEMORY);
    this.resolvedPositions.push(...recentResolved);

    const stats = this.positionsRepo.getAggregateStats();
    this.cumulativeRealizedPnl = stats.pnl;
    this.cumulativeWins = stats.wins;
    this.cumulativeLosses = stats.losses;

    const unresolved = this.pairsRepo.unresolved();
    const recentResolvedPairs = this.pairsRepo.recentResolved(MAX_RESOLVED_IN_MEMORY);
    this.pairStats = this.pairsRepo.getAggregateStats();
    // Les paires résolues ont realizedPnl/directional persistés — leurs legs ne
    // servent plus après finalisation. On ne charge que les legs des paires
    // ouvertes/partielles/couvertes pour reconstruire l'exposition.
    const openPairIds = unresolved.map((pair) => pair.id);
    const legs = openPairIds.length > 0 ? this.positionsRepo.byPairIds(openPairIds) : [];
    const openById = new Map(this.openPositions.map((p) => [p.id, p]));
    for (const pair of [...unresolved, ...recentResolvedPairs]) {
      if (pair.status !== "resolved") {
        pair.cheapLegs = legs
          .filter((p) => p.pairId === pair.id && p.kind === "cheap")
          .map((p) => openById.get(p.id) ?? p);
        pair.expensiveLegs = legs
          .filter(
            (p) =>
              p.pairId === pair.id &&
              // kind "manual" est rangé dans expensiveLegs par attachLeg
              // (fallback du ternaire cheap/expensive) — le garder ici pour
              // que la paire manuelle survive au restart.
              (p.kind === "expensive" || p.kind === "manual"),
          )
          .map((p) => openById.get(p.id) ?? p);
      }
      this.pairs.set(pair.id, pair);
    }

    // Catch-up finalisation : après un restart (crash, tsx watch), une paire
    // dont toutes les jambes sont déjà résolues (won/lost) mais qui n'a pas
    // été finalisée avant l'arrêt resterait sinon 'partial'/'covered' pour
    // toujours — realizedPnl/directional jamais écrits, stats faussées.
    // resolvePosition() ne re-traite pas ces jambes (déjà hors openPositions),
    // donc finalizePair() ne serait jamais rappelé. Les paires 'open' sans
    // aucune jambe sont ignorées : elles attendent leurs jambes.
    for (const pair of this.pairs.values()) {
      if (pair.status === "resolved") continue;
      const hasLegs = pair.cheapLegs.length + pair.expensiveLegs.length > 0;
      const allLegsResolved =
        pair.cheapLegs.every((leg) => leg.status !== "open") &&
        pair.expensiveLegs.every((leg) => leg.status !== "open");
      if (hasLegs && allLegsResolved) {
        this.finalizePair(pair);
      }
    }

    if (this.keysRepo) {
      for (const row of this.keysRepo.all()) this.keys.set(row.key, row.createdAt);
    }
    if (this.retriesRepo) {
      for (const [key, entry] of this.retriesRepo.all()) {
        this.retryCounts.set(key, entry);
      }
    }
    if (this.windowClaimsRepo) {
      for (const [pairId, claim] of this.windowClaimsRepo.all()) {
        this.windowClaims.set(pairId, claim);
      }
    }
    if (this.postedOrdersRepo) {
      for (const order of this.postedOrdersRepo.all()) {
        this.postedOrders.set(order.key, {
          eventSlug: order.eventSlug,
          windowEnd: order.windowEnd,
          cost: order.cost,
          orderId: order.orderId,
          tokenId: order.tokenId ?? "",
          outcome: order.outcome ?? "",
          outcomeIndex: order.outcomeIndex ?? 0,
          kind: (order.kind as "cheap" | "expensive") ?? "cheap",
          limitPrice: order.limitPrice ?? 0,
          size: order.size ?? 0,
          pairId: order.pairId ?? "",
          eventTitle: order.eventTitle ?? "",
          bestAskAtFill: order.bestAskAtFill ?? null,
          strategyId: asStrategyId(order.strategyId),
        });
      }
    }
  }

  reset(): void {
    this.keys.clear();
    this.openPositions.length = 0;
    this.resolvedPositions.length = 0;
    this.pairs.clear();
    this.retryCounts.clear();
    this.windowClaims.clear();
    this.postedOrders.clear();
    this.cumulativeRealizedPnl = 0;
    this.cumulativeWins = 0;
    this.cumulativeLosses = 0;
    this.pairStats = {
      arbPnl: 0,
      directionalPnl: 0,
      coveredCount: 0,
      uncoveredCount: 0,
    };
  }

  makeKey(
    eventSlug: string,
    outcome: string,
    kind: "cheap" | "expensive",
    price: number,
  ): string {
    return `${eventSlug}:${outcome}:${kind}-${price}`;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  mark(key: string): void {
    this.keys.set(key, Date.now());
    this.keysRepo?.mark(key);
  }

  unmark(key: string): void {
    this.keys.delete(key);
    this.keysRepo?.delete(key);
  }

  addOpenPosition(position: SimulatedPosition): void {
    this.openPositions.push(position);
    this.positionsRepo?.insert(position);
  }

  getOpenPositions(): SimulatedPosition[] {
    return [...this.openPositions];
  }

  countOpenPositionsForSide(eventSlug: string, outcome: string): number {
    return this.openPositions.filter(
      (p) => p.eventSlug === eventSlug && p.outcome === outcome,
    ).length;
  }

  /**
   * Compte en DB le nombre de jambes d'un kind donné pour un pairId, tout
   * statut confondu. Backstop DB-backed au guard mémoire : si le Map
   * postedOrders est vide après un restart tsx watch, ce compteur empêche
   * quand même l'empilement de plusieurs jambes cheap sur la même fenêtre.
   */
  countLegsByKind(pairId: string, kind: "cheap" | "expensive"): number {
    if (this.positionsRepo) return this.positionsRepo.countLegsByKind(pairId, kind);
    return [...this.openPositions, ...this.resolvedPositions].filter(
      (p) => p.pairId === pairId && p.kind === kind,
    ).length;
  }

  /**
   * Nombre d'ordres live GTC en attente sur le carnet (resting) pour un
   * (eventSlug, outcome) donné. En mode live, ces ordres ne sont pas encore
   * des positions ouvertes mais ils représentent une exposition future
   * potentielle : ils doivent être comptabilisés dans le garde-fou
   * maxOpenPositionsPerSide pour éviter d'empiler plusieurs ordres sur le
   * même outcome tant que le précédent n'est ni rempli ni annulé.
   */
  countPendingOrdersForSide(eventSlug: string, outcome: string): number {
    let count = 0;
    for (const order of this.postedOrders.values()) {
      if (order.eventSlug === eventSlug && order.outcome === outcome) {
        count++;
      }
    }
    return count;
  }

  /** Filled cheap shares only. FOK hedges must wait for this — not a resting GTC. */
  getFilledCheapSizeForPair(pairId: string): number {
    return this.getFilledSizeForPair(pairId, "cheap");
  }

  /** Filled expensive shares only. Used to skip defense on an already-covered pair. */
  getFilledExpensiveSizeForPair(pairId: string): number {
    return this.getFilledSizeForPair(pairId, "expensive");
  }

  private getFilledSizeForPair(
    pairId: string,
    kind: "cheap" | "expensive",
  ): number {
    let total = 0;
    for (const position of this.openPositions) {
      if (position.pairId === pairId && position.kind === kind) {
        total += position.size;
      }
    }
    return total;
  }

  /**
   * Volume-weighted average fill price of the cheap legs for a pair.
   * Used for pair cost re-validation at hedge posting time (S2.3).
   * Returns null if no cheap leg has been filled.
   */
  getCheapFillPriceForPair(pairId: string): number | null {
    let totalCost = 0;
    let totalSize = 0;
    for (const position of this.openPositions) {
      if (position.pairId === pairId && position.kind === "cheap") {
        totalCost += position.fillPrice * position.size;
        totalSize += position.size;
      }
    }
    if (totalSize === 0) return null;
    return Math.round((totalCost / totalSize) * 100) / 100;
  }

  /**
   * Returns the tokenId of the cheap leg for a pair (from the first
   * filled cheap position). Used by defendPair to know which token to
   * sell when the pair can no longer be covered.
   */
  getCheapTokenForPair(pairId: string): string | null {
    for (const position of this.openPositions) {
      if (position.pairId === pairId && position.kind === "cheap") {
        return position.tokenId;
      }
    }
    return null;
  }

  /**
   * Returns the tokenId of the expensive (edge) leg for a pair (from the
   * first filled expensive position). Used by edge-lead to know which
   * token to sell when the edge is a naked favorite.
   */
  getExpensiveTokenForPair(pairId: string): string | null {
    for (const position of this.openPositions) {
      if (position.pairId === pairId && position.kind === "expensive") {
        return position.tokenId;
      }
    }
    return null;
  }

  /**
   * Volume-weighted average fill price of the expensive (edge) legs for a
   * pair. Used by edge-lead to measure the loss % of a naked favorite.
   * Returns null if no expensive leg has been filled.
   */
  getExpensiveFillPriceForPair(pairId: string): number | null {
    let totalCost = 0;
    let totalSize = 0;
    for (const position of this.openPositions) {
      if (position.pairId === pairId && position.kind === "expensive") {
        totalCost += position.fillPrice * position.size;
        totalSize += position.size;
      }
    }
    if (totalSize === 0) return null;
    return Math.round((totalCost / totalSize) * 100) / 100;
  }

  /**
   * Shares already committed on the cheap leg of a pair (open fills + GTC
   * working remainder). Used to know a cheap leg exists before posting a hedge.
   * Resolved legs are ignored. A posted row that is only the crash duplicate
   * of an already-open fill is not counted twice.
   */
  getCheapSizeForPair(pairId: string): number {
    let total = this.getFilledCheapSizeForPair(pairId);
    for (const order of this.postedOrders.values()) {
      if (order.pairId === pairId && order.kind === "cheap") {
        total += this.postedWorkingRemainder(order).size;
      }
    }
    return total;
  }

  /**
   * Shares already committed on the expensive/hedge leg (open fills + GTC
   * working remainder). Used by reverseHedgeCapToFilledCheap so resting
   * hedges consume the cap across ticks, not only filled size.
   */
  getExpensiveSizeForPair(pairId: string): number {
    let total = this.getFilledExpensiveSizeForPair(pairId);
    for (const order of this.postedOrders.values()) {
      if (order.pairId === pairId && order.kind === "expensive") {
        total += this.postedWorkingRemainder(order).size;
      }
    }
    return total;
  }

  getResolvedPositions(): SimulatedPosition[] {
    return [...this.resolvedPositions].sort(
      (a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0),
    );
  }

  getRealizedPnl(): number {
    return this.cumulativeRealizedPnl;
  }

  getCumulativeWins(): number {
    return this.cumulativeWins;
  }

  getCumulativeLosses(): number {
    return this.cumulativeLosses;
  }

  getCumulativeResolvedCount(): number {
    return this.cumulativeWins + this.cumulativeLosses;
  }

  getOpenExposure(): number {
    return this.openPositions.reduce(
      (sum, position) => sum + position.cost,
      0,
    );
  }

  incrementRetry(key: string): void {
    const next = (this.retryCounts.get(key)?.count ?? 0) + 1;
    this.retryCounts.set(key, { count: next, updatedAt: Date.now() });
    this.retriesRepo?.increment(key);
  }

  getRetryCount(key: string): number {
    return this.retryCounts.get(key)?.count ?? 0;
  }

  recordPostedOrder(
    key: string,
    eventSlug: string,
    windowEnd: number,
    cost: number,
    orderId: string | undefined,
    context: PostedOrderContext,
  ): void {
    this.postedOrders.set(key, {
      eventSlug,
      windowEnd,
      cost,
      orderId,
      tokenId: context.tokenId,
      outcome: context.outcome,
      outcomeIndex: context.outcomeIndex,
      kind: context.kind,
      limitPrice: context.limitPrice,
      size: context.size,
      pairId: context.pairId,
      eventTitle: context.eventTitle,
      bestAskAtFill: context.bestAskAtFill,
      strategyId: context.strategyId,
    });
    const row: PostedOrderRow = {
      key,
      eventSlug,
      windowEnd,
      cost,
      createdAt: Date.now(),
      orderId,
      tokenId: context.tokenId,
      outcome: context.outcome,
      outcomeIndex: context.outcomeIndex,
      kind: context.kind,
      limitPrice: context.limitPrice,
      size: context.size,
      pairId: context.pairId,
      eventTitle: context.eventTitle,
      bestAskAtFill: context.bestAskAtFill,
      strategyId: context.strategyId,
    };
    this.postedOrdersRepo?.insert(row);
  }

  removePostedOrder(key: string): void {
    this.postedOrders.delete(key);
    this.postedOrdersRepo?.delete(key);
  }

  /** Shrink a resting GTC after a partial fill so size/cost match the remainder. */
  updatePostedRemainder(key: string, size: number, cost: number): void {
    const order = this.postedOrders.get(key);
    if (!order) return;
    order.size = size;
    order.cost = cost;
    this.postedOrdersRepo?.insert({
      key,
      eventSlug: order.eventSlug,
      windowEnd: order.windowEnd,
      cost,
      createdAt: Date.now(),
      orderId: order.orderId,
      tokenId: order.tokenId,
      outcome: order.outcome,
      outcomeIndex: order.outcomeIndex,
      kind: order.kind,
      limitPrice: order.limitPrice,
      size,
      pairId: order.pairId,
      eventTitle: order.eventTitle,
      bestAskAtFill: order.bestAskAtFill,
      strategyId: order.strategyId,
    });
  }

  getStalePostedOrders(
    nowSeconds: number,
  ): Array<{ key: string; orderId?: string } & PostedOrderContext> {
    const stale: Array<{ key: string; orderId?: string } & PostedOrderContext> = [];
    for (const [key, order] of this.postedOrders) {
      if (order.windowEnd + 300 < nowSeconds) {
        stale.push({ key, orderId: order.orderId, ...this.toContext(order) });
      }
    }
    return stale;
  }

  getPostedOrdersWithOrderId(): Array<{ key: string; orderId: string } & PostedOrderContext> {
    const result: Array<{ key: string; orderId: string } & PostedOrderContext> = [];
    for (const [key, order] of this.postedOrders) {
      if (order.orderId) result.push({ key, orderId: order.orderId, ...this.toContext(order) });
    }
    return result;
  }

  /** Tous les ordres GTC reposés (toute fenêtre) — garde toggle trading par famille. */
  getAllPostedOrders(): Array<{ key: string } & PostedOrderContext> {
    const result: Array<{ key: string } & PostedOrderContext> = [];
    for (const [key, order] of this.postedOrders) {
      result.push({ key, ...this.toContext(order) });
    }
    return result;
  }

  private toContext(order: PostedOrderEntry): PostedOrderContext {
    const { cost: _cost, orderId: _orderId, ...context } = order;
    return context;
  }

  /**
   * True when this posted row is the same working order as an open fill
   * (crash between addOpenPosition and removePostedOrder, or a GTC
   * remainder after a partial fill). Match by CLOB orderId when we have
   * one — tokenId alone would drop a second resting cheap on the same
   * outcome if maxOpenPositionsPerSide > 1.
   */
  private postedOverlapsOpen(order: PostedOrderEntry): boolean {
    return this.overlappingOpenSize(order) > 1e-9;
  }

  private overlappingOpenSize(order: PostedOrderEntry): number {
    let total = 0;
    if (order.orderId) {
      const liveId = `live:${order.orderId}`;
      for (const position of this.openPositions) {
        if (position.id === liveId) total += position.size;
      }
      return total;
    }
    for (const position of this.openPositions) {
      if (
        position.pairId === order.pairId &&
        position.kind === order.kind &&
        position.tokenId === order.tokenId
      ) {
        total += position.size;
      }
    }
    return total;
  }

  /**
   * Working size/cost still on the book. Skip only when open positions
   * already cover the posted size (full-fill crash duplicate). After a
   * partial fill the posted row is the remainder (`updatePostedRemainder`)
   * and must still count toward exposure / committed size.
   */
  private postedWorkingRemainder(order: PostedOrderEntry): { size: number; cost: number } {
    if (!this.postedOverlapsOpen(order)) {
      return { size: order.size, cost: order.cost };
    }
    if (this.overlappingOpenSize(order) + 1e-9 >= order.size) {
      return { size: 0, cost: 0 };
    }
    return { size: order.size, cost: order.cost };
  }

  getRestingExposure(): number {
    let total = 0;
    for (const order of this.postedOrders.values()) {
      total += this.postedWorkingRemainder(order).cost;
    }
    return total;
  }

  prunePostedOrders(nowSeconds: number): void {
    for (const [key, order] of this.postedOrders) {
      const age = nowSeconds - order.windowEnd;
      const noAck = !order.orderId && age > 900;
      const ancient = age > 86_400;
      if (!noAck && !ancient) continue;
      if (ancient && order.orderId) {
        log("Posted order pruned after 24h without confirmed cancel", {
          orderId: order.orderId,
          eventSlug: order.eventSlug,
        });
      }
      this.postedOrders.delete(key);
    }
    this.postedOrdersRepo?.pruneStale(nowSeconds);
  }

  pruneWindowClaims(nowSeconds: number): void {
    for (const pairId of this.windowClaims.keys()) {
      const match = pairId.match(/:(\d{10})$/);
      if (!match) continue;
      if (Number(match[1]) + 900 < nowSeconds) {
        this.windowClaims.delete(pairId);
        this.windowClaimsRepo?.delete(pairId);
      }
    }
  }

  claimWindowOutcomes(
    pairId: string,
    cheapOutcome: string,
    expensiveOutcome: string,
  ): void {
    if (!this.windowClaims.has(pairId)) {
      this.windowClaims.set(pairId, { cheapOutcome, expensiveOutcome });
      this.windowClaimsRepo?.set(pairId, { cheapOutcome, expensiveOutcome });
    }
  }

  setWindowClaimExpensive(pairId: string, expensiveOutcome: string): void {
    const existing = this.windowClaims.get(pairId);
    if (!existing || existing.expensiveOutcome) return;
    const next = { ...existing, expensiveOutcome };
    this.windowClaims.set(pairId, next);
    this.windowClaimsRepo?.set(pairId, next);
  }

  getWindowClaim(pairId: string): WindowClaim | undefined {
    return this.windowClaims.get(pairId);
  }

  clearWindowClaim(pairId: string): void {
    this.windowClaims.delete(pairId);
    this.windowClaimsRepo?.delete(pairId);
  }

  getOrCreatePair(eventSlug: string, eventTitle: string, windowEnd: number): SimulatedArbPair {
    const id = `${eventSlug}:${windowEnd}`;
    let pair = this.pairs.get(id);
    if (!pair) {
      pair = {
        id,
        eventSlug,
        eventTitle,
        windowEnd,
        cheapLegs: [],
        expensiveLegs: [],
        status: "open",
      };
      this.pairs.set(id, pair);
      this.pairsRepo?.upsert(pair);
    }
    return pair;
  }

  getPair(pairId: string): SimulatedArbPair | undefined {
    return this.pairs.get(pairId);
  }

  attachLeg(position: SimulatedPosition): void {
    const pair = this.getOrCreatePair(
      position.eventSlug,
      position.eventTitle,
      position.windowEnd,
    );
    const legs =
      position.kind === "cheap" ? pair.cheapLegs : pair.expensiveLegs;
    if (!legs.some((leg) => leg.id === position.id)) {
      legs.push(position);
    }
    pair.status = this.computePairStatus(pair);
    this.pairsRepo?.upsert(pair);
  }

  private computePairStatus(pair: SimulatedArbPair): ArbPairStatus {
    const hasCheap = pair.cheapLegs.length > 0;
    const hasExpensive = pair.expensiveLegs.length > 0;
    if (hasCheap && hasExpensive) return "covered";
    if (hasCheap || hasExpensive) return "partial";
    return "open";
  }

  getOpenPairs(): SimulatedArbPair[] {
    return [...this.pairs.values()].filter((pair) => pair.status !== "resolved");
  }

  getResolvedPairs(): SimulatedArbPair[] {
    return [...this.pairs.values()].filter((pair) => pair.status === "resolved");
  }

  getArbRealizedPnl(): number {
    if (this.pairsRepo) return this.pairStats.arbPnl;
    return this.getResolvedPairs().reduce(
      (sum, pair) => sum + (pair.directional ? 0 : pair.realizedPnl ?? 0),
      0,
    );
  }

  getDirectionalRealizedPnl(): number {
    if (this.pairsRepo) return this.pairStats.directionalPnl;
    return this.getResolvedPairs().reduce(
      (sum, pair) => sum + (pair.directional ? pair.realizedPnl ?? 0 : 0),
      0,
    );
  }

  getCoveredExposure(): number {
    return this.getOpenPairs()
      .filter((pair) => pair.status === "covered")
      .reduce(
        (sum, pair) =>
          sum +
          pair.cheapLegs.filter((l) => l.status === "open").reduce((s, l) => s + l.cost, 0) +
          pair.expensiveLegs.filter((l) => l.status === "open").reduce((s, l) => s + l.cost, 0),
        0,
      );
  }

  getUncoveredExposure(): number {
    return this.getOpenPairs()
      .filter((pair) => pair.status === "partial")
      .reduce(
        (sum, pair) =>
          sum +
          pair.cheapLegs.filter((l) => l.status === "open").reduce((s, l) => s + l.cost, 0) +
          pair.expensiveLegs.filter((l) => l.status === "open").reduce((s, l) => s + l.cost, 0),
        0,
      );
  }

  getCoveredCount(): number {
    if (this.pairsRepo) return this.pairStats.coveredCount;
    return this.getResolvedPairs().filter((pair) => !pair.directional).length;
  }

  getUncoveredCount(): number {
    if (this.pairsRepo) return this.pairStats.uncoveredCount;
    return this.getResolvedPairs().filter((pair) => pair.directional).length;
  }

  resolvePosition(position: SimulatedPosition): void {
    const index = this.openPositions.findIndex((p) => p.id === position.id);
    if (index !== -1) {
      this.openPositions.splice(index, 1);
    }
    this.cumulativeRealizedPnl += position.pnl ?? 0;
    if (position.status === "won") this.cumulativeWins++;
    if (position.status === "lost") this.cumulativeLosses++;
    // "void"/"sold" ne comptent ni victoire ni défaite : le PnL ci-dessus
    // rentre quand même dans le réalisé (getAggregateStats compte sur
    // status != 'open'), mais le winrate les exclut — un remboursement 50/50
    // n'est ni un bon ni un mauvais call directionnel.
    this.resolvedPositions.push(position);
    if (this.positionsRepo && this.resolvedPositions.length > MAX_RESOLVED_IN_MEMORY) {
      this.resolvedPositions.shift();
    }
    this.positionsRepo?.updateStatus(position);
  }

  /**
   * Removes an already-resolved position from the open list WITHOUT
   * re-counting its PnL/wins/losses. Used by the PositionResolver guard
   * when a position is already resolved (status !== "open") but still
   * appears in getOpenPositions() due to a race or restart.
   */
  pruneResolvedPosition(position: SimulatedPosition): void {
    const index = this.openPositions.findIndex((p) => p.id === position.id);
    if (index !== -1) {
      this.openPositions.splice(index, 1);
    }
    // Do NOT add to cumulativeRealizedPnl/wins/losses — already counted.
    // Only persist the status in case it wasn't saved.
    this.positionsRepo?.updateStatus(position);
  }

  /**
   * Pair defense (S2.4): resolves the filled cheap legs of a pair as SOLD
   * at `sellPrice × size` proceeds. Used after a successful FOK SELL by
   * defendPair, when the pair can no longer be covered. Without this, the
   * sold cheap stays in openPositions: exposure stays inflated,
   * getFilledCheapSizeForPair stays > 0 (a hedge could be posted against a
   * cheap already sold), and the resolver would later re-count the same
   * leg (double PnL).
   */
  closePairCheapAsSold(
    pairId: string,
    sellPrice: number,
    soldSize: number,
    nowMs: number = Date.now(),
  ): number {
    let remaining = soldSize;
    let closedCount = 0;
    for (const position of [...this.openPositions]) {
      if (remaining <= 0) break;
      if (position.pairId !== pairId || position.kind !== "cheap") continue;
      const closeSize = Math.min(position.size, remaining);
      const proceeds = Math.round(closeSize * sellPrice * 100) / 100;
      if (closeSize >= position.size) {
        position.status = "sold";
        position.resolvedAt = nowMs;
        position.sellPrice = sellPrice;
        position.pnl = round2(proceeds - position.cost);
        this.resolvePosition(position);
        closedCount++;
      } else {
        // Partial sale of a larger leg: split into a sold remainder and keep
        // the rest open (still an assumed directional position).
        const leftover = Math.round((position.size - closeSize) * 100) / 100;
        // Same dust rule as closePositionAsSold: a sub-MIN_CLOB_SHARES
        // remainder can never be sold again (CLOB minimum), so merge it
        // into the sold leg (booked at the sale price, like the
        // phantom-reconcile path) instead of leaving a ghost open leg.
        if (leftover < MIN_CLOB_SHARES) {
          const mergedSize = Math.round((closeSize + leftover) * 100) / 100;
          position.status = "sold";
          position.resolvedAt = nowMs;
          position.size = mergedSize;
          position.cost = Math.round(position.fillPrice * mergedSize * 100) / 100;
          position.sellPrice = sellPrice;
          position.pnl = round2(mergedSize * (sellPrice - position.fillPrice));
          this.positionsRepo?.insert(position);
          this.resolvePosition(position);
          closedCount++;
          remaining = 0;
          break;
        }
        position.size = leftover;
        position.cost = Math.round(position.fillPrice * position.size * 100) / 100;
        // Persist the shrunk remainder (INSERT OR REPLACE). Without this a
        // restart reloads the original size/cost → inflated exposure and an
        // over-sized 1:1 hedge target.
        this.positionsRepo?.insert(position);
        const sold: SimulatedPosition = {
          ...position,
          id: `${position.id}:sold-${nowMs}`,
          size: closeSize,
          cost: Math.round(position.fillPrice * closeSize * 100) / 100,
          status: "sold",
          resolvedAt: nowMs,
          sellPrice,
          pnl: round2(proceeds - Math.round(position.fillPrice * closeSize * 100) / 100),
        };
        this.openPositions.push(sold);
        this.positionsRepo?.insert(sold);
        this.resolvePosition(sold);
        closedCount++;
      }
      remaining = Math.round((remaining - closeSize) * 100) / 100;
    }

    // Finalize the pair when every leg is resolved (sold/won/lost) so the
    // pair-level realizedPnl is written once, like the resolver path does.
    if (closedCount > 0) {
      const pair = this.pairs.get(pairId);
      if (pair && pair.status !== "resolved") {
        const allLegsResolved =
          pair.cheapLegs.every((leg) => leg.status !== "open") &&
          pair.expensiveLegs.every((leg) => leg.status !== "open");
        if (allLegsResolved) {
          this.finalizePair(pair);
        }
      }
    }
    return closedCount;
  }

  /**
   * Edge-lead : résout les jambes expensive (edge) d'une paire comme SOLD
   * à `sellPrice × size` proceeds. Utilisé après un FOK SELL réussi de
   * l'edge nu (favori en perte, cheap jamais fillé). Miroir de
   * closePairCheapAsSold mais ciblant kind === "expensive".
   */
  closePairExpensiveAsSold(
    pairId: string,
    sellPrice: number,
    soldSize: number,
    nowMs: number = Date.now(),
  ): number {
    let remaining = soldSize;
    let closedCount = 0;
    for (const position of [...this.openPositions]) {
      if (remaining <= 0) break;
      if (position.pairId !== pairId || position.kind !== "expensive") continue;
      const closeSize = Math.min(position.size, remaining);
      const proceeds = Math.round(closeSize * sellPrice * 100) / 100;
      if (closeSize >= position.size) {
        position.status = "sold";
        position.resolvedAt = nowMs;
        position.sellPrice = sellPrice;
        position.pnl = round2(proceeds - position.cost);
        this.resolvePosition(position);
        closedCount++;
      } else {
        // Partial sale of a larger leg: split into a sold remainder and keep
        // the rest open.
        const leftover = Math.round((position.size - closeSize) * 100) / 100;
        // Same dust rule as closePositionAsSold: a sub-MIN_CLOB_SHARES
        // remainder can never be sold again (CLOB minimum), so merge it
        // into the sold leg (booked at the sale price, like the
        // phantom-reconcile path) instead of leaving a ghost open leg.
        if (leftover < MIN_CLOB_SHARES) {
          const mergedSize = Math.round((closeSize + leftover) * 100) / 100;
          position.status = "sold";
          position.resolvedAt = nowMs;
          position.size = mergedSize;
          position.cost = Math.round(position.fillPrice * mergedSize * 100) / 100;
          position.sellPrice = sellPrice;
          position.pnl = round2(mergedSize * (sellPrice - position.fillPrice));
          this.positionsRepo?.insert(position);
          this.resolvePosition(position);
          closedCount++;
          remaining = 0;
          break;
        }
        position.size = leftover;
        position.cost = Math.round(position.fillPrice * position.size * 100) / 100;
        this.positionsRepo?.insert(position);
        const sold: SimulatedPosition = {
          ...position,
          id: `${position.id}:sold-${nowMs}`,
          size: closeSize,
          cost: Math.round(position.fillPrice * closeSize * 100) / 100,
          status: "sold",
          resolvedAt: nowMs,
          sellPrice,
          pnl: round2(proceeds - Math.round(position.fillPrice * closeSize * 100) / 100),
        };
        this.openPositions.push(sold);
        this.positionsRepo?.insert(sold);
        this.resolvePosition(sold);
        closedCount++;
      }
      remaining = Math.round((remaining - closeSize) * 100) / 100;
    }

    if (closedCount > 0) {
      const pair = this.pairs.get(pairId);
      if (pair && pair.status !== "resolved") {
        const allLegsResolved =
          pair.cheapLegs.every((leg) => leg.status !== "open") &&
          pair.expensiveLegs.every((leg) => leg.status !== "open");
        if (allLegsResolved) {
          this.finalizePair(pair);
        }
      }
    }
    return closedCount;
  }

  /**
   * Fermeture manuelle d'UNE position ouverte (FOK SELL dashboard).
   * Ne touche que l'id demandé (pas toutes les jambes du même kind).
   */
  closePositionAsSold(
    positionId: string,
    sellPrice: number,
    soldSize?: number,
    nowMs: number = Date.now(),
  ): number {
    const position = this.openPositions.find(
      (p) => p.id === positionId && p.status === "open",
    );
    if (!position) return 0;
    const target = soldSize ?? position.size;
    const closeSize = Math.min(position.size, target);
    if (closeSize <= 0) return 0;
    const proceeds = Math.round(closeSize * sellPrice * 100) / 100;
    const pairId = position.pairId;
    if (closeSize >= position.size) {
      position.status = "sold";
      position.resolvedAt = nowMs;
      position.sellPrice = sellPrice;
      position.pnl = round2(proceeds - position.cost);
      this.resolvePosition(position);
    } else {
      const leftover = Math.round((position.size - closeSize) * 100) / 100;
      // The CLOB rejects sell orders below MIN_CLOB_SHARES, so a remainder
      // that small can never be sold again — the row would stick open until
      // market resolution (observed live: 5.075758 sold as 5.07 leaving a
      // 0.006-share ghost stuck in "Positions ouvertes"). Sellable remainders
      // stay open for a second close; unsellable dust merges into the sold
      // row (booked at the sale price, like the phantom-reconcile path)
      // so the position leaves the open list immediately.
      if (leftover < MIN_CLOB_SHARES) {
        const mergedSize = Math.round((closeSize + leftover) * 100) / 100;
        // Overwrite the ORIGINAL row (INSERT OR REPLACE): pushing a
        // separate :sold- child AND keeping the mutated open row would
        // double-count the leg after a restart (both rows reloaded).
        position.status = "sold";
        position.resolvedAt = nowMs;
        position.size = mergedSize;
        position.cost = Math.round(position.fillPrice * mergedSize * 100) / 100;
        position.sellPrice = sellPrice;
        position.pnl = round2(mergedSize * (sellPrice - position.fillPrice));
        this.positionsRepo?.insert(position);
        this.resolvePosition(position);
      } else {
        position.size = leftover;
        position.cost = Math.round(position.fillPrice * position.size * 100) / 100;
        this.positionsRepo?.insert(position);
        const sold: SimulatedPosition = {
          ...position,
          id: `${position.id}:sold-${nowMs}`,
          size: closeSize,
          cost: Math.round(position.fillPrice * closeSize * 100) / 100,
          status: "sold",
          resolvedAt: nowMs,
          sellPrice,
          pnl: round2(proceeds - Math.round(position.fillPrice * closeSize * 100) / 100),
        };
        this.openPositions.push(sold);
        this.positionsRepo?.insert(sold);
        this.resolvePosition(sold);
      }
    }
    const pair = this.pairs.get(pairId);
    if (pair && pair.status !== "resolved") {
      const allLegsResolved =
        pair.cheapLegs.every((leg) => leg.status !== "open") &&
        pair.expensiveLegs.every((leg) => leg.status !== "open");
      if (allLegsResolved) {
        this.finalizePair(pair);
      }
    }
    return 1;
  }

  finalizePair(pair: SimulatedArbPair): void {
    const cheapLegs = pair.cheapLegs;
    const expensiveLegs = pair.expensiveLegs;

    // Legs sold via pair defense (defendPair) realize their "credit" at the
    // sale proceeds (sellPrice × size) instead of a resolution payoff. Their
    // pnl is already recorded at sale time, so proceeds = pnl + cost —
    // including them with (pnl + cost) − cost nets to their realized pnl and
    // keeps the pair-level accounting complete (no double counting: the sale
    // proceeds enter once, as credit).
    const legCredit = (leg: SimulatedPosition): number =>
      leg.status === "won"
        ? leg.size
        : leg.status === "void"
          ? // Règlement 50/50 : remboursement au prix de settlement,
            // pas $1 — sinon une paire void compterait 2 × 0.5 de crédit
            // pour 1.0 de coût (perte fantôme).
            Math.round(leg.size * VOID_SETTLEMENT_PRICE * 100) / 100
          : leg.status === "sold"
            ? Math.round(((leg.pnl ?? 0) + leg.cost) * 100) / 100
            : 0;
    const totalCheapCredit = cheapLegs.reduce((sum, leg) => sum + legCredit(leg), 0);
    const totalExpensiveCredit = expensiveLegs.reduce((sum, leg) => sum + legCredit(leg), 0);
    const totalCheapCost = cheapLegs.reduce((sum, leg) => sum + leg.cost, 0);
    const totalExpensiveCost = expensiveLegs.reduce(
      (sum, leg) => sum + leg.cost,
      0,
    );

    pair.realizedPnl =
      totalCheapCredit +
      totalExpensiveCredit -
      totalCheapCost -
      totalExpensiveCost;
    pair.directional = cheapLegs.length === 0 || expensiveLegs.length === 0;
    pair.status = "resolved";
    pair.resolvedAt = Date.now();

    this.pairsRepo?.upsert(pair);
    if (this.pairsRepo) {
      this.pairStats = this.pairsRepo.getAggregateStats();
    } else if (pair.directional) {
      this.pairStats.uncoveredCount++;
      this.pairStats.directionalPnl += pair.realizedPnl ?? 0;
    } else {
      this.pairStats.coveredCount++;
      this.pairStats.arbPnl += pair.realizedPnl ?? 0;
    }
    this.evictOldResolvedPairs();
    this.clearWindowClaim(pair.id);
  }

  pruneMemory(beforeTs: number): void {
    for (const [key, createdAt] of this.keys) {
      if (createdAt < beforeTs) this.keys.delete(key);
    }
    for (const [key, entry] of this.retryCounts) {
      if (entry.updatedAt < beforeTs) this.retryCounts.delete(key);
    }
  }

  getPostedOrdersForPair(
    pairId: string,
    kind: "cheap" | "expensive",
  ): Array<{ key: string; orderId?: string } & PostedOrderContext> {
    const result: Array<{ key: string; orderId?: string } & PostedOrderContext> = [];
    for (const [key, order] of this.postedOrders) {
      if (order.pairId === pairId && order.kind === kind) {
        result.push({ key, orderId: order.orderId, ...this.toContext(order) });
      }
    }
    return result;
  }

  private evictOldResolvedPairs(): void {
    const resolved = [...this.pairs.values()]
      .filter((pair) => pair.status === "resolved")
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    for (const pair of resolved.slice(MAX_RESOLVED_IN_MEMORY)) {
      this.pairs.delete(pair.id);
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}