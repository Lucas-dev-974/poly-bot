/**
 * Sweep de paramètres early-low via runBacktest (src/backtest/runner.ts).
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/early-low/sweep.mts [minTicks] [maxGapMs]
 *
 * Grille : buyAskMax (0.10/0.12/0.15) × exitAsk (0.40/0.50) ×
 * momentum (0/0.005) = 12 combos, même dataset (15m, >= minTicks ticks).
 * Rapport JSON + MD dans audits/backtest/early-low/.
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";

const minTicks = Number(process.argv[2] ?? 750);
const maxGapMs = Number(process.argv[3] ?? 120_000);

const criteria: CompletenessCriteria = {
  minTicks,
  maxGapMs,
  maxEdgeGapMs: null,
};

const BUY_MAXES = [0.10, 0.12, 0.15];
const EXIT_ASKS = [0.4, 0.5];
const MOMENTUMS = [0, 0.005];

type Row = {
  label: string;
  buyAskMax: number;
  exitAsk: number;
  momentum: number;
  pnl: number;
  capitalEnd: number;
  fills: number;
  rejects: number;
  traded: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  ms: number;
};

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-sweep-${Date.now()}.db`);
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
const win15 = all.filter((w) => w.complete && w.eventSlug.includes("-15m-"));
const skipped = all.length - win15.length;
console.error(JSON.stringify({ selected: win15.length, criteria, skipped }, null, 2));
if (win15.length === 0) throw new Error("No 15m windows match criteria");

const leadsWithEdge = leadsWithEdgeFor("early-low", repos);
const rows: Row[] = [];
const totalCombos = BUY_MAXES.length * EXIT_ASKS.length * MOMENTUMS.length;
let comboIdx = 0;

for (const buyAskMax of BUY_MAXES) {
  for (const exitAsk of EXIT_ASKS) {
    for (const momentum of MOMENTUMS) {
      comboIdx++;
      const tag = `buy${buyAskMax}-x${exitAsk}-m${momentum}`;
      process.stderr.write(
        `\n=== ${comboIdx}/${totalCombos} ${tag} ===\n`,
      );
      const config = testConfig({ strategyId: "early-low" });
      const patch = sanitizePatch({
        strategyId: "early-low",
        earlyLowBuyAskMin: 0,
        earlyLowBuyAskMax: buyAskMax,
        earlyLowMaxElapsedSec: 300,
        earlyLowMaxSpread: 0.06,
        earlyLowOrderUsdc: 1,
        earlyLowExitEnabled: true,
        earlyLowExitAsk: exitAsk,
        earlyLowExitMomentumMin: momentum,
        earlyLow15mOnly: true,
        maxSharesPerOrder: 30,
        maxExposureUsdc: 450,
        simulatedCapital: 500,
      });
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (config as Record<string, unknown>)[k] = v;
      }
      config.strategyId = "early-low";
      validateConfigCoherence(config, { leadsWithEdge });

      const t0 = Date.now();
      const result = await runBacktest({
        runId: `earlylow-sweep-${tag}-${Date.now()}`,
        config,
        windows: win15,
        repos,
        hooks: {
          shouldCancel: () => false,
          onProgress: (cur, total) => {
            if (cur === total || cur % 200 === 0) {
              process.stderr.write(`\r${tag} ${cur}/${total}   `);
            }
          },
        },
        skippedIncomplete: skipped,
      });
      process.stderr.write("\n");

      const traded = result.windows.filter(
        (w) => w.pnl !== null && w.tradeCount > 0,
      );
      const pnls = traded.map((w) => w.pnl ?? 0);
      const wins = pnls.filter((p) => p > 0);
      const losses = pnls.filter((p) => p < 0);
      const row: Row = {
        label: tag,
        buyAskMax,
        exitAsk,
        momentum,
        pnl: result.pnl,
        capitalEnd: result.capitalEnd,
        fills: result.fillCount,
        rejects: result.rejectCount,
        traded: traded.length,
        wins: wins.length,
        losses: losses.length,
        winRate:
          wins.length + losses.length > 0
            ? Number(
                ((wins.length / (wins.length + losses.length)) * 100).toFixed(1),
              )
            : null,
        avgWin: wins.length
          ? Number((wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(2))
          : null,
        avgLoss: losses.length
          ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2))
          : null,
        expectancy: pnls.length
          ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(3))
          : null,
        ms: Date.now() - t0,
      };
      rows.push(row);
      console.error(JSON.stringify(row));
    }
  }
}

const ranked = [...rows].sort((a, b) => b.pnl - a.pnl);
const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outDir, `sweep-${stamp}.json`);
const mdPath = join(outDir, `sweep-${stamp}.md`);

const md: string[] = [];
md.push("# Sweep early-low");
md.push("");
md.push(
  `Fenêtres : ${win15.length} (15m, >= ${minTicks} ticks, gap <= ${maxGapMs} ms) — ignorées : ${skipped}`,
);
md.push("");
md.push("| # | Buy max | Exit | Momentum | PnL | Tradées | W/L | Avg W / L | Espérance/trade |");
md.push("|---|---|---|---|---|---|---|---|---|");
for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  md.push(
    `| ${i + 1} | ${r.buyAskMax} | ${r.exitAsk} | ${r.momentum} | $${r.pnl.toFixed(2)} | ${r.traded} | ${r.wins}/${r.losses} (${r.winRate === null ? "n/a" : `${r.winRate}%`}) | ${r.avgWin ?? "n/a"} / ${r.avgLoss ?? "n/a"} | ${r.expectancy ?? "n/a"} |`,
  );
}
md.push("");
md.push(
  `Durée totale : ${Math.round(rows.reduce((a, r) => a + r.ms, 0) / 1000)} s`,
);
md.push("");
md.push(`Budget fixe earlyLowOrderUsdc = 1 $, fenêtre d'entrée 300 s, spread max 0.06.`);

writeFileSync(
  jsonPath,
  JSON.stringify({ criteria, windows: win15.length, skipped, ranked }, null, 2),
);
writeFileSync(mdPath, md.join("\n"));
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