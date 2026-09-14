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

type Spec = { id: string; overrides: Record<string, unknown> };

const specs: Spec[] = [
  { id: "baseline", overrides: {} },
  // stricter entry
  { id: "confirm-8", overrides: { edgeConfirmSamples: 8 } },
  { id: "confirm-10", overrides: { edgeConfirmSamples: 10 } },
  { id: "band-86-89", overrides: { edgeBandMin: 0.86, edgeBandMax: 0.89 } },
  { id: "band-87-90", overrides: { edgeBandMin: 0.87, edgeBandMax: 0.9 } },
  { id: "maxDown-0.005", overrides: { edgeMaxDownTick: 0.005 } },
  // faster / tighter stop on naked edge
  {
    id: "stop-tight",
    overrides: {
      edgeSellExpensiveAfterMin: 3,
      edgeSellExpensiveLossPct: 5,
      edgeSellExpensiveLossWindowMs: 5000,
    },
  },
  {
    id: "stop-very-tight",
    overrides: {
      edgeSellExpensiveAfterMin: 2,
      edgeSellExpensiveLossPct: 3,
      edgeSellExpensiveLossWindowMs: 3000,
    },
  },
  // small size + more capital (less capital thrash, smaller risk)
  {
    id: "size-small-cap100",
    overrides: {
      edgeOrderUsdc: 10,
      edgeCheapOrderUsdc: 2,
      maxShareEdge: 15,
      maxSharesPerOrder: 15,
      maxExposureUsdc: 25,
      simulatedCapital: 100,
    },
  },
  // combo: stricter confirm + tight stop + small size
  {
    id: "combo-robust",
    overrides: {
      edgeConfirmSamples: 8,
      edgeBandMin: 0.86,
      edgeBandMax: 0.89,
      edgeMaxDownTick: 0.005,
      edgeSellExpensiveAfterMin: 3,
      edgeSellExpensiveLossPct: 5,
      edgeSellExpensiveLossWindowMs: 5000,
      edgeOrderUsdc: 10,
      edgeCheapOrderUsdc: 2,
      maxShareEdge: 15,
      maxSharesPerOrder: 15,
      maxExposureUsdc: 25,
      simulatedCapital: 100,
    },
  },
  // wider cheap band so hedge more often after edge fill
  {
    id: "cheap-band-wide",
    overrides: { edgeCheapBandMin: 0.02, edgeCheapBandMax: 0.2 },
  },
  // disable naked-edge sell (hold to resolution) — diagnostic
  { id: "no-edge-sell", overrides: { edgeSellExpensiveEnabled: false } },
];

const preset = listStrategyPresets().find((p) => p.id === "edge-lead");
if (!preset) throw new Error("edge-lead preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_edge-improve-${Date.now()}.db`);
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

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({ strategyId: "edge-lead", dryRun: true, enableExpensiveHedge: true });
  const patch = sanitizePatch({
    ...preset.settings,
    strategyId: "edge-lead",
    ...spec.overrides,
  });
  for (const [k, val] of Object.entries(patch)) {
    if (val !== undefined) (config as Record<string, unknown>)[k] = val;
  }
  config.dryRun = true;
  config.strategyId = "edge-lead";
  validateConfigCoherence(config, { leadsWithEdge: leadsWithEdgeFor("edge-lead", repos) });

  const runId = `edge-imp-${spec.id}-${Date.now()}`;
  const t0 = Date.now();
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
    ms: Date.now() - t0,
    pnl: result.pnl,
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
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

rows.sort((a, b) => Number(b.pnl) - Number(a.pnl));
mkdirSync(join("audits", "backtest", "edge-lead"), { recursive: true });
const outPath = join("audits", "backtest", `edge-lead-improve-grid-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ windows: selected.length, criteria, rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, ranked: rows.map((r) => ({ id: r.id, pnl: r.pnl, pnlPct: r.pnlPct, covered: r.covered, uncovered: r.uncovered, fills: r.fills, rejects: r.rejects })) }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}
