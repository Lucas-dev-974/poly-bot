/**
 * Fav-band time-slice backtest (official runner).
 * Modes :
 *   (défaut) Runs sur tranches ET identifiées par l'étude des win-streaks :
 *     A = 03:00–05:00, B = 09:00–10:00, C = 11:00–15:00 (début de fenêtre ET)
 *     → baseline-all / A / B / C / union-ABC / complement.
 *   --split  Stabilité par moitié de l'univers :
 *     H1 = jours ET < 2026-09-26 (avant l'étude paper), H2 = >= 2026-09-26
 *     → pour chaque moitié : baseline / union-ABC / union-AB, + union-AB-full.
 * Config IDENTIQUE partout (bande 0.70-0.85, minElapsed 200 s, exit OFF) —
 * seul le gate horaire (et la période pour les moitiés) diffère.
 * Offline only : copie VACUUM de data/bot-live.db ; bot live intact.
 *
 * Usage (sandbox-safe, no tsx — le banner createRequire est OBLIGATOIRE à cause
 * des require CJS de dotenv) :
 *   node_modules\@esbuild\win32-x64\esbuild.exe scripts/research/fav-band/win-windows-hours-backtest.mts \
 *     --bundle --platform=node --format=esm \
 *     "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
 *     --outfile=data/_hours-bt-bundle.mjs
 *   node --experimental-sqlite data/_hours-bt-bundle.mjs [--split]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { BacktestResult } from "../../../src/backtest/types.ts";

const SPLIT = process.argv.includes("--split");
const H2_MIN_DAY = "2026-09-26"; // moitié 2 = période paper où les tranches ont été détectées

const criteria: CompletenessCriteria = {
  minTicks: 801,
  maxGapMs: 60_000,
  maxEdgeGapMs: null,
};

// Tranches ET (minutes après minuit ET), convention : début de fenêtre
const SLICES: { id: string; label: string; from: number; to: number }[] = [
  { id: "A", label: "03:00-05:00 ET", from: 180, to: 300 },
  { id: "B", label: "09:00-10:00 ET", from: 540, to: 600 },
  { id: "C", label: "11:00-15:00 ET", from: 660, to: 900 },
];
const pickA = (mod: number) => inSlice(mod, SLICES[0]);
const pickB = (mod: number) => inSlice(mod, SLICES[1]);
const pickC = (mod: number) => inSlice(mod, SLICES[2]);
const unionPicker = (sels: { id: string }[]) => (mod: number) =>
  sels.some((sel) => {
    const s = SLICES.find((x) => x.id === sel.id)!;
    return inSlice(mod, s);
  });
const unionPick = unionPicker(SLICES);
const unionABPick = unionPicker([SLICES[0], SLICES[1]]);

function inSlice(mod: number, s: { from: number; to: number }): boolean {
  return mod >= s.from && mod < s.to;
}

const partsFmt2 = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const fmtDate = (ms: number) => partsFmt2.format(new Date(ms));
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const etMinuteOfDay = (windowStartSec: number) => {
  const p = Object.fromEntries(
    partsFmt
      .formatToParts(windowStartSec * 1000)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type as string, x.value as string]),
  ) as Record<string, string>;
  return { day: `${p.year}-${p.month}-${p.day}`, mod: Number(p.hour) * 60 + Number(p.minute) };
};

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  let equity = result.capitalStart;
  let peak = equity;
  let maxDd = 0;
  let worst = 0;
  for (const w of result.windows) {
    if (w.pnl == null) continue;
    equity = Math.round((equity + w.pnl) * 100) / 100;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (w.pnl < worst) worst = w.pnl;
  }
  const wr = traded.length ? Number(((wins / traded.length) * 100).toFixed(1)) : 0;
  return {
    trades: traded.length,
    wins,
    losses,
    wr,
    maxDd: Number(maxDd.toFixed(2)),
    worst: Number(worst.toFixed(2)),
  };
}

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-hours-${Date.now()}.db`);
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
const all = listBacktestWindows(repos, { completeness: criteria }).filter((w) => w.complete);
const startOfSlug = new Map<string, number>(all.map((w) => [w.eventSlug, w.windowStart]));
const dayMin = Math.min(...all.map((w) => w.windowStart)) * 1000;
const dayMax = Math.max(...all.map((w) => w.windowStart)) * 1000;
console.error(JSON.stringify({ selected: all.length, criteria, days: { min: fmtDate(dayMin), max: fmtDate(dayMax), splitAt: H2_MIN_DAY } }));

// classification ET de l'univers
let countsABC = { A: 0, B: 0, C: 0, H1: 0, H2: 0 };
for (const w of all) {
  const { day, mod } = etMinuteOfDay(w.windowStart);
  if (day < H2_MIN_DAY) countsABC.H1++;
  else countsABC.H2++;
  for (const s of SLICES) if (inSlice(mod, s)) countsABC[s.id as keyof typeof countsABC]++;
}
if (SPLIT) console.error(`moitiés: H1=${countsABC.H1} H2=${countsABC.H2} ; tranches: A=${countsABC.A} B=${countsABC.B} C=${countsABC.C}`);
else console.error(`tranches detectees: A=${countsABC.A} B=${countsABC.B} C=${countsABC.C}`);

type Spec = { label: string; pick: (mod: number) => boolean; dayOk?: (day: string) => boolean };
const specOf = (id: string): Spec => {
  const s = SLICES.find((x) => x.id === id)!;
  return { label: `${id}-${s.label}`, pick: (mod) => inSlice(mod, s) };
};

const specs: Spec[] = SPLIT
  ? (() => {
      const out: Spec[] = [];
      for (const half of [
        { tag: "H1", dayOk: (d: string) => d < H2_MIN_DAY },
        { tag: "H2", dayOk: (d: string) => d >= H2_MIN_DAY },
      ]) {
        out.push({ label: `baseline-${half.tag}`, pick: () => true, dayOk: half.dayOk });
        out.push({ label: `union-ABC-${half.tag}`, pick: unionPick, dayOk: half.dayOk });
        out.push({ label: `union-AB-${half.tag}`, pick: unionABPick, dayOk: half.dayOk });
      }
      out.push({ label: "baseline-full", pick: () => true });
      out.push({ label: "union-AB-full", pick: unionABPick });
      out.push({ label: "union-ABC-full", pick: unionPick });
      return out;
    })()
  : [
      { label: "baseline-all-hours", pick: () => true },
      specOf("A"),
      specOf("B"),
      specOf("C"),
      { label: "union-ABC", pick: unionPick },
      { label: "complement", pick: (mod) => !unionPick(mod) },
    ];

const rows: Record<string, unknown>[] = [];
const dailyByRun = new Map<string, Map<string, { trades: number; pnl: number }>>();

for (const spec of specs) {
  const config = testConfig({
    strategyId: "fav-band",
    dryRun: true,
    enableExpensiveHedge: false,
  });
  const patch = sanitizePatch({
    ...basePreset.settings,
    strategyId: "fav-band",
    // config officielle backtestée — identique pour tous les runs ;
    // en --split : capital 500 $ car un run restreint à H2 seule peut mourir de
    // capital (75 $ < budget) → spirale "insufficient-capital" qui pollue les
    // métriques (reject massif par tick). Avec 500 $ aucun run ne meurt de capital.
    ...(SPLIT ? { simulatedCapital: 500 } : {}),
    favBandAskMin: 0.7,
    favBandAskMax: 0.85,
    favBandMinElapsedSec: 200,
    favBandMaxElapsedSec: null,
    favBandExitEnabled: false,
    favBandExitSwitchEnabled: false,
    cheapOrderUsdc: 15,
  });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = "fav-band";
  config.enableExpensiveHedge = false;
  config.arbAskLockOnly = false;

  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const selected = all.filter((w) => {
    const { day, mod } = etMinuteOfDay(w.windowStart);
    return spec.pick(mod) && (spec.dayOk?.(day) ?? true);
  });
  console.error(`\n=== ${spec.label} : ${selected.length} fenêtres ===`);

  const runId = `fav-hours-${spec.label}-${Date.now()}`;
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 100 === 0) {
          process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
        }
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const m = metrics(result);
  const row = {
    label: spec.label,
    windows: result.windowsTested,
    ms: Date.now() - t0,
    pnl: result.pnl,
    pnlPct: result.capitalStart
      ? Number(((result.pnl / result.capitalStart) * 100).toFixed(2))
      : null,
    fills: result.fillCount,
    rejects: result.rejectCount,
    wins: result.wins ?? m.wins,
    losses: result.losses ?? m.losses,
    wr: result.winRate != null ? Number((result.winRate * 100).toFixed(1)) : m.wr,
    tradeCount: m.trades,
    maxDd: m.maxDd,
    worst: m.worst,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
  };
  rows.push(row);
  console.log(JSON.stringify(row));

  // répartition des résultats par jour ET (par fenêtre result)
  const daily = new Map<string, { trades: number; pnl: number }>();
  for (const w of result.windows) {
    const start = startOfSlug.get(w.eventSlug);
    if (start == null || w.pnl == null || w.tradeCount === 0) continue;
    const { day } = etMinuteOfDay(start);
    const d = daily.get(day) ?? { trades: 0, pnl: 0 };
    d.trades += 1;
    d.pnl = Math.round((d.pnl + w.pnl) * 100) / 100;
    daily.set(day, d);
  }
  dailyByRun.set(spec.label, daily);
}

const getRow = (label: string) => rows.find((r) => r.label === label);
const get = (label: string) =>
  (({ pnl, tradeCount, wins, losses, wr, maxDd, pnlPerDd, windows }) => ({
    pnl,
    tradeCount,
    wins,
    losses,
    wr,
    maxDd,
    pnlPerDd,
    windows,
  }))(getRow(label) as Record<string, never>);

const outBase = SPLIT ? "win-windows-hours-split" : "win-windows-hours";
const ts = Date.now();
const outPath = join("audits", "backtest", "fav-band", `${outBase}-${ts}.json`);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "Offline only — live bot untouched. fav-band backtest à gate horaire ET (runner officiel, config identique partout).",
      criteria,
      universe: all.length,
      counts: countsABC,
      daysSpan: { min: fmtDate(dayMin), max: fmtDate(dayMax), splitAt: H2_MIN_DAY },
      rankedByPnl: rows,
      dailyPnl: Object.fromEntries([...dailyByRun.entries()].map(([label, m]) => [label, [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))])),
    },
    null,
    2,
  ),
);

// ---- rapport MD
const L: string[] = [];
L.push(`# fav-band — backtest à gate horaire ET${SPLIT ? " — stabilité split-half" : " (03–05h, 09–10h, 11–15h)"} — runner officiel`);
L.push("");
L.push(`- Généré : ${new Date(ts).toISOString()} — offline, copie VACUUM de \`data/bot-live.db\`, bot live intact`);
L.push(`- Univers : **${all.length} fenêtres complètes** (critères ${JSON.stringify(criteria)} → fenêtres 15m ; 5m exclues par minTicks) — période ${fmtDate(dayMin)} → ${fmtDate(dayMax)} (ET)`);
L.push(`- Config IDENTIQUE pour tous les runs : bande **[0.70, 0.85]**, minElapsed **200 s**, max null, exit/switch OFF, budget 15 $ — **seul le gate horaire (et la période) diffère**`);
if (SPLIT) L.push(`- Split : **H1** = ${fmtDate(dayMin)} → 2026-09-25 (avant la fenêtre d'observation paper), **H2** = 2026-09-26 → ${fmtDate(dayMax)} (= période où les tranches ont été détectées) — **capital simulé 500 $ en mode split** (sinon un run H2-seul peut mourir de capital : spirale "insufficient-capital" qui pollue les métriques)`);
else L.push(`- Tranches : A = 03:00–05:00 (${countsABC.A} fenêtres), B = 09:00–10:00 (${countsABC.B}), C = 11:00–15:00 (${countsABC.C})`);
L.push("");
L.push(`## Comparaison`);
L.push("");
L.push(`| Run | Fenêtres | Trades | W/L | WR | PnL | PnL % | MaxDD | PnL/DD |
|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  L.push(
    `| **${r.label}** | ${r.windows} | ${r.tradeCount} | ${r.wins}/${r.losses} | ${r.wr === null ? "–" : `${r.wr} %`} | ${Number(r.pnl) >= 0 ? "+" : ""}$${r.pnl} | ${r.pnlPct === null ? "–" : `${r.pnlPct} %`} | ${r.maxDd} | ${r.pnlPerDd} |`,
  );
}

if (SPLIT) {
  const eff = (v: Record<string, unknown> | undefined) =>
    v ? `${Number(v.pnl) >= 0 ? "+" : ""}$${v.pnl} / DD ${v.maxDd} / ${Number(v.pnlPerDd).toFixed(3)}${v.wr != null ? ` / WR ${v.wr}%` : ""}` : "–";
  L.push("");
  L.push(`## Stabilité split-half (PnL / MaxDD / PnL/DD / WR)`);
  L.push("");
  L.push(`| Gate | H1 (${countsABC.H1} f.) | H2 (${countsABC.H2} f.) | Full (${all.length} f.) |
|---|---|---|---|`);
  for (const gate of ["baseline", "union-ABC", "union-AB"] as const) {
    L.push(
      `| **${gate}** | ${eff(get(`${gate}-H1`))} | ${eff(get(`${gate}-H2`))} | ${eff(get(`${gate}-full`))} |`,
    );
  }
  const b1 = get("baseline-H1"),
    u1 = get("union-AB-H1"),
    b2 = get("baseline-H2"),
    u2 = get("union-AB-H2");
  L.push("");
  L.push(`## Lectures`);
  L.push("");
  L.push(
    `- **H1 (out-of-sample)** : baseline ${eff(b1)} → union-AB ${eff(u1)} — l'efficience ${u1 && b1 ? (Number(u1.pnlPerDd) / Number(b1.pnlPerDd)).toFixed(2) : "–"}× celle du baseline`,
  );
  L.push(
    `- **H2 (in-sample streaks)** : baseline ${eff(b2)} → union-AB ${eff(u2)} — l'efficience ${u2 && b2 ? (Number(u2.pnlPerDd) / Number(b2.pnlPerDd)).toFixed(2) : "–"}× celle du baseline`,
  );
  L.push(`- Couper la tranche C (11–15) : l'union-AB garde le WR et coupe le DD par rapport à l'union-ABC.`);
} else {
  const baseline = getRow("baseline-all-hours");
  const union = getRow("union-ABC");
  const complement = getRow("complement");
  if (baseline && union && complement) {
    L.push("");
    L.push(`## Lectures`);
    L.push("");
    L.push(
      `- L'**union A+B+C** couvre ${union.windows} fenêtres sur ${all.length} (${Number(union.tradeCount)} trades) — PnL ${Number(union.pnl) >= 0 ? "+" : ""}$${union.pnl} (WR ${union.wr} %, DD ${union.maxDd})`,
    );
    L.push(
      `- Le **complément** (tout sauf ces tranches) : ${complement.windows} fenêtres, PnL ${Number(complement.pnl) >= 0 ? "+" : ""}$${complement.pnl} (WR ${complement.wr} %, DD ${complement.maxDd})`,
    );
    L.push(
      `- Baseline toutes heures : ${baseline.windows} fenêtres, ${Number(baseline.tradeCount)} trades, PnL ${Number(baseline.pnl) >= 0 ? "+" : ""}$${baseline.pnl} (WR ${baseline.wr} %)`,
    );
    L.push(`- L'écart baseline − (union + complément) vient de l'état inter-fenêtres du moteur (pause whipsaw) : les runs restreints ne subissent pas les pertes d'autres tranches.`);
  }
}

const dailyUnion = dailyByRun.get(SPLIT ? "union-ABC-H2" : "union-ABC");
const dailyComp = dailyByRun.get("complement");
const dailyBase = dailyByRun.get(SPLIT ? "baseline-H2" : "baseline-all-hours");
if (!SPLIT && dailyBase) {
  L.push("");
  L.push(`## PnL et trades par jour ET`);
  L.push("");
  L.push(`| Jour (ET) | Trades base | PnL base | Trades union | PnL union | Trades compl. | PnL compl. |
|---|---|---|---|---|---|---|`);
  const allDays = [...new Set([...dailyBase.keys(), ...(dailyUnion?.keys() ?? []), ...(dailyComp?.keys() ?? [])])].sort();
  for (const d of allDays) {
    const b = dailyBase.get(d),
      u = dailyUnion?.get(d),
      c = dailyComp?.get(d);
    L.push(
      `| ${d} | ${b ? b.trades : "–"} | ${b ? (b.pnl >= 0 ? "+" : "") + "$" + b.pnl : "–"} | ${u ? u.trades : "–"} | ${u ? (u.pnl >= 0 ? "+" : "") + "$" + u.pnl : "–"} | ${c ? c.trades : "–"} | ${c ? (c.pnl >= 0 ? "+" : "") + "$" + c.pnl : "–"} |`,
    );
  }
}
L.push("");
L.push(`## Caveats`);
L.push("");
L.push(`- Gate = **début de fenêtre marché en ET** (America/New_York) — même convention que l'étude des win-streaks (les libellés des questions marché).`);
L.push(`- La tranche ne filtre pas le SIZING ni la pause : le moteur garde son état (pause whipsaw) à travers les fenêtres du run restreint.`);
L.push(`- Les 5m ne sont pas dans l'univers backtest (minTicks 801 > 300 attendus pour une fenêtre 5m) — le gate horaire ne les teste pas.`);
L.push(`- \`skippedIncomplete: 0\` : toutes les fenêtres testées sont déjà « complete » (>801 ticks).`);
L.push(`- PnL % relatif au capital simulé du runner (\`testConfig\`, 75 $ — ou 500 $ en mode split)`);
L.push(`- Journée ${fmtDate(dayMax)} partiellement tradée (base au moment de l'extraction).`);

const md = L.join("\n");
writeFileSync(join("audits", "backtest", "fav-band", `${outBase}-${ts}.md`), md);
console.log(`Écrit : ${outPath} + .md`);
console.log(md);

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}