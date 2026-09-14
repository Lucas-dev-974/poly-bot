import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { listStrategyPresets } from "../../../src/strategy-presets.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";

const criteria: CompletenessCriteria = {
  minTicks: 601,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

const preset = listStrategyPresets().find((p) => p.id === "edge-lead");
if (!preset) throw new Error("edge-lead preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_edge-reject-dig-${Date.now()}.db`);
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
const selected = listBacktestWindows(repos, { completeness: criteria }).filter((w) => w.complete);
console.error(`selected=${selected.length}`);

const config = testConfig({ strategyId: "edge-lead", dryRun: true, enableExpensiveHedge: true });
const patch = sanitizePatch({ ...preset.settings, strategyId: "edge-lead" });
for (const [k, val] of Object.entries(patch)) {
  if (val !== undefined) (config as Record<string, unknown>)[k] = val;
}
config.dryRun = true;
config.strategyId = "edge-lead";
validateConfigCoherence(config, { leadsWithEdge: leadsWithEdgeFor("edge-lead", repos) });

const runId = `edge-reject-dig-${Date.now()}`;
const result = (await runBacktest({
  runId,
  config,
  windows: selected,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 50 === 0) process.stderr.write(`\rdig ${cur}/${total}   `);
    },
  },
  skippedIncomplete: 0,
})) as Awaited<ReturnType<typeof runBacktest>> & {
  rejectBreakdown?: Record<string, number>;
};
process.stderr.write("\n");

const breakdown = Object.entries(result.rejectBreakdown ?? {})
  .map(([k, c]) => ({ key: k, count: c }))
  .sort((a, b) => b.count - a.count);

const report = {
  headline: {
    pnl: result.pnl,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    fills: result.fillCount,
    rejects: result.rejectCount,
    covered: result.coveredPairs,
    uncovered: result.uncoveredPairs,
    windows: selected.length,
    definition:
      "rejectCount = in-memory trades with filled=false (FOK no-fill retries, exposure-cap, insufficient-capital, band skips, …). Resting GTC posts are not counted unless a separate unfilled trade row is pushed.",
  },
  rejectBreakdown: breakdown,
  top: breakdown.slice(0, 20),
};

mkdirSync(join("audits", "arb-backtest", "edge-lead"), { recursive: true });
const outPath = join("audits", "arb-backtest", `${runId}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, headline: report.headline, top: report.top }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}
