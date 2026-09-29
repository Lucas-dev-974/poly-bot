// Distribution par jour des fenêtres 15m et de leur complétude.
import { DatabaseSync } from "node:sqlite";
import { windowBoundsFromSlug, minTicksForDuration } from "../../../src/backtest/completeness.ts";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const groups = db.prepare(`
  SELECT eventSlug, COUNT(*) AS n, MIN(ts) AS firstTs, MAX(ts) AS lastTs
  FROM book_snapshots WHERE eventSlug LIKE '%-15m-%'
  GROUP BY eventSlug
`).all();
const byDay = new Map<string, { total: number; complete: number; ticksSum: number }>();
for (const g of groups) {
  const bounds = windowBoundsFromSlug(g.eventSlug);
  if (!bounds) continue;
  const day = new Date(bounds.windowEnd * 1000).toISOString().slice(0, 10);
  const ent = byDay.get(day) ?? { total: 0, complete: 0, ticksSum: 0 };
  ent.total++;
  ent.ticksSum += g.n;
  if (g.n >= minTicksForDuration(900)) ent.complete++;
  byDay.set(day, ent);
}
const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log("day       total complete avgTicks");
for (const [day, e] of rows) {
  console.log(`${day}  ${String(e.total).padStart(5)}  ${String(e.complete).padStart(8)}  ${Math.round(e.ticksSum / e.total)}`);
}
db.close();