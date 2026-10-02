import type { Database } from "./database.js";

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
