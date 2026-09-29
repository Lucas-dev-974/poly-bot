/**
 * Robustesse multi-split de la config early-low proposée.
 * Compare la config PRESET (exit 0.40 actif) et la config PROPOSÉE
 * (hold + stop 0.04 + fenêtre 150 s) sur plusieurs splits temporels
 * pour vérifier que le gain n'est pas un artefact d'un seul split.
 *
 *   npx tsx scripts/research/early-low/robustness.mts [minTicks] [maxGapMs]
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import type { CompletenessCriteria } from "../../../src/backtest/completeness.ts";
import type { BacktestWindowMeta } from "../../../src/backtest/types.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";

const minTicks = 500;
const maxGapMs = 180_000;

const PRESET: Record<string, unknown> = {
  strategyId: "early-low",
  earlyLowBuyAskMin: 0,
  earlyLowBuyAskMax: 0.12,
  earlyLowMaxElapsedSec: 300,
  earlyLowMaxSpread: 0.06,
  earlyLowOrderUsdc: 1,
  earlyLowExitEnabled: true,
  earlyLowExitAsk: 0.4,
  earlyLowExitMomentumMin: 0,
  earlyLow15mOnly: true,
  earlyLowDropEntryEnabled: false,
  earlyLowTrailingEnabled: false,
  earlyLowStopLossEnabled: false,
  earlyLowExitMaxElapsedSec: 0,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
};

/** Candidates : hold intégral + fenêtre d'entrée resserrée ± stop. */
const PROPOSED: Array<{ id: string; ov: Record<string, unknown> }> = [
  { id: "prop150-hold", ov: { ...PRESET, earlyLowExitEnabled: false, earlyLowMaxElapsedSec: 150 } },
  { id: "prop150-hold-sl4", ov: { ...PRESET, earlyLowExitEnabled: false, earlyLowMaxElapsedSec: 150, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  { id: "prop120-hold", ov: { ...PRESET, earlyLowExitEnabled: false, earlyLowMaxElapsedSec: 120 } },
  { id: "prop180-hold", ov: { ...PRESET, earlyLowExitEnabled: false, earlyLowMaxElapsedSec: 180 } },
];

const SPLITS = [
  "2026-09-21T00:00:00Z",
  "2026-09-23T00:00:00Z",
  "2026-09-24T00:00:00Z",
  "2026-09-25T00:00:00Z",
];

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-rb-${Date.now()}.db`);
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
const leadsWithEdge = leadsWithEdgeFor("early-low", repos);
const criteria: CompletenessCriteria = { minTicks, maxGapMs, maxEdgeGapMs: null };
const all = listBacktestWindows(repos, { completeness: criteria });
const win15 = all.filter((w) => w.complete && w.eventSlug.includes("-15m-"));
console.error(JSON.stringify({ total15m: win15.length, minTicks, maxGapMs }));

async function runOne(
  label: string,
  ov: Record<string, unknown>,
  windows: BacktestWindowMeta[],
): Promise<{ pnl: number; traded: number; wr: number | null }> {
  const config = testConfig({ strategyId: "early-low" });
  const patch = sanitizePatch(ov);
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.strategyId = "early-low";
  validateConfigCoherence(config, { leadsWithEdge });

  const result = await runBacktest({
    runId: `earlylow-rb-${label}-${Date.now()}`,
    config,
    windows,
    repos,
    hooks: { shouldCancel: () => false, onProgress: () => {} },
    skippedIncomplete: 0,
  });
  const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
  const pnls = traded.map((w) => w.pnl ?? 0);
  const winsN = pnls.filter((p) => p > 0).length;
  const lossesN = pnls.filter((p) => p < 0).length;
  return {
    pnl: result.pnl,
    traded: traded.length,
    wr: winsN + lossesN > 0 ? Number(((winsN / (winsN + lossesN)) * 100).toFixed(1)) : null,
  };
}

interface ResRow {
  split: string;
  label: string;
  beforeWindows: number;
  afterWindows: number;
  pnlBefore: number;
  pnlAfter: number;
  tradedBefore: number;
  tradedAfter: number;
  wrBefore: number | null;
  wrAfter: number | null;
}

const results: ResRow[] = [];
for (const split of SPLITS) {
  const splitSec = Math.floor(Date.parse(split) / 1000);
  const before = win15.filter((w) => w.windowEnd < splitSec);
  const after = win15.filter((w) => w.windowEnd >= splitSec);
  if (before.length < 50 || after.length < 50) {
    console.error(`split ${split} trop déséquilibré, skip`);
    continue;
  }
  for (const candidate of [ { id: "preset", ov: PRESET }, ...PROPOSED.map((p) => ({ id: p.id, ov: { ...PRESET, ...p.ov } })) ]) {
    const rB = await runOne(`${candidate.id}-pre`, candidate.ov, before);
    const rA = await runOne(`${candidate.id}-post`, candidate.ov, after);
    results.push({
      split, label: candidate.id,
      beforeWindows: before.length, afterWindows: after.length,
      pnlBefore: rB.pnl, pnlAfter: rA.pnl,
      tradedBefore: rB.traded, tradedAfter: rA.traded,
      wrBefore: rB.wr, wrAfter: rA.wr,
    });
    console.error(JSON.stringify(results[results.length - 1]));
  }
}

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const md: string[] = [];
md.push("# Robustesse multi-split early-low");
md.push("");
md.push(`Critères : 15m, ≥ ${minTicks} ticks, gap ≤ ${maxGapMs} ms — ${win15.length} fenêtres.`);
md.push(`Config proposée : hold intégral (exit off) + stop-loss bid ≤ 0.04 + entrée ≤ 150 s. Preset : exit 0.40 actif, entrée 300 s.`);
md.push("");
md.push("| Split | Config | PnL avant | PnL après | Trades av/ap | WR av/ap |");
md.push("|---|---|---|---|---|---|");
for (const r of results) {
  md.push(
    `| ${r.split.slice(0, 10)} | ${r.label} | ${r.pnlBefore >= 0 ? "+" : ""}$${r.pnlBefore.toFixed(2)} | ${r.pnlAfter >= 0 ? "+" : ""}$${r.pnlAfter.toFixed(2)} | ${r.tradedBefore}/${r.tradedAfter} | ${r.wrBefore ?? "n/a"} / ${r.wrAfter ?? "n/a"} |`,
  );
}

writeFileSync(join(outDir, `robustness-${stamp}.json`), JSON.stringify(results, null, 2));
writeFileSync(join(outDir, `robustness-${stamp}.md`), md.join("\n"));
console.error(`\nJSON: ${join(outDir, `robustness-${stamp}.json`)}\nMD:   ${join(outDir, `robustness-${stamp}.md`)}`);

try { (db as { close?: () => void }).close?.(); } catch {}
try { rmSync(workDb, { force: true }); } catch {}
for (const suf of ["-wal", "-shm"] as const) {
  if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
}