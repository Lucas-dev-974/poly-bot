/**
 * Loader d'univers OFFICIEL-aligned pour les sims research-new-strats.
 * Réplique exactement le filtre du runner officiel :
 *   - ticks = DISTINCT ts de book_snapshots AVEC >= 2 outcomes (les deux
 *     tokens présents), fenêtre INCLUSIVE [windowStart*1000, windowEnd*1000]
 *   - bornes via windowBoundsFromSlug (parse du slug)
 *   - complétude : minTicks 801, maxGapMs 60 000, maxEdgeGapMs null
 *   - résolution : market_resolutions requis (pas de fallback probabiliste)
 * C'est le même compte que `listBacktestWindows` (book_snapshots ticks),
 * ce qui a manqué aux discovery-sim 1-6 (market_snapshots → 394 fenêtres
 * au lieu de 529) : la calibration runner a montré l'écart.
 */
import { DatabaseSync } from "node:sqlite";

export interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
}
export interface Tick {
  ts: number;
  up: SideBook;
  down: SideBook;
}
export interface Universe {
  slugs: Map<string, Tick[]>;
  resMap: Map<string, number>;
  wsMap: Map<string, number>;
}

export const CRITERIA = { minTicks: 801, maxGapMs: 60_000, maxEdgeGapMs: null } as const;

export function parseWindowStart(slug: string): number | null {
  const parts = slug.split("-");
  const startSec = Number(parts[parts.length - 1]);
  return Number.isFinite(startSec) && startSec > 1e9 ? startSec : null;
}

export function loadUniverse(dbPath = "data/bot-live.db"): Universe {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // ticks par slug sur book_snapshots : ts avec >= 2 outcomes, fenêtre inclusive
  const WINDOW_SEC = 900;
  const rows = db
    .prepare(
      `SELECT eventSlug AS slug, ts, COUNT(*) AS n
       FROM book_snapshots
       WHERE eventSlug LIKE 'btc-updown-15m-%'
       GROUP BY eventSlug, ts
       HAVING COUNT(*) >= 2
       ORDER BY eventSlug, ts`,
    )
    .all() as Array<{ slug: string; ts: number; n: number }>;

  const resRows = db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));

  // regrouper par slug, évaluer la complétude
  const bySlug = new Map<string, number[]>();
  for (const r of rows) {
    let list = bySlug.get(r.slug);
    if (!list) {
      list = [];
      bySlug.set(r.slug, list);
    }
    list.push(r.ts);
  }

  const completeSlugs: Array<{ slug: string; ws: number; we: number }> = [];
  for (const [slug, allTs] of bySlug) {
    if (resMap.get(slug) === undefined) continue;
    const wsSec = parseWindowStart(slug);
    if (wsSec == null) continue;
    const weSec = wsSec + WINDOW_SEC;
    const startMs = wsSec * 1000;
    const endMs = weSec * 1000;
    const sorted = allTs.filter((ts) => ts >= startMs && ts <= endMs).sort((a, b) => a - b);
    if (sorted.length < CRITERIA.minTicks) continue;
    let maxGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      const g = sorted[i] - sorted[i - 1];
      if (g > maxGap) maxGap = g;
    }
    if (maxGap > CRITERIA.maxGapMs) continue;
    completeSlugs.push({ slug, ws: wsSec, we: weSec });
  }

  // charger les ticks
  const slugs = new Map<string, Tick[]>();
  const wsMap = new Map<string, number>();
  const bookStmt = db.prepare(
    `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize
     FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
  );
  for (const { slug, ws } of completeSlugs) {
    const bookRows = bookStmt.all(slug) as Array<{
      ts: number;
      outcomeIndex: number;
      bestAsk: number | null;
      bestBid: number | null;
      bestAskSize: number | null;
    }>;
    const startMs = ws * 1000;
    const endMs = (ws + WINDOW_SEC) * 1000;
    const byTs = new Map<number, { up: SideBook; down: SideBook }>();
    const blank = (): SideBook => ({ ask: null, bid: null, askSize: null });
    for (const r of bookRows) {
      if (r.ts < startMs || r.ts > endMs) continue;
      let e = byTs.get(r.ts);
      if (!e) {
        e = { up: blank(), down: blank() };
        byTs.set(r.ts, e);
      }
      const side = r.outcomeIndex === 0 ? e.up : e.down;
      side.ask = r.bestAsk;
      side.bid = r.bestBid;
      side.askSize = r.bestAskSize;
    }
    const ticks: Tick[] = [];
    for (const [ts, b] of byTs) {
      if (b.up.ask == null && b.down.ask == null) continue;
      ticks.push({ ts, up: b.up, down: b.down });
    }
    ticks.sort((a, b) => a.ts - b.ts);
    slugs.set(slug, ticks);
    wsMap.set(slug, ws);
  }
  db.close();
  return { slugs, resMap, wsMap };
}