// R&D phase 3 — final refinement around the 80% WR frontier.
// Phase-2 fact: band 0.78-0.82 + max780 crossed 80% (F4, WR 80.22, DD 32.45) and its
// 0.80-0.82 slice runs at WR 84.4% with all the PnL (+46.06 of +45.61 total).
// Swept here (913 complete BTC 15m windows, S1 sizing, cap20):
//   P1/P2/P3: narrow top band [0.80-0.82] and [0.79-0.82], with/without max780
//   P4: F4 + exit B (DD trim on the 80% config)
//   P5: F4 + pause 2x8 (tighter loss-streak pause)
//   P6: F4 + min250 (skip the earliest prints at 0.80)
// Usage: npx tsx scripts/research/fav-band-audit/wr-phase3.mts
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
  favBandExitEnabled: false,
};

const specs: Spec[] = [
  { label: "P1_askMin0.80_max780", overrides: { favBandAskMin: 0.8, favBandMaxElapsedSec: 780 } },
  { label: "P2_askMin0.79_max780", overrides: { favBandAskMin: 0.79, favBandMaxElapsedSec: 780 } },
  { label: "P3_askMin0.80", overrides: { favBandAskMin: 0.8 } },
  { label: "P4_F4_exitB", overrides: { favBandAskMin: 0.78, favBandMaxElapsedSec: 780, favBandExitEnabled: true, favBandExitRetraceRatio: 0.5, favBandExitMinLowerHighDrop: 0.03, favBandExitConsecutive: 3, favBandExitLookbackMs: 120_000, favBandExitMinElapsedSec: 0, favBandExitLossOnly: true, favBandExitSwitchEnabled: false } },
  { label: "P5_F4_pause2x8", overrides: { favBandAskMin: 0.78, favBandMaxElapsedSec: 780, favBandWhipsawPauseAfterLosses: 2 } },
  { label: "P6_F4_min250", overrides: { favBandAskMin: 0.78, favBandMaxElapsedSec: 780, favBandMinElapsedSec: 250 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-wr3-${Date.now()}.db`);
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

  const runId = `fav-wr3-${spec.label}-${Date.now()}`;
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
  const row = {
    label: spec.label,
    ms: Date.now() - t0,
    ...m,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-wr-phase3-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "WR R&D phase 3 — refinement around the 80% frontier (top band 0.80-0.82, exit B on F4, pause 2x8, min250).", criteria, capital: CAPITAL, windows: selected.length, rows }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}