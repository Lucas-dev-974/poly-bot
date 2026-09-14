import { copyFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { listStrategyPresets } from "../../../src/strategy-presets.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";
import type { StrategyId } from "../../../src/strategy/ids.ts";

type RunSpec = {
  label: string;
  presetId?: string;
  strategyId: StrategyId;
  overrides?: Record<string, unknown>;
};

const specs: RunSpec[] = [
  { label: "ask-lock (ref)", presetId: "ask-lock", strategyId: "arb" },
  { label: "edge-lead", presetId: "edge-lead", strategyId: "edge-lead" },
  { label: "reverse", presetId: "reverse", strategyId: "reverse" },
  {
    label: "barbell-0.5",
    strategyId: "barbell",
    // no dedicated preset: maker-ish bands + ratio hedge, no pair lock
    overrides: {
      strategyId: "barbell",
      barbellHedgeRatio: 0.5,
      pollIntervalMs: 1000,
      marketSlugPrefixes: ["btc-updown-15m"],
      cheapBuyMin: 0.01,
      cheapBuyMax: 0.15,
      expensiveBuyMin: 0.5,
      expensiveBuyMax: 0.95,
      enableExpensiveHedge: true,
      cheapOrderUsdc: 3,
      expensiveOrderUsdc: 12,
      expensiveOrderType: "FOK",
      maxSharesPerOrder: 50,
      maxOpenPositionsPerSide: 1,
      maxExposureUsdc: 50,
      minutesBeforeCloseMin: 0,
      minutesBeforeCloseMax: 15,
      simulatedCapital: 50,
      pairLockMax: 0.99,
      arbAskLockOnly: false,
      arbAskSumMax: null,
    },
  },
];

const presets = listStrategyPresets();
const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_strat-compare-${Date.now()}.db`);
// Live bot may lock -wal/-shm: use SQLite online backup instead of copyFile.
{
  const { DatabaseSync } = await import("node:sqlite");
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
const complete = listBacktestWindows(repos, {}).filter(
  (w) => w.eventSlug.startsWith("btc-updown-15m") && w.complete,
);
console.error(`btc complete windows: ${complete.length}`);

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({
    strategyId: spec.strategyId,
    dryRun: true,
    enableExpensiveHedge: true,
  });

  if (spec.presetId) {
    const preset = presets.find((p) => p.id === spec.presetId);
    if (!preset) throw new Error(`preset missing: ${spec.presetId}`);
    if (preset.strategyId !== spec.strategyId) {
      throw new Error(`preset ${spec.presetId} is ${preset.strategyId}, expected ${spec.strategyId}`);
    }
    const patch = sanitizePatch({ ...preset.settings, strategyId: spec.strategyId });
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) (config as Record<string, unknown>)[k] = val;
    }
  }
  if (spec.overrides) {
    const patch = sanitizePatch({ ...spec.overrides, strategyId: spec.strategyId });
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) (config as Record<string, unknown>)[k] = val;
    }
  }
  config.dryRun = true;
  config.strategyId = spec.strategyId;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `compare-${spec.label.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const t0 = Date.now();
  process.stderr.write(`\n=== ${spec.label} (${spec.strategyId}) ===\n`);
  const result = await runBacktest({
    runId,
    config,
    windows: complete,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 20 === 0) {
          process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");

  const row = {
    label: spec.label,
    strategyId: spec.strategyId,
    presetId: spec.presetId ?? null,
    ms: Date.now() - t0,
    pnl: result.pnl,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
    covered: result.coveredPairs,
    uncovered: result.uncoveredPairs,
    fills: result.fillCount,
    rejects: result.rejectCount,
    unresolved: result.unresolvedWindows,
    windows: result.windowsTested,
    simulatedCapital: config.simulatedCapital,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "compare"), { recursive: true });
const outPath = join("audits", "backtest", `strategy-compare-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ windows: complete.length, rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, n: rows.length }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {
  /* ignore */
}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {
  /* ignore */
}

