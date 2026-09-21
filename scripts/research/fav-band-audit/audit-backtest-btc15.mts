// Fav-band full audit backtest — ALL BTC 15m windows in bot-live.db.
// Groups: baselines (presets), live-band (current live config era), inverse ON,
// exit mode B (confirmed lower-lows + retraceRatio — NEW code, never backtested),
// whipsaw filters. Offline only: VACUUM copy of data/bot-live.db, official runner.
//
// Usage: npx tsx scripts/research/fav-band-audit/audit-backtest-btc15.mts
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

type Spec = { label: string; group: string; overrides: Record<string, unknown> };

const SIZING_GRID = { favBandOrderUsdc: 15, maxSharesPerOrder: 40, maxExposureUsdc: 40 };
const SIZING_LIVE = { favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6 };
const BAND_LIVE = { favBandAskMin: 0.65, favBandAskMax: 0.75, favBandMinElapsedSec: 180, favBandMaxElapsedSec: 600 };
const BAND_OPT = { favBandAskMin: 0.7, favBandAskMax: 0.85, favBandMinElapsedSec: 200, favBandMaxElapsedSec: 600 };

const specs: Spec[] = [];

// ---- Group 1: baselines (entry only, sizing grid) ----
specs.push({ group: "baseline", label: "baseline_band-070-085_min200_max600", overrides: { ...BAND_OPT, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false } });
specs.push({ group: "baseline", label: "baseline_band-070-085_noMax", overrides: { favBandAskMin: 0.7, favBandAskMax: 0.85, favBandMinElapsedSec: 200, favBandMaxElapsedSec: null, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false } });
specs.push({ group: "baseline", label: "baseline_band-068-082_min200_noMax", overrides: { favBandAskMin: 0.68, favBandAskMax: 0.82, favBandMinElapsedSec: 200, favBandMaxElapsedSec: null, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false } });

// ---- Group 2: live config era (band 0.65-0.75, min180 max600) ----
specs.push({ group: "live", label: "live_band-065-075_sizing-live", overrides: { ...BAND_LIVE, ...SIZING_LIVE, favBandInverseEnabled: false, favBandExitEnabled: false } });
specs.push({ group: "live", label: "live_band-065-075_sizing-grid", overrides: { ...BAND_LIVE, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false } });

// ---- Group 3: inverse GTC follow-up (live has it ON, never backtested) ----
specs.push({ group: "inverse", label: "inverse-on_live-band_sizing-live", overrides: { ...BAND_LIVE, ...SIZING_LIVE, favBandInverseEnabled: true, favBandInverseAskMax: 0.15, favBandInverseShareRatio: 1.3, favBandInverseOrderUsdc: 1.4, maxOpenPositionsPerSide: 3, favBandExitEnabled: false } });
specs.push({ group: "inverse", label: "inverse-on_band-opt_sizing-grid", overrides: { ...BAND_OPT, ...SIZING_GRID, favBandInverseEnabled: true, favBandInverseAskMax: 0.2, favBandInverseShareRatio: 2, favBandInverseOrderUsdc: 15, maxOpenPositionsPerSide: 2, favBandExitEnabled: false } });

// ---- Group 4: deterioration exit mode B (confirmed lower-lows, retraceRatio) ----
// NEW code path — never officially backtested. Baseline band, exit grid.
const EXIT_BASE = { ...BAND_OPT, ...SIZING_GRID, favBandExitEnabled: true, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0, favBandExitLossOnly: true, favBandExitSwitchEnabled: false };
for (const ratio of [0.25, 0.5]) {
  for (const drop of [0.03, 0.05]) {
    for (const consecutive of [2, 3]) {
      specs.push({
        group: "exit",
        label: `exit-ratio${ratio.toString().replace(".", "p")}_drop${drop.toString().replace(".", "p")}_n${consecutive}`,
        overrides: { ...EXIT_BASE, favBandExitRetraceRatio: ratio, favBandExitMinLowerHighDrop: drop, favBandExitConsecutive: consecutive },
      });
    }
  }
}
// Live-configured exit params (destructive in mode A: 0.02/2).
specs.push({
  group: "exit",
  label: "exit-ratio0p25_drop0p02_n2_LIVE-CONFIGURED",
  overrides: { ...EXIT_BASE, favBandExitRetraceRatio: 0.25, favBandExitMinLowerHighDrop: 0.02, favBandExitConsecutive: 2 },
});
// Loss-only off.
specs.push({
  group: "exit",
  label: "exit-ratio0p25_drop0p05_n3_loss-only-off",
  overrides: { ...EXIT_BASE, favBandExitRetraceRatio: 0.25, favBandExitMinLowerHighDrop: 0.05, favBandExitConsecutive: 3, favBandExitLossOnly: false },
});
// Switch ON (requires maxOpenPositionsPerSide >= 2).
specs.push({
  group: "exit",
  label: "exit-ratio0p25_drop0p05_n3_switch-on",
  overrides: { ...EXIT_BASE, favBandExitRetraceRatio: 0.25, favBandExitMinLowerHighDrop: 0.05, favBandExitConsecutive: 3, favBandExitSwitchEnabled: true, favBandExitSwitchOrderUsdc: 15, maxOpenPositionsPerSide: 2 },
});

// ---- Group 5: whipsaw filters (wired, never backtested on this universe) ----
specs.push({ group: "whipsaw", label: "whipsaw-pause3x8_band-opt", overrides: { ...BAND_OPT, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false, favBandWhipsawEnabled: true, favBandWhipsawPauseAfterLosses: 3, favBandWhipsawPauseWindows: 8 } });
specs.push({ group: "whipsaw", label: "whipsaw-maxIntraFlips4_band-opt", overrides: { ...BAND_OPT, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false, favBandWhipsawEnabled: true, favBandWhipsawMaxIntraFlips: 4 } });
specs.push({ group: "whipsaw", label: "whipsaw-maxScore40_band-opt", overrides: { ...BAND_OPT, ...SIZING_GRID, favBandInverseEnabled: false, favBandExitEnabled: false, favBandWhipsawEnabled: true, favBandWhipsawMaxScore: 40 } });

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-audit-${Date.now()}.db`);
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
console.error(JSON.stringify({ btc15Total: allBtc.length, selected: selected.length, specs: specs.length, criteria }, null, 2));

// Per-day PnL series for select runs (day-level equity for charts).
function perDayPositions(runId: string): BacktestPositionRow[] {
  return repos.backtestPositions.byRun(runId);
}

function dayStats(rows: BacktestPositionRow[]) {
  // Resolution-level (one row per position: side BUY, status won/lost/sold).
  const buys = new Map<string, BacktestPositionRow>();
  for (const r of rows) {
    if (r.side !== "BUY" || r.status === "open") continue;
    buys.set(r.id, r);
  }
  const byDay = new Map<string, { pnl: number; won: number; lost: number; sold: number; trades: number }>();
  const buckets = new Map<string, { pnl: number; won: number; lost: number; n: number }>();
  const sellPrices: Array<{ ts: number; day: string; pnl: number; fillPrice: number }> = [];
  for (const r of buys.values()) {
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
    const bk = fp < 0.65 ? "lt-0.65" : fp < 0.7 ? "0.65-0.70" : fp < 0.75 ? "0.70-0.75" : fp < 0.8 ? "0.75-0.80" : "0.80+";
    const b = buckets.get(bk) ?? { pnl: 0, won: 0, lost: 0, n: 0 };
    b.pnl = Math.round((b.pnl + pnl) * 100) / 100;
    b.n += 1;
    if (pnl > 0) b.won += 1;
    else if (pnl < 0) b.lost += 1;
    buckets.set(bk, b);
    if (r.status === "sold" && r.sellPrice != null) {
      sellPrices.push({ ts: r.resolvedAt ?? r.ts, day, pnl, fillPrice: r.sellPrice });
    }
  }
  const dayList = [...byDay.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day));
  const bucketList = [...buckets.entries()].map(([bucket, v]) => ({ bucket, wrPct: v.n ? Number((((v.won) / v.n) * 100).toFixed(1)) : 0, ...v })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  return { days: dayList, buckets: bucketList, exitsSold: sellPrices.length };
}

const rows: Record<string, unknown>[] = [];
const perDayArtifacts: Record<string, unknown> = {};

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

  const runId = `fav-audit-${spec.label}-${Date.now()}`;
  process.stderr.write(`\n=== [${specs.indexOf(spec) + 1}/${specs.length}] ${spec.label} ===\n`);
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
    group: spec.group,
    label: spec.label,
    ...spec.overrides,
    ms: Date.now() - t0,
    pnl: result.pnl,
    pnlPct: result.capitalStart ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2)) : null,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    fills: result.fillCount,
    rejects: result.rejectCount,
    windows: result.windowsTested,
    ...m,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);

  // Day + price-bucket breakdown for representative runs.
  if (spec.label.startsWith("baseline_band-070-085_min200_max600") || spec.label.startsWith("live_band-065-075_sizing-live") || spec.group === "exit" || spec.group === "whipsaw" || spec.group === "inverse") {
    perDayArtifacts[spec.label] = dayStats(repos.backtestPositions.byRun(runId));
  }
}

const ranked = [...rows].sort((a, b) => Number(b.pnl) - Number(a.pnl));
mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const ts = Date.now();
const outPath = join("audits", "backtest", "fav-band", `fav-band-audit-btc15-${ts}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "Offline only — live bot untouched. Full fav-band audit on ALL complete BTC 15m windows (minTicks 601, gap<=60s).",
      criteria,
      windows: selected.length,
      rankedByPnl: ranked,
      perDayArtifacts,
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ outPath, ranked: ranked.map((r) => ({ group: r.group, label: r.label, pnl: r.pnl, pnlPct: r.pnlPct, wr: r.wr, trades: r.trades, maxDd: r.maxDd, pnlPerDd: r.pnlPerDd, fills: r.fills })) }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}