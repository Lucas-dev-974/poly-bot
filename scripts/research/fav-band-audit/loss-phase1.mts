// R&D — reduce fav-band average loss per losing trade (S1 base: -5 x entry price,
// i.e. -4.00 at ask 0.80, while a win pays only +5 x (1 - entry) = +1.00).
// Levers swept (914 complete BTC 15m windows, S1 sizing, cap20):
//   A0: S1 base (avg-loss baseline measurement)
//   A1-A5: exit B variants, tuned for earlier/more sensitive loss cutting
//        (retrace / minLowerHighDrop / consecutive / lookbackMs)
//   A6: known best exit + max780 (free-lunch timing)
//   A7: cheaper entry band 0.68-0.76 (structural: win/loss asymmetry improves)
// Usage: npx tsx scripts/research/fav-band-audit/loss-phase1.mts
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
import type { BacktestPositionRow } from "../../../src/db/repositories.ts";

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };
const CAPITAL = 20;
const SIZING = { favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6, maxOpenPositionsPerSide: 3, simulatedCapital: CAPITAL };

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
    if (peak - equity > maxDd) maxDd = peak - equity;
  }
  return {
    trades: traded.length,
    wins,
    losses,
    wr: traded.length ? Number(((wins / traded.length) * 100).toFixed(2)) : 0,
    pnl: result.pnl,
    maxDd: Number(maxDd.toFixed(2)),
    endEquity: Number(equity.toFixed(2)),
  };
}

// Leg-level loss stats: mean pnl of losing BUY legs, mean of winning legs, worst leg.
function lossStats(rows: BacktestPositionRow[]) {
  const legs = rows.filter((r) => r.side === "BUY" && r.status !== "open");
  const losers = legs.filter((r) => (r.pnl ?? 0) < 0);
  const winners = legs.filter((r) => (r.pnl ?? 0) > 0);
  const avg = (arr: BacktestPositionRow[]) =>
    arr.length ? Number((arr.reduce((s, r) => s + (r.pnl ?? 0), 0) / arr.length).toFixed(3)) : 0;
  const worst = legs.length ? Math.min(...legs.map((r) => r.pnl ?? 0)) : 0;
  // Loss tail: share of losing legs worse than -3.5 (near-full-stake losses).
  const deep = losers.filter((r) => (r.pnl ?? 0) <= -3.5).length;
  return {
    legs: legs.length,
    avgWin: avg(winners),
    avgLoss: avg(losers),
    payoff: avg(winners) && avg(losers) ? Number((avg(winners) / Math.abs(avg(losers))).toFixed(3)) : 0,
    worst: Number(worst.toFixed(2)),
    deepSharePct: losers.length ? Number(((deep / losers.length) * 100).toFixed(1)) : 0,
  };
}

type Spec = { label: string; overrides: Record<string, unknown> };
const BASE = {
  favBandAskMin: 0.68,
  favBandAskMax: 0.82,
  favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: null,
  favBandInverseEnabled: false,
  favBandWhipsawEnabled: true,
  favBandWhipsawPauseAfterLosses: 3,
  favBandWhipsawPauseWindows: 8,
};
const EXIT = { favBandExitEnabled: true, favBandExitLossOnly: true, favBandExitSwitchEnabled: false };

const specs: Spec[] = [
  { label: "A0_base_S1", overrides: {} },
  { label: "A1_exitB_0.5_0.03_3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0 } },
  { label: "A2_exitB_0.5_0.02_2", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 2, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0 } },
  { label: "A3_exitB_0.25_0.02_2_livepreset", overrides: { ...EXIT, favBandExitRetraceRatio: 0.25, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 2, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0 } },
  { label: "A4_exitB_0.5_0.02_3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0 } },
  { label: "A5_exitB_0.5_0.03_3_lb60", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3, favBandExitLookbackMs: 60_000, favBandExitMinElapsedSec: 0 } },
  { label: "A6_exitB_0.5_0.03_3_max780", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0, favBandMaxElapsedSec: 780 } },
  { label: "A7_band0.68_0.76_cheap", overrides: { favBandAskMax: 0.76 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-loss1-${Date.now()}.db`);
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
const selected = listBacktestWindows(repos, { prefix: "btc-updown-15m", completeness: criteria }).filter((w) => w.complete);
console.error(JSON.stringify({ selected: selected.length, specs: specs.length }, null, 2));

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false, simulatedCapital: CAPITAL });
  const patch = sanitizePatch({ ...basePreset.settings, strategyId: "fav-band", ...SIZING, ...BASE, ...spec.overrides });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = "fav-band";
  config.enableExpensiveHedge = false;
  config.arbAskLockOnly = false;
  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `fav-loss1-${spec.label}-${Date.now()}`;
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
        if (cur === total || cur % 300 === 0) process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const m = metrics(result);
  const ls = lossStats(repos.backtestPositions.byRun(runId));
  const row = {
    label: spec.label,
    ms: Date.now() - t0,
    ...m,
    ...ls,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-loss-phase1-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "Avg-loss R&D — exit B sensitivity sweep + cheap-entry band, 914 windows, cap20 sizing.", criteria, capital: CAPITAL, windows: selected.length, rows }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}