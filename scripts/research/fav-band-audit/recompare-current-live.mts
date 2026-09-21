// Fav-band — re-fetch live config comparison: CURRENT live (band 0.68-0.82, inverse ON ratio2/2usdc)
// vs BEST (same band + pause, inverse OFF), all at live sizing, same universe.
// Usage: npx tsx scripts/research/fav-band-audit/recompare-current-live.mts
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
  return { trades: traded.length, wins, losses, wr, maxDd: Number(maxDd.toFixed(2)), worst: Number(worst.toFixed(2)) };
}

function inverseLegStats(runId: string, repos: ReturnType<typeof createRepositories>) {
  // BUY fills at fillPrice <= 0.20 = inverse leg (underdog). PnL of those positions.
  const rows = repos.backtestPositions.byRun(runId);
  let n = 0, pnl = 0, won = 0;
  for (const r of rows) {
    if (r.side !== "BUY" || r.status === "open" || r.status === "open") continue;
    const fp = r.fillPrice ?? 1;
    if (fp <= 0.2) {
      n += 1;
      pnl = Math.round((pnl + (r.pnl ?? 0)) * 100) / 100;
      if (r.pnl != null && r.pnl > 0) won += 1;
    }
  }
  return { inverseFills: n, inversePnl: pnl, inverseWr: n ? Number(((won / n) * 100).toFixed(1)) : 0 };
}

type Spec = { label: string; overrides: Record<string, unknown> };

// EXACT live sizing (bot-settings.json, 07:31): 4.5 USDC / 5 sh / expo 6 / 3 slots.
const SIZING_LIVE = { favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6, maxOpenPositionsPerSide: 3 };
// CURRENT live band + timing (fetched 07:31 UTC).
const BAND_LIVE = { favBandAskMin: 0.68, favBandAskMax: 0.82, favBandMinElapsedSec: 180, favBandMaxElapsedSec: 600 };
const INVERSE_LIVE = { favBandInverseEnabled: true, favBandInverseAskMax: 0.15, favBandInverseShareRatio: 2, favBandInverseOrderUsdc: 2 };
const PAUSE = { favBandWhipsawEnabled: true, favBandWhipsawPauseAfterLosses: 3, favBandWhipsawPauseWindows: 8 };
const NO_INVERSE = { favBandInverseEnabled: false };

const specs: Spec[] = [
  { label: "L1_live-asis (bande 0.68-0.82 + inverse ON ratio2/2u)", overrides: { ...BAND_LIVE, ...SIZING_LIVE, ...INVERSE_LIVE, favBandExitEnabled: false } },
  { label: "L2_live-asis-sans-inverse", overrides: { ...BAND_LIVE, ...SIZING_LIVE, ...NO_INVERSE, favBandExitEnabled: false } },
  { label: "BEST_band-0.68-0.82_min200_noMax_pause_inverse-off", overrides: { favBandAskMin: 0.68, favBandAskMax: 0.82, favBandMinElapsedSec: 200, favBandMaxElapsedSec: null, ...SIZING_LIVE, ...NO_INVERSE, ...PAUSE, favBandExitEnabled: false } },
  { label: "BEST+min180-max600 (garde timing live, pause, inverse off)", overrides: { ...BAND_LIVE, ...SIZING_LIVE, ...NO_INVERSE, ...PAUSE, favBandExitEnabled: false } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-recompare-${Date.now()}.db`);
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
console.error(JSON.stringify({ selected: selected.length, specs: specs.length }, null, 2));

const rows: Record<string, unknown>[] = [];
for (const spec of specs) {
  const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false });
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

  const runId = `fav-recompare-${spec.label}-${Date.now()}`;
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
    pnl: result.pnl,
    pnlPct: Number(((result.pnl / result.capitalStart) * 100).toFixed(2)),
    fills: result.fillCount,
    rejects: result.rejectCount,
    windows: result.windowsTested,
    ...m,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
    ...(spec.label.startsWith("L1") || spec.label.startsWith("L2") ? { inverse: inverseLegStats(runId, repos) } : {}),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-recompare-live-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ note: "Offline. Live config re-fetched 2026-09-21 07:31 UTC (band 0.68-0.82, inverse ON ratio2/2usdc). vs BEST at live sizing.", criteria, windows: selected.length, rows }, null, 2));
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}