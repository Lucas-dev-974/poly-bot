/**
 * Re-vérification dip-revert : backtests via le runner OFFICIEL
 * (src/backtest/runner.ts) — pas la sim standalone — pour valider le code
 * implémenté (entrée + take-profit optionnel branché sur defendCheapLegs).
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/dip-revert-research/recheck-official.mts
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
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

type Spec = {
  label: string;
  strategyId: StrategyId;
  overrides: Record<string, unknown>;
};

const DIP_BASE = {
  strategyId: "dip-revert",
  dipRevertBandMin: 0.55,
  dipRevertBandMax: 0.65,
  dipRevertMinDrop: 0.03,
  dipRevertDropLookbackMs: 60_000,
  dipRevertMinElapsedSec: 180,
  dipRevertMaxElapsedSec: null,
  dipRevertMaxSpread: 0.04,
  dipRevertOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

const specs: Spec[] = [
  // 1. Base (hold intégral, TP OFF) — reproductit la référence officielle
  { label: "base-hold", strategyId: "dip-revert", overrides: { ...DIP_BASE } },
  // 2. TP ON à 0.85 (défaut preset)
  {
    label: "tp-085",
    strategyId: "dip-revert",
    overrides: {
      ...DIP_BASE,
      dipRevertExitTakeProfitEnabled: true,
      dipRevertExitWinAsk: 0.85,
    },
  },
  // 3. TP ON à 0.90
  {
    label: "tp-090",
    strategyId: "dip-revert",
    overrides: {
      ...DIP_BASE,
      dipRevertExitTakeProfitEnabled: true,
      dipRevertExitWinAsk: 0.9,
    },
  },
  // 4. TP ON à 0.95 (l'axe v1 — vérifier qu'il n'apporte rien en fidèle)
  {
    label: "tp-095",
    strategyId: "dip-revert",
    overrides: {
      ...DIP_BASE,
      dipRevertExitTakeProfitEnabled: true,
      dipRevertExitWinAsk: 0.95,
    },
  },
  // 5. Petits + honnêtes v2 : deadline entrée 420 s
  { label: "max420", strategyId: "dip-revert", overrides: { ...DIP_BASE, dipRevertMaxElapsedSec: 420 } },
  // 6. Combo 420 + TP 0.85
  {
    label: "max420-tp085",
    strategyId: "dip-revert",
    overrides: {
      ...DIP_BASE,
      dipRevertMaxElapsedSec: 420,
      dipRevertExitTakeProfitEnabled: true,
      dipRevertExitWinAsk: 0.85,
    },
  },
];

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_dip-recheck-${Date.now()}.db`);
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
  const config = testConfig({
    strategyId: spec.strategyId,
    dryRun: true,
  });
  const patch = sanitizePatch({ ...spec.overrides, strategyId: spec.strategyId });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = spec.strategyId;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `dip-recheck-${spec.label}-${Date.now()}`;
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
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
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

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "arb-backtest", "dip-revert"), { recursive: true });
const outPath = join(
  "audits",
  "arb-backtest",
  "dip-revert",
  `dip-revert-recheck-${Date.now()}.json`,
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