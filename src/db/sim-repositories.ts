import type {
  SimulatedArbPair,
  SimulatedPosition,
} from "../types.js";
import type { Database } from "./database.js";
import {
  toPosition,
  type EngineStatsRow,
  type PairRow,
  type PositionRow,
  type PostedOrderRow,
  type WindowClaimRow,
} from "./repositories.js";

// Paper trading (simulation live) — miroirs des repos live/backtest
// Les classes existantes hardcodent leur nom de table ; chaque repo sim
// est donc un miroir avec le préfixe sim_. Requis par TradeTracker :
// positions, pairs, keys, retries, windowClaims, postedOrders.
// ============================================================

export class SimPositionRepository {
  constructor(private readonly db: Database) {}

  insert(position: SimulatedPosition): void {
    this.db.run(
      `INSERT OR REPLACE INTO sim_positions (
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
      `UPDATE sim_positions SET status = ?, resolvedAt = ?, pnl = ?, sellPrice = ? WHERE id = ?`,
      [position.status, position.resolvedAt ?? null, position.pnl ?? null, position.sellPrice ?? null, position.id],
    );
  }

  open(): SimulatedPosition[] {
    return this.db
      .all<PositionRow>("SELECT * FROM sim_positions WHERE status = 'open' ORDER BY createdAt ASC")
      .map(toPosition);
  }

  byPairIds(ids: string[]): SimulatedPosition[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all<PositionRow>(
        `SELECT * FROM sim_positions WHERE pairId IN (${placeholders}) ORDER BY createdAt ASC`,
        ids,
      )
      .map(toPosition);
  }

  recentResolved(limit: number): SimulatedPosition[] {
    return this.db
      .all<PositionRow>(
        `SELECT * FROM sim_positions
         WHERE status != 'open'
         ORDER BY COALESCE(resolvedAt, createdAt) DESC
         LIMIT ?`,
        [limit],
      )
      .map(toPosition)
      .reverse();
  }

  /** Nombre total de positions résolues (status != open) — source DB complète. */
  countResolved(): number {
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sim_positions WHERE status != 'open'",
    );
    return row?.c ?? 0;
  }

  /**
   * Page de positions résolues triées plus récent d'abord (page 1 = les plus
   * récentes). Lit la DB complète : sans le plafond MAX_RESOLVED_IN_MEMORY du
   * tracker. `offset` = (page - 1) × pageSize.
   */
  resolvedPaged(limit: number, offset: number): SimulatedPosition[] {
    return this.db
      .all<PositionRow>(
        `SELECT * FROM sim_positions
         WHERE status != 'open'
         ORDER BY COALESCE(resolvedAt, createdAt) DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      .map(toPosition);
  }

  countLegsByKind(pairId: string, kind: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM sim_positions WHERE pairId = ? AND kind = ?",
      [pairId, kind],
    );
    return row?.count ?? 0;
  }

  /** Positions dont le tokenId est dans `ids` (toutes statuts). */
  byTokenIds(ids: string[]): SimulatedPosition[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .all<PositionRow>(
        `SELECT * FROM sim_positions WHERE tokenId IN (${placeholders}) ORDER BY createdAt ASC`,
        ids,
      )
      .map(toPosition);
  }

  engineStats(): EngineStatsRow[] {
    return this.db.all<EngineStatsRow>(`
      SELECT
        COALESCE(strategyId, '(sans moteur)') AS engine,
        COALESCE(SUM(CASE WHEN status != 'open' THEN COALESCE(pnl, 0) ELSE 0 END), 0) AS realizedPnl,
        COUNT(CASE WHEN status = 'won' THEN 1 END) AS wins,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) AS losses,
        COALESCE(SUM(CASE WHEN status = 'open' THEN cost ELSE 0 END), 0) AS openExposure,
        COUNT(CASE WHEN status = 'open' THEN 1 END) AS openCount
      FROM sim_positions
      GROUP BY COALESCE(strategyId, '(sans moteur)')
      ORDER BY engine ASC
    `);
  }

  getAggregateStats(): { pnl: number; wins: number; losses: number } {
    const row = this.db.get<{ pnl: number; wins: number; losses: number }>(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'open' THEN COALESCE(pnl, 0) ELSE 0 END), 0) as pnl,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as wins,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as losses
      FROM sim_positions
    `);
    return row ?? { pnl: 0, wins: 0, losses: 0 };
  }

  all(): SimulatedPosition[] {
    return this.db.all<PositionRow>("SELECT * FROM sim_positions").map(toPosition);
  }

  /**
   * Archive toutes les positions sim résolues (status != open) dans
   * sim_positions_archive, puis les supprime de sim_positions.
   * Retourne le batch id et le nombre de lignes archivées.
   */
  archiveResolved(): { batchId: string; archived: number } {
    const batchId = `sim-archive-${Date.now()}`;
    const archivedAt = Date.now();
    this.db.run(
      `INSERT INTO sim_positions_archive (
        archiveBatchId, archivedAt,
        id, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind,
        limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt,
        pnl, fillReason, pairId, bestAskAtFill, orderType, strategyId, sellPrice, createdAt
      )
      SELECT
        ?, ?,
        id, eventSlug, eventTitle, tokenId, outcome, outcomeIndex, kind,
        limitPrice, fillPrice, size, cost, windowEnd, status, resolvedAt,
        pnl, fillReason, pairId, bestAskAtFill, orderType, strategyId, sellPrice, createdAt
      FROM sim_positions
      WHERE status != 'open'`,
      [batchId, archivedAt],
    );
    const countRow = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM sim_positions_archive WHERE archiveBatchId = ?",
      [batchId],
    );
    const archived = Number(countRow?.c ?? 0);
    this.db.run("DELETE FROM sim_positions WHERE status != 'open'");
    return { batchId, archived };
  }

  deleteAll(): void {
    this.db.run("DELETE FROM sim_positions");
  }
}

export class SimPairRepository {
  constructor(private readonly db: Database) {}

  upsert(pair: SimulatedArbPair): void {
    this.db.run(
      `INSERT OR REPLACE INTO sim_pairs (
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
    return this.db.all<PairRow>("SELECT * FROM sim_pairs").map((row) => this.toPair(row));
  }

  unresolved(): SimulatedArbPair[] {
    return this.db
      .all<PairRow>("SELECT * FROM sim_pairs WHERE status != 'resolved'")
      .map((row) => this.toPair(row));
  }

  recentResolved(limit: number): SimulatedArbPair[] {
    return this.db
      .all<PairRow>(
        "SELECT * FROM sim_pairs WHERE status = 'resolved' ORDER BY resolvedAt DESC LIMIT ?",
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
      FROM sim_pairs
      WHERE status = 'resolved'
    `);
    return row ?? { arbPnl: 0, directionalPnl: 0, coveredCount: 0, uncoveredCount: 0 };
  }

  /** Supprime uniquement les paires sim déjà résolues (laisse les ouvertes). */
  deleteResolved(): void {
    this.db.run("DELETE FROM sim_pairs WHERE status = 'resolved'");
  }

  deleteAll(): void {
    this.db.run("DELETE FROM sim_pairs");
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

export interface SimTradeRow {
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

export class SimTradeRepository {
  constructor(private readonly db: Database) {}

  insert(row: SimTradeRow): void {
    this.db.run(
      `INSERT INTO sim_trades (
        ts, eventSlug, kind, outcome, side, limitPrice, fillPrice, size,
        filled, reason, fillReason, orderType, pairId, pnl
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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

  recent(
    limit: number,
    opts?: { slug?: string; filledOnly?: boolean },
  ): SimTradeRow[] {
    const slug = opts?.slug?.trim() || "";
    const filledOnly = opts?.filledOnly === true;
    if (slug && filledOnly) {
      return this.db.all<SimTradeRow>(
        "SELECT * FROM sim_trades WHERE eventSlug = ? AND filled = 1 ORDER BY ts DESC, id DESC LIMIT ?",
        [slug, limit],
      );
    }
    if (slug) {
      return this.db.all<SimTradeRow>(
        "SELECT * FROM sim_trades WHERE eventSlug = ? ORDER BY ts DESC, id DESC LIMIT ?",
        [slug, limit],
      );
    }
    if (filledOnly) {
      return this.db.all<SimTradeRow>(
        "SELECT * FROM sim_trades WHERE filled = 1 ORDER BY ts DESC, id DESC LIMIT ?",
        [limit],
      );
    }
    return this.db.all<SimTradeRow>(
      "SELECT * FROM sim_trades ORDER BY ts DESC, id DESC LIMIT ?",
      [limit],
    );
  }

  deleteOlderThan(beforeTs: number): void {
    this.db.run("DELETE FROM sim_trades WHERE ts < ?", [beforeTs]);
  }

  deleteAll(): void {
    this.db.run("DELETE FROM sim_trades");
  }
}

export class SimStateRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    return this.db.get<{ value: string }>(
      "SELECT value FROM sim_state WHERE key = ?",
      [key],
    )?.value;
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO sim_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}

export class SimPostedOrderRepository {
  constructor(private readonly db: Database) {}

  insert(order: PostedOrderRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO sim_posted_orders (
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
    return this.db.all<PostedOrderRow>("SELECT * FROM sim_posted_orders");
  }

  delete(key: string): void {
    this.db.run("DELETE FROM sim_posted_orders WHERE key = ?", [key]);
  }

  /** Drop never-acked rows after 15 min past windowEnd; tracked rows after 24h. */
  pruneStale(nowSeconds: number): void {
    this.db.run(
      "DELETE FROM sim_posted_orders WHERE (orderId IS NULL OR orderId = '') AND windowEnd < ?",
      [nowSeconds - 900],
    );
    this.db.run("DELETE FROM sim_posted_orders WHERE windowEnd < ?", [
      nowSeconds - 86_400,
    ]);
  }

  deleteAll(): void {
    this.db.run("DELETE FROM sim_posted_orders");
  }
}

export class SimKeyRepository {
  constructor(private readonly db: Database) {}

  mark(key: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO sim_trade_keys (key, createdAt) VALUES (?, ?)",
      [key, Date.now()],
    );
  }

  all(): Array<{ key: string; createdAt: number }> {
    return this.db.all<{ key: string; createdAt: number }>(
      "SELECT key, createdAt FROM sim_trade_keys",
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM sim_trade_keys WHERE createdAt < ?", [beforeTs]);
  }

  delete(key: string): void {
    this.db.run("DELETE FROM sim_trade_keys WHERE key = ?", [key]);
  }
}

export class SimRetryRepository {
  constructor(private readonly db: Database) {}

  get(key: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT count FROM sim_retry_counts WHERE key = ?",
      [key],
    );
    return row?.count ?? 0;
  }

  increment(key: string): number {
    const next = this.get(key) + 1;
    this.db.run(
      `INSERT INTO sim_retry_counts (key, count, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, updatedAt = excluded.updatedAt`,
      [key, next, Date.now()],
    );
    return next;
  }

  all(): Map<string, { count: number; updatedAt: number }> {
    const rows = this.db.all<{ key: string; count: number; updatedAt: number | null }>(
      "SELECT key, count, updatedAt FROM sim_retry_counts",
    );
    return new Map(
      rows.map((r) => [r.key, { count: r.count, updatedAt: r.updatedAt ?? 0 }]),
    );
  }
}

export class SimWindowClaimRepository {
  constructor(private readonly db: Database) {}

  set(pairId: string, claim: WindowClaimRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO sim_window_claims (pairId, cheapOutcome, expensiveOutcome)
       VALUES (?, ?, ?)`,
      [pairId, claim.cheapOutcome, claim.expensiveOutcome],
    );
  }

  delete(pairId: string): void {
    this.db.run("DELETE FROM sim_window_claims WHERE pairId = ?", [pairId]);
  }

  all(): Map<string, WindowClaimRow> {
    const rows = this.db.all<{ pairId: string } & WindowClaimRow>(
      "SELECT pairId, cheapOutcome, expensiveOutcome FROM sim_window_claims",
    );
    return new Map(
      rows.map((r) => [r.pairId, { cheapOutcome: r.cheapOutcome, expensiveOutcome: r.expensiveOutcome }]),
    );
  }
}
