// R&D phase 2 — recover PnL while keeping the avg-loss reduction from exit B.
// Phase-1 fact: A4 (retrace 0.5 / drop 0.02 / n3) cut avgLoss -3.56 -> -0.76 and
// DD 42 -> 9.75 (PnL/DD 7.85) but halved PnL (+137 -> +77). The trades "breathing
// room" lever (favBandExitMinElapsedSec) delays the exit so early dips that resolve
// back up are not cut; consecutive 4 demands one more confirmed lower low.
// Swept (917 windows, S1 sizing, cap20): exitMinElapsed 30/60/120, n4, lookback 90s,
// and A6+minElapsed60 combo. Usage: npx tsx scripts/research/fav-band-audit/loss-phase2.mts
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
  const sold = rows.filter((r) => r.side === "SELL").length;
  return {
    legs: legs.length,
    avgWin: avg(winners),
    avgLoss: avg(losers),
    payoff: avg(winners) && avg(losers) ? Number((avg(winners) / Math.abs(avg(losers))).toFixed(3)) : 0,
    worst: Number(worst.toFixed(2)),
    deepSharePct: losers.length ? Number(((deep / losers.length) * 100).toFixed(1)) : 0,
    sells: sold,
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
const EXIT_A4 = { favBandExitEnabled: true, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0, favBandExitLossOnly: true, favBandExitSwitchEnabled: false };

const specs: Spec[] = [
  { label: "L1_A4_exitMin30", overrides: { ...EXIT_A4, favBandExitMinElapsedSec: 30 } },
  { label: "L2_A4_exitMin60", overrides: { ...EXIT_A4, favBandExitMinElapsedSec: 60 } },
  { label: "L3_A4_exitMin120", overrides: { ...EXIT_A4, favBandExitMinElapsedSec: 120 } },
  { label: "L4_A4_n4", overrides: { ...EXIT_A4, favBandExitConsecutive: 4 } },
  { label: "L5_A4_lb90", overrides: { ...EXIT_A4, favBandExitLookbackMs: 90_000 } },
  { label: "L6_A4plus780_min60", overrides: { ...EXIT_A4, favBandExitMinElapsedSec: 60, favBandMaxElapsedSec: 780 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-loss2-${Date.now()}.db`);
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

  const runId = `fav-loss2-${spec.label}-${Date.now()}`;
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
const outPath = join("audits", "backtest", "fav-band", `fav-band-loss-phase2-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "Avg-loss R&D phase 2 — exit breathing room (exitMinElapsed), n4, lb90, combo max780. 917 windows, cap20.", criteria, capital: CAPITAL, windows: selected.length, rows }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}