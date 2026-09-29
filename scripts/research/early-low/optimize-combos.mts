/**
 * Phase C' — combos focalisées post-phase AB (optimize.mts).
 * Découvertes AB : l'exit wait-and-see 0.40 détruit de la valeur (hold-pure
 * gagne IS et OOS) ; le stop-loss bid améliore les deux segments ; la fenêtre
 * 150 s est OOS-positive. Combos testées : hold × stop × fenêtre d'entrée.
 *
 *   npx tsx scripts/research/early-low/optimize-combos.mts [minTicks] [maxGapMs] [splitIso]
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

const minTicks = Number(process.argv[2] ?? 500);
const maxGapMs = Number(process.argv[3] ?? 180_000);
const SPLIT_ISO = process.argv[4] ?? "2026-09-23T00:00:00Z";
const splitSec = Math.floor(Date.parse(SPLIT_ISO) / 1000);

const criteria: CompletenessCriteria = { minTicks, maxGapMs, maxEdgeGapMs: null };

const BASE: Record<string, unknown> = {
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
  earlyLowDropEntryPriceMin: 0.15,
  earlyLowDropMin: 0.05,
  earlyLowDropMinElapsedSec: 0,
  earlyLowTrailingEnabled: false,
  earlyLowTrailingOffset: 0.02,
  earlyLowStopLossEnabled: false,
  earlyLowStopLossBidMax: 0.02,
  earlyLowExitMaxElapsedSec: 0,
  maxSharesPerOrder: 30,
  maxExposureUsdc: 450,
  simulatedCapital: 500,
};

interface Variant {
  id: string;
  desc: string;
  ov: Record<string, unknown>;
}

/** hold = exit désactivé ; slN = stop-loss bid ≤ N¢ ; maxN = fenêtre d'entrée. */
const VARIANTS: Variant[] = [
  { id: "ref-base", desc: " référence preset (exit 0.40 actif, pas de stop)", ov: {} },
  { id: "ref-hold", desc: "référence hold-pure (exit off, pas de stop)", ov: { earlyLowExitEnabled: false } },
  { id: "hold-sl2", desc: "hold + stop 0.02", ov: { earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.02 } },
  { id: "hold-sl3", desc: "hold + stop 0.03", ov: { earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.03 } },
  { id: "hold-sl4", desc: "hold + stop 0.04", ov: { earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  { id: "hold-sl6", desc: "hold + stop 0.06", ov: { earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.06 } },
  { id: "hold-sl8", desc: "hold + stop 0.08", ov: { earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.08 } },
  { id: "tpsl-sl4", desc: "exit 0.40 actif + stop 0.04", ov: { earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  { id: "max150-hold", desc: "fenêtre 150 s + hold", ov: { earlyLowMaxElapsedSec: 150, earlyLowExitEnabled: false } },
  { id: "max150-hold-sl4", desc: "fenêtre 150 s + hold + stop 0.04", ov: { earlyLowMaxElapsedSec: 150, earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  { id: "max150-hold-sl6", desc: "fenêtre 150 s + hold + stop 0.06", ov: { earlyLowMaxElapsedSec: 150, earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.06 } },
  { id: "max200-hold-sl4", desc: "fenêtre 200 s + hold + stop 0.04", ov: { earlyLowMaxElapsedSec: 200, earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  { id: "max225-hold-sl4", desc: "fenêtre 225 s + hold + stop 0.04", ov: { earlyLowMaxElapsedSec: 225, earlyLowExitEnabled: false, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
];

interface Stats {
  pnl: number;
  fills: number;
  rejects: number;
  traded: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  maxDD: number;
}

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-c2-${Date.now()}.db`);
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
const isWin = win15.filter((w) => w.windowEnd < splitSec);
const oosWin = win15.filter((w) => w.windowEnd >= splitSec);
console.error(JSON.stringify({ selected: win15.length, inSample: isWin.length, oos: oosWin.length, skipped, splitIso: SPLIT_ISO }, null, 2));
if (isWin.length === 0 || oosWin.length === 0) throw new Error("Split vide");

const leadsWithEdge = leadsWithEdgeFor("early-low", repos);

async function runOne(variantId: string, ov: Record<string, unknown>, windows: BacktestWindowMeta[]): Promise<Stats> {
  const config = testConfig({ strategyId: "early-low" });
  const patch = sanitizePatch({ ...BASE, ...ov });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.strategyId = "early-low";
  validateConfigCoherence(config, { leadsWithEdge });

  const result = await runBacktest({
    runId: `earlylow-c2-${variantId}-${Date.now()}`,
    config,
    windows,
    repos,
    hooks: { shouldCancel: () => false, onProgress: () => {} },
    skippedIncomplete: skipped,
  });

  const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
  const pnls = traded.map((w) => w.pnl ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  let cum = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    cum = Math.round((cum + p) * 100) / 100;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = Math.round((peak - cum) * 100) / 100;
  }
  return {
    pnl: result.pnl,
    fills: result.fillCount,
    rejects: result.rejectCount,
    traded: traded.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length + losses.length > 0
      ? Number(((wins.length / (wins.length + losses.length)) * 100).toFixed(1))
      : null,
    avgWin: wins.length ? Number((wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(2)) : null,
    avgLoss: losses.length ? Number((losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)) : null,
    expectancy: pnls.length ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(3)) : null,
    maxDD,
  };
}

interface Row { id: string; desc: string; is: Stats; oos: Stats }
const rows: Row[] = [];
let i = 0;
for (const v of VARIANTS) {
  i++;
  process.stderr.write(`\n[${i}/${VARIANTS.length}] ${v.id} — IS\n`);
  const stIs = await runOne(v.id, v.ov, isWin);
  process.stderr.write(`[${i}/${VARIANTS.length}] ${v.id} — OOS\n`);
  const stOos = await runOne(v.id, v.ov, oosWin);
  rows.push({ id: v.id, desc: v.desc, is: stIs, oos: stOos });
  console.error(JSON.stringify({ id: v.id, isPnl: stIs.pnl, oosPnl: stOos.pnl, isTraded: stIs.traded, oosTraded: stOos.traded }));
}

const money = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
const num = (v: number | null) => (v === null ? "n/a" : String(v));
const refBase = rows.find((r) => r.id === "ref-base")!;
const refHold = rows.find((r) => r.id === "ref-hold")!;

const md: string[] = [];
md.push("# Optimisation early-low — phase C' (combos)");
md.push("");
md.push(`Fenêtres 15m (≥ ${minTicks} ticks, gap ≤ ${maxGapMs} ms) : **${win15.length}** — IS ${isWin.length} (< ${SPLIT_ISO}) / OOS ${oosWin.length}.`);
md.push(`Références : base IS ${money(refBase.is.pnl)} / OOS ${money(refBase.oos.pnl)} · hold-pure IS ${money(refHold.is.pnl)} / OOS ${money(refHold.oos.pnl)}.`);
md.push("");
md.push("| # | Combo | Description | IS PnL | IS esp. | IS W/L | IS DD | OOS PnL | OOS esp. | OOS W/L | OOS DD | Verdict |");
md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
const ranked = [...rows].filter((r) => r.id !== "ref-base" && r.id !== "ref-hold")
  .sort((a, b) => (b.is.pnl + b.oos.pnl) - (a.is.pnl + a.oos.pnl));
for (let k = 0; k < ranked.length; k++) {
  const r = ranked[k];
  const verdict = r.oos.pnl > refHold.oos.pnl && r.is.pnl > refHold.is.pnl - 1
    ? "MEILLEURE ✓✓"
    : r.oos.pnl > refHold.oos.pnl ? "OOS mieux ✓" : r.is.pnl > refHold.is.pnl ? "IS mieux ✗" : "pire ✗";
  md.push(
    `| ${k + 1} | **${r.id}** | ${r.desc} | ${money(r.is.pnl)} | ${num(r.is.expectancy)} | ${r.is.wins}/${r.is.losses} | ${money(-r.is.maxDD)} | ${money(r.oos.pnl)} | ${num(r.oos.expectancy)} | ${r.oos.wins}/${r.oos.losses} | ${money(-r.oos.maxDD)} | ${verdict} |`,
  );
}

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(outDir, `opt-combos-${stamp}.json`), JSON.stringify({
  criteria, splitIso: SPLIT_ISO, windows: win15.length, skipped, inSample: isWin.length, oos: oosWin.length, rows,
}, null, 2));
writeFileSync(join(outDir, `opt-combos-${stamp}.md`), md.join("\n"));
console.error(`\nJSON: ${join(outDir, `opt-combos-${stamp}.json`)}\nMD:   ${join(outDir, `opt-combos-${stamp}.md`)}`);

try { (db as { close?: () => void }).close?.(); } catch {}
try { rmSync(workDb, { force: true }); } catch {}
for (const suf of ["-wal", "-shm"] as const) {
  if (existsSync(workDb + suf)) { try { rmSync(workDb + suf, { force: true }); } catch {} }
}