import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
// Use the phase0 copy - last run wrote into it via repos
const db = new DatabaseSync("data/bot-phase0-postA.db", { readOnly: true });
const runs = db.prepare("SELECT id, status, startedAt FROM backtest_runs ORDER BY startedAt DESC LIMIT 5").all();
console.log("runs", runs);
const runId = runs[0]?.id;
if (!runId) { console.log("no run"); process.exit(0); }
const trades = db.prepare("SELECT side, kind, reason, filled, COUNT(*) c, SUM(size) sz FROM backtest_trades WHERE runId=? GROUP BY side, kind, reason, filled").all(runId);
console.log("trades", trades);
const pos = db.prepare("SELECT kind, status, COUNT(*) c FROM backtest_positions WHERE runId=? GROUP BY kind, status").all(runId);
console.log("positions", pos);
