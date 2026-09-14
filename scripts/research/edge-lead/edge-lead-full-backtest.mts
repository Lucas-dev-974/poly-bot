import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

// >600 ticks, inter-tick gaps < 1 minute; no edge-gap requirement
const criteria: CompletenessCriteria = {
  minTicks: 601,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

const preset = listStrategyPresets().find((p) => p.id === "edge-lead");
if (!preset) throw new Error("edge-lead preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_edge-lead-full-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try {
    const dest = workDb.replace(/\\/g, "/").replace(/'/g, "''");
    src.exec(`VACUUM INTO '${dest}'`);
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

// prefix breakdown
const prefixCount: Record<string, number> = {};
for (const w of selected) {
  const m = /^(.*?-updown-\d+m)/.exec(w.eventSlug);
  const key = m?.[1] ?? w.eventSlug.split("-").slice(0, 3).join("-");
  prefixCount[key] = (prefixCount[key] ?? 0) + 1;
}

console.error(
  JSON.stringify(
    {
      phase: "universe",
      criteria,
      listed: all.length,
      selected: selected.length,
      skipped,
      prefixCount,
      tickRange: selected.length
        ? {
            min: Math.min(...selected.map((w) => w.tickCount)),
            max: Math.max(...selected.map((w) => w.tickCount)),
            maxGapMax: Math.max(...selected.map((w) => w.maxGapMs)),
          }
        : null,
    },
    null,
    2,
  ),
);

if (selected.length === 0) {
  throw new Error("No windows match criteria");
}

const config = testConfig({
  strategyId: "edge-lead",
  dryRun: true,
  enableExpensiveHedge: true,
});
const patch = sanitizePatch({ ...preset.settings, strategyId: "edge-lead" });
for (const [k, val] of Object.entries(patch)) {
  if (val !== undefined) (config as Record<string, unknown>)[k] = val;
}
config.dryRun = true;
config.strategyId = "edge-lead";
// Don't restrict marketSlugPrefixes in config for backtest selection —
// windows list already defines universe. Keep preset prefixes for live parity logging.
validateConfigCoherence(config, {
  leadsWithEdge: leadsWithEdgeFor(config.strategyId, repos),
});

const runId = `edge-lead-600t-1m-${Date.now()}`;
const t0 = Date.now();
const result = await runBacktest({
  runId,
  config,
  windows: selected,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 25 === 0) process.stderr.write(`\redge-lead ${cur}/${total}   `);
    },
  },
  skippedIncomplete: skipped,
});
process.stderr.write("\n");

const summary = {
  phase: "done",
  runId,
  ms: Date.now() - t0,
  criteria,
  listed: all.length,
  selected: selected.length,
  skipped,
  prefixCount,
  pnl: result.pnl,
  capitalStart: result.capitalStart,
  capitalEnd: result.capitalEnd,
  pnlPct: result.capitalStart
    ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
    : null,
  covered: result.coveredPairs,
  uncovered: result.uncoveredPairs,
  fills: result.fillCount,
  rejects: result.rejectCount,
  unresolved: result.unresolvedWindows,
  windowsTested: result.windowsTested,
  presetId: "edge-lead",
  config: {
    strategyId: config.strategyId,
    edgeOrderUsdc: config.edgeOrderUsdc,
    edgeCheapOrderUsdc: config.edgeCheapOrderUsdc,
    edgeBandMin: config.edgeBandMin,
    edgeBandMax: config.edgeBandMax,
    edgeConfirmSamples: config.edgeConfirmSamples,
    maxExposureUsdc: config.maxExposureUsdc,
    simulatedCapital: config.simulatedCapital,
    marketSlugPrefixes: config.marketSlugPrefixes,
  },
};

mkdirSync(join("audits", "arb-backtest", "edge-lead"), { recursive: true });
const outPath = join("audits", "arb-backtest", `${runId}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, outPath }, null, 2));

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

