/**
 * Backtest OFFICIEL des 3 nouvelles stratégies via runBacktest
 * (src/backtest/runner.ts) — validation du wiring implémenté.
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/backtests/backtest-new-strats.mts [minTicks] [maxGapMs]
 *
 * Écrit dans audits/backtest/<antiflip-revert|flip-confirm|early-conviction>/.
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
import type { StrategyId } from "../../../src/strategy/ids.ts";

const criteria: CompletenessCriteria = {
  minTicks: Number(process.argv[2] ?? 801),
  maxGapMs: Number(process.argv[3] ?? 60_000),
  maxEdgeGapMs: null,
};

type Spec = {
  label: string;
  strategyId: StrategyId;
  overrides: Record<string, unknown>;
};

const specs: Spec[] = [
  {
    label: "antiflip-revert",
    strategyId: "antiflip-revert",
    overrides: {
      antiflipBandMin: 0.35,
      antiflipBandMax: 0.45,
      antiflipDeposedAskMin: 0.40,
      antiflipFlipLookbackMs: 90_000,
      antiflipMinElapsedSec: 240,
      antiflipMaxElapsedSec: null,
      antiflipMaxSpread: 0.05,
      antiflipOrderUsdc: 15,
      maxSharesPerOrder: 30,
      maxExposureUsdc: 450,
      simulatedCapital: 500,
    },
  },
  {
    label: "flip-confirm",
    strategyId: "flip-confirm",
    overrides: {
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
    },
  },
  {
    label: "early-conviction",
    strategyId: "early-conviction",
    overrides: {
      earlyConvictionAskMin: 0.60,
      earlyConvictionAskMax: 0.80,
      earlyConvictionMaxElapsedSec: 45,
      earlyConvictionMaxSpread: 0.05,
      earlyConvictionOrderUsdc: 15,
      maxSharesPerOrder: 30,
      maxExposureUsdc: 450,
      simulatedCapital: 500,
    },
  },
];

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_newstrats-bt-${Date.now()}.db`);
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
console.error(
  JSON.stringify({ selected: selected.length, criteria, skipped }, null, 2),
);
if (selected.length === 0) throw new Error("No windows match criteria");

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({ strategyId: spec.strategyId });
  const patch = sanitizePatch({ ...spec.overrides, strategyId: spec.strategyId });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.strategyId = spec.strategyId;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `newstrats-${spec.label}-${Date.now()}`;
  process.stderr.write(`\n=== ${spec.label} (${spec.strategyId}) ===\n`);
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 50 === 0) {
          process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: skipped,
  });
  process.stderr.write("\n");

  const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  const row = {
    label: spec.label,
    strategyId: spec.strategyId,
    ms: Date.now() - t0,
    pnl: result.pnl,
    capitalEnd: result.capitalEnd,
    fills: result.fillCount,
    rejects: result.rejectCount,
    unresolved: result.unresolvedWindows,
    winRate: traded.length
      ? Number(((wins / traded.length) * 100).toFixed(1))
      : null,
    wins,
    losses,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}

mkdirSync(join("audits", "backtest", "antiflip-revert"), { recursive: true });
const outPath = join(
  "audits",
  "backtest",
  "antiflip-revert",
  `new-strats-official-${Date.now()}.json`,
);
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: rows }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath, ranked: rows }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}