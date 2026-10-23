import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readTableMetrics } from "./db-metrics.js";

export interface DbTableStatRow {
  name: string;
  count: number;
  /**
   * Octets occupés par la table (btree de la table + ses indexes, via dbstat).
   * null si la build SQLite n'a pas DBSTAT_VTAB ou si le scan est en cours.
   */
  bytes: number | null;
  /**
   * Jours civils DISTINCTS (UTC) couverts par market_snapshots UNIQUEMENT —
   * undefined pour toutes les autres tables.
   */
  days?: number | null;
}

export interface DbStatsInfo {
  /** Taille du fichier .db sur disque. */
  fileBytes: number;
  /** Taille du -wal sur disque (0 si absent). */
  walBytes: number;
  pageSize: number;
  pageCount: number;
  /** Pages libres (freelist) en octets. */
  freelistBytes: number;
  /**
   * Message d'échec de la requête dbstat (tailles par table), pour diagnostic
   * via l'API — null si les tailles sont disponibles.
   */
  sizeQueryError: string | null;
}

export interface DbStatsReport {
  tables: DbTableStatRow[];
  /** null si la persistance est désactivée. */
  db: DbStatsInfo | null;
}

/** TTL du cache des tailles par table (scan dbstat worker better-sqlite3). */
const SIZES_TTL_MS = 180_000;

/** Table unique qui porte la métrique « jours marché enregistrés » (days). */
const MARKET_SNAPSHOTS_TABLE = "market_snapshots";

export class Database {
  private readonly conn: DatabaseSync | null;
  /** Chemin du fichier DB (null si persistance désactivée) — pour stat du .db / -wal. */
  private readonly path: string | null;
  /** Cache du scan dbstat (worker better-sqlite3 readonly) — TTL SIZES_TTL_MS. */
  private sizesByTable: Map<string, number> | null = null;
  /** Nb de jours marché (market_snapshots), ride dans le même scan caché. */
  private sizesMarketDays: number | null = null;
  private sizesAt = 0;
  private sizesError: string | null = null;
  private sizesPending = false;

  constructor(path: string, enabled: boolean) {
    this.path = enabled ? path : null;
    if (!enabled) {
      this.conn = null;
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.conn = new DatabaseSync(path);
    this.conn.exec("PRAGMA journal_mode = WAL");
    this.conn.exec("PRAGMA busy_timeout = 5000");
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
        sellPrice REAL,
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

      CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        "to" TEXT NOT NULL,
        amount REAL NOT NULL,
        txHash TEXT,
        source TEXT NOT NULL,
        success INTEGER NOT NULL,
        errorMessage TEXT
      );

      CREATE TABLE IF NOT EXISTS market_rules (
        prefix            TEXT PRIMARY KEY,
        recordingEnabled  INTEGER NOT NULL DEFAULT 1,
        tradingEnabled    INTEGER NOT NULL DEFAULT 1,
        addedBy           TEXT NOT NULL DEFAULT 'user',
        createdAt         INTEGER NOT NULL,
        updatedAt         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_graphs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        leadsWithEdge INTEGER NOT NULL DEFAULT 0,
        graphJson TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
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
        strategyId TEXT,
        sellPrice REAL
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

      CREATE TABLE IF NOT EXISTS sim_positions (
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
        sellPrice REAL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_positions_status ON sim_positions(status);
      CREATE INDEX IF NOT EXISTS idx_sim_positions_pair_kind ON sim_positions(pairId, kind);

      CREATE TABLE IF NOT EXISTS sim_pairs (
        id TEXT PRIMARY KEY,
        eventSlug TEXT NOT NULL,
        eventTitle TEXT NOT NULL,
        windowEnd INTEGER NOT NULL,
        status TEXT NOT NULL,
        realizedPnl REAL,
        resolvedAt INTEGER,
        directional INTEGER
      );

      CREATE TABLE IF NOT EXISTS sim_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      CREATE INDEX IF NOT EXISTS idx_sim_trades_ts ON sim_trades(ts);

      CREATE TABLE IF NOT EXISTS sim_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sim_posted_orders (
        key TEXT PRIMARY KEY,
        eventSlug TEXT NOT NULL,
        windowEnd INTEGER NOT NULL,
        cost REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        orderId TEXT,
        tokenId TEXT,
        outcome TEXT,
        outcomeIndex INTEGER,
        kind TEXT,
        limitPrice REAL,
        size REAL,
        pairId TEXT,
        eventTitle TEXT,
        bestAskAtFill REAL,
        strategyId TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sim_posted_orders_slug ON sim_posted_orders(eventSlug);


      CREATE TABLE IF NOT EXISTS sim_positions_archive (
        archiveId INTEGER PRIMARY KEY AUTOINCREMENT,
        archiveBatchId TEXT NOT NULL,
        archivedAt INTEGER NOT NULL,
        id TEXT NOT NULL,
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
        sellPrice REAL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sim_positions_archive_batch ON sim_positions_archive(archiveBatchId);
      CREATE INDEX IF NOT EXISTS idx_sim_positions_archive_archivedAt ON sim_positions_archive(archivedAt);

      CREATE TABLE IF NOT EXISTS sim_trade_keys (
        key TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sim_retry_counts (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        updatedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS sim_window_claims (
        pairId TEXT PRIMARY KEY,
        cheapOutcome TEXT NOT NULL,
        expensiveOutcome TEXT NOT NULL
      );
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
    this.addColumnIfMissing("positions", "sellPrice", "REAL");
    this.addColumnIfMissing("sim_positions", "orderType", "TEXT");
    this.addColumnIfMissing("sim_positions", "strategyId", "TEXT");
    this.addColumnIfMissing("sim_positions", "sellPrice", "REAL");
    this.addColumnIfMissing("backtest_positions", "sellPrice", "REAL");
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
      DELETE FROM withdrawals;
      DELETE FROM stats_snapshots;
      DELETE FROM market_snapshots;
      DELETE FROM book_snapshots;
      DELETE FROM opportunity_snapshots;
      DELETE FROM market_resolutions;
      DELETE FROM market_rules;
      DELETE FROM backtest_runs;
      DELETE FROM backtest_trades;
      DELETE FROM backtest_positions;
      DELETE FROM sim_positions;
      DELETE FROM sim_pairs;
      DELETE FROM sim_trades;
      DELETE FROM sim_state;
      DELETE FROM sim_posted_orders;
      DELETE FROM sim_trade_keys;
      DELETE FROM sim_retry_counts;
      DELETE FROM sim_window_claims;
      DELETE FROM sim_positions_archive;
    `);
  }


  listDbStats(): DbStatsReport {
    if (!this.conn) return { tables: [], db: null };
    const tables = this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const out: DbTableStatRow[] = [];
    for (const t of tables) {
      // Only count real identifiers from sqlite_master (defense in depth).
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name)) continue;
      const row = this.get<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM "${t.name}"`);
      out.push({ name: t.name, count: Number(row?.c ?? 0), bytes: null });
    }
    // Tailles par table = btree + indexes via dbstat, exécuté HORS boucle
    // (worker better-sqlite3 readonly + cache TTL) : le scan peut durer
    // plusieurs secondes sur une base de plusieurs Go, il ne doit JAMAIS
    // geler la boucle d'événements du bot. Un cycle peut donc renvoyer des
    // bytes null — l'UI dégrade la colonne en « — » puis se remplit.
    const sizeQueryError = this.ensureTableSizes(out);
    const pageSize = Number(this.get<{ page_size: number }>("PRAGMA page_size")?.page_size ?? 0);
    const pageCount = Number(this.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0);
    const freePages = Number(
      this.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count ?? 0,
    );
    let fileBytes = 0;
    let walBytes = 0;
    if (this.path) {
      try {
        fileBytes = statSync(this.path).size;
      } catch {
        /* fichier introuvable : garde 0 */
      }
      try {
        walBytes = statSync(`${this.path}-wal`).size;
      } catch {
        /* pas de -wal : garde 0 */
      }
    }
    return {
      tables: out,
      db: {
        fileBytes,
        walBytes,
        pageSize,
        pageCount,
        freelistBytes: freePages * pageSize,
        sizeQueryError,
      },
    };
  }

  /**
   * Remplit `bytes` de chaque ligne depuis le cache du scan dbstat, et
   * planifie un scan worker (better-sqlite3 readonly) si le cache est périmé
   * — jamais dans la boucle du bot.
   * Retour : null si les tailles sont complètes, sinon le message d'attente
   * (« scan en cours ») ou l'erreur du dernier scan tenté.
   */
  private ensureTableSizes(out: DbTableStatRow[]): string | null {
    if (this.sizesByTable) {
      for (const t of out) {
        const bytes = this.sizesByTable.get(t.name);
        if (bytes != null) t.bytes = bytes;
      }
      const market = out.find((t) => t.name === MARKET_SNAPSHOTS_TABLE);
      if (market) market.days = this.sizesMarketDays;
      const complete = !out.some((t) => t.bytes == null);
      // Une fois le cache complet, une erreur historique du dernier scan
      // raté n'est plus pertinente.
      if (complete) this.sizesError = null;
      return complete ? null : this.sizesError ?? "tailles partielles, nouveau scan attendu";
    }
    if (!this.path) return null;
    if (Date.now() - this.sizesAt > SIZES_TTL_MS && !this.sizesPending) {
      this.sizesPending = true;
      const dbPath = resolve(this.path);
      void readTableMetrics(dbPath)
        .then((m) => {
          this.sizesByTable = m.byTable;
          this.sizesMarketDays = m.marketDays;
          this.sizesError = null;
        })
        .catch((e: unknown) => {
          this.sizesError = e instanceof Error ? e.message : String(e);
          console.warn(`[db] métriques par table indisponibles : ${this.sizesError}`);
        })
        .finally(() => {
          this.sizesPending = false;
          this.sizesAt = Date.now();
        });
    }
    return this.sizesError ?? "scan dbstat (worker) en cours…";
  }

  close(): void {
    if (!this.conn) return;
    this.conn.close();
  }
}
