// One-off probe: live band [0.60,0.74] vs tested preset band on the CURRENT universe.
// Work-DB pattern (VACUUM INTO), official runBacktest, 3 specs same universe.
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
import type { BacktestResult } from "../../../src/backtest/types.ts";

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  let equity = result.capitalStart;
  let peak = equity;
  let maxDd = 0;
  for (const w of result.windows) {
    if (w.pnl == null) continue;
    equity = Math.round((equity + w.pnl) * 100) / 100;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    trades: traded.length,
    wins,
    losses,
    wr: traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : 0,
    maxDd: Number(maxDd.toFixed(2)),
  };
}

const specs = [
  {
    label: "LIVE band-060-074_min200_max600 (sizing live 5sh/15exp)",
    overrides: {
      favBandAskMin: 0.6, favBandAskMax: 0.74, favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: 600, favBandOrderUsdc: 15,
      maxSharesPerOrder: 5, maxExposureUsdc: 15,
      favBandInverseEnabled: false,
    },
  },
  {
    label: "LIVE band + sizing grid (40sh/40exp)",
    overrides: {
      favBandAskMin: 0.6, favBandAskMax: 0.74, favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: 600, favBandOrderUsdc: 15,
      maxSharesPerOrder: 40, maxExposureUsdc: 40,
      favBandInverseEnabled: false,
    },
  },
  {
    label: "TESTED preset fav-band-opt (070-085, min200, max600)",
    overrides: {
      favBandAskMin: 0.7, favBandAskMax: 0.85, favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: 600, favBandOrderUsdc: 15,
      maxSharesPerOrder: 40, maxExposureUsdc: 40,
      favBandInverseEnabled: false,
    },
  },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-liveband-${Date.now()}.db`);
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
console.error(JSON.stringify({ selected: selected.length, specs: specs.length }, null, 2));

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

  const runId = `fav-liveband-${spec.label}-${Date.now()}`;
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
          process.stderr.write(`\r${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: 0,
  });
  const m = metrics(result);
  const row = {
    label: spec.label,
    ms: Date.now() - t0,
    pnl: result.pnl,
    capitalStart: result.capitalStart,
    fills: result.fillCount,
    rejects: result.rejectCount,
    windows: result.windowsTested,
    ...m,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `live-band-vs-tested-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ note: "Offline probe — live band vs tested preset, current universe", criteria, windows: selected.length, rows }, null, 2));
console.log(JSON.stringify({ outPath }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}