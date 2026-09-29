/**
 * Utilitaires partagés pour chargement DB et filtres de complétude
 * Partagé entre patterns-ml et next-market-ml
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

export interface DBConfig {
  dbPath: string;
}

export const DEFAULT_DB_CONFIG: DBConfig = {
  dbPath: path.resolve(process.cwd(), 'data/bot-live.db'),
};

/**
 * Ouvre la DB en lecture seule
 */
export function openDB(config: Partial<DBConfig> = {}): Database.Database {
  const cfg = { ...DEFAULT_DB_CONFIG, ...config };
  if (!fs.existsSync(cfg.dbPath)) {
    throw new Error(`Database not found: ${cfg.dbPath}`);
  }
  return new Database(cfg.dbPath, { readonly: true });
}

/**
 * Vérifie que la DB a les tables requises
 */
export function validateSchema(db: Database.Database): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));

  const required = ['book_snapshots', 'market_snapshots', 'market_resolutions'];
  for (const t of required) {
    if (!tableNames.has(t)) {
      console.error(`Missing table: ${t}`);
      return false;
    }
  }
  return true;
}

/**
 * Filtre de complétude pour fenêtres (réutilise la logique existante du repo)
 * Fenêtre complète = ≥ 801 ticks, gaps ≤ 60s, avec résolution
 */
export interface CompleteWindowFilter {
  minTicks: number;
  maxAvgGapSec: number;
  requireResolution: boolean;
}

export const DEFAULT_COMPLETE_WINDOW_FILTER: CompleteWindowFilter = {
  minTicks: 801,
  maxAvgGapSec: 60,
  requireResolution: true,
};

/**
 * Requête SQL pour fenêtres complètes
 */
export function getCompleteWindowsQuery(filter: Partial<CompleteWindowFilter> = {}): string {
  const f = { ...DEFAULT_COMPLETE_WINDOW_FILTER, ...filter };
  return `
    SELECT
      bs.eventSlug,
      MIN(bs.ts) as windowStart,
      MAX(bs.ts) as windowEnd,
      COUNT(*) as tickCount,
      mr.winnerOutcomeIndex,
      -- Récupère les noms d'outcomes depuis book_snapshots (UP/DOWN)
      MAX(CASE WHEN bs.outcomeIndex = 0 THEN bs.outcome END) as outcomeA,
      MAX(CASE WHEN bs.outcomeIndex = 1 THEN bs.outcome END) as outcomeB
    FROM book_snapshots bs
    JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
    GROUP BY bs.eventSlug
    HAVING tickCount >= ${f.minTicks}
       AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= ${f.maxAvgGapSec}
       ${f.requireResolution ? 'AND mr.winnerOutcomeIndex IS NOT NULL' : ''}
    ORDER BY windowStart
  `;
}

/**
 * Charge les fenêtres complètes avec le filtre standard
 */
export function loadCompleteWindows(
  db: Database.Database,
  filter: Partial<CompleteWindowFilter> = {}
): Array<{
  eventSlug: string;
  windowStart: number;
  windowEnd: number;
  tickCount: number;
  winnerOutcomeIndex: number | null;
  outcomeA: string;
  outcomeB: string;
}> {
  const query = getCompleteWindowsQuery(filter);
  return db.prepare(query).all() as any[];
}

/**
 * Charge les book snapshots pour une fenêtre
 */
export function loadBookSnapshots(
  db: Database.Database,
  eventSlug: string
): Array<{
  ts: number;
  outcome: string;
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  ask2: number;
  ask2Size: number;
  ask3: number;
  ask3Size: number;
  bid2: number;
  bid2Size: number;
  bid3: number;
  bid3Size: number;
}> {
  return db.prepare(`
    SELECT ts, outcome, bestBid, bestAsk, bestBidSize, bestAskSize,
           ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size
    FROM book_snapshots
    WHERE eventSlug = ?
    ORDER BY ts
  `).all(eventSlug) as any[];
}

/**
 * Charge les market snapshots pour une fenêtre
 */
export function loadMarketSnapshots(
  db: Database.Database,
  eventSlug: string
): Array<{
  ts: number;
  volume: number;
  volume24hr: number;
  liquidity: number;
  lastTradePrice: number;
  spread: number;
}> {
  return db.prepare(`
    SELECT ts, volume, volume24hr, liquidity, lastTradePrice, spread
    FROM market_snapshots
    WHERE eventSlug = ?
    ORDER BY ts
  `).all(eventSlug) as any[];
}

/**
 * Résolution du marché (winner)
 */
export function loadMarketResolution(
  db: Database.Database,
  eventSlug: string
): { winnerOutcomeIndex: number | null; resolvedAt: number | null } | null {
  const row = db.prepare(`
    SELECT winnerOutcomeIndex, resolvedAt
    FROM market_resolutions
    WHERE eventSlug = ?
  `).get(eventSlug) as any;
  return row || null;
}

/**
 * Infos marché (slug, outcomes, etc.) — récupéré depuis book_snapshots
 */
export function loadMarketInfo(
  db: Database.Database,
  eventSlug: string
): { eventSlug: string; outcomeA: string; outcomeB: string; question: string } | null {
  const row = db.prepare(`
    SELECT 
      eventSlug,
      MAX(CASE WHEN outcomeIndex = 0 THEN outcome END) as outcomeA,
      MAX(CASE WHEN outcomeIndex = 1 THEN outcome END) as outcomeB,
      eventSlug as question
    FROM book_snapshots
    WHERE eventSlug = ?
    GROUP BY eventSlug
  `).get(eventSlug) as any;
  return row || null;
}

/**
 * Compte total fenêtres résolues
 */
export function countResolvedWindows(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT eventSlug) as count
    FROM market_resolutions
    WHERE winnerOutcomeIndex IS NOT NULL
  `).get() as any;
  return row.count as number;
}

/**
 * Stats globales DB
 */
export function getDBStats(db: Database.Database): {
  bookSnapshots: number;
  marketSnapshots: number;
  resolutions: number;
  dateRange: { min: number; max: number };
} {
  const book = (db.prepare('SELECT COUNT(*) as c FROM book_snapshots').get() as any).c as number;
  const market = (db.prepare('SELECT COUNT(*) as c FROM market_snapshots').get() as any).c as number;
  const resolutions = (db.prepare('SELECT COUNT(*) as c FROM market_resolutions').get() as any).c as number;
  const range = db.prepare('SELECT MIN(ts) as min, MAX(ts) as max FROM book_snapshots').get() as any;

  return {
    bookSnapshots: book,
    marketSnapshots: market,
    resolutions,
    dateRange: { min: range.min, max: range.max },
  };
}

/**
 * Ferme la DB proprement
 */
export function closeDB(db: Database.Database): void {
  db.close();
}
