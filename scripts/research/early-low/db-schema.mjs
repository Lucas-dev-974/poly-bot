// Schéma des tables utiles.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
for (const t of ["book_snapshots", "market_resolutions", "events"]) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log(t + ":", cols.map((c) => c.name).join(", "));
}
db.close();