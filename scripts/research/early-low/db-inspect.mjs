// Inspection rapide de data/bot-live.db : couverture temporelle, durées.
// Usage : node scripts/research/early-low/db-inspect.mjs
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

const durations = db.prepare(`
  SELECT CASE
    WHEN eventSlug LIKE '%-15m-%' THEN '15m'
    WHEN eventSlug LIKE '%-5m-%' THEN '5m'
    WHEN eventSlug LIKE '%-30m-%' THEN '30m'
    ELSE 'other' END AS dur,
  COUNT(DISTINCT eventSlug) AS n
  FROM book_snapshots GROUP BY dur
`).all();
console.log("durations:", JSON.stringify(durations));

const range = db.prepare("SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS n FROM book_snapshots").all();
console.log("range:", JSON.stringify(range));
if (range[0] && range[0].minTs) {
  console.log("from:", new Date(range[0].minTs).toISOString(), "to:", new Date(range[0].maxTs).toISOString());
  const days = (range[0].maxTs - range[0].minTs) / 86_400_000;
  console.log("coverage days:", days.toFixed(2));
}

// Répartition par jour (UTC) des fenêtres 15m
const perDay = db.prepare(`
  SELECT date(MIN(ts)/1000, 'unixepoch') AS day, COUNT(DISTINCT eventSlug) AS windows
  FROM book_snapshots WHERE eventSlug LIKE '%-15m-%'
  GROUP BY day ORDER BY day
`).all();
console.log("perDay15m:", JSON.stringify(perDay));

db.close();