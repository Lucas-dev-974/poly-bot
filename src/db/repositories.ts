import type {
  ArbPairStatus,
  FillReason,
  PositionKind,
  PositionStatus,
  SimulatedArbPair,
  SimulatedPosition,
} from "../types.js";
import { asStrategyId } from "../strategy/ids.js";
import type { Database } from "./database.js";

interface PositionRow {
  id: string;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: PositionKind;
  limitPrice: number;
  fillPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
  status: PositionStatus;
  resolvedAt: number | null;
  pnl: number | null;
  fillReason: FillReason;
  pairId: string;
  bestAskAtFill: number | null;
  orderType: "GTC" | "FOK" | "FAK" | "SIM" | null;
  strategyId: string | null;
  sellPrice: number | null;
  createdAt: number;
}

interface PairRow {
  id: string;
  eventSlug: string;
  eventTitle: string;
  windowEnd: number;
  status: ArbPairStatus;
  realizedPnl: number | null;
  resolvedAt: number | null;
  directional: number | null;
}

function toPosition(row: PositionRow): SimulatedPosition {
  return {
    id: row.id,
    eventSlug: row.eventSlug,
    eventTitle: row.eventTitle,
    tokenId: row.tokenId,
    outcome: row.outcome,
    outcomeIndex: row.outcomeIndex,
    kind: row.kind,
    limitPrice: row.limitPrice,
    fillPrice: row.fillPrice,
    size: row.size,
    cost: row.cost,
    windowEnd: row.windowEnd,
    status: row.status,
    resolvedAt: row.resolvedAt ?? undefined,
    pnl: row.pnl ?? undefined,
    fillReason: row.fillReason,
    pairId: row.pairId,
    bestAskAtFill: row.bestAskAtFill ?? null,
    orderType: row.orderType ?? undefined,
    strategyId: asStrategyId(row.strategyId),
    sellPrice: row.sellPrice ?? null,
  };
}

export class PositionRepository {
  constructor(private readonly db: Database) {}

  insert(position: SimulatedPosition): void {
    this.db.run(
      `INSERT OR REPLACE INTO positions (
        id, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind,
        limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt,
        pnl, fillReason, pairId, bestAskAtFill, orderType, strategyId, sellPrice, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        position.id,
        position.eventSlug,
        position.eventTitle,
        position.tokenId,
        position.outcome,
        position.outcomeIndex,
        position.kind,
        position.limitPrice,
        position.fillPrice,
        position.size,
        position.cost,
        position.windowEnd,
        position.status,
        position.resolvedAt ?? null,
        position.pnl ?? null,
        position.fillReason,
        position.pairId,
        position.bestAskAtFill ?? null,
        position.orderType ?? null,
        position.strategyId ?? null,
        position.sellPrice ?? null,
        Date.now(),
      ],
    );
  }

  updateStatus(position: SimulatedPosition): void {
    this.db.run(
      `UPDATE positions SET status = ?, resolvedAt = ?, pnl = ?, sellPrice = ? WHERE id = ?`,
      [position.status, position.resolvedAt ?? null, position.pnl ?? null, position.sellPrice ?? null, position.id],
    );
  }

  open(): SimulatedPosition[] {
    return this.db
      .all<PositionRow>("SELECT * FROM positions WHERE status = 'open' ORDER BY createdAt ASC")
      .map(toPosition);
  }

  byPairIds(ids: string[]): SimulatedPosition[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all<PositionRow>(
        `SELECT * FROM positions WHERE pairId IN (${placeholders}) ORDER BY createdAt ASC`,
        ids,
      )
      .map(toPosition);
  }

  /** Positions dont le tokenId est dans `ids` (toutes statuts). Plus récent gagne au merge appelant. */
  byTokenIds(ids: string[]): SimulatedPosition[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all<PositionRow>(
        `SELECT * FROM positions WHERE tokenId IN (${placeholders}) ORDER BY createdAt ASC`,
        ids,
      )
      .map(toPosition);
  }

  recentResolved(limit: number): SimulatedPosition[] {
    return this.db
      .all<PositionRow>(
        `SELECT * FROM positions
         WHERE status != 'open'
         ORDER BY COALESCE(resolvedAt, createdAt) DESC
         LIMIT ?`,
        [limit],
      )
      .map(toPosition)
      .reverse(); // oldest-first, same order as runtime push/shift
  }

  /**
   * Compte en DB le nombre de jambes d'un kind donné pour un pairId, tout
   * statut confondu (open + résolues). Utilisé comme backstop DB-backed au
   * guard mémoire countPendingOrdersForSide / countOpenPositionsForSide,
   * qui peut être contourné par un restart tsx watch (le Map postedOrders
   * est reconstruit depuis la DB, mais si l'insert n'était pas encore
   * commité ou a été pruné, le Map est vide et le guard ne bloque pas).
   */
  countLegsByKind(pairId: string, kind: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM positions WHERE pairId = ? AND kind = ?",
      [pairId, kind],
    );
    return row?.count ?? 0;
  }

  getAggregateStats(): { pnl: number; wins: number; losses: number } {
    const row = this.db.get<{ pnl: number; wins: number; losses: number }>(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'open' THEN COALESCE(pnl, 0) ELSE 0 END), 0) as pnl,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as wins,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as losses
      FROM positions
    `);
    return row ?? { pnl: 0, wins: 0, losses: 0 };
  }

  /**
   * Stats agrégées par moteur (strategyId), mêmes sémantiques que
   * getAggregateStats : realizedPnl sur status != 'open' (inclut sold),
   * wins/losses sur won/lost, exposition sur les positions ouvertes.
   * Les lignes antérieures à la migration (strategyId NULL) sortent
   * sous '(sans moteur)'.
   */
  engineStats(): EngineStatsRow[] {
    return this.db.all<EngineStatsRow>(`
      SELECT
        COALESCE(strategyId, '(sans moteur)') AS engine,
        COALESCE(SUM(CASE WHEN status != 'open' THEN COALESCE(pnl, 0) ELSE 0 END), 0) AS realizedPnl,
        COUNT(CASE WHEN status = 'won' THEN 1 END) AS wins,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) AS losses,
        COALESCE(SUM(CASE WHEN status = 'open' THEN cost ELSE 0 END), 0) AS openExposure,
        COUNT(CASE WHEN status = 'open' THEN 1 END) AS openCount
      FROM positions
      GROUP BY COALESCE(strategyId, '(sans moteur)')
      ORDER BY engine ASC
    `);
  }
}

export interface EngineStatsRow {
  engine: string;
  realizedPnl: number;
  wins: number;
  losses: number;
  openExposure: number;
  openCount: number;
}

export class PairRepository {
  constructor(private readonly db: Database) {}

  upsert(pair: SimulatedArbPair): void {
    this.db.run(
      `INSERT OR REPLACE INTO arb_pairs (
        id, eventSlug, eventTitle, windowEnd, status, realizedPnl, resolvedAt, directional
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pair.id,
        pair.eventSlug,
        pair.eventTitle,
        pair.windowEnd,
        pair.status,
        pair.realizedPnl ?? null,
        pair.resolvedAt ?? null,
        pair.directional === undefined ? null : pair.directional ? 1 : 0,
      ],
    );
  }

  all(): SimulatedArbPair[] {
    return this.db.all<PairRow>("SELECT * FROM arb_pairs").map((row) => this.toPair(row));
  }

  unresolved(): SimulatedArbPair[] {
    return this.db
      .all<PairRow>("SELECT * FROM arb_pairs WHERE status != 'resolved'")
      .map((row) => this.toPair(row));
  }

  recentResolved(limit: number): SimulatedArbPair[] {
    return this.db
      .all<PairRow>(
        "SELECT * FROM arb_pairs WHERE status = 'resolved' ORDER BY resolvedAt DESC LIMIT ?",
        [limit],
      )
      .map((row) => this.toPair(row));
  }

  getAggregateStats(): {
    arbPnl: number;
    directionalPnl: number;
    coveredCount: number;
    uncoveredCount: number;
  } {
    const row = this.db.get<{
      arbPnl: number;
      directionalPnl: number;
      coveredCount: number;
      uncoveredCount: number;
    }>(`
      SELECT
        COALESCE(SUM(CASE WHEN directional = 0 THEN COALESCE(realizedPnl, 0) ELSE 0 END), 0) as arbPnl,
        COALESCE(SUM(CASE WHEN directional = 1 THEN COALESCE(realizedPnl, 0) ELSE 0 END), 0) as directionalPnl,
        COUNT(CASE WHEN directional = 0 THEN 1 END) as coveredCount,
        COUNT(CASE WHEN directional = 1 THEN 1 END) as uncoveredCount
      FROM arb_pairs
      WHERE status = 'resolved'
    `);
    return row ?? { arbPnl: 0, directionalPnl: 0, coveredCount: 0, uncoveredCount: 0 };
  }

  private toPair(row: PairRow): SimulatedArbPair {
    return {
      id: row.id,
      eventSlug: row.eventSlug,
      eventTitle: row.eventTitle,
      windowEnd: row.windowEnd,
      cheapLegs: [],
      expensiveLegs: [],
      status: row.status,
      realizedPnl: row.realizedPnl ?? undefined,
      resolvedAt: row.resolvedAt ?? undefined,
      directional: row.directional === null ? undefined : row.directional === 1,
    };
  }
}

export class LedgerRepository {
  constructor(private readonly db: Database) {}

  getBalance(): number | undefined {
    const row = this.db.get<{ balance: number }>(
      "SELECT balance FROM ledger WHERE id = 1",
    );
    return row?.balance;
  }

  setBalance(balance: number): void {
    this.db.run(
      `INSERT INTO ledger (id, balance, updatedAt) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET balance = excluded.balance, updatedAt = excluded.updatedAt`,
      [balance, Date.now()],
    );
  }
}

export interface BalanceSnapshotRow {
  availableCollateral: number;
  positionsValue: number;
  totalValue: number;
  source: "live" | "simulated";
}

export class BalanceSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: BalanceSnapshotRow): void {
    this.db.run(
      `INSERT INTO balance_snapshots (ts, availableCollateral, positionsValue, totalValue, source)
       VALUES (?, ?, ?, ?, ?)`,
      [
        Date.now(),
        snapshot.availableCollateral,
        snapshot.positionsValue,
        snapshot.totalValue,
        snapshot.source,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM balance_snapshots WHERE ts < ?", [beforeTs]);
  }
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  insert(type: string, payload: unknown): void {
    this.db.run(
      "INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)",
      [Date.now(), type, JSON.stringify(payload)],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM events WHERE ts < ?", [beforeTs]);
  }
}

export class KeyRepository {
  constructor(private readonly db: Database) {}

  mark(key: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO trade_keys (key, createdAt) VALUES (?, ?)",
      [key, Date.now()],
    );
  }

  all(): Array<{ key: string; createdAt: number }> {
    return this.db.all<{ key: string; createdAt: number }>(
      "SELECT key, createdAt FROM trade_keys",
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM trade_keys WHERE createdAt < ?", [beforeTs]);
  }

  delete(key: string): void {
    this.db.run("DELETE FROM trade_keys WHERE key = ?", [key]);
  }
}

export class RetryRepository {
  constructor(private readonly db: Database) {}

  get(key: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT count FROM retry_counts WHERE key = ?",
      [key],
    );
    return row?.count ?? 0;
  }

  increment(key: string): number {
    const next = this.get(key) + 1;
    this.db.run(
      `INSERT INTO retry_counts (key, count, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, updatedAt = excluded.updatedAt`,
      [key, next, Date.now()],
    );
    return next;
  }

  all(): Map<string, { count: number; updatedAt: number }> {
    const rows = this.db.all<{ key: string; count: number; updatedAt: number | null }>(
      "SELECT key, count, updatedAt FROM retry_counts",
    );
    return new Map(
      rows.map((r) => [r.key, { count: r.count, updatedAt: r.updatedAt ?? 0 }]),
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM retry_counts WHERE updatedAt IS NULL OR updatedAt < ?", [beforeTs]);
  }
}

export interface PostedOrderRow {
  key: string;
  eventSlug: string;
  windowEnd: number;
  cost: number;
  createdAt: number;
  orderId?: string;
  // Contexte de l'opportunity (pour recréer une position live au fill)
  tokenId?: string;
  outcome?: string;
  outcomeIndex?: number;
  kind?: PositionKind;
  limitPrice?: number;
  size?: number;
  pairId?: string;
  eventTitle?: string;
  bestAskAtFill?: number | null;
  strategyId?: string | null;
}

export class PostedOrderRepository {
  constructor(private readonly db: Database) {}

  insert(order: PostedOrderRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO posted_orders (
        key, eventSlug, windowEnd, cost, createdAt, orderId,
        tokenId, outcome, outcomeIndex, kind, limitPrice, size, pairId, eventTitle, bestAskAtFill, strategyId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.key,
        order.eventSlug,
        order.windowEnd,
        order.cost,
        order.createdAt,
        order.orderId ?? null,
        order.tokenId ?? null,
        order.outcome ?? null,
        order.outcomeIndex ?? null,
        order.kind ?? null,
        order.limitPrice ?? null,
        order.size ?? null,
        order.pairId ?? null,
        order.eventTitle ?? null,
        order.bestAskAtFill ?? null,
        order.strategyId ?? null,
      ],
    );
  }

  all(): PostedOrderRow[] {
    return this.db.all<PostedOrderRow>("SELECT * FROM posted_orders");
  }

  delete(key: string): void {
    this.db.run("DELETE FROM posted_orders WHERE key = ?", [key]);
  }

  /**
   * Drop never-acked rows after 15 min past windowEnd; drop even tracked
   * CLOB orders after 24h so a dead cancel loop cannot leak rows forever.
   */
  pruneStale(nowSeconds: number): void {
    this.db.run(
      "DELETE FROM posted_orders WHERE (orderId IS NULL OR orderId = '') AND windowEnd < ?",
      [nowSeconds - 900],
    );
    this.db.run("DELETE FROM posted_orders WHERE windowEnd < ?", [
      nowSeconds - 86_400,
    ]);
  }
}

export interface WindowClaimRow {
  cheapOutcome: string;
  expensiveOutcome: string;
}

export class WindowClaimRepository {
  constructor(private readonly db: Database) {}

  set(pairId: string, claim: WindowClaimRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO window_claims (pairId, cheapOutcome, expensiveOutcome)
       VALUES (?, ?, ?)`,
      [pairId, claim.cheapOutcome, claim.expensiveOutcome],
    );
  }

  delete(pairId: string): void {
    this.db.run("DELETE FROM window_claims WHERE pairId = ?", [pairId]);
  }

  all(): Map<string, WindowClaimRow> {
    const rows = this.db.all<{ pairId: string } & WindowClaimRow>(
      "SELECT pairId, cheapOutcome, expensiveOutcome FROM window_claims",
    );
    return new Map(
      rows.map((r) => [r.pairId, { cheapOutcome: r.cheapOutcome, expensiveOutcome: r.expensiveOutcome }]),
    );
  }
}

export class BotStateRepository {
  constructor(private readonly db: Database) {}

  get(key: string): number | undefined {
    const row = this.db.get<{ value: number }>(
      "SELECT value FROM bot_state WHERE key = ?",
      [key],
    );
    return row?.value;
  }

  set(key: string, value: number): void {
    this.db.run(
      `INSERT INTO bot_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}

export interface OrderRow {
  ts: number;
  tradeKey: string;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: PositionKind;
  orderType: "GTC" | "FOK" | "FAK" | "SIM";
  side: string;
  limitPrice: number;
  fillPrice: number | null;
  size: number;
  cost: number | null;
  filled: number;
  reason: string | null;
  dryRun: number;
  orderId: string | null;
  pairId: string | null;
  windowEnd: number;
  /** Heure réelle du fill (ms), null si non rempli. */
  filledTs: number | null;
}

export class OrderRepository {
  constructor(private readonly db: Database) {}

  record(
    result: {
      dryRun: boolean;
      price: number;
      fillPrice?: number;
      size: number;
      filledSize?: number;
      filled?: boolean;
      reason?: string;
      orderType?: "GTC" | "FOK" | "FAK" | "SIM";
      side?: "BUY" | "SELL";
      response?: unknown;
    },
    opportunity: {
      kind: PositionKind;
      tradeKey: string;
      pairId: string;
      event: { slug: string; title: string; windowEnd: number };
      token: { tokenId: string; outcome: string; outcomeIndex: number };
    },
  ): void {
    const orderId =
      (result.response as { orderID?: string } | undefined)?.orderID ?? null;
    const filled = result.filled === true ? 1 : 0;
    const fillPrice = result.fillPrice ?? null;
    const filledSize = result.filledSize ?? result.size;
    const cost = Math.round((fillPrice ?? result.price) * filledSize * 100) / 100;
    const orderType: OrderRow["orderType"] = result.dryRun
      ? "SIM"
      : result.orderType === "FAK" || result.reason?.includes("fak")
        ? "FAK"
        : result.orderType === "FOK" || result.reason?.includes("fok")
          ? "FOK"
          : "GTC";

    if (result.reason === "cancelled") {
      const existing = orderId
        ? this.db.get<{ id: number }>(
            `SELECT id FROM orders
             WHERE orderId = ? AND reason = 'resting' AND filled = 0
             ORDER BY ts DESC LIMIT 1`,
            [orderId],
          )
        : this.db.get<{ id: number }>(
            `SELECT id FROM orders
             WHERE tokenId = ? AND reason = 'resting' AND filled = 0
             ORDER BY ts DESC LIMIT 1`,
            [opportunity.token.tokenId],
          );
      if (existing) {
        this.db.run(
          "UPDATE orders SET filled = 0, reason = 'cancelled' WHERE id = ?",
          [existing.id],
        );
        return;
      }
    }

    const now = Date.now();
    this.db.run(
      `INSERT INTO orders (
        ts, tradeKey, eventSlug, eventTitle, tokenId, outcome, outcomeIndex,
        kind, orderType, side, limitPrice, fillPrice, size, cost, filled,
        reason, dryRun, orderId, pairId, windowEnd, filledTs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now,
        opportunity.tradeKey,
        opportunity.event.slug,
        opportunity.event.title,
        opportunity.token.tokenId,
        opportunity.token.outcome,
        opportunity.token.outcomeIndex,
        opportunity.kind,
        orderType,
        result.side ?? "BUY",
        result.price,
        fillPrice,
        result.size,
        cost,
        filled,
        result.reason ?? null,
        result.dryRun ? 1 : 0,
        orderId,
        opportunity.pairId,
        opportunity.event.windowEnd,
        filled ? now : null,
      ],
    );
  }

  markFilled(position: {
    id: string;
    tokenId: string;
    pairId: string;
    fillPrice: number;
  }): void {
    const now = Date.now();
    if (position.id.startsWith("live:")) {
      const orderId = position.id.slice("live:".length);
      this.db.run(
        `UPDATE orders SET filled = 1, fillPrice = ?, reason = NULL, filledTs = ?
         WHERE orderId = ? AND filled = 0`,
        [position.fillPrice, now, orderId],
      );
      return;
    }
    this.db.run(
      `UPDATE orders SET filled = 1, fillPrice = ?, reason = NULL, filledTs = ?
       WHERE tokenId = ? AND pairId = ? AND reason = 'resting' AND filled = 0`,
      [position.fillPrice, now, position.tokenId, position.pairId],
    );
  }

  recent(limit: number): OrderRow[] {
    return this.db.all<OrderRow>(
      "SELECT * FROM orders ORDER BY ts DESC LIMIT ?",
      [limit],
    );
  }

  /** Ordres remplis (fills réels ou simulés) pour un ensemble de tokens, triés par ts. */
  filledByTokenIds(tokenIds: string[]): OrderRow[] {
    const ids = tokenIds.filter((id) => id.length > 0);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.db.all<OrderRow>(
      `SELECT * FROM orders
       WHERE filled = 1 AND tokenId IN (${placeholders})
       ORDER BY COALESCE(filledTs, ts) ASC`,
      ids,
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM orders WHERE ts < ?", [beforeTs]);
  }
}

export interface RedeemRow {
  ts: number;
  conditionId: string;
  outcomeIndex: number;
  negRisk: number;
  title: string | null;
  outcome: string | null;
  size: number | null;
  txHash: string | null;
  source: "auto" | "manual";
  success: number;
  errorMessage: string | null;
}

export class StatsSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(stats: unknown): void {
    this.db.run("INSERT INTO stats_snapshots (ts, payload) VALUES (?, ?)", [
      Date.now(),
      JSON.stringify(stats),
    ]);
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM stats_snapshots WHERE ts < ?", [beforeTs]);
  }
}

export class RedeemRepository {
  constructor(private readonly db: Database) {}

  insert(
    row: Pick<RedeemRow, "conditionId" | "outcomeIndex" | "negRisk" | "source" | "success"> &
      Partial<Omit<RedeemRow, "conditionId" | "outcomeIndex" | "negRisk" | "source" | "success">>,
  ): void {
    this.db.run(
      `INSERT INTO redeems (
        ts, conditionId, outcomeIndex, negRisk, title, outcome, size,
        txHash, source, success, errorMessage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts ?? Date.now(),
        row.conditionId,
        row.outcomeIndex,
        row.negRisk,
        row.title ?? null,
        row.outcome ?? null,
        row.size ?? null,
        row.txHash ?? null,
        row.source,
        row.success,
        row.errorMessage ?? null,
      ],
    );
  }

  recentSuccessfulKeys(sinceTs: number): string[] {
    return this.db
      .all<{ conditionId: string; outcomeIndex: number }>(
        `SELECT conditionId, outcomeIndex FROM redeems
         WHERE success = 1 AND ts >= ?`,
        [sinceTs],
      )
      .map((r) => `${r.conditionId}:${r.outcomeIndex}`);
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM redeems WHERE ts < ?", [beforeTs]);
  }
}

export interface WithdrawalRow {
  ts: number;
  to: string;
  amount: number;
  txHash: string | null;
  source: "manual";
  success: number;
  errorMessage: string | null;
}

export class WithdrawalRepository {
  constructor(private readonly db: Database) {}

  insert(
    row: Pick<WithdrawalRow, "to" | "amount" | "source" | "success"> &
      Partial<Omit<WithdrawalRow, "to" | "amount" | "source" | "success">>,
  ): void {
    this.db.run(
      `INSERT INTO withdrawals (ts, "to", amount, txHash, source, success, errorMessage)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts ?? Date.now(),
        row.to,
        row.amount,
        row.txHash ?? null,
        row.source,
        row.success,
        row.errorMessage ?? null,
      ],
    );
  }

  recent(limit = 20): WithdrawalRow[] {
    return this.db.all<WithdrawalRow>(
      `SELECT ts, "to", amount, txHash, source, success, errorMessage
       FROM withdrawals ORDER BY ts DESC, id DESC LIMIT ?`,
      [limit],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM withdrawals WHERE ts < ?", [beforeTs]);
  }
}

export interface MarketSnapshotRow {
  ts: number;
  eventSlug: string;
  eventTitle: string;
  conditionId: string;
  windowStart: number;
  windowEnd: number;
  volume?: number | null;
  volume24hr?: number | null;
  liquidity?: number | null;
  lastTradePrice?: number | null;
  spread?: number | null;
}

const MARKET_SNAPSHOT_COLUMNS =
  "ts, eventSlug, eventTitle, conditionId, windowStart, windowEnd, volume, volume24hr, liquidity, lastTradePrice, spread";

export class MarketSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: MarketSnapshotRow): void {
    this.db.run(
      `INSERT INTO market_snapshots (${MARKET_SNAPSHOT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.eventTitle,
        snapshot.conditionId,
        snapshot.windowStart,
        snapshot.windowEnd,
        snapshot.volume ?? null,
        snapshot.volume24hr ?? null,
        snapshot.liquidity ?? null,
        snapshot.lastTradePrice ?? null,
        snapshot.spread ?? null,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM market_snapshots WHERE ts < ?", [beforeTs]);
  }

  latestBySlug(eventSlug: string): MarketSnapshotRow | undefined {
    return this.db.get<MarketSnapshotRow>(
      `SELECT ${MARKET_SNAPSHOT_COLUMNS}
       FROM market_snapshots WHERE eventSlug = ? ORDER BY ts DESC LIMIT 1`,
      [eventSlug],
    );
  }

  bySlugAndRange(eventSlug: string, startTs: number, endTs: number): MarketSnapshotRow[] {
    return this.db.all<MarketSnapshotRow>(
      `SELECT ${MARKET_SNAPSHOT_COLUMNS}
       FROM market_snapshots
       WHERE eventSlug = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [eventSlug, startTs, endTs],
    );
  }

  titlesBySlug(): Array<{
    eventSlug: string;
    eventTitle: string;
    conditionId: string;
    windowStart: number;
    windowEnd: number;
  }> {
    return this.db.all(
      `SELECT eventSlug, MAX(eventTitle) AS eventTitle, MAX(conditionId) AS conditionId,
              MAX(windowStart) AS windowStart, MAX(windowEnd) AS windowEnd
       FROM market_snapshots GROUP BY eventSlug`,
    );
  }

  listForStrategyChart(): Array<{
    eventSlug: string;
    eventTitle: string;
    windowStart: number;
    windowEnd: number;
    ticks: number;
  }> {
    return this.db.all(
      `SELECT m.eventSlug,
              MAX(m.eventTitle) AS eventTitle,
              MAX(m.windowStart) AS windowStart,
              MAX(m.windowEnd) AS windowEnd,
              (SELECT COUNT(DISTINCT b.ts)
                 FROM book_snapshots b
                WHERE b.eventSlug = m.eventSlug) AS ticks
       FROM market_snapshots m
       GROUP BY m.eventSlug
       ORDER BY MAX(m.windowEnd) DESC`,
    );
  }
}

export interface BookSnapshotRow {
  ts: number;
  eventSlug: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestAskSize: number | null;
  bestBidSize?: number | null;
  ask2?: number | null;
  ask2Size?: number | null;
  ask3?: number | null;
  ask3Size?: number | null;
  bid2?: number | null;
  bid2Size?: number | null;
  bid3?: number | null;
  bid3Size?: number | null;
}

const BOOK_SNAPSHOT_COLUMNS =
  "ts, eventSlug, tokenId, outcome, outcomeIndex, bestBid, bestAsk, bestAskSize, bestBidSize, ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size";

export class BookSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: BookSnapshotRow): void {
    this.db.run(
      `INSERT INTO book_snapshots (${BOOK_SNAPSHOT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.tokenId,
        snapshot.outcome,
        snapshot.outcomeIndex,
        snapshot.bestBid,
        snapshot.bestAsk,
        snapshot.bestAskSize,
        snapshot.bestBidSize ?? null,
        snapshot.ask2 ?? null,
        snapshot.ask2Size ?? null,
        snapshot.ask3 ?? null,
        snapshot.ask3Size ?? null,
        snapshot.bid2 ?? null,
        snapshot.bid2Size ?? null,
        snapshot.bid3 ?? null,
        snapshot.bid3Size ?? null,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM book_snapshots WHERE ts < ?", [beforeTs]);
  }

  byTokenAndRange(tokenId: string, startTs: number, endTs: number): BookSnapshotRow[] {
    return this.db.all<BookSnapshotRow>(
      `SELECT ${BOOK_SNAPSHOT_COLUMNS}
       FROM book_snapshots
       WHERE tokenId = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [tokenId, startTs, endTs],
    );
  }

  listTickGroups(): Array<{ eventSlug: string; ts: number; n: number }> {
    return this.db.all(
      `SELECT eventSlug, ts, COUNT(DISTINCT outcomeIndex) AS n
       FROM book_snapshots
       GROUP BY eventSlug, ts
       ORDER BY eventSlug, ts`,
    );
  }

  bySlugAndRange(eventSlug: string, startTs: number, endTs: number): BookSnapshotRow[] {
    return this.db.all<BookSnapshotRow>(
      `SELECT ${BOOK_SNAPSHOT_COLUMNS}
       FROM book_snapshots
       WHERE eventSlug = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [eventSlug, startTs, endTs],
    );
  }

  tokensBySlug(): Array<{ eventSlug: string; tokenId: string; outcomeIndex: number; outcome: string }> {
    return this.db.all(
      `SELECT eventSlug, tokenId, outcomeIndex, MAX(outcome) AS outcome
       FROM book_snapshots
       GROUP BY eventSlug, tokenId, outcomeIndex`,
    );
  }

  seriesUpDownBySlug(
    eventSlug: string,
    startTsMs: number,
    endTsMs: number,
  ): {
    up: Array<{ t: number; ask: number | null; bid: number | null }>;
    down: Array<{ t: number; ask: number | null; bid: number | null }>;
    upTokenId: string | null;
    downTokenId: string | null;
  } {
    const rows = this.bySlugAndRange(eventSlug, startTsMs, endTsMs);
    const up: Array<{ t: number; ask: number | null; bid: number | null }> = [];
    const down: Array<{ t: number; ask: number | null; bid: number | null }> = [];
    let upTokenId: string | null = null;
    let downTokenId: string | null = null;
    for (const row of rows) {
      const point = {
        t: Math.floor(row.ts / 1000),
        ask: row.bestAsk,
        bid: row.bestBid ?? null,
      };
      if (row.outcomeIndex === 0) {
        up.push(point);
        upTokenId ??= row.tokenId;
      } else {
        down.push(point);
        downTokenId ??= row.tokenId;
      }
    }
    return { up, down, upTokenId, downTokenId };
  }
}

export interface OpportunitySnapshotRow {
  ts: number;
  eventSlug: string;
  kind: PositionKind;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
  executed: number;
  pairId: string;
}

export class OpportunitySnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: OpportunitySnapshotRow): void {
    this.db.run(
      `INSERT INTO opportunity_snapshots (ts, eventSlug, kind, tokenId, outcome, price, size, executed, pairId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.kind,
        snapshot.tokenId,
        snapshot.outcome,
        snapshot.price,
        snapshot.size,
        snapshot.executed,
        snapshot.pairId,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM opportunity_snapshots WHERE ts < ?", [beforeTs]);
  }
}

export interface MarketResolutionRow {
  eventSlug: string;
  winnerOutcomeIndex: number;
  source: string;
  ts: number;
}

export class MarketResolutionRepository {
  constructor(private readonly db: Database) {}

  get(eventSlug: string): MarketResolutionRow | undefined {
    return this.db.get<MarketResolutionRow>(
      `SELECT eventSlug, winnerOutcomeIndex, source, ts FROM market_resolutions WHERE eventSlug = ?`,
      [eventSlug],
    );
  }

  upsert(row: MarketResolutionRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts)
       VALUES (?, ?, ?, ?)`,
      [row.eventSlug, row.winnerOutcomeIndex, row.source, row.ts],
    );
  }
}

export type BacktestRunStatus = "running" | "done" | "error" | "cancelled";

export interface BacktestRunRow {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: BacktestRunStatus;
  requestJson: string;
  resultJson: string | null;
  error: string | null;
}

export class BacktestRunRepository {
  constructor(private readonly db: Database) {}

  insert(row: BacktestRunRow): void {
    this.db.run(
      `INSERT INTO backtest_runs (id, startedAt, finishedAt, status, requestJson, resultJson, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.startedAt,
        row.finishedAt,
        row.status,
        row.requestJson,
        row.resultJson,
        row.error,
      ],
    );
  }

  update(row: Pick<BacktestRunRow, "id" | "finishedAt" | "status" | "resultJson" | "error">): void {
    this.db.run(
      `UPDATE backtest_runs SET finishedAt = ?, status = ?, resultJson = ?, error = ? WHERE id = ?`,
      [row.finishedAt, row.status, row.resultJson, row.error, row.id],
    );
  }

  get(id: string): BacktestRunRow | undefined {
    return this.db.get<BacktestRunRow>(
      `SELECT id, startedAt, finishedAt, status, requestJson, resultJson, error FROM backtest_runs WHERE id = ?`,
      [id],
    );
  }

  recent(limit: number): BacktestRunRow[] {
    return this.db.all<BacktestRunRow>(
      `SELECT id, startedAt, finishedAt, status, requestJson, resultJson, error
       FROM backtest_runs ORDER BY startedAt DESC LIMIT ?`,
      [limit],
    );
  }

  pruneKeepLatest(keep: number): void {
    const kept = this.recent(keep);
    if (kept.length === 0) return;
    const placeholders = kept.map(() => "?").join(",");
    const ids = kept.map((row) => row.id);
    this.db.run(
      `DELETE FROM backtest_trades WHERE runId NOT IN (${placeholders})`,
      ids,
    );
    this.db.run(
      `DELETE FROM backtest_positions WHERE runId NOT IN (${placeholders})`,
      ids,
    );
    this.db.run(
      `DELETE FROM backtest_runs WHERE id NOT IN (${placeholders})`,
      ids,
    );
  }
}

export interface BacktestTradeRow {
  runId: string;
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
}

export class BacktestTradeRepository {
  constructor(private readonly db: Database) {}

  insert(row: BacktestTradeRow): void {
    this.db.run(
      `INSERT INTO backtest_trades (
        runId, ts, eventSlug, kind, outcome, side, limitPrice, fillPrice, size,
        filled, reason, fillReason, orderType, pairId, pnl
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.runId,
        row.ts,
        row.eventSlug,
        row.kind,
        row.outcome,
        row.side,
        row.limitPrice,
        row.fillPrice,
        row.size,
        row.filled,
        row.reason,
        row.fillReason,
        row.orderType,
        row.pairId,
        row.pnl,
      ],
    );
  }

  byRun(runId: string): BacktestTradeRow[] {
    return this.db.all<BacktestTradeRow>(
      `SELECT runId, ts, eventSlug, kind, outcome, side, limitPrice, fillPrice, size,
              filled, reason, fillReason, orderType, pairId, pnl
       FROM backtest_trades WHERE runId = ? ORDER BY ts ASC`,
      [runId],
    );
  }
}

export interface BacktestPositionRow {
  id: string;
  runId: string;
  ts: number;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: string;
  side: string;
  limitPrice: number;
  fillPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
  status: string;
  resolvedAt: number | null;
  pnl: number | null;
  fillReason: string | null;
  pairId: string;
  bestAskAtFill: number | null;
  orderType: string | null;
  strategyId: string | null;
  sellPrice: number | null;
}

export class BacktestPositionRepository {
  constructor(private readonly db: Database) {}

  upsert(row: BacktestPositionRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO backtest_positions (
        id, runId, ts, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind, side,
        limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt, pnl, fillReason,
        pairId, bestAskAtFill, orderType, strategyId, sellPrice
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.runId,
        row.ts,
        row.eventSlug,
        row.eventTitle,
        row.tokenId,
        row.outcome,
        row.outcomeIndex,
        row.kind,
        row.side,
        row.limitPrice,
        row.fillPrice,
        row.size,
        row.cost,
        row.windowEnd,
        row.status,
        row.resolvedAt,
        row.pnl,
        row.fillReason,
        row.pairId,
        row.bestAskAtFill,
        row.orderType,
        row.strategyId,
        row.sellPrice,
      ],
    );
  }

  byRun(runId: string): BacktestPositionRow[] {
    return this.db.all<BacktestPositionRow>(
      `SELECT id, runId, ts, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind, side,
              limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt, pnl, fillReason,
              pairId, bestAskAtFill, orderType, strategyId, sellPrice
       FROM backtest_positions WHERE runId = ? ORDER BY ts ASC`,
      [runId],
    );
  }
}

export interface MarketRuleRow {
  prefix: string;
  recordingEnabled: number; // 0|1
  tradingEnabled: number; // 0|1
  addedBy: string;
  createdAt: number;
  updatedAt: number;
}

export class MarketRuleRepository {
  constructor(private readonly db: Database) {}

  list(): MarketRuleRow[] {
    return this.db.all<MarketRuleRow>(
      "SELECT * FROM market_rules ORDER BY prefix",
    );
  }

  get(prefix: string): MarketRuleRow | undefined {
    return this.db.get<MarketRuleRow>(
      "SELECT * FROM market_rules WHERE prefix = ?",
      [prefix],
    );
  }

  /**
   * Crée ou met à jour les flags d'une famille. La ligne existante (created,
   * addedBy) est conservée via INSERT OR IGNORE + UPDATE ciblé.
   */
  setFlags(
    prefix: string,
    patch: { recordingEnabled?: boolean; tradingEnabled?: boolean },
    addedBy?: string,
  ): MarketRuleRow {
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO market_rules (prefix, recordingEnabled, tradingEnabled, addedBy, createdAt, updatedAt)
       VALUES (?, 1, 1, ?, ?, ?)`,
      [prefix, addedBy ?? "user", now, now],
    );
    const sets: string[] = ["updatedAt = ?"];
    const params: Array<number | string> = [now];
    if (patch.recordingEnabled !== undefined) {
      sets.push("recordingEnabled = ?");
      params.push(patch.recordingEnabled ? 1 : 0);
    }
    if (patch.tradingEnabled !== undefined) {
      sets.push("tradingEnabled = ?");
      params.push(patch.tradingEnabled ? 1 : 0);
    }
    if (addedBy !== undefined) {
      sets.push("addedBy = ?");
      params.push(addedBy);
    }
    params.push(prefix);
    this.db.run(
      `UPDATE market_rules SET ${sets.join(", ")} WHERE prefix = ?`,
      params,
    );
    const row = this.get(prefix);
    if (!row) {
      throw new Error(`market_rules: failed to persist flags for ${prefix}`);
    }
    return row;
  }

  /** INSERT OR IGNORE — idempotent, ne mute jamais une ligne existante. */
  ensureDefaults(prefixes: string[]): void {
    const now = Date.now();
    for (const prefix of prefixes) {
      if (!prefix) continue;
      this.db.run(
        `INSERT OR IGNORE INTO market_rules (prefix, recordingEnabled, tradingEnabled, addedBy, createdAt, updatedAt)
         VALUES (?, 1, 1, 'default', ?, ?)`,
        [prefix, now, now],
      );
    }
  }

  /** Familles vues récemment dans market_snapshots, hors préfixes configurés. */
  discovered(excludePrefixes: string[], sinceTs: number): Array<{ prefix: string; lastSeenTs: number; slugCount: number }> {
    const rows = this.db.all<{ prefix: string; lastSeenTs: number; slugCount: number }>(
      `SELECT substr(eventSlug, 1, length(eventSlug) - 11) AS prefix,
              MAX(ts) AS lastSeenTs,
              COUNT(DISTINCT eventSlug) AS slugCount
       FROM market_snapshots
       GROUP BY prefix
       HAVING lastSeenTs >= ?`,
      [sinceTs],
    );
    return rows.filter(
      (row) => row.prefix && !excludePrefixes.includes(row.prefix),
    );
  }
}
