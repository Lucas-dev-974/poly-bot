import Database from 'better-sqlite3';
const db = new Database('data/bot-live.db', { readonly: true });
const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'").all();
console.log('INDEXES:', JSON.stringify(idx, null, 1));
const plan = db.prepare("EXPLAIN QUERY PLAN SELECT ts, outcomeIndex, bestAsk FROM book_snapshots WHERE eventSlug = 'btc-updown-15m-1788848100' ORDER BY ts").all();
console.log('QUERY PLAN (par eventSlug):', JSON.stringify(plan, null, 1));
db.close();