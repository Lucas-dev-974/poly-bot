import { copyFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { listStrategyPresets } from "../../../src/strategy-presets.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";

type Variant = { id: string; overrides: Record<string, unknown> };

const variants: Variant[] = [
  { id: "baseline", overrides: {} },
  { id: "sum-0.985", overrides: { arbAskSumMax: 0.985 } },
  { id: "sum-0.98", overrides: { arbAskSumMax: 0.98 } },
  { id: "plock-0.995", overrides: { pairLockMax: 0.995, arbAskSumMax: null } },
  { id: "plock-0.999", overrides: { pairLockMax: 0.999, arbAskSumMax: null } },
  {
    id: "size-2x",
    overrides: {
      cheapOrderUsdc: 2,
      expensiveOrderUsdc: 24,
      maxSharesPerOrder: 50,
      maxExposureUsdc: 50,
    },
  },
  {
    id: "size-3x",
    overrides: {
      cheapOrderUsdc: 3,
      expensiveOrderUsdc: 36,
      maxSharesPerOrder: 75,
      maxExposureUsdc: 75,
    },
  },
  {
    id: "hedge-budget-20",
    overrides: { expensiveOrderUsdc: 20, maxSharesPerOrder: 40, maxExposureUsdc: 40 },
  },
  {
    id: "plock995-size2x",
    overrides: {
      pairLockMax: 0.995,
      arbAskSumMax: null,
      cheapOrderUsdc: 2,
      expensiveOrderUsdc: 24,
      maxSharesPerOrder: 50,
      maxExposureUsdc: 50,
    },
  },
];

const preset = listStrategyPresets().find((p) => p.id === "ask-lock");
if (!preset) throw new Error("ask-lock preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_asklock-grid-${Date.now()}.db`);
copyFileSync(srcDb, workDb);
for (const suf of ["-wal", "-shm"] as const) {
  const p = srcDb + suf;
  if (existsSync(p)) copyFileSync(p, workDb + suf);
}

const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);
const all = listBacktestWindows(repos, {});
const complete = all.filter((w) => w.eventSlug.startsWith("btc-updown-15m") && w.complete);
console.error(`windows complete btc-15m: ${complete.length}`);

const rows: Record<string, unknown>[] = [];

for (const v of variants) {
  const config = testConfig({
    strategyId: "arb",
    dryRun: true,
    enableExpensiveHedge: true,
  });
  const patch = sanitizePatch({ ...preset.settings, strategyId: "arb", ...v.overrides });
  for (const [k, val] of Object.entries(patch)) {
    if (val !== undefined) (config as Record<string, unknown>)[k] = val;
  }
  config.dryRun = true;
  validateConfigCoherence(config, { leadsWithEdge: false });

  const runId = `asklock-grid-${v.id}-${Date.now()}`;
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: complete,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 20 === 0) process.stderr.write(`\r${v.id} ${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");

  const row = {
    id: v.id,
    ms: Date.now() - t0,
    pnl: result.pnl,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    covered: result.coveredPairs,
    uncovered: result.uncoveredPairs,
    fills: result.fillCount,
    rejects: result.rejectCount,
    unresolved: result.unresolvedWindows,
    pairLockMax: config.pairLockMax,
    arbAskSumMax: config.arbAskSumMax,
    cheapOrderUsdc: config.cheapOrderUsdc,
    expensiveOrderUsdc: config.expensiveOrderUsdc,
    maxSharesPerOrder: config.maxSharesPerOrder,
    maxExposureUsdc: config.maxExposureUsdc,
    pollIntervalMs: config.pollIntervalMs,
    overrides: v.overrides,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "arb-backtest", "ask-lock"), { recursive: true });
const outPath = join("audits", "arb-backtest", `ask-lock-grid-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ windows: complete.length, rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, n: rows.length }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {
  /* ignore */
}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {
  /* ignore */
}
