/**
 * Backtest runner officiel flip-confirm (preset backtesté 2026-09-15).
 * Template : scripts/research/open-entry/wiring-runner.mts.
 * Preuve de wiring : fills > 0, rejects == 0, hold-to-resolution
 * (pas de SELL defend attendu pour ce moteur — pas de exits).
 *
 * npx tsx scripts/research/flip-confirm/official-runner.mts
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

// Preset backtesté = config/presets/flip-confirm.json (identique aux defaults
// du moteur + budget/exposition du runner officiel open-entry).
const FLIP_CONFIRM_BASE = {
  strategyId: "flip-confirm",
  flipConfirmBandMin: 0.55,
  flipConfirmBandMax: 0.65,
  flipConfirmFlipLookbackMs: 90_000,
  flipConfirmMinElapsedSec: 120,
  flipConfirmMaxElapsedSec: 180,
  flipConfirmMaxSpread: 0.05,
  flipConfirmOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fc-recheck-${Date.now()}.db`);
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

const config = testConfig({ strategyId: "flip-confirm", dryRun: true });
const patch = sanitizePatch({ ...FLIP_CONFIRM_BASE, strategyId: "flip-confirm" });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "flip-confirm";
const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `flip-confirm-wire-${Date.now()}`;
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
  label: "flip-confirm-wired",
  ms: Date.now() - t0,
  pnl: result.pnl,
  fills: result.fillCount,
  rejects: result.rejectCount,
  unresolved: result.unresolvedWindows,
  winRate: traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : null,
  wins,
  losses: traded.length - wins,
  capitalEnd: result.capitalEnd,
  windowsTotal: selected.length,
};
console.log(JSON.stringify(row));

// SELL rows — flip-confirm n'a pas d'exit : tout doit être résolution (payout),
// pas defend.
const trades = repos.backtestTrades.byRun(runId);
const sellRows = trades
  .filter((t) => t.side === "SELL" && t.filled)
  .reduce<Record<string, number>>((acc, t) => {
    const key = t.reason ?? "null";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
console.log(JSON.stringify({ sells: sellRows, buyRows: trades.filter((t) => t.side === "BUY" && t.filled).length }));

mkdirSync(join("audits", "backtest", "flip-confirm"), { recursive: true });
const outPath = join("audits", "backtest", "flip-confirm", `flip-confirm-official-runner-${Date.now()}.json`);
const perWindow = result.windows
  .filter((w) => w.pnl !== null)
  .map((w) => ({ slug: w.eventSlug ?? "", pnl: w.pnl }));
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: [row], sells: sellRows, perWindow }, null, 2));
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