/**
 * Backtest dip-revert — validation OFFICIELLE des axes d'entrée gagnants de la
 * grille sim v3 (dip-grid3.mts + dip-grid3-combos.mts).
 *
 * Candidats : minElapsedSec 120/150, minDrop 0.05/0.04, maxSpread 0.03,
 * combo e150+d050, et cross-check avec la deadline d'entrée maxElapsed 420.
 * Breakdown PnL par jour UTC à partir des window results (eventSlug).
 *
 * Usage : npx tsx scripts/research/backtests/backtest-dip-revert-axes.mts
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";
import type { StrategyId } from "../../../src/strategy/ids.ts";

const criteria: CompletenessCriteria = {
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

type Spec = { label: string; strategyId: StrategyId; overrides: Record<string, unknown> };

const BASE_OVR = {
  dipRevertBandMin: 0.55,
  dipRevertBandMax: 0.65,
  dipRevertMinDrop: 0.03,
  dipRevertDropLookbackMs: 60_000,
  dipRevertMinElapsedSec: 180,
  dipRevertMaxElapsedSec: null,
  dipRevertMaxSpread: 0.04,
  dipRevertOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

const specs: Spec[] = [
  { label: "base", strategyId: "dip-revert", overrides: { ...BASE_OVR } },
  {
    label: "e150+d050",
    strategyId: "dip-revert",
    overrides: { ...BASE_OVR, dipRevertMinElapsedSec: 150, dipRevertMinDrop: 0.05 },
  },
  {
    label: "e150+d050+b0.63",
    strategyId: "dip-revert",
    overrides: {
      ...BASE_OVR,
      dipRevertMinElapsedSec: 150,
      dipRevertMinDrop: 0.05,
      dipRevertBandMax: 0.63,
    },
  },
  {
    label: "e150+d050+s003",
    strategyId: "dip-revert",
    overrides: {
      ...BASE_OVR,
      dipRevertMinElapsedSec: 150,
      dipRevertMinDrop: 0.05,
      dipRevertMaxSpread: 0.03,
    },
  },
  {
    label: "e150+d050+s003+b0.63",
    strategyId: "dip-revert",
    overrides: {
      ...BASE_OVR,
      dipRevertMinElapsedSec: 150,
      dipRevertMinDrop: 0.05,
      dipRevertMaxSpread: 0.03,
      dipRevertBandMax: 0.63,
    },
  },
  {
    label: "live-now",
    strategyId: "dip-revert",
    overrides: { ...BASE_OVR, dipRevertBandMax: 0.63 },
  },
];

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_dip-revert-axes-${Date.now()}.db`);
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
const DEBUG_KEEP_DB = process.env.KEEP_DB === "1";

const all = listBacktestWindows(repos, { completeness: criteria });
const selected = all.filter((w) => w.complete);
const skipped = all.length - selected.length;
console.error(JSON.stringify({ selected: selected.length, skipped }, null, 2));
if (selected.length === 0) throw new Error("No windows match criteria");

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({ strategyId: spec.strategyId, dryRun: true });
  const patch = sanitizePatch({ ...spec.overrides, strategyId: spec.strategyId });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = spec.strategyId;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `dip-axes-${spec.label}-${Date.now()}`;
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
        if (cur === total || cur % 50 === 0) {
          process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: skipped,
  });
  process.stderr.write("\n");

  const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;

  // per-UTC-day pnl from window slugs (windowStart sec is the slug suffix)
  const byDay: Record<string, number> = {};
  for (const w of traded) {
    const wsSec = Number(w.eventSlug.split("-").pop());
    const day = new Date(wsSec * 1000).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + (w.pnl ?? 0);
  }
  for (const k of Object.keys(byDay)) byDay[k] = Math.round(byDay[k] * 100) / 100;

  const row = {
    label: spec.label,
    strategyId: spec.strategyId,
    ms: Date.now() - t0,
    pnl: result.pnl,
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    fills: result.fillCount,
    rejects: result.rejectCount,
    unresolved: result.unresolvedWindows,
    windows: result.windowsTested,
    winRate: traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : null,
    wins,
    losses,
    byDay,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "backtest", "dip-revert"), { recursive: true });
const outPath = join("audits", "backtest", "dip-revert", `dip-revert-axes-official-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, ranked: rows }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
if (!DEBUG_KEEP_DB) {
  try {
    rmSync(workDb, { force: true });
    for (const suf of ["-wal", "-shm"] as const) {
      if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
    }
  } catch {}
}