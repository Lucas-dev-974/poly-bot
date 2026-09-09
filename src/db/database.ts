import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export class Database {
  private readonly conn: DatabaseSync | null;

  constructor(path: string, enabled: boolean) {
    if (!enabled) {
      this.conn = null;
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.conn = new DatabaseSync(path);
    this.conn.exec("PRAGMA journal_mode = WAL");
    this.conn.exec("PRAGMA foreign_keys = ON");
  }

  init(): void {
    if (!this.conn) return;
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        tokenId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcomeIndex INTEGER NOT NULL,
        kind TEXT NOT NULL,
        limitPrice REAL NOT NULL,
        fillPrice REAL NOT NULL,
        size REAL NOT NULL,
        cost REAL NOT NULL,
        windowEnd INTEGER NOT NULL,
        status TEXT NOT NULL,
        resolvedAt INTEGER,
        pnl REAL,
        fillReason TEXT NOT NULL,
        pairId TEXT NOT NULL,
        bestAskAtFill REAL,
        orderType TEXT,
        strategyId TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS arb_pairs (
        id TEXT PRIMARY KEY,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        windowEnd INTEGER NOT NULL,
        status TEXT NOT NULL,
        realizedPnl REAL,
        resolvedAt INTEGER,
        directional INTEGER
      );

      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance REAL NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        availableCollateral REAL NOT NULL,
        positionsValue REAL NOT NULL,
        totalValue REAL NOT NULL,
        source TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trade_keys (
        key TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retry_counts (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS posted_orders (
        key TEXT PRIMARY KEY,
        eventSlug TEXT NOT NULL,
        windowEnd INTEGER NOT NULL,
        cost REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        orderId TEXT
      );

      CREATE TABLE IF NOT EXISTS window_claims (
        pairId TEXT PRIMARY KEY,
        cheapOutcome TEXT NOT NULL,
        expensiveOutcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        tradeKey TEXT NOT NULL,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        tokenId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcomeIndex INTEGER NOT NULL,
        kind TEXT NOT NULL,
        orderType TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'BUY',
        limitPrice REAL NOT NULL,
        fillPrice REAL,
        size REAL NOT NULL,
        cost REAL,
        filled INTEGER NOT NULL,
        reason TEXT,
        dryRun INTEGER NOT NULL,
        orderId TEXT,
        pairId TEXT,
        windowEnd INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS redeems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        conditionId TEXT NOT NULL,
        outcomeIndex INTEGER NOT NULL,
        negRisk INTEGER NOT NULL,
        title TEXT,
        outcome TEXT,
        size REAL,
        txHash TEXT,
        source TEXT NOT NULL,
        success INTEGER NOT NULL,
        errorMessage TEXT
      );

      CREATE TABLE IF NOT EXISTS stats_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        conditionId TEXT NOT NULL,
        windowStart INTEGER NOT NULL,
        windowEnd INTEGER NOT NULL,
        volume REAL,
        volume24hr REAL,
        liquidity REAL,
        lastTradePrice REAL,
        spread REAL
      );

      CREATE TABLE IF NOT EXISTS book_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        eventSlug TEXT NOT NULL,
        tokenId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcomeIndex INTEGER NOT NULL,
        bestBid REAL,
        bestAsk REAL,
        bestAskSize REAL,
        bestBidSize REAL,
        ask2 REAL,
        ask2Size REAL,
        ask3 REAL,
        ask3Size REAL,
        bid2 REAL,
        bid2Size REAL,
        bid3 REAL,
        bid3Size REAL
      );

      CREATE TABLE IF NOT EXISTS opportunity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        eventSlug TEXT NOT NULL,
        kind TEXT NOT NULL,
        tokenId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        executed INTEGER NOT NULL DEFAULT 0,
        pairId TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
      CREATE INDEX IF NOT EXISTS idx_orders_orderId ON orders(orderId);
      CREATE INDEX IF NOT EXISTS idx_redeems_condition ON redeems(conditionId, outcomeIndex);
      CREATE INDEX IF NOT EXISTS idx_positions_pair_kind ON positions(pairId, kind);
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_stats_snapshots_ts ON stats_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_ts ON balance_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts ON market_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_book_snapshots_ts ON book_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_book_snapshots_slug_ts ON book_snapshots(eventSlug, ts);
      CREATE INDEX IF NOT EXISTS idx_opportunity_snapshots_ts ON opportunity_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_opportunity_snapshots_slug_ts ON opportunity_snapshots(eventSlug, ts);

      CREATE TABLE IF NOT EXISTS market_resolutions (
        eventSlug TEXT PRIMARY KEY,
        winnerOutcomeIndex INTEGER NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backtest_runs (
        id TEXT PRIMARY KEY,
        startedAt INTEGER NOT NULL,
        finishedAt INTEGER,
        status TEXT NOT NULL,
        requestJson TEXT NOT NULL,
        resultJson TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS backtest_positions (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        tokenId TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcomeIndex INTEGER NOT NULL,
        kind TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'BUY',
        limitPrice REAL NOT NULL,
        fillPrice REAL NOT NULL,
        size REAL NOT NULL,
        cost REAL NOT NULL,
        windowEnd INTEGER NOT NULL,
        status TEXT NOT NULL,
        resolvedAt INTEGER,
        pnl REAL,
        fillReason TEXT,
        pairId TEXT NOT NULL,
        bestAskAtFill REAL,
        orderType TEXT,
        strategyId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_positions_run ON backtest_positions(runId);

      CREATE TABLE IF NOT EXISTS backtest_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        eventSlug TEXT NOT NULL,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        side TEXT NOT NULL,
        limitPrice REAL NOT NULL,
        fillPrice REAL,
        size REAL NOT NULL,
        filled INTEGER NOT NULL,
        reason TEXT,
        fillReason TEXT,
        orderType TEXT,
        pairId TEXT,
        pnl REAL
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(runId);
    `);

    this.addColumnIfMissing("posted_orders", "orderId", "TEXT");
    const postedOrdersCols: Array<[string, string]> = [
      ["tokenId", "TEXT"],
      ["outcome", "TEXT"],
      ["outcomeIndex", "INTEGER"],
      ["kind", "TEXT"],
      ["limitPrice", "REAL"],
      ["size", "REAL"],
      ["pairId", "TEXT"],
      ["eventTitle", "TEXT"],
      ["bestAskAtFill", "REAL"],
      ["strategyId", "TEXT"],
    ];
    for (const [col, type] of postedOrdersCols) {
      this.addColumnIfMissing("posted_orders", col, type);
    }
    this.addColumnIfMissing("retry_counts", "updatedAt", "INTEGER");
    this.addColumnIfMissing("positions", "orderType", "TEXT");
    this.addColumnIfMissing("positions", "strategyId", "TEXT");
    // Heure réelle du fill (ms). Pour un GTC resting, diffère de ts (heure de placement).
    this.addColumnIfMissing("orders", "filledTs", "INTEGER");
    const marketSnapshotCols: Array<[string, string]> = [
      ["volume", "REAL"],
      ["volume24hr", "REAL"],
      ["liquidity", "REAL"],
      ["lastTradePrice", "REAL"],
      ["spread", "REAL"],
    ];
    for (const [col, type] of marketSnapshotCols) {
      this.addColumnIfMissing("market_snapshots", col, type);
    }
    const bookSnapshotCols: Array<[string, string]> = [
      ["bestBidSize", "REAL"],
      ["ask2", "REAL"],
      ["ask2Size", "REAL"],
      ["ask3", "REAL"],
      ["ask3Size", "REAL"],
      ["bid2", "REAL"],
      ["bid2Size", "REAL"],
      ["bid3", "REAL"],
      ["bid3Size", "REAL"],
    ];
    for (const [col, type] of bookSnapshotCols) {
      this.addColumnIfMissing("book_snapshots", col, type);
    }
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    if (!this.conn) return;
    try {
      this.conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/duplicate column name/i.test(message)) return;
      throw error;
    }
  }

  run(sql: string, params: SQLInputValue[] = []): void {
    if (!this.conn) return;
    this.conn.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
    if (!this.conn) return undefined;
    return this.conn.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: SQLInputValue[] = []): T[] {
    if (!this.conn) return [];
    return this.conn.prepare(sql).all(...params) as T[];
  }

  reset(): void {
    if (!this.conn) return;
    this.conn.exec(`
      DELETE FROM positions;
      DELETE FROM arb_pairs;
      DELETE FROM ledger;
      DELETE FROM balance_snapshots;
      DELETE FROM events;
      DELETE FROM trade_keys;
      DELETE FROM retry_counts;
      DELETE FROM posted_orders;
      DELETE FROM window_claims;
      DELETE FROM bot_state;
      DELETE FROM orders;
      DELETE FROM redeems;
      DELETE FROM stats_snapshots;
      DELETE FROM market_snapshots;
      DELETE FROM book_snapshots;
      DELETE FROM opportunity_snapshots;
      DELETE FROM market_resolutions;
      DELETE FROM backtest_runs;
      DELETE FROM backtest_trades;
      DELETE FROM backtest_positions;
    `);
  }

  close(): void {
    if (!this.conn) return;
    this.conn.close();
  }
}
