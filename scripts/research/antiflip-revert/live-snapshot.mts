// Snapshot final des positions antiflip-revert
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const rows = db
  .prepare(
    "SELECT eventSlug, outcome, fillPrice, size, cost, status, pnl, windowEnd FROM positions WHERE strategyId='antiflip-revert' ORDER BY createdAt",
  )
  .all();
let pnl = 0;
let open = 0;
for (const p of rows) {
  if (p.status !== "open" && p.pnl != null) pnl += p.pnl;
  else open++;
  console.log(
    `${p.eventSlug.slice(-10)} | ${p.outcome} @ ${p.fillPrice} | ${p.status} | pnl ${p.pnl}`,
  );
}
console.log(`\nTOTAL closed PnL: ${Math.round(pnl * 100) / 100} $ | open: ${open}`);
db.close();