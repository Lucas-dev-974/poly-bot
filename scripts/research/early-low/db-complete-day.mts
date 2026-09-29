// Complétude réelle par jour selon les critères du runner, pour choisir
// un couple (minTicks, maxGapMs) qui garde un OOS exploitable après le split.
// Usage : npx tsx scripts/research/early-low/db-complete-day.mts
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-cd-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);

for (const [minTicks, maxGapMs] of [[750, 120000], [750, 180000], [500, 180000], [500, 240000]] as const) {
  const criteria: CompletenessCriteria = { minTicks, maxGapMs, maxEdgeGapMs: null };
  const all = listBacktestWindows(repos, { completeness: criteria });
  const win15 = all.filter((w) => w.eventSlug.includes("-15m-"));
  const byDay = new Map<string, number>();
  for (const w of win15) {
    if (!w.complete) continue;
    const day = new Date(w.windowEnd * 1000).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\ncriteria minTicks=${minTicks} maxGapMs=${maxGapMs} : total=${win15.filter((w) => w.complete).length}`);
  console.log(days.map(([d, n]) => `${d.slice(5)}:${n}`).join(" "));
}

db.close();
try { rmSync(workDb, { force: true }); } catch {}
for (const suf of ["-wal", "-shm"] as const) {
  const f = workDb + suf;
  try { if (existsSync(f)) rmSync(f, { force: true }); } catch {}
}