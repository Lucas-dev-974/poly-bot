import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { listStrategyPresets } from "../../../src/strategy-presets.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch, applyRuntimeSettingsPatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence, validateTradingConfig } from "../../../src/config.ts";

const srcDb = join("data", "bot-live.db");
const dstDb = join("data", "bot-phase0-postA.db");
copyFileSync(srcDb, dstDb);
// also copy wal/shm if present
for (const suf of ["-wal", "-shm"]) {
  const p = srcDb + suf;
  if (existsSync(p)) copyFileSync(p, dstDb + suf);
}

const db = new Database(dstDb, true);
db.init();
const repos = createRepositories(db);

const preset = listStrategyPresets().find((p) => p.id === "coverage-max");
if (!preset) throw new Error("coverage-max missing");

let config = testConfig({
  strategyId: "arb",
  dryRun: true,
  enableExpensiveHedge: true,
});
// apply preset settings
const patch = sanitizePatch({ ...preset.settings, strategyId: "arb" });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as any)[k] = v;
}
validateConfigCoherence(config, { leadsWithEdge: false });
validateTradingConfig(config, { leadsWithEdge: false });

const all = listBacktestWindows(repos, {});
const btc = all.filter((w) => w.eventSlug.startsWith("btc-updown-15m"));
const complete = btc.filter((w) => w.complete);
console.log({ btc: btc.length, complete: complete.length, strategyId: config.strategyId, pairLockMax: config.pairLockMax });

const result = await runBacktest({
  runId: "phase0-postA-" + Date.now(),
  config,
  windows: complete,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur % 10 === 0 || cur === total) process.stdout.write(`\rprogress ${cur}/${total}`);
    },
  },
  skippedIncomplete: btc.length - complete.length,
});
console.log("\nRESULT", {
  strategyId: result.strategyId,
  windowsTested: result.windowsTested,
  windowsSkippedIncomplete: result.windowsSkippedIncomplete,
  coveredPairs: result.coveredPairs,
  uncoveredPairs: result.uncoveredPairs,
  fillCount: result.fillCount,
  pnl: result.pnl,
  capitalStart: result.capitalStart,
  capitalEnd: result.capitalEnd,
});
const activity = result.coveredPairs + result.uncoveredPairs;
console.log(
  "uncovered rate",
  activity ? ((result.uncoveredPairs / activity) * 100).toFixed(1) + "%" : "n/a",
);
