/**
 * Audit de couverture des données de snapshots.
 *
 * Critères (par défaut, modifiables en CLI) :
 *   - plus de 800 ticks par fenêtre de marché (>= 801)
 *   - trous max entre ticks <= 1 minute (60 000 ms)
 *
 * Usage :
 *   npx tsx scripts/research/audit/audit-data-coverage.mts [dbPath] [minTicks] [maxGapMs]
 *   ex. npx tsx scripts/research/audit/audit-data-coverage.mts data/bot-live.db 801 60000
 *
 * Sortie : JSON détaillé dans audits/backtest/coverage/audit-data-coverage-<ts>.json
 * + résumé console. Ne modifie pas la base source (copie de travail via VACUUM INTO).
 */
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import {
  EXPECTED_TICKS,
  isCompleteFromStats,
  type CompletenessCriteria,
} from "../../../src/backtest/completeness.ts";
import type { BacktestWindowMeta } from "../../../src/backtest/types.ts";

function parseArgs(argv: string[]) {
  const defaultDb = join("data", "bot-live.db");
  let dbPath = defaultDb;
  let minTicks = 801;
  let maxGapMs = 60_000;
  const p = argv.filter((a) => !a.startsWith("--"));
  if (p[0]) dbPath = p[0];
  if (p[1] && Number.isFinite(Number(p[1]))) minTicks = Math.round(Number(p[1]));
  if (p[2] && Number.isFinite(Number(p[2]))) maxGapMs = Math.round(Number(p[2]));
  return { dbPath, minTicks, maxGapMs };
}

const { dbPath, minTicks, maxGapMs } = parseArgs(process.argv.slice(2));
const criteria: CompletenessCriteria = { minTicks, maxGapMs, maxEdgeGapMs: null };

if (!existsSync(dbPath)) {
  console.error(`Base introuvable: ${dbPath}`);
  process.exit(1);
}

const workDb = join("data", `_audit-data-${Date.now()}.db`);
{
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);

// Toutes les fenêtres avec leurs stats ; on ré-évalue avec nos critères.
const all = listBacktestWindows(repos, {});
const windows = all.map((w) => ({
  ...w,
  complete: isCompleteFromStats(
    { tickCount: w.tickCount, maxGapMs: w.maxGapMs, firstTs: w.firstTs, lastTs: w.lastTs },
    w.windowStart,
    w.windowEnd,
    criteria,
  ),
}));

const total = windows.length;
const selected = windows.filter((w) => w.complete);
const tooFewTicks = windows.filter(
  (w) => !w.complete && w.tickCount < criteria.minTicks!,
).length;
const gapTooBig = windows.filter(
  (w) => !w.complete && w.tickCount >= criteria.minTicks! && w.maxGapMs > criteria.maxGapMs!,
).length;

const dayOf = (ms: number) =>
  new Date(ms).toISOString().slice(0, 10);

const byDay: Record<string, { total: number; complete: number; ticks: number[] }> = {};
const byPrefix: Record<string, { total: number; complete: number }> = {};
for (const w of windows) {
  const day = dayOf(w.windowStart * 1000);
  byDay[day] ??= { total: 0, complete: 0, ticks: [] };
  byDay[day].total++;
  byDay[day].ticks.push(w.tickCount);
  if (w.complete) byDay[day].complete++;

  const m = /^(.*?-updown-\d+m)/.exec(w.eventSlug);
  const prefix = m?.[1] ?? w.eventSlug.split("-").slice(0, 3).join("-");
  byPrefix[prefix] ??= { total: 0, complete: 0 };
  byPrefix[prefix].total++;
  if (w.complete) byPrefix[prefix].complete++;
}

const pct = (n: number, d: number) => (d ? Number(((n / d) * 100).toFixed(1)) : null);
const avg = (xs: number[]) =>
  xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)) : null;

const report = {
  phase: "audit-data-coverage",
  generatedAt: new Date().toISOString(),
  sourceDb: dbPath,
  criteria,
  totals: {
    windows: total,
    complete: selected.length,
    completePct: pct(selected.length, total),
    excluded: total - selected.length,
    tooFewTicks,
    gapTooBig,
  },
  tickStats: {
    expectedPerWindow: EXPECTED_TICKS,
    min: selected.length ? Math.min(...selected.map((w) => w.tickCount)) : null,
    max: selected.length ? Math.max(...selected.map((w) => w.tickCount)) : null,
    avg: avg(selected.map((w) => w.tickCount)),
  },
  gapStats: {
    maxGapMsMax: selected.length ? Math.max(...selected.map((w) => w.maxGapMs)) : null,
    maxGapMsAvg: avg(selected.map((w) => w.maxGapMs)),
    gapCountMax: selected.length ? Math.max(...selected.map((w) => w.gapCount)) : null,
  },
  byDay: Object.entries(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, s]) => ({
      day,
      total: s.total,
      complete: s.complete,
      completePct: pct(s.complete, s.total),
      avgTicks: avg(s.ticks),
    })),
  byPrefix: Object.entries(byPrefix)
    .sort((a, b) => b[1].complete - a[1].complete)
    .map(([prefix, s]) => ({
      prefix,
      total: s.total,
      complete: s.complete,
      completePct: pct(s.complete, s.total),
    })),
  completeWindows: selected.map((w) => ({
    eventSlug: w.eventSlug,
    eventTitle: w.eventTitle,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    tickCount: w.tickCount,
    coveragePct: w.coveragePct,
    maxGapMs: w.maxGapMs,
    gapCount: w.gapCount,
    firstTs: w.firstTs,
    lastTs: w.lastTs,
  })),
};

mkdirSync(join("audits", "backtest", "coverage"), { recursive: true });
const outPath = join("audits", "backtest", "coverage", `audit-data-coverage-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ ...report, outPath }, null, 2));

console.log(
  JSON.stringify(
    {
      phase: "audit-data-coverage",
      sourceDb: dbPath,
      criteria,
      windows: total,
      complete: selected.length,
      completePct: pct(selected.length, total),
      tooFewTicks,
      gapTooBig,
      tickRange:
        selected.length > 0
          ? `${Math.min(...selected.map((w) => w.tickCount))}-${Math.max(...selected.map((w) => w.tickCount))}`
          : null,
      outPath,
    },
    null,
    2,
  ),
);

try {
  (db as { close?: () => void }).close?.();
} catch {
  /* ignore */
}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {
  /* ignore */
}
