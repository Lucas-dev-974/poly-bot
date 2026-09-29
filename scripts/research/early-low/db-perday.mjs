// Répartition par jour des fenêtres 15m.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const perDay = db.prepare(`
  SELECT substr(ts, 1, 10) AS day,
  (SELECT COUNT(DISTINCT eventSlug) FROM book_snapshots b2
   WHERE substr(b2.ts, 1, 10) = substr(book_snapshots.ts, 1, 10)
     AND b2.eventSlug LIKE '%-15m-%') AS windows
  FROM book_snapshots GROUP BY day ORDER BY day
`).all();
const seen = new Set();
for (const r of perDay) {
  if (seen.has(r.day)) continue;
  seen.add(r.day);
  console.log(r.day, r.windows);
}
db.close();