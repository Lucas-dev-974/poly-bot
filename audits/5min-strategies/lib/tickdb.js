// Schéma et accès SQLite pour le dataset 5m (autonome, node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(HERE, "..", "data", "5m-data.db");

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS windows (
      slug TEXT PRIMARY KEY,
      startTs INTEGER NOT NULL,
      endTs INTEGER NOT NULL,
      conditionId TEXT,
      tokenUp TEXT,
      tokenDown TEXT,
      winnerIndex INTEGER,          -- 0=Up, 1=Down, NULL=pas encore résolu
      resolutionTs INTEGER,
      tradeCount INTEGER,
      source TEXT NOT NULL          -- 'collector' | 'history'
    );

    -- Un tick = un trade (histoire importée) OU un échantillon de book (collector).
    CREATE TABLE IF NOT EXISTS ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      ts INTEGER NOT NULL,          -- epoch ms
      side INTEGER NOT NULL,        -- 0=Up, 1=Down
      kind TEXT NOT NULL,           -- 'book' | 'trade'
      bid REAL, ask REAL,           -- book only
      bidSize REAL, askSize REAL,   -- book only
      price REAL,                   -- trade only (prix d'exécution)
      size REAL,                    -- trade only (shares)
      tradeSide TEXT,               -- trade only ('BUY'/'SELL' vu du taker)
      FOREIGN KEY (slug) REFERENCES windows(slug)
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_slug_ts ON ticks(slug, ts);
    CREATE INDEX IF NOT EXISTS idx_ticks_slug ON ticks(slug);
    CREATE INDEX IF NOT EXISTS idx_ticks_kind ON ticks(kind);

    CREATE TABLE IF NOT EXISTS resolutions (
      slug TEXT PRIMARY KEY,
      winnerIndex INTEGER NOT NULL,
      winner TEXT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL          -- 'gamma' | 'bot-db'
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      startedAt INTEGER NOT NULL,
      finishedAt INTEGER,
      status TEXT NOT NULL,
      paramsJson TEXT NOT NULL,
      resultJson TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId TEXT NOT NULL,
      slug TEXT NOT NULL,
      entryTs INTEGER,
      side INTEGER NOT NULL,        -- 0=Up, 1=Down
      entryPrice REAL NOT NULL,
      shares REAL NOT NULL,
      cost REAL NOT NULL,
      exitTs INTEGER,
      exitPrice REAL,
      status TEXT NOT NULL,         -- 'open' | 'won' | 'lost' | 'sold'
      pnl REAL,
      strategyId TEXT NOT NULL,
      paramsHash TEXT,
      signal TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_trades_run ON run_trades(runId);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function upsertWindow(db, w) {
  db.prepare(`
    INSERT INTO windows (slug, startTs, endTs, conditionId, tokenUp, tokenDown, winnerIndex, resolutionTs, tradeCount, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      conditionId = COALESCE(excluded.conditionId, conditionId),
      tokenUp = COALESCE(excluded.tokenUp, tokenUp),
      tokenDown = COALESCE(excluded.tokenDown, tokenDown),
      winnerIndex = COALESCE(excluded.winnerIndex, winnerIndex),
      resolutionTs = COALESCE(excluded.resolutionTs, resolutionTs),
      tradeCount = COALESCE(excluded.tradeCount, tradeCount),
      source = excluded.source
  `).run(
    w.slug, w.startTs, w.endTs, w.conditionId ?? null,
    w.tokenUp ?? null, w.tokenDown ?? null,
    w.winnerIndex ?? null, w.resolutionTs ?? null, w.tradeCount ?? null,
    w.source,
  );
}

export function insertTick(db, t) {
  db.prepare(`
    INSERT INTO ticks (slug, ts, side, kind, bid, ask, bidSize, askSize, price, size, tradeSide)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.slug, t.ts, t.side, t.kind, t.bid ?? null, t.ask ?? null,
    t.bidSize ?? null, t.askSize ?? null, t.price ?? null, t.size ?? null, t.tradeSide ?? null);
}

export function insertTicksTx(db, ticks) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(`
      INSERT INTO ticks (slug, ts, side, kind, bid, ask, bidSize, askSize, price, size, tradeSide)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of ticks) {
      stmt.run(t.slug, t.ts, t.side, t.kind, t.bid ?? null, t.ask ?? null,
        t.bidSize ?? null, t.askSize ?? null, t.price ?? null, t.size ?? null, t.tradeSide ?? null);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function upsertResolution(db, r) {
  db.prepare(`
    INSERT INTO resolutions (slug, winnerIndex, winner, ts, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO NOTHING
  `).run(r.slug, r.winnerIndex, r.winner ?? null, r.ts, r.source);
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

/**
 * Charge les fenêtres complètes (ticks + résolution) pour le backtest.
 * @returns {Array<{slug, startTs, endTs, winnerIndex, ticksUp: Array, ticksDown: Array}>}
 * ticks triés par ts asc. Pour kind='book' : bid/ask. Pour kind='trade' : price/size/tradeSide.
 */
export function loadWindows(db, opts = {}) {
  const { minTicks = 20, prefix = "btc-updown-5m" } = opts;
  const windows = db.prepare(`
    SELECT w.slug, w.startTs, w.endTs, w.winnerIndex
    FROM windows w
    WHERE w.slug LIKE ? AND w.winnerIndex IS NOT NULL
    ORDER BY w.startTs
  `).all(`${prefix}-%`);

  const out = [];
  for (const w of windows) {
    const rows = db.prepare(`
      SELECT ts, side, kind, bid, ask, bidSize, askSize, price, size, tradeSide
      FROM ticks WHERE slug = ? ORDER BY ts
    `).all(w.slug);
    const ticksUp = rows.filter((r) => r.side === 0);
    const ticksDown = rows.filter((r) => r.side === 1);
    if (ticksUp.length < minTicks || ticksDown.length < minTicks) continue;
    out.push({
      slug: w.slug,
      startTs: w.startTs,
      endTs: w.endTs,
      winnerIndex: w.winnerIndex,
      ticksUp,
      ticksDown,
    });
  }
  return out;
}

export function runStats(db) {
  const windows = db.prepare("SELECT COUNT(*) c FROM windows WHERE winnerIndex IS NOT NULL").get().c;
  const withTicks = db.prepare(`
    SELECT COUNT(*) c FROM windows w
    WHERE w.winnerIndex IS NOT NULL AND (
      SELECT COUNT(*) FROM ticks WHERE slug = w.slug
    ) >= 40
  `).get().c;
  const ticks = db.prepare("SELECT COUNT(*) c FROM ticks").get().c;
  const runs = db.prepare("SELECT COUNT(*) c FROM runs WHERE status = 'done'").get().c;
  return { windows, withTicks, ticks, runs };
}