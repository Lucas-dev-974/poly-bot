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

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };
const specs = [
  {
    id: "asksum1-small",
    overrides: {
      edgeAskSumMax: 1.0,
      edgeRequireCheapReady: true,
      edgeOrderUsdc: 10,
      edgeCheapOrderUsdc: 2,
      maxShareEdge: 15,
      maxSharesPerOrder: 15,
      maxExposureUsdc: 25,
      simulatedCapital: 100,
      edgeConfirmSamples: 8,
      edgeSellExpensiveAfterMin: 3,
      edgeSellExpensiveLossPct: 5,
      edgeSellExpensiveLossWindowMs: 5000,
    },
  },
  {
    id: "asksum1-only",
    overrides: { edgeAskSumMax: 1.0 },
  },
];

const preset = listStrategyPresets().find((p) => p.id === "edge-lead")!;
const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_edge-asksum1-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try { src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/").replace(/'/g, "''")}'`); }
  finally { src.close(); }
}
const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);
const selected = listBacktestWindows(repos, { completeness: criteria }).filter((w) => w.complete);
const rows = [];
for (const spec of specs) {
  const config = testConfig({ strategyId: "edge-lead", dryRun: true, enableExpensiveHedge: true });
  const patch = sanitizePatch({ ...preset.settings, strategyId: "edge-lead", ...spec.overrides });
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (config as any)[k] = v;
  config.dryRun = true;
  config.strategyId = "edge-lead";
  validateConfigCoherence(config, { leadsWithEdge: leadsWithEdgeFor("edge-lead", repos) });
  const result = await runBacktest({
    runId: `x-${spec.id}-${Date.now()}`,
    config,
    windows: selected,
    repos,
    hooks: { shouldCancel: () => false, onProgress: () => {} },
    skippedIncomplete: 0,
  });
  const row = { id: spec.id, pnl: result.pnl, pnlPct: Number(((result.pnl/result.capitalStart)*100).toFixed(2)), covered: result.coveredPairs, uncovered: result.uncoveredPairs, fills: result.fillCount, rejects: result.rejectCount, capitalStart: result.capitalStart };
  rows.push(row);
  console.log(JSON.stringify(row));
}
mkdirSync(join("audits", "arb-backtest", "edge-lead"), { recursive: true });
writeFileSync(join("audits", "arb-backtest", `edge-asksum1-combo-${Date.now()}.json`), JSON.stringify(rows, null, 2));
try { (db as any).close?.(); } catch {}
try { rmSync(workDb, { force: true }); } catch {}
