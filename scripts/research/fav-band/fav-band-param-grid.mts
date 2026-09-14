/**
 * Offline fav-band parameter grid. Does NOT touch data/bot-settings.json
 * or live process. Reads snapshots from a VACUUM copy of bot-live.db.
 */
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

const criteria: CompletenessCriteria = {
  minTicks: 601,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

type Spec = {
  label: string;
  overrides: Record<string, unknown>;
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

const bands: Array<[number, number, string]> = [
  [0.7, 0.85, "070-085"],
  [0.7, 0.8, "070-080"],
  [0.75, 0.85, "075-085"],
  [0.72, 0.88, "072-088"],
  [0.68, 0.82, "068-082"],
  [0.65, 0.8, "065-080"],
  [0.78, 0.9, "078-090"],
];

const minElapsed = [120, 180, 200, 240, 300, 400];
const maxElapsed: Array<number | null> = [null, 600, 720];

const specs: Spec[] = [];

// Full band × minElapsed (baseline maxElapsed=null)
for (const [amin, amax, tag] of bands) {
  for (const minE of minElapsed) {
    // Skip some sparse combos to keep runtime reasonable: for non-baseline
    // bands only test 180/200/240/300
    if (tag !== "070-085" && ![180, 200, 240, 300].includes(minE)) continue;
    specs.push({
      label: `band-${tag}_min${minE}`,
      overrides: {
        favBandAskMin: amin,
        favBandAskMax: amax,
        favBandMinElapsedSec: minE,
        favBandMaxElapsedSec: null,
        cheapOrderUsdc: 15,
      },
    });
  }
}

// maxElapsed sweep on baseline band + min 200
for (const maxE of maxElapsed) {
  if (maxE === null) continue; // already in grid
  specs.push({
    label: `band-070-085_min200_max${maxE}`,
    overrides: {
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: maxE,
      cheapOrderUsdc: 15,
    },
  });
}

// Size sensitivity on baseline (edge should be similar; check fill count)
for (const usdc of [5, 10, 15]) {
  specs.push({
    label: `band-070-085_min200_size${usdc}`,
    overrides: {
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      favBandMaxElapsedSec: null,
      cheapOrderUsdc: usdc,
      maxExposureUsdc: Math.max(40, usdc * 3),
    },
  });
}

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-grid-${Date.now()}.db`);
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
console.error(JSON.stringify({ selected: selected.length, specs: specs.length, criteria }, null, 2));

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

  const runId = `fav-grid-${spec.label}-${Date.now()}`;
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
    fills: result.fillCount ?? (result as { fillCount?: number }).fillCount,
    rejects: result.rejectCount,
    uncovered: result.uncoveredPairs,
    windows: result.windowsTested,
    ...m,
    // risk-adjusted-ish: pnl / max(1, maxDd)
    pnlPerDd:
      m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const ts = Date.now();
const outPath = join("audits", "backtest", `fav-band-param-grid-${ts}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "Offline only — live bot untouched",
      criteria,
      windows: selected.length,
      rankedByPnl: rows,
      topByPnlPerDd: [...rows].sort((a, b) => Number(b.pnlPerDd) - Number(a.pnlPerDd)).slice(0, 10),
    },
    null,
    2,
  ),
);

const baseline = rows.find((r) => r.label === "band-070-085_min200")
  ?? rows.find((r) => r.label === "band-070-085_min200_size15");
const best = rows[0];
const bestRisk = [...rows].sort((a, b) => Number(b.pnlPerDd) - Number(a.pnlPerDd))[0];

console.log(
  JSON.stringify(
    {
      phase: "done",
      outPath,
      baseline,
      bestPnl: best,
      bestRisk,
      top5: rows.slice(0, 5).map((r) => ({
        label: r.label,
        pnl: r.pnl,
        pnlPct: r.pnlPct,
        wr: r.wr,
        maxDd: r.maxDd,
        trades: r.trades,
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
