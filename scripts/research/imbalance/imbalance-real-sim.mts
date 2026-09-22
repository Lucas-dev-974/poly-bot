// Fav-band imbalance gate — REAL in-strategy gate simulation (Phase 2).
// Baseline = BEST fav-band (band 0.68-0.82, min200, pause 3x8, inverse/exit
// off, S1 sizing, cap $20) over all complete BTC 15m windows. Variants apply
// the cross-imbalance gate INSIDE the strategy (not post-hoc): entry allowed
// only when the 3-level merged book pressure signed toward the bought
// favorite stayed >= CrossMin for Ticks consecutive samples.
//   V1 = CrossMin -0.3, 2 ticks (post-hoc winner: kept 83% PnL on 45% trades)
//   V2 = CrossMin -0.1, 2 ticks (tighter floor)
//   V3 = CrossMin -0.3, 1 tick (no persistence)
//   V4 = V1 + maxSpread 0.05 (floor + liquidity filter)
// Usage: npx tsx scripts/research/imbalance/imbalance-real-sim.mts
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

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };
const CAPITAL = 20;

const PAUSE = { favBandWhipsawEnabled: true, favBandWhipsawPauseAfterLosses: 3, favBandWhipsawPauseWindows: 8 };
const BASE_SIGNAL = {
  favBandAskMin: 0.68,
  favBandAskMax: 0.82,
  favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: null,
  ...PAUSE,
  favBandInverseEnabled: false,
  favBandExitEnabled: false,
  favBandOrderUsdc: 4.5,
  maxSharesPerOrder: 5,
  maxExposureUsdc: 6,
  maxOpenPositionsPerSide: 3,
  simulatedCapital: CAPITAL,
};

type Spec = {
  label: string;
  overrides: Record<string, unknown>;
};

const specs: Spec[] = [
  { label: "S1_baseline_no_gate", overrides: { ...BASE_SIGNAL } },
  {
    label: "S1_gate_crossMin-0.3_ticks2",
    overrides: { ...BASE_SIGNAL, favBandImbalanceEnabled: true, favBandImbalanceCrossMin: -0.3, favBandImbalanceTicks: 2 },
  },
  {
    label: "S1_gate_crossMin-0.1_ticks2",
    overrides: { ...BASE_SIGNAL, favBandImbalanceEnabled: true, favBandImbalanceCrossMin: -0.1, favBandImbalanceTicks: 2 },
  },
  {
    label: "S1_gate_crossMin-0.3_ticks1",
    overrides: { ...BASE_SIGNAL, favBandImbalanceEnabled: true, favBandImbalanceCrossMin: -0.3, favBandImbalanceTicks: 1 },
  },
  {
    label: "S1_gate_crossMin-0.3_ticks2_spread0.04",
    overrides: {
      ...BASE_SIGNAL,
      favBandImbalanceEnabled: true,
      favBandImbalanceCrossMin: -0.3,
      favBandImbalanceTicks: 2,
      favBandImbalanceMaxSpread: 0.04,
    },
  },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_imb-realsim-${Date.now()}.db`);
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
const allBtc = listBacktestWindows(repos, { prefix: "btc-updown-15m", completeness: criteria });
const selected = allBtc.filter((w) => w.complete);
console.error(JSON.stringify({ completeBtc15Windows: selected.length }));
if (selected.length === 0) {
  console.error("No complete BTC 15m windows — aborting.");
  process.exit(1);
}

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
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
  const wr = traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : 0;
  return {
    tradedWindows: traded.length,
    wr,
    maxDd: Number(maxDd.toFixed(2)),
    endEquity: Number(equity.toFixed(2)),
  };
}

const rows: Record<string, unknown>[] = [];
for (const spec of specs) {
  const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false, simulatedCapital: CAPITAL });
  const patch = sanitizePatch({ ...basePreset.settings, strategyId: "fav-band", ...spec.overrides });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = "fav-band";
  config.enableExpensiveHedge = false;
  config.arbAskLockOnly = false;
  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `imb-realsim-${spec.label}-${Date.now()}`;
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
        if (cur === total || cur % 200 === 0) process.stderr.write(`\r${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  const ms = Date.now() - t0;
  const m = metrics(result);
  const row = {
    label: spec.label,
    ms,
    pnl: result.pnl,
    fills: result.fillCount,
    rejects: result.rejectCount,
    ...m,
    pnlPerTrade: result.fillCount > 0 ? Number((result.pnl / result.fillCount).toFixed(3)) : 0,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "imbalance"), { recursive: true });
const outPath = join("audits", "backtest", "imbalance", `imbalance-real-sim-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "Phase 2 — REAL in-strategy cross-imbalance gate: baseline BEST fav-band (S1 sizing, cap $20) vs gate variants. Gate: entry only when 3-level merged book pressure signed toward the bought favorite stayed >= CrossMin for Ticks consecutive samples. Same engine/preset path as production.",
      criteria,
      windows: selected.length,
      rows,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}