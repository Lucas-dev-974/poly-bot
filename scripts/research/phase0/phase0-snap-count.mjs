import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
console.log("tables:", tables.filter(t => /book|snap|backtest/i.test(t)).join(", "));
try {
  const c = db.prepare("SELECT COUNT(*) c FROM book_snapshots").get();
  console.log("book_snapshots rows:", c.c);
  const btc = db.prepare("SELECT COUNT(*) c FROM (SELECT eventSlug FROM book_snapshots WHERE eventSlug LIKE 'btc-updown-15m%' GROUP BY eventSlug)").get();
  console.log("btc distinct slugs:", btc.c);
  const eth = db.prepare("SELECT COUNT(*) c FROM (SELECT eventSlug FROM book_snapshots WHERE eventSlug LIKE 'eth-updown-15m%' GROUP BY eventSlug)").get();
  console.log("eth distinct slugs:", eth.c);
} catch (e) { console.error(e.message); }
