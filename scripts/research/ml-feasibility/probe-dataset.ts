import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/bot-live.db', { readOnly: true });

const bal = db.prepare('SELECT winnerOutcomeIndex, COUNT(*) n FROM market_resolutions GROUP BY winnerOutcomeIndex').all();
console.log('class balance (0=Up,1=Down):', JSON.stringify(bal));

// Windows with resolution + enough ticks in [windowStart-ish, resolution ts]
const uni = db.prepare(`
  SELECT COUNT(*) n FROM (
    SELECT s.eventSlug,
           COUNT(DISTINCT s.ts) ticks,
           COUNT(DISTINCT s.outcomeIndex) nout
    FROM book_snapshots s
    JOIN market_resolutions r ON r.eventSlug = s.eventSlug
    WHERE s.ts >= r.ts - 960000 AND s.ts <= r.ts
    GROUP BY s.eventSlug
    HAVING nout >= 2 AND ticks >= 801
  )`).get();
console.log('windows w/ resolution + >=801 ticks in [res-960s, res]:', uni.n);

const both = db.prepare('SELECT COUNT(*) n FROM (SELECT eventSlug FROM book_snapshots GROUP BY eventSlug HAVING COUNT(DISTINCT outcomeIndex) >= 2)').get();
console.log('slugs with BOTH outcomes recorded:', both.n);

const avg = db.prepare('SELECT AVG(c) a, MIN(c) mn, MAX(c) mx FROM (SELECT eventSlug, COUNT(DISTINCT ts) c FROM book_snapshots GROUP BY eventSlug)').get();
console.log('distinct ts per slug avg/min/max:', Math.round(avg.a), '/', avg.mn, '/', avg.mx);

// resolution lag sample
const lag = db.prepare(`
  SELECT AVG(r.ts - m.windowEnd*1000)/1000.0 lag_s, COUNT(*) n
  FROM market_resolutions r JOIN market_snapshots m ON m.eventSlug = r.eventSlug
  GROUP BY r.eventSlug LIMIT 5`).all();
console.log('sample resolution lag vs windowEnd (s):', JSON.stringify(lag));