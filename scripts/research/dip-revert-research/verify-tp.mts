// Phantom hunt 5: run the OFFICIAL runner with TP ON on 60 windows and count
// SELL rows persisted in backtest_trades -> proves the wiring fires.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { testConfig } from "../../../tests/helpers.js";
import { sanitizePatch } from "../../../src/runtime-settings.js";

const workDb = "data/_tp-verify.db";
for (const f of [workDb, workDb + "-wal", workDb + "-shm"]) {
  if (existsSync(f)) rmSync(f, { force: true });
}
const src = new DatabaseSync("data/bot-live.db", { readOnly: true });
src.exec(`VACUUM INTO '${workDb}'`);
src.close();
const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);
const all = listBacktestWindows(repos, { completeness: { minTicks: 801, maxGapMs: 60_000, maxEdgeGapMs: null } });
const selected = all.filter((w) => w.complete).slice(0, 60);

const config = testConfig({ strategyId: "dip-revert", dryRun: true });
const patch = sanitizePatch({
  strategyId: "dip-revert",
  dipRevertBandMin: 0.55, dipRevertBandMax: 0.65,
  dipRevertMinDrop: 0.03, dipRevertDropLookbackMs: 60_000,
  dipRevertMinElapsedSec: 180, dipRevertMaxElapsedSec: 420,
  dipRevertMaxSpread: 0.04, dipRevertOrderUsdc: 15,
  dipRevertExitTakeProfitEnabled: true, dipRevertExitWinAsk: 0.85,
  maxSharesPerOrder: 30, maxExposureUsdc: 450, simulatedCapital: 500,
  minutesBeforeCloseMin: 0, minutesBeforeCloseMax: 15,
});
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "dip-revert";

const runId = `tp-verify-${Date.now()}`;
const result = await runBacktest({
  runId, config, windows: selected, repos,
  hooks: { shouldCancel: () => false, onProgress: () => {} },
});
const sellRows = (repos!.backtestTrades as unknown as {
  db: { all: (q: string, p?: unknown[]) => Array<{ reason: string; n: number }> };
}).db.all("SELECT reason, COUNT(*) as n FROM backtest_trades WHERE runId = ? AND side = 'SELL' GROUP BY reason", [runId]);
console.log(JSON.stringify({ windows: selected.length, fills: result.fillCount, sellRows }));
assert.ok(sellRows.length > 0, "TP exit must produce SELL trades when enabled");
console.log("TP WIRING CONFIRMED IN OFFICIAL RUNNER — PASS");
(db as { close?: () => void }).close?.();
rmSync(workDb, { force: true });
for (const suf of ["-wal", "-shm"] as const) {
  if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
}
