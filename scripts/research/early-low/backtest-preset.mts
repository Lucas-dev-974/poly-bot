/**
 * Backtest OFFICIEL early-low — config = PRESET ACTUEL (config/presets/early-low.json).
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/early-low/backtest-preset.mts [minTicks] [maxGapMs]
 *
 * Contrairement à backtest-official.mts (qui embarque une ancienne config hard-codée
 * 300 s / exit 0.50), ce run applique TEL QUEL le preset early-low hold + 150 s + 12¢
 * de sorte que chaque mise à jour du preset se reteste avec la même commande.
 *
 * Sélection : fenêtres 15m (early-low est 15m-only), >= minTicks ticks (défaut 500,
 * critères de l'optimisation 2026-09-29), gap <= maxGapMs, résolution enregistrée.
 * Rapport JSON + MD dans audits/backtest/early-low/ (famille `current-`).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

const minTicks = Number(process.argv[2] ?? 500);
const maxGapMs = Number(process.argv[3] ?? 180_000);
// Overrides optionnels argv[4+] au format clé=valeur (ex: earlyLowBuyAskMax=0.10).
// Taguent la famille de rapport (earlyMax0.10-...) pour distinguer les runs.
const OVERRIDES: Record<string, unknown> = {};
const tagParts: string[] = [];
for (const arg of process.argv.slice(4)) {
  const eq = arg.indexOf("=");
  if (eq <= 0) throw new Error(`override invalide (clé=valeur attendu): ${arg}`);
  const key = arg.slice(0, eq);
  const raw = arg.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw; // string brute (ex: slug)
  }
  OVERRIDES[key] = value;
  tagParts.push(`${key}=${raw}`);
}
const overrideTag = tagParts.length > 0 ? tagParts.join("+").replace(/[:.]/g, "-") + "-" : "";

const criteria: CompletenessCriteria = {
  minTicks,
  maxGapMs,
  maxEdgeGapMs: null,
} as const;

// Preset actuel = config testée. Toute clé non reconnue par sanitizePatch est
// signalée (config drift detection) au lieu d'être appliquée en silence.
const presetPath = join("config", "presets", "early-low.json");
const preset = JSON.parse(readFileSync(presetPath, "utf8")) as {
  settings: Record<string, unknown>;
};
const presetSettings = preset.settings;

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
const all = listBacktestWindows(repos, { completeness: criteria });
const win15 = all.filter((w) => w.complete && w.eventSlug.includes("-15m-"));
const skipped = all.length - win15.length;
console.error(
  JSON.stringify({ selected: win15.length, criteria, skipped }, null, 2),
);
if (win15.length === 0) throw new Error("No 15m windows match criteria");

const config = testConfig({ strategyId: "early-low" });
const patch = sanitizePatch({ ...presetSettings, ...OVERRIDES });
if (Object.keys(OVERRIDES).length > 0) {
  console.error(`Overrides preset: ${JSON.stringify(OVERRIDES)}`);
}
const dropped = Object.keys(presetSettings).filter(
  (k) => (patch as Record<string, unknown>)[k] === undefined && presetSettings[k] !== null,
);
if (dropped.length > 0) {
  console.error(`⚠ clés preset ignorées par sanitizePatch: ${dropped.join(", ")}`);
}
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.strategyId = "early-low";

const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `earlylow-preset-${Date.now()}`;
const t0 = Date.now();
const result = await runBacktest({
  runId,
  config,
  windows: win15,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 100 === 0) {
        process.stderr.write(`\rearly-low-preset ${cur}/${total}   `);
      }
    },
  },
  skippedIncomplete: skipped,
});
process.stderr.write("\n");

const traded = result.windows.filter((w) => w.pnl !== null && w.tradeCount > 0);
const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;

// Attribution PnL par jour UTC (slug : dernier suffixe = windowStart epoch-sec).
interface DayRow {
  day: string;
  pnl: number;
  tradedWindows: number;
  wins: number;
  losses: number;
}
const perDay = new Map<string, DayRow>();
for (const w of traded) {
  const ws = Number(w.eventSlug.split("-").pop());
  const day = new Date(ws * 1000).toISOString().slice(0, 10);
  const row = perDay.get(day) ?? { day, pnl: 0, tradedWindows: 0, wins: 0, losses: 0 };
  row.pnl = Math.round((row.pnl + (w.pnl ?? 0)) * 100) / 100;
  row.tradedWindows += 1;
  if ((w.pnl ?? 0) > 0) row.wins += 1;
  else if ((w.pnl ?? 0) < 0) row.losses += 1;
  perDay.set(day, row);
}
const dayRows = [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day));

const sorted = [...traded].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
const topWins = sorted.slice(0, 5).map((w) => ({ eventSlug: w.eventSlug, pnl: w.pnl }));
const topLosses = sorted.slice(-5).reverse().map((w) => ({ eventSlug: w.eventSlug, pnl: w.pnl }));

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outDir, `current-${overrideTag}${stamp}.json`);
const mdPath = join(outDir, `current-${overrideTag}${stamp}.md`);

const summary = {
  label:
    OVERRIDES.earlyLowBuyAskMax !== undefined
      ? `early-low (preset actuel + override earlyLowBuyAskMax=${OVERRIDES.earlyLowBuyAskMax})`
      : "early-low (preset actuel, hold intégral)",
  strategyId: "early-low",
  presetPath,
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
  wins,
  losses,
  winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : null,
  tradedWindows: traded.length,
  dayRows,
  topWins,
  topLosses,
  windowResults: traded.map((w) => ({
    eventSlug: w.eventSlug,
    pnl: w.pnl,
    tradeCount: w.tradeCount,
    unresolved: w.unresolved,
  })),
};
writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

const money = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
const md: string[] = [];
md.push("# Backtest officiel early-low — preset actuel (hold intégral)");
md.push("");
if (Object.keys(OVERRIDES).length > 0) {
  md.push(`**Overrides preset :** \`${Object.entries(OVERRIDES).map(([k, v]) => `${k}=${v}`).join(", ")}\``);
  md.push("");
}
md.push(
  `Exécution : npx tsx scripts/research/early-low/backtest-preset.mts ${minTicks} ${maxGapMs}`,
);
md.push("");
md.push(`Config = \`config/presets/early-low.json\` tel que lu au moment du run :`);
md.push("");
md.push("| Métrique | Valeur |");
md.push("|---|---|");
md.push(`| Fenêtres testées | ${win15.length} (15m, ≥ ${minTicks} ticks, gap ≤ ${maxGapMs / 1000} s) |`);
md.push(`| Fenêtres ignorées | ${skipped} |`);
md.push(`| PnL total | ${money(result.pnl)} |`);
md.push(`| Capital | $${result.capitalStart} → $${result.capitalEnd} |`);
md.push(`| Fills / rejects | ${result.fillCount} / ${result.rejectCount} |`);
md.push(`| Wins / losses (fenêtres) | ${wins} / ${losses} → WR ${summary.winRate ?? "n/a"} % |`);
md.push(`| Fenêtres non résolues | ${result.unresolvedWindows} |`);
md.push(`| Durée | ${((Date.now() - t0) / 1000).toFixed(1)} s |`);
md.push("");
md.push("## PnL par jour UTC");
md.push("");
md.push("| Jour | PnL | Fenêtres tradées | W/L |");
md.push("|---|---:|---:|---|");
for (const d of dayRows) {
  md.push(`| ${d.day} | ${money(d.pnl)} | ${d.tradedWindows} | ${d.wins}/${d.losses} |`);
}
md.push("");
md.push(`> **${dayRows.filter((d) => d.pnl > 0).length}/${dayRows.length} jours positifs.**`);
md.push("");
md.push("## Top 5 gains / pertes (fenêtres)");
md.push("");
md.push("| # | Gains | | Pertes | |");
md.push("|---|---|---:|---|---:|");
for (let i = 0; i < 5; i++) {
  const w = topWins[i];
  const l = topLosses[i];
  md.push(`| ${i + 1} | \`${w?.eventSlug ?? "—"}\` | ${w ? money(w.pnl ?? 0) : "—"} | \`${l?.eventSlug ?? "—"}\` | ${l ? money(l.pnl ?? 0) : "—"} |`);
}
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