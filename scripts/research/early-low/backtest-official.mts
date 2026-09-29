/**
 * Backtest OFFICIEL early-low via runBacktest (src/backtest/runner.ts).
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/early-low/backtest-official.mts [minTicks] [maxGapMs]
 *
 * Sélection : fenêtres 15m (early-low est 15m-only) avec >= minTicks ticks
 * (défaut 750) et résolution enregistrée.
 * Rapport JSON + MD dans audits/backtest/early-low/.
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
import { makeMdReport } from "./report.ts";

const minTicks = Number(process.argv[2] ?? 750);
const maxGapMs = Number(process.argv[3] ?? 120_000);

const criteria = {
  minTicks,
  maxGapMs,
  maxEdgeGapMs: null,
} as const;

const overrides: Record<string, unknown> = {
  strategyId: "early-low",
  earlyLowBuyAskMin: 0,
  earlyLowBuyAskMax: 0.15,
  earlyLowMaxElapsedSec: 300,
  earlyLowMaxSpread: 0.06,
  earlyLowOrderUsdc: 1,
  earlyLowExitEnabled: true,
  earlyLowExitAsk: 0.5,
  earlyLowExitMomentumMin: 0.005,
  earlyLow15mOnly: true,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
};

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-bt-${Date.now()}.db`);
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

// Fenêtres 15m uniquement (gate du moteur).
const all = listBacktestWindows(repos, {
  completeness: { minTicks, maxGapMs, maxEdgeGapMs: null },
});
const win15 = all.filter((w) => w.complete && w.eventSlug.includes("-15m-"));
const skipped = all.length - win15.length;
console.error(
  JSON.stringify({ selected: win15.length, criteria, skipped: skipped }, null, 2),
);
if (win15.length === 0) throw new Error("No 15m windows match criteria");

const config = testConfig({ strategyId: "early-low" });
const patch = sanitizePatch(overrides);
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.strategyId = "early-low";

const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `earlylow-official-${Date.now()}`;
const t0 = Date.now();
const result = await runBacktest({
  runId,
  config,
  windows: win15,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 50 === 0) {
        process.stderr.write(`\rearly-low ${cur}/${total}   `);
      }
    },
  },
  skippedIncomplete: skipped,
});
process.stderr.write("\n");

const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outDir, `official-${stamp}.json`);
const mdPath = join(outDir, `official-${stamp}.md`);

const summary = {
  label: "early-low",
  strategyId: "early-low",
  criteria,
  windows: win15.length,
  skippedIncomplete: skipped,
  ms: Date.now() - t0,
  pnl: result.pnl,
  capitalStart: result.capitalStart,
  capitalEnd: result.capitalEnd,
  fills: result.fillCount,
  rejects: result.rejectCount,
  unresolved: result.unresolvedWindows,
  wins: result.wins ?? wins,
  losses: result.losses ?? losses,
  winRate: result.winRate ?? (traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : null),
  tradedWindows: traded.length,
  windowResults: traded.map((w) => ({
    eventSlug: w.eventSlug,
    pnl: w.pnl,
    tradeCount: w.tradeCount,
    unresolved: w.unresolved,
  })),
};
writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
writeFileSync(mdPath, makeMdReport(summary));
console.error(`\nJSON: ${jsonPath}\nMD:   ${mdPath}`);

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}