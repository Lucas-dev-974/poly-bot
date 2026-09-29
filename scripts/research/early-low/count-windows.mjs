// Compte les fenêtres 15m avec ≥ N ticks et couverture résolutions.
// Usage: node scripts/research/early-low/count-windows.mjs [minTicks]
import { DatabaseSync } from "node:sqlite";

const minTicks = Number(process.argv[2] ?? 750);
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

// Fenêtres par durée
const byDur = db
  .prepare(
    "SELECT CASE WHEN eventSlug LIKE '%-15m-%' THEN '15m' WHEN eventSlug LIKE '%-5m-%' THEN '5m' ELSE 'other' END AS d, COUNT(*) AS n FROM (SELECT DISTINCT eventSlug FROM book_snapshots) GROUP BY 1",
  )
  .all();
console.log("durations:", byDur);

// Fenêtres 15m avec >= minTicks ticks (un "tick" = row ts unique par slug)
const rows = db
  .prepare(
    "SELECT eventSlug, COUNT(DISTINCT ts) AS ticks FROM book_snapshots WHERE eventSlug LIKE '%-15m-%' GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= ?",
  )
  .all(minTicks);
console.log(`fenetres 15m avec >=${minTicks} ticks:`, rows.length);

// Résolutions enregistrées
const resTotal = db.prepare("SELECT COUNT(*) AS n FROM market_resolutions").get();
console.log("market_resolutions total:", resTotal.n);
const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM market_resolutions GROUP BY 1").all();
console.log("by source:", bySource);

// Overlap: fenêtres 15m >=750 ticks avec résolution enregistrée
const overlap = db
  .prepare(
    "SELECT COUNT(*) AS n FROM (SELECT DISTINCT eventSlug FROM book_snapshots WHERE eventSlug LIKE '%-15m-%' GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= ?) w INNER JOIN market_resolutions r ON r.eventSlug = w.eventSlug",
  )
  .get(minTicks);
console.log("overlap >=750 ticks + resolution:", overlap.n);

// Répartition gagnant (0=Up, 1=Down, 2=void)
const byWinner = db
  .prepare(
    "SELECT r.winnerOutcomeIndex, COUNT(*) AS n FROM (SELECT DISTINCT eventSlug FROM book_snapshots WHERE eventSlug LIKE '%-15m-%' GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= ?) w INNER JOIN market_resolutions r ON r.eventSlug = w.eventSlug",
  )
  .all(minTicks);
console.log("winner repartition (0=Up,1=Down,2=void):", byWinner);

db.close();