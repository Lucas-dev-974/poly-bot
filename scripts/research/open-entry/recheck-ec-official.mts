/**
 * Calibration runner officiel ↔ sim open-entry : early-conviction (hold,
 * exits off — moteur natif existant) sur le même univers 724 fenêtres.
 * La sim calibrée doit retomber sur les mêmes fills (±1-2 %) et des PnL
 * de direction/delta cohérents (piège : le runner modèle capital/exposure).
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

const EC_BASE = {
  strategyId: "early-conviction",
  earlyConvictionAskMin: 0.6,
  earlyConvictionAskMax: 0.8,
  earlyConvictionMaxElapsedSec: 45,
  earlyConvictionMaxSpread: 0.05,
  earlyConvictionOrderUsdc: 15,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
};

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_ec-recheck-${Date.now()}.db`);
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

const config = testConfig({ strategyId: "early-conviction", dryRun: true });
const patch = sanitizePatch({ ...EC_BASE, strategyId: "early-conviction" });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "early-conviction";
const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `ec-recheck-${Date.now()}`;
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
  label: "ec-hold-official",
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

mkdirSync(join("audits", "backtest", "open-entry"), { recursive: true });
const outPath = join("audits", "backtest", "open-entry", `ec-recheck-official-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ criteria, windows: selected.length, ranked: [row] }, null, 2));
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