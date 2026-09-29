/**
 * Probe : combien de fenêtres existe dans la DB vs combien utilisées par le clustering ?
 * Usage : npx tsx model-ia/scripts/research/patterns-ml/probe-coverage.mts
 */
import Database from 'better-sqlite3';

const db = new Database('data/bot-live.db', { readonly: true });

const total = db.prepare('SELECT COUNT(DISTINCT eventSlug) n FROM book_snapshots').get() as { n: number };

const withRes = db
  .prepare(
    'SELECT COUNT(DISTINCT bs.eventSlug) n FROM book_snapshots bs JOIN market_resolutions mr ON mr.eventSlug=bs.eventSlug'
  )
  .get() as { n: number };

const complete = db
  .prepare(
    `SELECT COUNT(*) n FROM (
      SELECT bs.eventSlug, COUNT(*) tickCount, MIN(bs.ts) s, MAX(bs.ts) e, mr.winnerOutcomeIndex w
      FROM book_snapshots bs JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
      GROUP BY bs.eventSlug
      HAVING tickCount >= 801
         AND (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) <= 1.5
         AND mr.winnerOutcomeIndex IS NOT NULL
    )`
  )
  .get() as { n: number };

const dates = db
  .prepare(
    `SELECT MIN(d) d1, MAX(d) d2 FROM (
      SELECT date(MIN(bs.ts)/1000, 'unixepoch') d FROM book_snapshots bs GROUP BY bs.eventSlug
    )`
  )
  .get() as { d1: string; d2: string };

const reasons = db
  .prepare(
    `SELECT
      SUM(CASE WHEN tickCount < 801 THEN 1 ELSE 0 END) tooFewTicks,
      SUM(CASE WHEN tickCount >= 801 AND avgGap > 1.5 THEN 1 ELSE 0 END) gappy,
      SUM(CASE WHEN winnerOutcomeIndex IS NULL THEN 1 ELSE 0 END) unresolved
    FROM (
      SELECT bs.eventSlug, COUNT(*) tickCount,
             (MAX(bs.ts) - MIN(bs.ts)) / 1000.0 / COUNT(*) avgGap,
             mr.winnerOutcomeIndex
      FROM book_snapshots bs LEFT JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
      GROUP BY bs.eventSlug
    )`
  )
  .get() as { tooFewTicks: number; gappy: number; unresolved: number };

console.log(
  JSON.stringify(
    {
      totalWindows: total.n,
      withResolution: withRes.n,
      completeAndClean: complete.n,
      excluded: total.n - complete.n,
      dateRange: `${dates.d1} -> ${dates.d2}`,
      exclusionReasons: reasons,
    },
    null,
    2
  )
);

// --- Diagnostic des fenêtres SANS résolution ---
const unresolved = db
  .prepare(
    `SELECT bs.eventSlug, COUNT(*) tickCount, MIN(bs.ts) windowStart, MAX(bs.ts) windowEnd
     FROM book_snapshots bs LEFT JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
     WHERE mr.eventSlug IS NULL
     GROUP BY bs.eventSlug
     ORDER BY windowStart`
  )
  .all() as { eventSlug: string; tickCount: number; windowStart: number; windowEnd: number }[];

const now = Date.now();
const byDay = new Map<string, { unresolved: number; total: number }>();
for (const w of unresolved) {
  const day = new Date(w.windowStart).toISOString().split('T')[0];
  const e = byDay.get(day) ?? { unresolved: 0, total: 0 };
  e.unresolved += 1;
  byDay.set(day, e);
}
const totalByDay = db
  .prepare(
    `SELECT date(d/1000, 'unixepoch') day, COUNT(*) n FROM (
       SELECT MIN(ts) d FROM book_snapshots GROUP BY eventSlug
     ) GROUP BY day ORDER BY day`
  )
  .all() as { day: string; n: number }[];
const timeline = totalByDay.map((t) => `${t.d}: ${byDay.get(t.d)?.unresolved ?? 0}/${t.n} sans résolution`);

// Fenêtres récentes (probablement pas encore résolues) vs anciennes
const recent = unresolved.filter((w) => now - w.windowEnd < 24 * 3600 * 1000).length;
const old = unresolved.length - recent;

// Répartition par taille
const small = unresolved.filter((w) => w.tickCount < 100).length;
const medium = unresolved.filter((w) => w.tickCount >= 100 && w.tickCount < 801).length;
const big = unresolved.filter((w) => w.tickCount >= 801).length;

// Un échantillon de slugs pour voir le type de marché
console.log('\n=== Fenêtres SANS market_resolutions ===');
console.log(JSON.stringify({ total: unresolved.length, recent24h: recent, olderThan24h: old, sizeBuckets: { '<100 ticks (abandonnées)': small, '100-800 ticks': medium, '>=801 ticks (complètes mais non résolues)': big } }, null, 2));
// Ventilation BTC vs ETH : résolues vs non-résolues
const byPrefix = db
  .prepare(
    `SELECT
       CASE WHEN eventSlug LIKE 'eth-%' THEN 'ETH' WHEN eventSlug LIKE 'btc%' THEN 'BTC' ELSE 'autre' END prefix,
       COUNT(*) n
     FROM (
       SELECT DISTINCT eventSlug FROM book_snapshots
     ) GROUP BY prefix`
  )
  .all() as { prefix: string; n: number }[];
const resolvedByPrefix = db
  .prepare(
    `SELECT
       CASE WHEN eventSlug LIKE 'eth-%' THEN 'ETH' WHEN eventSlug LIKE 'btc%' THEN 'BTC' ELSE 'autre' END prefix,
       COUNT(*) n
     FROM market_resolutions GROUP BY prefix`
  )
  .all() as { prefix: string; n: number }[];

const unresolvedCompleteByPrefix = db
  .prepare(
    `SELECT prefix, COUNT(*) n FROM (
       SELECT bs.eventSlug, COUNT(*) tickCount,
              CASE WHEN bs.eventSlug LIKE 'eth-%' THEN 'ETH' WHEN bs.eventSlug LIKE 'btc%' THEN 'BTC' ELSE 'autre' END prefix
       FROM book_snapshots bs LEFT JOIN market_resolutions mr ON mr.eventSlug = bs.eventSlug
       WHERE mr.eventSlug IS NULL
       GROUP BY bs.eventSlug HAVING tickCount >= 801
     ) GROUP BY prefix`
  )
  .all() as { prefix: string; n: number }[];

console.log('\n=== BTC vs ETH ===');
console.log('Fenêtres totales par préfixe :', JSON.stringify(byPrefix));
console.log('Résolutions écrites par préfixe :', JSON.stringify(resolvedByPrefix));
console.log('Complètes (>=801 ticks) SANS résolution :', JSON.stringify(unresolvedCompleteByPrefix));

console.log('\nTimeline par jour (sans résolution / total) :');
for (const t of totalByDay) console.log(`  ${t.day}: ${byDay.get(t.day)?.unresolved ?? 0}/${t.n} sans résolution`);
console.log('\nÉchantillon de 10 slugs complets non résolus :');
for (const w of unresolved.filter((w) => w.tickCount >= 801).slice(0, 10)) {
  console.log(`  ${w.eventSlug} (${w.tickCount} ticks)`);
}

db.close();