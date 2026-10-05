import type { Database } from "./database.js";

type BacktestRunStatus = "running" | "done" | "error" | "cancelled";

interface BacktestRunRow {
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
