import { copyFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../src/db/database.ts";
import { createRepositories } from "../src/db/index.ts";
import { runBacktest } from "../src/backtest/runner.ts";
import { listBacktestWindows } from "../src/backtest/windows.ts";
import { listStrategyPresets } from "../src/strategy-presets.ts";
import { testConfig } from "../tests/helpers.ts";
import { sanitizePatch } from "../src/runtime-settings.ts";
import { validateConfigCoherence } from "../src/config.ts";

const presetId = process.argv[2] ?? "coverage-max";
const cheapBuyMaxOverride = process.argv[3] ? Number(process.argv[3]) : null;
const expensiveBuyMaxOverride = process.argv[4] ? Number(process.argv[4]) : null;
const expensiveOrderTypeOverride =
  process.argv[5] === "FOK" || process.argv[5] === "GTC" ? process.argv[5] : null;
const tagParts = [presetId];
if (cheapBuyMaxOverride !== null && Number.isFinite(cheapBuyMaxOverride)) {
  tagParts.push(`cbmax${cheapBuyMaxOverride}`);
}
if (expensiveBuyMaxOverride !== null && Number.isFinite(expensiveBuyMaxOverride)) {
  tagParts.push(`emax${expensiveBuyMaxOverride}`);
}
if (expensiveOrderTypeOverride) tagParts.push(expensiveOrderTypeOverride);
const tag = tagParts.join("-");
const runId = `arb-audit-${tag}-` + Date.now();
const srcDb = join("data", "bot-live.db");
const dstDb = join("data", `bot-arb-audit-${tag}.db`);
copyFileSync(srcDb, dstDb);
for (const suf of ["-wal", "-shm"] as const) {
  const p = srcDb + suf;
  if (existsSync(p)) copyFileSync(p, dstDb + suf);
}

const db = new Database(dstDb, true);
db.init();
const repos = createRepositories(db);

const preset = listStrategyPresets().find((p) => p.id === presetId);
if (!preset) throw new Error(`preset missing: ${presetId}`);

let config = testConfig({
  strategyId: "arb",
  dryRun: true,
  enableExpensiveHedge: true,
});
const patch = sanitizePatch({ ...preset.settings, strategyId: "arb" });
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
// Backtest is always simulated — never inherit live dryRun=false from presets/settings.
config.dryRun = true;
if (cheapBuyMaxOverride !== null && Number.isFinite(cheapBuyMaxOverride)) {
  config.cheapBuyMax = cheapBuyMaxOverride;
}
if (expensiveBuyMaxOverride !== null && Number.isFinite(expensiveBuyMaxOverride)) {
  config.expensiveBuyMax = expensiveBuyMaxOverride;
}
if (expensiveOrderTypeOverride) {
  config.expensiveOrderType = expensiveOrderTypeOverride;
}
validateConfigCoherence(config, { leadsWithEdge: false });
// skip validateTradingConfig — backtest needs no PRIVATE_KEY

const all = listBacktestWindows(repos, {});
const btc = all.filter((w) => w.eventSlug.startsWith("btc-updown-15m"));
const complete = btc.filter((w) => w.complete);
console.log(
  JSON.stringify(
    {
      phase: "start",
      runId,
      presetId,
      cheapBuyMaxOverride,
      expensiveBuyMaxOverride,
      expensiveOrderTypeOverride,
      cheapBuyMax: config.cheapBuyMax,
      expensiveBuyMax: config.expensiveBuyMax,
      expensiveOrderType: config.expensiveOrderType,
      btc: btc.length,
      complete: complete.length,
      strategyId: config.strategyId,
      pairLockMax: config.pairLockMax,
      arbAskLockOnly: config.arbAskLockOnly,
      arbAskSumMax: config.arbAskSumMax,
      cheapBuyMin: config.cheapBuyMin,
      cheapBuyMax: config.cheapBuyMax,
      expensiveBuyMin: config.expensiveBuyMin,
      expensiveBuyMax: config.expensiveBuyMax,
      expensiveOrderUsdc: config.expensiveOrderUsdc,
      cheapOrderUsdc: config.cheapOrderUsdc,
      simulatedCapital: config.simulatedCapital,
    },
    null,
    2,
  ),
);

const result = await runBacktest({
  runId,
  config,
  windows: complete,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur % 10 === 0 || cur === total) {
        process.stderr.write(`\rprogress ${cur}/${total}   `);
      }
    },
  },
  skippedIncomplete: btc.length - complete.length,
});
process.stderr.write("\n");

const raw = new DatabaseSync(dstDb, { readOnly: true });
const tradeGroups = raw
  .prepare(
    `SELECT side, kind, reason, filled, COUNT(*) AS c, ROUND(SUM(size),4) AS sz,
            ROUND(SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END),4) AS pnlSum
     FROM backtest_trades WHERE runId=? GROUP BY side, kind, reason, filled
     ORDER BY c DESC`,
  )
  .all(runId);
const posGroups = raw
  .prepare(
    `SELECT kind, status, COUNT(*) AS c,
            ROUND(SUM(size),4) AS sz,
            ROUND(SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END),4) AS pnlSum
     FROM backtest_positions WHERE runId=? GROUP BY kind, status
     ORDER BY c DESC`,
  )
  .all(runId);
const sellReasons = raw
  .prepare(
    `SELECT reason, COUNT(*) AS c, ROUND(SUM(size),4) AS sz,
            ROUND(SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END),4) AS pnlSum
     FROM backtest_trades
     WHERE runId=? AND side='SELL' AND filled=1
     GROUP BY reason ORDER BY c DESC`,
  )
  .all(runId);
const windowPnls = raw
  .prepare(
    `SELECT eventSlug,
            ROUND(SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END),4) AS pnl,
            COUNT(*) AS trades,
            SUM(CASE WHEN filled=1 THEN 1 ELSE 0 END) AS fills
     FROM backtest_trades WHERE runId=? GROUP BY eventSlug
     ORDER BY pnl ASC`,
  )
  .all(runId);

const filledBuyCheap = raw
  .prepare(
    `SELECT COUNT(*) AS c FROM backtest_trades
     WHERE runId=? AND side='BUY' AND kind='cheap' AND filled=1`,
  )
  .get(runId) as { c: number };
const filledBuyExp = raw
  .prepare(
    `SELECT COUNT(*) AS c FROM backtest_trades
     WHERE runId=? AND side='BUY' AND kind='expensive' AND filled=1`,
  )
  .get(runId) as { c: number };
const filledSellCheap = raw
  .prepare(
    `SELECT COUNT(*) AS c FROM backtest_trades
     WHERE runId=? AND side='SELL' AND kind='cheap' AND filled=1`,
  )
  .get(runId) as { c: number };

const policyAHints = raw
  .prepare(
    `SELECT reason, COUNT(*) AS c FROM backtest_trades
     WHERE runId=? AND (
       reason LIKE '%pair-lock%' OR reason LIKE '%policy%' OR reason LIKE '%defend%'
       OR reason LIKE '%unsellable%' OR reason LIKE '%remainder%' OR reason LIKE '%clob%'
     )
     GROUP BY reason ORDER BY c DESC`,
  )
  .all(runId);

const worst = windowPnls.slice(0, 8);
const best = [...windowPnls].reverse().slice(0, 8);
const activity = result.coveredPairs + result.uncoveredPairs;

const audit = {
  runId,
  when: new Date().toISOString(),
  preset: tag,
  basePreset: presetId,
  config: {
    strategyId: config.strategyId,
    pairLockMax: config.pairLockMax,
    cheapBuyMin: config.cheapBuyMin,
    cheapBuyMax: config.cheapBuyMax,
    expensiveBuyMin: config.expensiveBuyMin,
    expensiveBuyMax: config.expensiveBuyMax,
    cheapOrderUsdc: config.cheapOrderUsdc,
    expensiveOrderUsdc: config.expensiveOrderUsdc,
    expensiveOrderType: config.expensiveOrderType,
    simulatedCapital: config.simulatedCapital,
    maxExposureUsdc: config.maxExposureUsdc,
  },
  universe: {
    btcWindows: btc.length,
    completeWindows: complete.length,
    skippedIncomplete: btc.length - complete.length,
  },
  headline: {
    strategyId: result.strategyId,
    windowsTested: result.windowsTested,
    windowsSkippedIncomplete: result.windowsSkippedIncomplete,
    unresolvedWindows: result.unresolvedWindows,
    coveredPairs: result.coveredPairs,
    uncoveredPairs: result.uncoveredPairs,
    uncoveredRatePct: activity ? Number(((result.uncoveredPairs / activity) * 100).toFixed(2)) : null,
    fillCount: result.fillCount ?? (result as { fillCount?: number }).fillCount,
    rejectCount: result.rejectCount,
    capitalStart: result.capitalStart,
    capitalEnd: result.capitalEnd,
    pnl: result.pnl,
    pnlPctOfStart: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
  },
  flow: {
    filledBuyCheap: filledBuyCheap.c,
    filledBuyExpensive: filledBuyExp.c,
    filledSellCheap: filledSellCheap.c,
    hedgeRatioVsCheapBuys:
      filledBuyCheap.c > 0
        ? Number(((filledBuyExp.c / filledBuyCheap.c) * 100).toFixed(1))
        : null,
    sellVsCheapBuys:
      filledBuyCheap.c > 0
        ? Number(((filledSellCheap.c / filledBuyCheap.c) * 100).toFixed(1))
        : null,
  },
  tradeGroups,
  posGroups,
  sellReasons,
  policyAHints,
  worstWindows: worst,
  bestWindows: best,
};

mkdirSync(join("audits", "arb-backtest"), { recursive: true });
const outJson = join("audits", "arb-backtest", `${runId}.json`);
const outMd = join("audits", "arb-backtest", `${runId}.md`);
writeFileSync(outJson, JSON.stringify(audit, null, 2));

const md = `# Audit backtest ARB — ${runId}

## Setup
- Preset: **${tag}** (base ${presetId}) / strategyId=arb
- Pair lock: **${config.pairLockMax}**
- Cheap band: ${config.cheapBuyMin}–${config.cheapBuyMax} | Expensive: ${config.expensiveBuyMin}–${config.expensiveBuyMax}
- Order USDC: cheap ${config.cheapOrderUsdc} / expensive ${config.expensiveOrderUsdc} (${config.expensiveOrderType})
- Capital sim: ${config.simulatedCapital} | max exposure: ${config.maxExposureUsdc}
- Univers: ${complete.length} fenêtres BTC 15m **complètes** / ${btc.length} listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **${result.pnl}** |
| Capital | ${result.capitalStart} → ${result.capitalEnd} |
| Windows tested | ${result.windowsTested} |
| Covered pairs | ${result.coveredPairs} |
| Uncovered pairs | ${result.uncoveredPairs} |
| Uncovered rate | ${audit.headline.uncoveredRatePct ?? "n/a"}% |
| Fills / rejects | ${audit.headline.fillCount} / ${result.rejectCount} |
| Unresolved windows | ${result.unresolvedWindows} |

## Flux (fills)
- BUY cheap: **${filledBuyCheap.c}**
- BUY expensive (hedge): **${filledBuyExp.c}** (${audit.flow.hedgeRatioVsCheapBuys}% des cheap fills)
- SELL cheap (Policy A / band defend): **${filledSellCheap.c}** (${audit.flow.sellVsCheapBuys}% des cheap fills)

## SELL reasons
\`\`\`
${JSON.stringify(sellReasons, null, 2)}
\`\`\`

## Positions
\`\`\`
${JSON.stringify(posGroups, null, 2)}
\`\`\`

## Trade groups
\`\`\`
${JSON.stringify(tradeGroups, null, 2)}
\`\`\`

## Policy A / dust / defend hints
\`\`\`
${JSON.stringify(policyAHints, null, 2)}
\`\`\`

## Worst windows
\`\`\`
${JSON.stringify(worst, null, 2)}
\`\`\`

## Best windows
\`\`\`
${JSON.stringify(best, null, 2)}
\`\`\`
`;
writeFileSync(outMd, md);
console.log(JSON.stringify({ phase: "done", outJson, outMd, headline: audit.headline, flow: audit.flow }, null, 2));
