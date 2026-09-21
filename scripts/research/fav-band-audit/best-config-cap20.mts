// Fav-band — BEST config backtest with $20 simulated capital, ALL complete BTC 15m windows.
// BEST = band [0.68, 0.82], minElapsed 200, no maxElapsed, whipsaw pause 3x8, inverse OFF.
// Sizing constraint: MIN_CLOB_SHARES = 5 → minimum viable order ≈ 4.2 USDC at ask 0.82.
// Specs cover live-like risk, a moderate step-up, the DD variant (exit B), and a ruin demo.
// Usage: npx tsx scripts/research/fav-band-audit/best-config-cap20.mts
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

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  // Chronological equity path (windows are sorted by windowStart in the runner).
  let equity = result.capitalStart;
  let peak = equity;
  let maxDd = 0;
  let minEquity = equity;
  let worst = 0;
  for (const w of result.windows) {
    if (w.pnl == null) continue;
    equity = Math.round((equity + w.pnl) * 100) / 100;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (equity < minEquity) minEquity = equity;
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
    minEquity: Number(minEquity.toFixed(2)),
    endEquity: Number(equity.toFixed(2)),
  };
}

function dayStats(rows: BacktestPositionRow[]) {
  const byDay = new Map<string, { pnl: number; won: number; lost: number; sold: number; trades: number }>();
  const buckets = new Map<string, { pnl: number; won: number; lost: number; n: number }>();
  for (const r of rows) {
    if (r.side !== "BUY" || r.status === "open") continue;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const pnl = r.pnl ?? 0;
    const cur = byDay.get(day) ?? { pnl: 0, won: 0, lost: 0, sold: 0, trades: 0 };
    cur.pnl = Math.round((cur.pnl + pnl) * 100) / 100;
    cur.trades += 1;
    if (r.status === "won") cur.won += 1;
    else if (r.status === "lost") cur.lost += 1;
    else if (r.status === "sold") cur.sold += 1;
    byDay.set(day, cur);
    const fp = r.fillPrice ?? 0;
    const bk = fp < 0.7 ? "0.68-0.70" : fp < 0.75 ? "0.70-0.75" : fp < 0.78 ? "0.75-0.78" : "0.78-0.82";
    const b = buckets.get(bk) ?? { pnl: 0, won: 0, lost: 0, n: 0 };
    b.pnl = Math.round((b.pnl + pnl) * 100) / 100;
    b.n += 1;
    if (pnl > 0) b.won += 1;
    else if (pnl < 0) b.lost += 1;
    buckets.set(bk, b);
  }
  return {
    days: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    buckets: [...buckets.entries()].map(([bucket, v]) => ({ bucket, wrPct: v.n ? Number(((v.won / v.n) * 100).toFixed(1)) : 0, ...v })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
  };
}

type Spec = { label: string; overrides: Record<string, unknown> };

const PAUSE = { favBandWhipsawEnabled: true, favBandWhipsawPauseAfterLosses: 3, favBandWhipsawPauseWindows: 8 };
const NO_INVERSE = { favBandInverseEnabled: false };
const EXIT_B = { favBandExitEnabled: true, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0, favBandExitLossOnly: true, favBandExitSwitchEnabled: false };
const BEST_SIGNAL = { favBandAskMin: 0.68, favBandAskMax: 0.82, favBandMinElapsedSec: 200, favBandMaxElapsedSec: null, ...PAUSE, ...NO_INVERSE, favBandExitEnabled: false };

const specs: Spec[] = [
  // S1 — live-like per-trade risk (4.5 USDC ≈ 22 % of the 20 $ capital, expo 6 = 30 %).
  { label: "S1_BEST_cap20_order4.5_sh5_expo6", overrides: { ...BEST_SIGNAL, favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6, maxOpenPositionsPerSide: 3, simulatedCapital: CAPITAL } },
  // S2 — moderate step-up: 5 USDC order, 10 sh cap, expo 10 (50 % of capital).
  { label: "S2_BEST_cap20_order5_sh10_expo10", overrides: { ...BEST_SIGNAL, favBandOrderUsdc: 5, maxSharesPerOrder: 10, maxExposureUsdc: 10, maxOpenPositionsPerSide: 3, simulatedCapital: CAPITAL } },
  // S3 — drawdown variant: BEST + exit B (confirmed lower-lows 0.5/0.03/3), live-like sizing.
  { label: "S3_BEST+exitB_cap20_order4.5_sh5_expo6", overrides: { ...BEST_SIGNAL, ...EXIT_B, favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6, maxOpenPositionsPerSide: 3, simulatedCapital: CAPITAL } },
  // S4 — ruin demo: one 15 USDC position = 75 % of capital per trade.
  { label: "S4_BEST_cap20_order15_sh25_expo20_ruin-demo", overrides: { ...BEST_SIGNAL, favBandOrderUsdc: 15, maxSharesPerOrder: 25, maxExposureUsdc: 20, maxOpenPositionsPerSide: 1, simulatedCapital: CAPITAL } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-cap20-${Date.now()}.db`);
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
console.error(JSON.stringify({ selected: selected.length, specs: specs.length, capital: CAPITAL }, null, 2));

const rows: Record<string, unknown>[] = [];
let mainRunDays: unknown = null;

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

  const runId = `fav-cap20-${spec.label}-${Date.now()}`;
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
        if (cur === total || cur % 200 === 0) process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const m = metrics(result);
  const row = {
    label: spec.label,
    ms: Date.now() - t0,
    capitalStart: result.capitalStart,
    pnl: result.pnl,
    pnlPct: Number(((result.pnl / result.capitalStart) * 100).toFixed(2)),
    fills: result.fillCount,
    rejects: result.rejectCount,
    windows: result.windowsTested,
    ...m,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (spec.label.startsWith("S1")) {
    mainRunDays = dayStats(repos.backtestPositions.byRun(runId));
  }
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-cap20-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "Offline. BEST config (band 0.68-0.82, min200, no max, pause 3x8, inverse off) with $20 simulated capital — 4 sizing variants incl. ruin demo.", criteria, capital: CAPITAL, windows: selected.length, rows, mainRunDays }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}