/**
 * Fav-band deterioration-exit backtest (official runner).
 * Baseline (exit OFF) vs exit ON (default params) vs switch ON vs
 * minDrop × consecutive sensitivity. Offline only: VACUUM copy of
 * data/bot-live.db; never touches bot-settings.json or the live process.
 *
 * Usage: npx tsx scripts/research/fav-band/exit-rule-backtest.mts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { BacktestResult } from "../../../src/backtest/types.ts";

const criteria: CompletenessCriteria = {
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  let equity = result.capitalStart;
  let peak = equity;
  let maxDd = 0;
  let worst = 0;
  for (const w of result.windows) {
    if (w.pnl == null) continue;
    equity = Math.round((equity + w.pnl) * 100) / 100;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (w.pnl < worst) worst = w.pnl;
  }
  const wr = traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : 0;
  return {
    trades: traded.length,
    wins,
    losses,
    wr,
    maxDd: Number(maxDd.toFixed(2)),
    worst: Number(worst.toFixed(2)),
  };
}

type Spec = { label: string; overrides: Record<string, unknown> };

const specs: Spec[] = [
  // Reference: current backtested config, exit OFF.
  {
    label: "baseline-exit-off",
    overrides: {
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: null,
      favBandExitEnabled: false,
      favBandExitSwitchEnabled: false,
      cheapOrderUsdc: 15,
    },
  },
  // Exit ON, defaults (drop 0.02, 2 peaks, lookback 120s, loss-only).
  {
    label: "exit-on-default",
    overrides: {
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: null,
      favBandExitEnabled: true,
      favBandExitMinLowerHighDrop: 0.02,
      favBandExitConsecutive: 2,
      favBandExitLookbackMs: 120_000,
      favBandExitMinElapsedSec: 0,
      favBandExitLossOnly: true,
      favBandExitSwitchEnabled: false,
      cheapOrderUsdc: 15,
    },
  },
  // Exit ON + opposite-token switch after the sell.
  {
    label: "exit-on-switch-on",
    overrides: {
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: null,
      favBandExitEnabled: true,
      favBandExitMinLowerHighDrop: 0.02,
      favBandExitConsecutive: 2,
      favBandExitLookbackMs: 120_000,
      favBandExitMinElapsedSec: 0,
      favBandExitLossOnly: true,
      favBandExitSwitchEnabled: true,
      favBandExitSwitchOrderUsdc: 15,
      maxOpenPositionsPerSide: 2,
      cheapOrderUsdc: 15,
    },
  },
];

// Sensitivity: minDrop × consecutive (exit ON, switch OFF).
for (const drop of [0.015, 0.02, 0.03, 0.05]) {
  for (const consecutive of [2, 3]) {
    if (drop === 0.02 && consecutive === 2) continue; // already in grid
    specs.push({
      label: `exit-drop${drop.toString().replace(".", "p")}_n${consecutive}`,
      overrides: {
        favBandAskMin: 0.7,
        favBandAskMax: 0.85,
        favBandMinElapsedSec: 200,
        favBandMaxElapsedSec: null,
        favBandExitEnabled: true,
        favBandExitMinLowerHighDrop: drop,
        favBandExitConsecutive: consecutive,
        favBandExitLookbackMs: 120_000,
        favBandExitMinElapsedSec: 0,
        favBandExitLossOnly: true,
        favBandExitSwitchEnabled: false,
        cheapOrderUsdc: 15,
      },
    });
  }
}

// Loss-only off: exit also when deteriorating above the entry price.
specs.push({
  label: "exit-on-default_loss-only-off",
  overrides: {
    favBandAskMin: 0.7,
    favBandAskMax: 0.85,
    favBandMinElapsedSec: 200,
    favBandMaxElapsedSec: null,
    favBandExitEnabled: true,
    favBandExitMinLowerHighDrop: 0.02,
    favBandExitConsecutive: 2,
    favBandExitLookbackMs: 120_000,
    favBandExitMinElapsedSec: 0,
    favBandExitLossOnly: false,
    favBandExitSwitchEnabled: false,
    cheapOrderUsdc: 15,
  },
});

// MinElapsed exit gate (only exit after 300 s into the window).
specs.push({
  label: "exit-on-default_minElapsed300",
  overrides: {
    favBandAskMin: 0.7,
    favBandAskMax: 0.85,
    favBandMinElapsedSec: 200,
    favBandMaxElapsedSec: null,
    favBandExitEnabled: true,
    favBandExitMinLowerHighDrop: 0.02,
    favBandExitConsecutive: 2,
    favBandExitLookbackMs: 120_000,
    favBandExitMinElapsedSec: 300,
    favBandExitLossOnly: true,
    favBandExitSwitchEnabled: false,
    cheapOrderUsdc: 15,
  },
});

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-exit-${Date.now()}.db`);
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
const selected = listBacktestWindows(repos, { completeness: criteria }).filter(
  (w) => w.complete,
);
console.error(
  JSON.stringify({ selected: selected.length, specs: specs.length, criteria }),
);

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({
    strategyId: "fav-band",
    dryRun: true,
    enableExpensiveHedge: false,
  });
  const patch = sanitizePatch({
    ...basePreset.settings,
    strategyId: "fav-band",
    ...spec.overrides,
  });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = "fav-band";
  config.enableExpensiveHedge = false;
  config.arbAskLockOnly = false;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `fav-exit-${spec.label}-${Date.now()}`;
  process.stderr.write(`\n=== ${spec.label} ===\n`);
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 100 === 0) {
          process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const m = metrics(result);
  const row = {
    label: spec.label,
    ...spec.overrides,
    ms: Date.now() - t0,
    pnl: result.pnl,
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    fills: result.fillCount,
    rejects: result.rejectCount,
    windows: result.windowsTested,
    ...m,
    pnlPerDd:
      m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const ts = Date.now();
const outPath = join("audits", "backtest", "fav-band", `fav-band-exit-rule-${ts}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "Offline only — live bot untouched. Deterioration-exit grid (lower-peaks detector).",
      criteria,
      windows: selected.length,
      rankedByPnl: rows,
    },
    null,
    2,
  ),
);

const baseline = rows.find((r) => r.label === "baseline-exit-off");
console.log(
  JSON.stringify(
    {
      phase: "done",
      outPath,
      baseline,
      ranked: rows.map((r) => ({
        label: r.label,
        pnl: r.pnl,
        pnlPct: r.pnlPct,
        wr: r.wr,
        trades: r.trades,
        maxDd: r.maxDd,
        pnlPerDd: r.pnlPerDd,
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