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

const specs = [
  { id: "baseline", overrides: {} },
  { id: "cheap-ready", overrides: { edgeRequireCheapReady: true } },
  { id: "asksum-0.99", overrides: { edgeAskSumMax: 0.99 } },
  { id: "asksum-1.00", overrides: { edgeAskSumMax: 1.0 } },
  {
    id: "cheap-ready+asksum99",
    overrides: { edgeRequireCheapReady: true, edgeAskSumMax: 0.99 },
  },
  {
    id: "gates+small",
    overrides: {
      edgeRequireCheapReady: true,
      edgeAskSumMax: 0.99,
      edgeOrderUsdc: 10,
      edgeCheapOrderUsdc: 2,
      maxShareEdge: 15,
      maxSharesPerOrder: 15,
      maxExposureUsdc: 25,
      simulatedCapital: 100,
      edgeConfirmSamples: 8,
      edgeSellExpensiveAfterMin: 3,
      edgeSellExpensiveLossPct: 5,
      edgeSellExpensiveLossWindowMs: 5000,
    },
  },
  {
    id: "cheap-ready+small",
    overrides: {
      edgeRequireCheapReady: true,
      edgeOrderUsdc: 10,
      edgeCheapOrderUsdc: 2,
      maxShareEdge: 15,
      maxSharesPerOrder: 15,
      maxExposureUsdc: 25,
      simulatedCapital: 100,
    },
  },
];

const preset = listStrategyPresets().find((p) => p.id === "edge-lead");
if (!preset) throw new Error("missing preset");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_edge-gates-${Date.now()}.db`);
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

const rows = [];
for (const spec of specs) {
  const config = testConfig({ strategyId: "edge-lead", dryRun: true, enableExpensiveHedge: true });
  const patch = sanitizePatch({ ...preset.settings, strategyId: "edge-lead", ...spec.overrides });
  for (const [k, val] of Object.entries(patch)) {
    if (val !== undefined) (config as Record<string, unknown>)[k] = val;
  }
  config.dryRun = true;
  config.strategyId = "edge-lead";
  validateConfigCoherence(config, { leadsWithEdge: leadsWithEdgeFor("edge-lead", repos) });
  const runId = `edge-gate-${spec.id}-${Date.now()}`;
  process.stderr.write(`\n=== ${spec.id} ===\n`);
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 50 === 0) process.stderr.write(`\r${spec.id} ${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const row = {
    id: spec.id,
    pnl: result.pnl,
    pnlPct: result.capitalStart ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2)) : null,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    covered: result.coveredPairs,
    uncovered: result.uncoveredPairs,
    fills: result.fillCount,
    rejects: result.rejectCount,
    overrides: spec.overrides,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => b.pnl - a.pnl);
mkdirSync(join("audits", "arb-backtest", "edge-lead"), { recursive: true });
const outPath = join("audits", "arb-backtest", `edge-lead-gates-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ windows: selected.length, rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, ranked: rows.map((r) => ({ id: r.id, pnl: r.pnl, pnlPct: r.pnlPct, covered: r.covered, uncovered: r.uncovered, fills: r.fills, rejects: r.rejects })) }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}
