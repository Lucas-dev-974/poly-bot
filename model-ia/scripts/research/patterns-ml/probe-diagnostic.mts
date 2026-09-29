/**
 * Sonde de diagnostic — vérifie où la pipeline discover casse
 * Lecture seule, n'écrit rien. Usage: npx tsx model-ia/scripts/research/patterns-ml/probe-diagnostic.mts
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import { toSAX, DEFAULT_SAX_CONFIG } from './sax.mts';

const dbPath = path.resolve(process.cwd(), 'data/bot-live.db');
const db = new Database(dbPath, { readonly: true });

// 1. Schéma réel des tables
const cols = (t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name).join(',');
console.log('=== SCHÉMA ===');
console.log('book_snapshots:', cols('book_snapshots'));
console.log('market_snapshots:', cols('market_snapshots'));
console.log('market_resolutions:', cols('market_resolutions'));

// 2. Fenêtres selon la requête de dataset.mts
const windows = db.prepare(`
  SELECT bs.eventSlug, MIN(bs.ts) as windowStart, MAX(bs.ts) as windowEnd,
    COUNT(*) as tickCount, mr.winnerOutcomeIndex
  FROM book_snapshots bs
  JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
  GROUP BY bs.eventSlug
  HAVING tickCount >= 801
    AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= 1.5
    AND mr.winnerOutcomeIndex IS NOT NULL
  ORDER BY windowStart
`).all() as any[];
console.log(`\n=== FENÊTRES (requête dataset.mts) ===`);
console.log('Fenêtres complètes:', windows.length);

// 3. Recharge ticks de 3 fenêtres comme discover.mts
console.log(`\n=== TICKS PAR FENÊTRE (échantillon 3) ===`);
for (const w of windows.slice(0, 3)) {
  const distinctTs = db.prepare(`SELECT DISTINCT ts FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`).all(w.eventSlug) as any[];
  let merged = 0;
  for (const { ts } of distinctTs.slice(0, 5000)) {
    const up = db.prepare(`SELECT bestAsk FROM book_snapshots WHERE eventSlug = ? AND ts = ? AND outcomeIndex = 0`).get(w.eventSlug, ts);
    const down = db.prepare(`SELECT bestAsk FROM book_snapshots WHERE eventSlug = ? AND ts = ? AND outcomeIndex = 1`).get(w.eventSlug, ts);
    if (up && down && (up as any).bestAsk !== null && (down as any).bestAsk !== null) merged++;
  }
  const series: number[] = [];
  for (const { ts } of distinctTs) {
    const up = db.prepare(`SELECT bestAsk FROM book_snapshots WHERE eventSlug = ? AND ts = ? AND outcomeIndex = 0`).get(w.eventSlug, ts) as any;
    const down = db.prepare(`SELECT bestAsk FROM book_snapshots WHERE eventSlug = ? AND ts = ? AND outcomeIndex = 1`).get(w.eventSlug, ts) as any;
    if (up && down && up.bestAsk !== null && down.bestAsk !== null) {
      const fav = up.bestAsk <= down.bestAsk ? up.bestAsk : down.bestAsk;
      series.push(fav);
    }
  }
  console.log(`${w.eventSlug.slice(0, 40)}: rowsSQL=${w.tickCount} distinctTs=${distinctTs.length} ticksFusionnés=${merged} série=${series.length}`);
  if (series.length >= 100) {
    const paaSeg = Math.min(200, series.length);
    const sax = toSAX(series, { ...DEFAULT_SAX_CONFIG, windowTicks: series.length, stride: series.length, paaSegments: paaSeg });
    console.log(`  SAX len=${sax.length} ex="${sax.slice(0, 40)}..."`);
    // nb shapelets candidats (lengths du discover actuel)
    let nShapelets = 0;
    for (const len of [10, 20, 40]) if (len <= sax.length) nShapelets += sax.length - len + 1;
    console.log(`  Shapelets candidats/fenêtre (len 10,20,40): ~${nShapelets}`);
  }
}

// 4. Distribution outcomes / balance des labels
const res = db.prepare(`SELECT winnerOutcomeIndex, COUNT(*) as c FROM market_resolutions WHERE winnerOutcomeIndex IS NOT NULL GROUP BY winnerOutcomeIndex`).all() as any[];
console.log(`\n=== RÉSOLUTIONS ===`, res);

db.close();
console.log('\n=== SONDE TERMINÉE ===');