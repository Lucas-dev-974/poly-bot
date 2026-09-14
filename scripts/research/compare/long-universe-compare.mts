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
import type { StrategyId } from "../../../src/strategy/ids.ts";

const criteria: CompletenessCriteria = {
  minTicks: 601,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

type Spec = {
  label: string;
  strategyId: StrategyId;
  presetId?: string;
  overrides?: Record<string, unknown>;
  note?: string;
};

const specs: Spec[] = [
  // presets / engines not validated on THIS long-universe filter yet
  { label: "ask-lock", strategyId: "arb", presetId: "ask-lock" },
  { label: "conservative", strategyId: "arb", presetId: "conservative" },
  { label: "coverage-max", strategyId: "arb", presetId: "coverage-max" },
  { label: "reverse", strategyId: "reverse", presetId: "reverse" },
  {
    label: "barbell-0.5",
    strategyId: "barbell",
    note: "no preset; ratio 0.5 maker-ish",
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
  {
    label: "barbell-0.7",
    strategyId: "barbell",
    note: "higher hedge ratio",
    overrides: {
      strategyId: "barbell",
      barbellHedgeRatio: 0.7,
      pollIntervalMs: 1000,
      marketSlugPrefixes: ["btc-updown-15m"],
      cheapBuyMin: 0.01,
      cheapBuyMax: 0.15,
      expensiveBuyMin: 0.5,
      expensiveBuyMax: 0.95,
      enableExpensiveHedge: true,
      cheapOrderUsdc: 3,
      expensiveOrderUsdc: 15,
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
  // reference already known on this universe
  {
    label: "edge-lead-improved (ref)",
    strategyId: "edge-lead",
    presetId: "edge-lead",
    note: "already ~-4.6% on this universe",
  },
];

const presets = listStrategyPresets();
const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_long-compare-${Date.now()}.db`);
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
console.error(
  JSON.stringify({ selected: selected.length, criteria }, null, 2),
);

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
      throw new Error(`preset ${spec.presetId} is ${preset.strategyId}`);
    }
    const patch = sanitizePatch({ ...preset.settings, strategyId: spec.strategyId });
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (config as Record<string, unknown>)[k] = v;
    }
  }
  if (spec.overrides) {
    const patch = sanitizePatch({ ...spec.overrides, strategyId: spec.strategyId });
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (config as Record<string, unknown>)[k] = v;
    }
  }
  config.dryRun = true;
  config.strategyId = spec.strategyId;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `long-${spec.label.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  process.stderr.write(`\n=== ${spec.label} (${spec.strategyId}) ===\n`);
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 50 === 0) {
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
    note: spec.note ?? null,
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
    unresolved: result.unresolvedWindows,
    windows: result.windowsTested,
    simulatedCapital: config.simulatedCapital,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "arb-backtest", "compare"), { recursive: true });
const outPath = join("audits", "arb-backtest", `long-universe-compare-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ criteria, windows: selected.length, ranked: rows }, null, 2),
);
console.log(
  JSON.stringify(
    {
      phase: "done",
      outPath,
      ranked: rows.map((r) => ({
        label: r.label,
        strategyId: r.strategyId,
        pnl: r.pnl,
        pnlPct: r.pnlPct,
        covered: r.covered,
        uncovered: r.uncovered,
        fills: r.fills,
        capital: `${r.capitalStart}->${r.capitalEnd}`,
      })),
    },
    null,
    2,
  ),
);

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}
