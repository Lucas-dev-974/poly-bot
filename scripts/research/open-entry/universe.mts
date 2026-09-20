/**
 * Loader d'univers OFFICIEL-aligned pour open-entry (copie étendue de
 * research-new-strats/universe.mts). Réplique exactement le filtre du runner
 * officiel :
 *   - ticks = DISTINCT ts de book_snapshots AVEC >= 2 outcomes, fenêtre
 *     INCLUSIVE [windowStart*1000, windowEnd*1000]
 *   - bornes via parse du slug, complétude minTicks 801 / maxGapMs 60 000
 *   - résolution : market_resolutions requis (pas de fallback probabiliste)
 * Extension additive pour pricer des SORTIES honnêtement (ventes FOK sur le
 * carnet détenu) : le SideBook porte aussi bidSize + niveaux bid2/bid3
 * (prix+tailles) et ask2/ask3 (contrôle, l'entrée officielle exige la
 * profondeur totale au niveau 1 et kill sinon — pas de walk).
 */
import { DatabaseSync } from "node:sqlite";

export interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
  bidSize: number | null;
  bid2: number | null;
  bid2Size: number | null;
  bid3: number | null;
  bid3Size: number | null;
  ask2: number | null;
  ask2Size: number | null;
  ask3: number | null;
  ask3Size: number | null;
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
export const WINDOW_SEC = 900;

export function parseWindowStart(slug: string): number | null {
  const parts = slug.split("-");
  const startSec = Number(parts[parts.length - 1]);
  return Number.isFinite(startSec) && startSec > 1e9 ? startSec : null;
}

export function loadUniverse(dbPath = "data/bot-live.db"): Universe {
  const db = new DatabaseSync(dbPath, { readOnly: true });

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

  const slugs = new Map<string, Tick[]>();
  const wsMap = new Map<string, number>();
  const bookStmt = db.prepare(
    `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize, bestBidSize,
            ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size
     FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
  );
  for (const { slug, ws } of completeSlugs) {
    const bookRows = bookStmt.all(slug) as Array<{
      ts: number;
      outcomeIndex: number;
      bestAsk: number | null;
      bestBid: number | null;
      bestAskSize: number | null;
      bestBidSize: number | null;
      ask2: number | null;
      ask2Size: number | null;
      ask3: number | null;
      ask3Size: number | null;
      bid2: number | null;
      bid2Size: number | null;
      bid3: number | null;
      bid3Size: number | null;
    }>;
    const startMs = ws * 1000;
    const endMs = (ws + WINDOW_SEC) * 1000;
    const byTs = new Map<number, { up: SideBook; down: SideBook }>();
    const blank = (): SideBook => ({
      ask: null, bid: null, askSize: null, bidSize: null,
      bid2: null, bid2Size: null, bid3: null, bid3Size: null,
      ask2: null, ask2Size: null, ask3: null, ask3Size: null,
    });
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
      side.bidSize = r.bestBidSize;
      side.ask2 = r.ask2;
      side.ask2Size = r.ask2Size;
      side.ask3 = r.ask3;
      side.ask3Size = r.ask3Size;
      side.bid2 = r.bid2;
      side.bid2Size = r.bid2Size;
      side.bid3 = r.bid3;
      side.bid3Size = r.bid3Size;
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