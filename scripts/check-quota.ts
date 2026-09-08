import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { DatabaseSync } from "node:sqlite";

const config = loadConfig();
const db = new DatabaseSync(config.dbPath);

const now = Math.floor(Date.now() / 1000);
const day = now - 86400;
const week = now - 7 * 86400;

console.log("=== Redeems dernières 24h ===");
const rows = db
  .prepare(
    "SELECT ts, title, outcome, size, success, txHash, errorMessage FROM redeems WHERE ts >= ? ORDER BY ts DESC",
  )
  .all(day) as Array<{
  ts: number;
  title: string;
  outcome: string;
  size: number;
  success: number;
  txHash: string | null;
  errorMessage: string | null;
}>;
console.log("Total:", rows.length);
for (const r of rows) {
  console.log(
    new Date(r.ts).toISOString().slice(0, 19),
    r.success ? "OK  " : "FAIL",
    r.title,
    r.outcome,
    "size=" + r.size,
    r.errorMessage || "",
  );
}

console.log("\n=== Stats 7 derniers jours ===");
const weekStats = db
  .prepare(
    "SELECT count(*) as c, sum(case when success=1 then 1 else 0 end) as ok, sum(case when success=0 then 1 else 0 end) as fail FROM redeems WHERE ts >= ?",
  )
  .get(week) as { c: number; ok: number; fail: number };
console.log(weekStats);

console.log("\n=== Par jour (7 derniers jours) ===");
const byDay = db
  .prepare(
    "SELECT date(ts, 'unixepoch') as day, count(*) as total, sum(case when success=1 then 1 else 0 end) as ok FROM redeems WHERE ts >= ? GROUP BY day ORDER BY day",
  )
  .all(week) as Array<{ day: string; total: number; ok: number }>;
for (const r of byDay) {
  console.log(r.day, "total=" + r.total, "ok=" + r.ok);
}

db.close();