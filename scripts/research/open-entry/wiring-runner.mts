/**
 * Backtest runner officiel open-entry (preset backtesté 2026-09-19).
 * Preuve de wiring : fills > 0, rejects == 0, SELL rows "defend" présents
 * dans backtest_trades (le SL dual-scale doit sortir via defendCheapLegs).
 * Template : scripts/research/dip-revert-research/recheck-official.mts.
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";

const criteria: CompletenessCriteria = { minTicks: 801, maxGapMs: 60_000, maxEdgeGapMs: null };

const OPEN_ENTRY_BASE = {
  strategyId: "open-entry",
  openEntryLeanTrigger: 0.15,
  openEntryMaxElapsedSec: 300,
  openEntryFairAskSumMax: 1.02,
  openEntryMaxSpread: 0.04,
  openEntryOrderUsdc: 15,
  openEntrySlStructFlipDist: 0.2,
  openEntrySlStructConfirmSec: 20,
  openEntrySlStructDist: 0.1,
  openEntrySlLateAfterSec: 300,
  openEntrySlLateDist: 0.06,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

// Contrôle exits-OFF : hold intégral via le switch openEntrySlEnabled=false.
const OPEN_ENTRY_HOLD = {
  ...OPEN_ENTRY_BASE,
  openEntrySlEnabled: false,
};

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_oe-recheck-${Date.now()}.db`);
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

const all = listBacktestWindows(repos, { completeness: criteria });
const selected = all.filter((w) => w.complete);
const skipped = all.length - selected.length;
console.error(JSON.stringify({ selected: selected.length, criteria, skipped }));

const config = testConfig({ strategyId: "open-entry", dryRun: true });
const patch = sanitizePatch({ ...OPEN_ENTRY_BASE, strategyId: "open-entry" });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "open-entry";
const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `open-entry-wire-${Date.now()}`;
const t0 = Date.now();
const result = await runBacktest({
  runId,
  config,
  windows: selected,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 100 === 0) process.stderr.write(`\r${cur}/${total}   `);
    },
  },
  skippedIncomplete: skipped,
});
process.stderr.write("\n");

const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
const row = {
  label: "open-entry-wired",
  ms: Date.now() - t0,
  pnl: result.pnl,
  fills: result.fillCount,
  rejects: result.rejectCount,
  unresolved: result.unresolvedWindows,
  winRate: traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : null,
  wins,
  losses: traded.length - wins,
  capitalEnd: result.capitalEnd,
};
console.log(JSON.stringify(row));

// SELL rows = preuve que le SL dual-scale tire via defendCheapLegs
const trades = repos.backtestTrades.byRun(runId);
const sellRows = trades
  .filter((t) => t.side === "SELL" && t.filled)
  .reduce<Record<string, number>>((acc, t) => {
    const key = t.reason ?? "null";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
console.log(JSON.stringify({ sells: sellRows, buyRows: trades.filter((t) => t.side === "BUY" && t.filled).length }));

// ---- Contrôle exits-OFF (hold intégral, même entrée) : delta honnête ----
const holdConfig = testConfig({ strategyId: "open-entry", dryRun: true });
const holdPatch = sanitizePatch({ ...OPEN_ENTRY_HOLD, strategyId: "open-entry" });
for (const [k, v] of Object.entries(holdPatch)) {
  if (v !== undefined) (holdConfig as Record<string, unknown>)[k] = v;
}
holdConfig.dryRun = true;
holdConfig.strategyId = "open-entry";
validateConfigCoherence(holdConfig, { leadsWithEdge });

const holdRunId = `open-entry-hold-${Date.now()}`;
const h0 = Date.now();
const holdResult = await runBacktest({
  runId: holdRunId,
  config: holdConfig,
  windows: selected,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 100 === 0) process.stderr.write(`\rhold ${cur}/${total}   `);
    },
  },
  skippedIncomplete: skipped,
});
process.stderr.write("\n");

const holdTraded = holdResult.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
const holdWins = holdTraded.filter((w) => (w.pnl ?? 0) > 0).length;
const holdRow = {
  label: "open-entry-hold-ref",
  ms: Date.now() - h0,
  pnl: holdResult.pnl,
  fills: holdResult.fillCount,
  rejects: holdResult.rejectCount,
  unresolved: holdResult.unresolvedWindows,
  winRate: holdTraded.length ? Number(((holdWins / holdTraded.length) * 100).toFixed(1)) : null,
  wins: holdWins,
  losses: holdTraded.length - holdWins,
  capitalEnd: holdResult.capitalEnd,
};
console.log(JSON.stringify(holdRow));
const holdTrades = repos.backtestTrades.byRun(holdRunId);
console.log(JSON.stringify({
  sells: holdTrades.filter((t) => t.side === "SELL" && t.filled).length,
  buyRows: holdTrades.filter((t) => t.side === "BUY" && t.filled).length,
}));

mkdirSync(join("audits", "backtest", "open-entry"), { recursive: true });
const outPath = join("audits", "backtest", "open-entry", `open-entry-wiring-runner-${Date.now()}.json`);
const perWindow = result.windows.filter((w) => w.pnl !== null).map((w) => ({ slug: w.eventSlug, pnl: w.pnl }));
const holdPerWindow = holdResult.windows.filter((w) => w.pnl !== null).map((w) => ({ slug: w.eventSlug, pnl: w.pnl }));
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: [row, holdRow], sells: sellRows, perWindow, holdPerWindow }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath }));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}