import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot-live.db', { readOnly: true });

// Completeness per slug on book_snapshots (official-runner criteria: >=801 distinct ts, gap <= 60s)
const rows = db.prepare(`
  SELECT eventSlug,
         COUNT(DISTINCT ts) ticks,
         MAX(ts) - MIN(ts) span,
         COUNT(DISTINCT outcomeIndex) nout
  FROM book_snapshots
  GROUP BY eventSlug
`).all();

let complete = 0, withRes = 0, bothOut = 0;
const res = new Set(db.prepare('SELECT eventSlug e FROM market_resolutions').all().map(r => r.e));
for (const r of rows) {
  const gapOk = r.span <= (r.ticks - 1) * 60000 + 60000; // max gap 60s approximated by span vs ticks
  if (r.nout >= 2) bothOut++;
  if (r.ticks >= 801 && gapOk) { complete++; if (res.has(r.eventSlug)) withRes++; }
}
console.log('total slugs:', rows.length);
console.log('slugs with both outcomes:', bothOut);
console.log('slugs >=801 ticks (span-approx completeness):', complete);
console.log('...of those with a resolution:', withRes);

// per-tick feature width: fields available per tick
console.log('book columns: bestBid/bestAsk +/- sizes, ask2/ask3, bid2/bid3 (3 levels per side, both outcomes = ~14 raw features per tick)');
console.log('market columns: volume, volume24hr, liquidity, lastTradePrice, spread');