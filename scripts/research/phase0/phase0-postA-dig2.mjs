import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("data/bot-phase0-postA.db", { readOnly: true });
const runs = db.prepare("SELECT id, status, startedAt, substr(resultJson,1,200) r FROM backtest_runs ORDER BY startedAt DESC LIMIT 8").all();
for (const r of runs) console.log(r.id, r.status, r.startedAt, r.r?.slice(0,120));
const ids = db.prepare("SELECT DISTINCT runId FROM backtest_trades ORDER BY runId DESC LIMIT 10").all();
console.log("trade runIds", ids);
for (const { runId } of ids) {
  if (!String(runId).includes("phase0-postA") && !String(runId).startsWith("phase0")) continue;
  const trades = db.prepare("SELECT side, kind, reason, filled, COUNT(*) c FROM backtest_trades WHERE runId=? GROUP BY side, kind, reason, filled").all(runId);
  console.log("\n", runId, trades);
}
// also any runId like phase0-postA-*
const all = db.prepare("SELECT runId, COUNT(*) c FROM backtest_trades GROUP BY runId").all();
console.log("all runIds", all);
