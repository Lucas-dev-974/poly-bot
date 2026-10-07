/**
 * Re-vérification antiflip-revert : backtests via le runner OFFICIEL
 * (src/backtest/runner.ts) — template scripts/research/dip-revert-research/recheck-official.mts.
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 * Grid demandée : antiflip-revert à sizing MINIMUM de shares = 5 par ordre
 * (orderUsdc = 5 × prix max de bande = 2.25 → size varie 5..6.43 dans [0.35,0.45]),
 * comparé au preset actuel (orderUsdc 15) et à des variants de bande/elapsed.
 *
 * npx tsx scripts/research/antiflip-revert/recheck-official-minshares.mts
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

const AF_BASE = {
  strategyId: "antiflip-revert",
  antiflipBandMin: 0.35,
  antiflipBandMax: 0.45,
  antiflipDeposedAskMin: 0.4,
  antiflipFlipLookbackMs: 90_000,
  antiflipMinElapsedSec: 240,
  antiflipMaxElapsedSec: null,
  antiflipMaxSpread: 0.05,
  antiflipOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

const specs: Spec[] = [
  // 1. Preset backtesté 2026-09-15 (référence, $15/ordre)
  { label: "preset-15usdc", strategyId: "antiflip-revert", overrides: { ...AF_BASE } },
  // 2. Sizing minimum 5 shares : budget = 5 × prix max bande (0.45) → size plancher 5 sh
  { label: "min5sh-2.25usdc", strategyId: "antiflip-revert", overrides: { ...AF_BASE, antiflipOrderUsdc: 2.25 } },
  // 3. min 5 shares + lookback flip élargi (les flips 240s+ sont tardifs: voir si + de signal)
  { label: "min5sh-lookback120", strategyId: "antiflip-revert", overrides: { ...AF_BASE, antiflipOrderUsdc: 2.25, antiflipFlipLookbackMs: 120_000 } },
  // 4. min 5 shares + elapsed tardif min 180 s (entrées plus tôt)
  { label: "min5sh-elite180", strategyId: "antiflip-revert", overrides: { ...AF_BASE, antiflipOrderUsdc: 2.25, antiflipMinElapsedSec: 180 } },
  // 5. min 5 shares + bande étendue bas (0.30-0.45): cale la demande "<0.40/0.30"
  { label: "min5sh-band30-45", strategyId: "antiflip-revert", overrides: { ...AF_BASE, antiflipOrderUsdc: 2.25, antiflipBandMin: 0.3, antiflipDeposedAskMin: 0.35 } },
  // 6. Contrôle sizing $15 sur la bande 30 : le preset à $15 sur 0.30-0.45
  { label: "15usdc-band30-45", strategyId: "antiflip-revert", overrides: { ...AF_BASE, antiflipBandMin: 0.3, antiflipDeposedAskMin: 0.35 } },
];

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_af-recheck-${Date.now()}.db`);
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
const perWindowByLabel: Record<string, { slug: string; pnl: number | null }[]> = {};

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

  const runId = `antiflip-recheck-${spec.label}-${Date.now()}`;
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
  perWindowByLabel[spec.label] = result.windows
    .filter((w) => w.pnl !== null)
    .map((w) => ({ slug: w.eventSlug, pnl: w.pnl }));
  console.log(JSON.stringify(row));
}

rows.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
mkdirSync(join("audits", "backtest", "antiflip-revert"), { recursive: true });
const outPath = join(
  "audits",
  "backtest",
  "antiflip-revert",
  `antiflip-recheck-minshares-${Date.now()}.json`,
);
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: rows, perWindowByLabel }, null, 2));
console.log(JSON.stringify({ phase: "done", outPath }));

try {
  (db as unknown as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}