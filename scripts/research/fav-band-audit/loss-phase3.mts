// R&D phase 3 — hit the user's dual target: avgLoss <= -2.00 (max 2 loss) AND WR >= 60%.
// Continuum logic: A4 (0.5/0.02/3) = WR 43.9 / avgLoss -0.76 ; hold = WR 75.4 / -3.56.
// Intermediate exit-B params (n4/n5, drop 0.03-0.05, retrace 0.75) should cross the
// (WR 60, avgLoss -2) point. All specs include max780 (free-lunch timing).
// Swept (917 complete BTC 15m windows, S1 sizing, cap20).
// Usage: npx tsx scripts/research/fav-band-audit/loss-phase3.mts
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

function lossStats(rows: BacktestPositionRow[]) {
  const legs = rows.filter((r) => r.side === "BUY" && r.status !== "open");
  const losers = legs.filter((r) => (r.pnl ?? 0) < 0);
  const winners = legs.filter((r) => (r.pnl ?? 0) > 0);
  const avg = (arr: BacktestPositionRow[]) =>
    arr.length ? Number((arr.reduce((s, r) => s + (r.pnl ?? 0), 0) / arr.length).toFixed(3)) : 0;
  const worst = legs.length ? Math.min(...legs.map((r) => r.pnl ?? 0)) : 0;
  const deep = losers.filter((r) => (r.pnl ?? 0) <= -3.5).length;
  return {
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
  favBandMaxElapsedSec: 780,
  favBandInverseEnabled: false,
  favBandWhipsawEnabled: true,
  favBandWhipsawPauseAfterLosses: 3,
  favBandWhipsawPauseWindows: 8,
};
const EXIT = { favBandExitEnabled: true, favBandExitMinElapsedSec: 0, favBandExitLossOnly: true, favBandExitSwitchEnabled: false, favBandExitLookbackMs: 120_000 };

const specs: Spec[] = [
  { label: "M1_r0.5_d0.03_n4", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 4 } },
  { label: "M2_r0.5_d0.02_n5", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 5 } },
  { label: "M3_r0.5_d0.04_n3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.04, favBandExitConsecutive: 3 } },
  { label: "M4_r0.5_d0.03_n5", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 5 } },
  { label: "M5_r0.75_d0.02_n3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.75, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 3 } },
  { label: "M6_r0.75_d0.03_n3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.75, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3 } },
  { label: "M7_r0.75_d0.02_n4", overrides: { ...EXIT, favBandExitRetraceRatio: 0.75, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 4 } },
  { label: "M8_r0.5_d0.04_n4", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.04, favBandExitConsecutive: 4 } },
  { label: "M9_r0.25_d0.03_n4", overrides: { ...EXIT, favBandExitRetraceRatio: 0.25, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 4 } },
  { label: "M10_r0.5_d0.05_n3", overrides: { ...EXIT, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.05, favBandExitConsecutive: 3 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-loss3-${Date.now()}.db`);
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

  const runId = `fav-loss3-${spec.label}-${Date.now()}`;
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
    targetMet: Math.abs(ls.avgLoss) <= 2.0 && m.wr >= 60,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-loss-phase3-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "Avg-loss R&D phase 3 — dual target avgLoss<=2 AND WR>=60%. Intermediate exit-B params, all with max780. 917 windows, cap20.", criteria, capital: CAPITAL, windows: selected.length, rows }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}