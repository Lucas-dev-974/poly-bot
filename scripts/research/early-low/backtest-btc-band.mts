/**
 * Backtest OFFICIEL early-low — univers BTC 15m UNIQUEMENT (btc-updown-15m).
 * READ-ONLY sur data/bot-live.db (VACUUM INTO work copy, supprimée à la fin).
 *
 *   npx tsx scripts/research/early-low/backtest-btc-band.mts [minTicks] [maxGapMs] [cle=valeur ...]
 *
 * Ex bande 0.08 ; 0.10 :
 *   npx tsx scripts/research/early-low/backtest-btc-band.mts 500 180000 earlyLowBuyAskMin=0.08 earlyLowBuyAskMax=0.10
 *
 * Identique a backtest-preset.mts (config/presets/early-low.json + overrides,
 * criteres de completude minTicks/maxGapMs) mais filtre les fenetres sur le
 * prefixe btc-updown-15m : le preset live ne trade que BTC, l'ETH n'etait
 * conserve jusqu'ici que pour triangulation. Overrides passes a argv[4+]
 * (format cle=valeur) taguent la famille de rapport (btc-band-...).
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
// Overrides optionnels argv[4+] au format cle=valeur (ex: earlyLowBuyAskMax=0.10).
const OVERRIDES: Record<string, unknown> = {};
const tagParts: string[] = [];
for (const arg of process.argv.slice(4)) {
  const eq = arg.indexOf("=");
  if (eq <= 0) throw new Error(`override invalide (cle=valeur attendu): ${arg}`);
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

// Preset actuel = config testee. Toute cle non reconnue par sanitizePatch est
// signalee (config drift detection) au lieu d'etre appliquee en silence.
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
const workDb = join("data", `_earlylow-btc-bt-${Date.now()}.db`);
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

// fenetres 15m BTC uniquement (early-low est 15m-only ; univers preset = BTC).
const all = listBacktestWindows(repos, { completeness: criteria });
const win15btc = all.filter(
  (w) => w.complete && w.eventSlug.startsWith("btc-updown-15m-"),
);
const win15eth = all.filter(
  (w) => w.complete && w.eventSlug.startsWith("eth-updown-15m-"),
);
const other = all.length - (win15btc.length + win15eth.length); // non-15m ou prefixe inattendu
const skipped = all.length - win15btc.length;
console.error(
  JSON.stringify(
    {
      selected: win15btc.length,
      eth15mExcluded: win15eth.length,
      otherExcluded: other,
      criteria,
      skipped: skipped,
    },
    null,
    2,
  ),
);
if (win15btc.length === 0) throw new Error("No BTC 15m windows match criteria");

const config = testConfig({ strategyId: "early-low" });
const patch = sanitizePatch({ ...presetSettings, ...OVERRIDES });
if (Object.keys(OVERRIDES).length > 0) {
  console.error(`Overrides preset: ${JSON.stringify(OVERRIDES)}`);
}
const dropped = Object.keys(presetSettings).filter(
  (k) => (patch as Record<string, unknown>)[k] === undefined && presetSettings[k] !== null,
);
if (dropped.length > 0) {
  console.error(`\u26a0 cles preset ignorees par sanitizePatch: ${dropped.join(", ")}`);
}
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.strategyId = "early-low";

const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
validateConfigCoherence(config, { leadsWithEdge });

const runId = `earlylow-btc-band-${Date.now()}`;
const t0 = Date.now();
const result = await runBacktest({
  runId,
  config,
  windows: win15btc,
  repos,
  hooks: {
    shouldCancel: () => false,
    onProgress: (cur, total) => {
      if (cur === total || cur % 100 === 0) {
        process.stderr.write(`\rearly-low-btc ${cur}/${total}   `);
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

// Profit factor sur fenetres tradees.
const grossWin = traded.reduce((s, w) => s + Math.max(0, w.pnl ?? 0), 0);
const grossLoss = traded.reduce((s, w) => s + Math.max(0, -(w.pnl ?? 0)), 0);
const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null;

// fenetres BTC tradees depuis le 2026-09-29 (re-scan recent).
const recent = traded.filter(
  (w) =>
    new Date(Number(w.eventSlug.split("-").pop()) * 1000).toISOString().slice(0, 10) >=
    "2026-09-29",
);
const recentWins = recent.filter((w) => (w.pnl ?? 0) > 0).length;
const recentLosses = recent.filter((w) => (w.pnl ?? 0) < 0).length;
const recentPnl = Math.round(recent.reduce((s, w) => s + (w.pnl ?? 0), 0) * 100) / 100;

const sorted = [...traded].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
const topWins = sorted.slice(0, 5).map((w) => ({ eventSlug: w.eventSlug, pnl: w.pnl }));
const topLosses = sorted.slice(-5).reverse().map((w) => ({ eventSlug: w.eventSlug, pnl: w.pnl }));

const outDir = join("audits", "backtest", "early-low");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(outDir, `btc-band-${overrideTag}${stamp}.json`);
const mdPath = join(outDir, `btc-band-${overrideTag}${stamp}.md`);

const summary = {
  label: `early-low BTC 15m only (preset actuel + overrides ${tagParts.join(", ") || "aucun"})`,
  strategyId: "early-low",
  universe: "btc-updown-15m (BTC 15m uniquement)",
  presetPath,
  criteria,
  windows: win15btc.length,
  skippedIncomplete: skipped,
  eth15mExcluded: win15eth.length,
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
  profitFactor,
  recentSince: "2026-09-29",
  recentPnl,
  recentWins,
  recentLosses,
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
md.push("# Backtest officiel early-low — BTC 15m uniquement");
md.push("");
if (Object.keys(OVERRIDES).length > 0) {
  md.push(
    `**Overrides preset :** \`${Object.entries(OVERRIDES).map(([k, v]) => `${k}=${v}`).join(", ")}\``,
  );
  md.push("");
}
md.push(
  `Execution : npx tsx scripts/research/early-low/backtest-btc-band.mts ${minTicks} ${maxGapMs} ${tagParts.join(" ")}`.trim(),
);
md.push("");
md.push(
  "Univers = fenetres \`btc-updown-15m\` uniquement (ETH 15m exclu, il ne fait pas partie du preset live).",
);
md.push("");
md.push("| Metrique | Valeur |");
md.push("|---|---|");
md.push(`| fenetres BTC testees | ${win15btc.length} (15m, >= ${minTicks} ticks, gap <= ${maxGapMs / 1000} s) |`);
md.push(`| fenetres ignorees | ${skipped} (dont ETH 15m : ${win15eth.length}, autres : ${other}) |`);
md.push(`| PnL total | ${money(result.pnl)} |`);
md.push(`| Capital | $${result.capitalStart} -> $${result.capitalEnd} |`);
md.push(`| Fills / rejects | ${result.fillCount} / ${result.rejectCount} |`);
md.push(`| Wins / losses (fenetres) | ${wins} / ${losses} -> WR ${summary.winRate ?? "n/a"} % |`);
md.push(`| Profit factor | ${profitFactor ?? "\u221e (aucune perte)"} |`);
md.push(`| PnL depuis 09-29 | ${money(recentPnl)} (${recentWins}/${recentLosses}) |`);
md.push(`| fenetres non resolues | ${result.unresolvedWindows} |`);
md.push(`| Duree | ${((Date.now() - t0) / 1000).toFixed(1)} s |`);
md.push("");
md.push("## PnL par jour UTC");
md.push("");
md.push("| Jour | PnL | fenetres tradees | W/L |");
md.push("|---|---:|---:|---|");
for (const d of dayRows) {
  md.push(`| ${d.day} | ${money(d.pnl)} | ${d.tradedWindows} | ${d.wins}/${d.losses} |`);
}
md.push("");
md.push(`> **${dayRows.filter((d) => d.pnl > 0).length}/${dayRows.length} jours positifs.**`);
md.push("");
md.push("## Top 5 gains / pertes (fenetres)");
md.push("");
md.push("| # | Gains | | Pertes | |");
md.push("|---|---|---:|---|---:|");
for (let i = 0; i < 5; i++) {
  const w = topWins[i];
  const l = topLosses[i];
  md.push(
    `| ${i + 1} | \`${w?.eventSlug ?? "\u2014"}\` | ${w ? money(w.pnl ?? 0) : "\u2014"} | \`${l?.eventSlug ?? "\u2014"}\` | ${l ? money(l.pnl ?? 0) : "\u2014"} |`,
  );
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
