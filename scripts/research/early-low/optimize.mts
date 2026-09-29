/**
 * Optimisation early-low — phases A/B/C sur le runner officiel.
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/early-low/optimize.mts [minTicks] [maxGapMs] [splitIso]
 *
 * Phase A/B : 18 variantes "single" (grid prix + nouvelles règlesentrée/exit)
 * testées sur 2 segments : in-sample (fenêtres finissant avant splitIso) et
 * out-of-sample (après). Phase C : combos des top-k singles in-sample, la
 * meilleure combo est validée out-of-sample.
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
import type { BacktestWindowMeta } from "../../../src/backtest/types.ts";
import { testConfig } from "../../../tests/helpers.ts";
import { sanitizePatch } from "../../../src/runtime-settings.ts";
import { validateConfigCoherence } from "../../../src/config.ts";
import { leadsWithEdgeFor } from "../../../src/strategy/registry.ts";

const minTicks = Number(process.argv[2] ?? 750);
const maxGapMs = Number(process.argv[3] ?? 120_000);
const SPLIT_ISO = process.argv[4] ?? "2026-09-23T00:00:00Z";
const splitSec = Math.floor(Date.parse(SPLIT_ISO) / 1000);
if (!Number.isFinite(splitSec)) throw new Error(`split ISO invalide: ${SPLIT_ISO}`);

const criteria: CompletenessCriteria = {
  minTicks,
  maxGapMs,
  maxEdgeGapMs: null,
};

/** Base = preset actuel (config choisie par le sweep 2026-09-29) + knobs OPT off. */
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
  family: "base" | "grid" | "exit" | "entry";
  desc: string;
  ov: Record<string, unknown>;
}

/** Phase A/B : variantes "single". */
const SINGLES: Variant[] = [
  { id: "base", family: "base", desc: "Preset actuel 0.12/0.40/mom 0 (référence)", ov: {} },
  // Phase A — grid prix jamais balayée.
  { id: "x035", family: "grid", desc: "Seuil exit 0.35 (plus précoce)", ov: { earlyLowExitAsk: 0.35 } },
  { id: "x045", family: "grid", desc: "Seuil exit 0.45 (plus tardif)", ov: { earlyLowExitAsk: 0.45 } },
  { id: "max450", family: "grid", desc: "Fenêtre d'entrée 450 s", ov: { earlyLowMaxElapsedSec: 450 } },
  { id: "max150", family: "grid", desc: "Fenêtre d'entrée 150 s (plus sélectif)", ov: { earlyLowMaxElapsedSec: 150 } },
  { id: "min08", family: "grid", desc: "Bande d'achat [0.08, 0.12)", ov: { earlyLowBuyAskMin: 0.08 } },
  { id: "min10", family: "grid", desc: "Bande d'achat [0.10, 0.12) — anti tickets quasi-morts", ov: { earlyLowBuyAskMin: 0.1 } },
  // Phase B exit — trailing (tolérance de repli depuis chaque plus-haut).
  { id: "t1", family: "exit", desc: "Trailing offset 0.01 (tolère 1¢ de repli)", ov: { earlyLowTrailingEnabled: true, earlyLowTrailingOffset: 0.01 } },
  { id: "t2", family: "exit", desc: "Trailing offset 0.02", ov: { earlyLowTrailingEnabled: true, earlyLowTrailingOffset: 0.02 } },
  { id: "t3", family: "exit", desc: "Trailing offset 0.03", ov: { earlyLowTrailingEnabled: true, earlyLowTrailingOffset: 0.03 } },
  // Phase B exit — stop-loss sur le bid (coupe avant expiration à 0).
  { id: "sl2", family: "exit", desc: "Stop-loss bid ≤ 0.02", ov: { earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.02 } },
  { id: "sl4", family: "exit", desc: "Stop-loss bid ≤ 0.04", ov: { earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.04 } },
  // Phase B exit — deadline d'observation.
  { id: "dl840", family: "exit", desc: "Deadline exit 840 s (dernière minute : armé → vend)", ov: { earlyLowExitMaxElapsedSec: 840 } },
  { id: "hold-pure", family: "exit", desc: "Exit désactivé — hold intégral", ov: { earlyLowExitEnabled: false } },
  // Phase B entry — drop confirmé (référence haute récente + chute).
  { id: "drop-r18d5", family: "entry", desc: "Entrée drop confirmé : réf ≥ 0.18 il y a ≥ 0 s, drop ≥ 0.05", ov: { earlyLowDropEntryEnabled: true, earlyLowDropEntryPriceMin: 0.18, earlyLowDropMin: 0.05, earlyLowDropMinElapsedSec: 0 } },
  { id: "drop-r20d7", family: "entry", desc: "Entrée drop confirmé : réf ≥ 0.20, drop ≥ 0.07", ov: { earlyLowDropEntryEnabled: true, earlyLowDropEntryPriceMin: 0.2, earlyLowDropMin: 0.07, earlyLowDropMinElapsedSec: 0 } },
  { id: "drop-r22d8", family: "entry", desc: "Entrée drop confirmé : réf ≥ 0.22, drop ≥ 0.08", ov: { earlyLowDropEntryEnabled: true, earlyLowDropEntryPriceMin: 0.22, earlyLowDropMin: 0.08, earlyLowDropMinElapsedSec: 0 } },
  // Phase B entry — liquidité.
  { id: "sp04", family: "entry", desc: "Spread max 0.04", ov: { earlyLowMaxSpread: 0.04 } },
  { id: "sp03", family: "entry", desc: "Spread max 0.03", ov: { earlyLowMaxSpread: 0.03 } },
];

interface Stats {
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
  maxDD: number;
  ms: number;
}

const srcDb = join("data", "bot-live.db");
if (!existsSync(srcDb)) {
  console.error(`base source introuvable: ${srcDb}`);
  process.exit(1);
}
const workDb = join("data", `_earlylow-opt-${Date.now()}.db`);
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
console.error(
  JSON.stringify(
    { selected: win15.length, inSample: isWin.length, oos: oosWin.length, skipped, splitIso: SPLIT_ISO, criteria },
    null, 2,
  ),
);
if (isWin.length === 0 || oosWin.length === 0) throw new Error("Split vide : réduire minTicks ou ajuster le split");

const leadsWithEdge = leadsWithEdgeFor("early-low", repos);

async function runOne(
  variantId: string,
  ov: Record<string, unknown>,
  windows: BacktestWindowMeta[],
): Promise<Stats> {
  const config = testConfig({ strategyId: "early-low" });
  const patch = sanitizePatch({ ...BASE, ...ov });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.strategyId = "early-low";
  validateConfigCoherence(config, { leadsWithEdge });

  const t0 = Date.now();
  const result = await runBacktest({
    runId: `earlylow-opt-${variantId}-${Date.now()}`,
    config,
    windows,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: () => {},
    },
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
    capitalEnd: result.capitalEnd,
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
    ms: Date.now() - t0,
  };
}

// ---------------- Phase A/B : singles sur IS + OOS ----------------
interface VariantRow {
  id: string;
  family: Variant["family"];
  desc: string;
  is: Stats;
  oos: Stats;
}

const rows: VariantRow[] = [];
let idx = 0;
for (const v of SINGLES) {
  idx++;
  process.stderr.write(`\n[${idx}/${SINGLES.length}] ${v.id} — IS (${isWin.length} fen.)\n`);
  const stIs = await runOne(v.id, v.ov, isWin);
  process.stderr.write(`[${idx}/${SINGLES.length}] ${v.id} — OOS (${oosWin.length} fen.)\n`);
  const stOos = await runOne(v.id, v.ov, oosWin);
  rows.push({ id: v.id, family: v.family, desc: v.desc, is: stIs, oos: stOos });
  process.stderr.write(
    JSON.stringify({ id: v.id, isPnl: stIs.pnl, oosPnl: stOos.pnl, isTraded: stIs.traded, oosTraded: stOos.traded }) + "\n",
  );
}

// ---------------- Phase C : combos des top-3 in-sample ----------------
const baseRow = rows.find((r) => r.id === "base")!;
const improvers = rows
  .filter((r) => r.id !== "base" && r.is.pnl > baseRow.is.pnl)
  .sort((a, b) => b.is.pnl - a.is.pnl);
const top3 = improvers.slice(0, 3);

const comboSpecs: Array<{ id: string; ov: Record<string, unknown>; from: string[] }> = [];
if (top3.length >= 2) {
  for (let i = 0; i < top3.length; i++) {
    for (let j = i + 1; j < top3.length; j++) {
      comboSpecs.push({
        id: `combo:${top3[i].id}+${top3[j].id}`,
        ov: { ...top3[i].ov, ...top3[j].ov },
        from: [top3[i].id, top3[j].id],
      });
    }
  }
  comboSpecs.push({
    id: `combo:${top3.map((t) => t.id).join("+")}`,
    ov: Object.assign({}, ...top3.map((t) => t.ov)),
    from: top3.map((t) => t.id),
  });
}

const comboRows: Array<VariantRow & { from: string[] }> = [];
for (const c of comboSpecs) {
  process.stderr.write(`\n[combo] ${c.id} — IS\n`);
  const stIs = await runOne(c.id, c.ov, isWin);
  comboRows.push({
    id: c.id, family: "exit", desc: `Combo ${c.from.join(" + ")}`, is: stIs,
    oos: { pnl: 0, capitalEnd: 0, fills: 0, rejects: 0, traded: 0, wins: 0, losses: 0, winRate: null, avgWin: null, avgLoss: null, expectancy: null, maxDD: 0, ms: 0 },
    from: c.from,
  });
  process.stderr.write(JSON.stringify({ id: c.id, isPnl: stIs.pnl, isTraded: stIs.traded }) + "\n");
}

// Meilleure combo (IS) → validation OOS.
const bestCombo = [...comboRows].sort((a, b) => b.is.pnl - a.is.pnl)[0];
if (bestCombo) {
  const spec = comboSpecs.find((c) => c.id === bestCombo.id)!;
  process.stderr.write(`\n[combo] ${bestCombo.id} — OOS\n`);
  const stOos = await runOne(bestCombo.id, spec.ov, oosWin);
  bestCombo.oos = stOos;
  process.stderr.write(JSON.stringify({ id: bestCombo.id, oosPnl: stOos.pnl, oosTraded: stOos.traded }) + "\n");
}

// ---------------- Rapport ----------------
const money = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
const num = (v: number | null) => (v === null ? "n/a" : String(v));
const verdict = (r: VariantRow) => {
  const beatIs = r.is.pnl > baseRow.is.pnl;
  const beatOos = r.oos.pnl >= baseRow.oos.pnl;
  return beatIs && beatOos ? "GARDER ✓" : beatIs ? "IS seulement ✗" : "Pire ✗";
};

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const md: string[] = [];
md.push("# Optimisation early-low (phases A/B/C)");
md.push("");
md.push(`Fenêtres 15m (≥ ${minTicks} ticks, gap ≤ ${maxGapMs} ms) : **${win15.length}** — ignorées : ${skipped}.`);
md.push(`Split : in-sample = fenêtres finissant avant **${SPLIT_ISO}** (${isWin.length}), out-of-sample après (${oosWin.length}).`);
md.push(`Base commune : bande [buyMin, buyMax 0.12], entrée ≤ 300 s, spread ≤ 0.06, budget 1 $, exit 0.40 / momentum 0. Knobs OPT off sauf variante.`);
md.push("");
md.push("## Référence base");
md.push("");
md.push(`base — IS ${money(baseRow.is.pnl)} (esp ${num(baseRow.is.expectancy)}) · OOS ${money(baseRow.oos.pnl)} (esp ${num(baseRow.oos.expectancy)}) · DD ${money(-baseRow.is.maxDD)} / ${money(-baseRow.oos.maxDD)}`);
md.push("");
md.push("## Phase A/B — variantes simples (triées par gain cumulé IS+OOS vs base)");
md.push("");
md.push("| # | Variante | Famille | IS PnL | IS esp. | IS W/L | OOS PnL | OOS esp. | OOS W/L | Verdict |");
md.push("|---|---|---|---|---|---|---|---|---|---|");
const ranked = [...rows].sort((a, b) => (b.is.pnl + b.oos.pnl) - (a.is.pnl + a.oos.pnl));
for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  md.push(
    `| ${i + 1} | **${r.id}** | ${r.family} | ${money(r.is.pnl)} | ${num(r.is.expectancy)} | ${r.is.wins}/${r.is.losses} | ${money(r.oos.pnl)} | ${num(r.oos.expectancy)} | ${r.oos.wins}/${r.oos.losses} | ${r.id === "base" ? "référence" : verdict(r)} |`,
  );
}
if (comboRows.length > 0) {
  md.push("");
  md.push("## Phase C — combos (top-3 in-sample)");
  md.push("");
  md.push("| Combo | IS PnL | IS esp. | IS W/L | OOS PnL | OOS esp. | OOS W/L | Validée |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const c of [...comboRows].sort((a, b) => b.is.pnl - a.is.pnl)) {
    md.push(
      `| ${c.id} | ${money(c.is.pnl)} | ${num(c.is.expectancy)} | ${c.is.wins}/${c.is.losses} | ${money(c.oos.pnl)} | ${num(c.oos.expectancy)} | ${c.oos.wins}/${c.oos.losses} | ${c.oos.ms > 0 ? (c.oos.pnl >= baseRow.oos.pnl ? "OUI" : "non") : "—"} |`,
    );
  }
}
md.push("");
md.push("## Détail des stats");
md.push("");
for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
  md.push(
    `- **${r.id}** (${r.family}) ${r.desc} — IS: fills ${r.is.fills} rejects ${r.is.rejects} DD ${money(-r.is.maxDD)} avgW/L ${num(r.is.avgWin)}/${num(r.is.avgLoss)} · OOS: fills ${r.oos.fills} rejects ${r.oos.rejects} DD ${money(-r.oos.maxDD)} avgW/L ${num(r.oos.avgWin)}/${num(r.oos.avgLoss)}`,
  );
}

writeFileSync(join(outDir, `opt-${stamp}.json`), JSON.stringify({
  criteria, splitIso: SPLIT_ISO, windows: win15.length, skipped, inSample: isWin.length, oos: oosWin.length,
  singles: rows, combos: comboRows,
}, null, 2));
writeFileSync(join(outDir, `opt-${stamp}.md`), md.join("\n"));
console.error(`\nJSON: ${join(outDir, `opt-${stamp}.json`)}\nMD:   ${join(outDir, `opt-${stamp}.md`)}`);

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}