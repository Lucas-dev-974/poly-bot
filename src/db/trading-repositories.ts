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

export interface PositionRow {
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

export interface PairRow {
  id: string;
  eventSlug: string;
  eventTitle: string;
  windowEnd: number;
  status: ArbPairStatus;
  realizedPnl: number | null;
  resolvedAt: number | null;
  directional: number | null;
}

export function toPosition(row: PositionRow): SimulatedPosition {
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


interface OrderRow {
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
