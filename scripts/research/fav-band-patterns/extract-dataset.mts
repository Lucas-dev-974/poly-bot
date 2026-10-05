/**
 * Extract fav-band win/loss dataset with book-derived features.
 *
 * Primary source: live resolved positions in data/bot-live.db (strategyId=fav-band).
 * Cap50 JSON (audits/backtest/fav-band/fav-band-opt-cap50-*.json) is summary-only
 * (no per-position rows) â€” documented in META of the output.
 *
 * Optional: --include-backtest-run=<runId> pulls backtest_positions for that run.
 *
 * Usage (repo root):
 *   npx tsx scripts/research/fav-band-patterns/extract-dataset.mts
 *   npx tsx scripts/research/fav-band-patterns/extract-dataset.mts --include-backtest-run=259af8b2-1bd0-4285-ab42-fb5b6fb00ee0
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractFeatures,
  type FeatureRow,
  type PositionInput,
  type TickPoint,
} from "./features.mts";

const OUT_DIR = join("audits", "backtest", "fav-band", "patterns");
const DB_PATH = join("data", "bot-live.db");
const CAP50_GLOB_PREFIX = "fav-band-opt-cap50-";

function parseArgs(argv: string[]) {
  const out: { includeBacktestRun: string | null; db: string } = {
    includeBacktestRun: null,
    db: DB_PATH,
  };
  for (const a of argv) {
    if (a.startsWith("--include-backtest-run=")) out.includeBacktestRun = a.slice("--include-backtest-run=".length);
    else if (a.startsWith("--db=")) out.db = a.slice("--db=".length);
  }
  return out;
}

function findLatestCap50Summary(): { path: string; summary: Record<string, unknown> } | null {
  const dir = join("audits", "backtest", "fav-band");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(CAP50_GLOB_PREFIX) && f.endsWith(".json") && !f.includes("settings"))
    .map((f) => join(dir, f));
  if (!files.length) return null;
  files.sort();
  const path = files[files.length - 1];
  const summary = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { path, summary };
}

function loadLivePositions(db: DatabaseSync): PositionInput[] {
  const rows = db
    .prepare(
      `SELECT id, eventSlug, outcome, outcomeIndex, fillPrice, bestAskAtFill, size, cost, pnl,
              status, createdAt, resolvedAt, windowEnd, sellPrice
       FROM positions
       WHERE strategyId = 'fav-band' AND status IN ('won','lost','sold')
       ORDER BY createdAt ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    source: "live" as const,
    eventSlug: String(r.eventSlug),
    outcome: String(r.outcome ?? ""),
    outcomeIndex: r.outcomeIndex == null ? null : Number(r.outcomeIndex),
    fillPrice: r.fillPrice == null ? null : Number(r.fillPrice),
    bestAskAtFill: r.bestAskAtFill == null ? null : Number(r.bestAskAtFill),
    size: r.size == null ? null : Number(r.size),
    cost: r.cost == null ? null : Number(r.cost),
    pnl: r.pnl == null ? null : Number(r.pnl),
    status: String(r.status),
    createdAt: Number(r.createdAt),
    resolvedAt: r.resolvedAt == null ? null : Number(r.resolvedAt),
    windowEnd: r.windowEnd == null ? null : Number(r.windowEnd),
    sellPrice: r.sellPrice == null ? null : Number(r.sellPrice),
  }));
}

function loadBacktestPositions(db: DatabaseSync, runId: string): PositionInput[] {
  const rows = db
    .prepare(
      `SELECT id, runId, ts, eventSlug, outcome, outcomeIndex, fillPrice, bestAskAtFill, size, cost, pnl,
              status, resolvedAt, windowEnd, sellPrice
       FROM backtest_positions
       WHERE runId = ? AND status IN ('won','lost','sold')
       ORDER BY ts ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: `bt:${r.id}`,
    source: "backtest" as const,
    eventSlug: String(r.eventSlug),
    outcome: String(r.outcome ?? ""),
    outcomeIndex: r.outcomeIndex == null ? null : Number(r.outcomeIndex),
    fillPrice: r.fillPrice == null ? null : Number(r.fillPrice),
    bestAskAtFill: r.bestAskAtFill == null ? null : Number(r.bestAskAtFill),
    size: r.size == null ? null : Number(r.size),
    cost: r.cost == null ? null : Number(r.cost),
    pnl: r.pnl == null ? null : Number(r.pnl),
    status: String(r.status),
    createdAt: Number(r.ts),
    resolvedAt: r.resolvedAt == null ? null : Number(r.resolvedAt),
    windowEnd: r.windowEnd == null ? null : Number(r.windowEnd),
    sellPrice: r.sellPrice == null ? null : Number(r.sellPrice),
    runId: String(r.runId),
  }));
}

function loadTicks(db: DatabaseSync, eventSlug: string): TickPoint[] {
  const rows = db
    .prepare(
      `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize
       FROM book_snapshots WHERE eventSlug = ? ORDER BY ts ASC`,
    )
    .all(eventSlug) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ts: Number(r.ts),
    outcomeIndex: Number(r.outcomeIndex),
    bestAsk: r.bestAsk == null ? null : Number(r.bestAsk),
    bestBid: r.bestBid == null ? null : Number(r.bestBid),
    bestAskSize: r.bestAskSize == null ? null : Number(r.bestAskSize),
  }));
}

function toCsv(rows: FeatureRow[]): string {
  const keys = [
    "id","source","label","status","eventSlug","outcome","outcomeIndex","pnl","fillPrice","bestAskAtFill",
    "elapsedSec","remainingSec","entryAsk","entryBid","entrySpread","entryAskSize","otherAskAtEntry","favMarginAtEntry",
    "ticksBefore","ticksAfter","flipsBefore","flipsAfter","askRangeBefore","askRangeAfter",
    "pathDelta30s","pathDelta60s","pathDelta120s","maeAsk","mfeAsk","favShareBefore","favShareAfter",
    "lowerLowsAfter","timeToResolveSec","coverageOk","coverageNote",
  ] as const;
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [keys.join(",")];
  for (const r of rows) {
    lines.push(keys.map((k) => esc((r as Record<string, unknown>)[k])).join(","));
  }
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.db)) throw new Error(`DB missing: ${args.db}`);

mkdirSync(OUT_DIR, { recursive: true });
const db = new DatabaseSync(args.db, { readOnly: true });

const live = loadLivePositions(db);
const backtest = args.includeBacktestRun ? loadBacktestPositions(db, args.includeBacktestRun) : [];
const positions = [...live, ...backtest];
process.stderr.write(`positions live=${live.length} backtest=${backtest.length} total=${positions.length}\n`);

const tickCache = new Map<string, TickPoint[]>();
const features: FeatureRow[] = [];
let i = 0;
for (const pos of positions) {
  i++;
  if (i % 50 === 0 || i === positions.length) process.stderr.write(`\rextract ${i}/${positions.length}   `);
  let ticks = tickCache.get(pos.eventSlug);
  if (!ticks) {
    ticks = loadTicks(db, pos.eventSlug);
    tickCache.set(pos.eventSlug, ticks);
  }
  features.push(extractFeatures(pos, ticks));
}
process.stderr.write("\n");
db.close();

const wins = features.filter((f) => f.label === "win");
const losses = features.filter((f) => f.label === "loss");
const flats = features.filter((f) => f.label === "flat");
const covered = features.filter((f) => f.coverageOk);

const cap50 = findLatestCap50Summary();
const stamp = Date.now();
const meta = {
  generatedAt: new Date().toISOString(),
  dbPath: args.db,
  sources: {
    live: {
      table: "positions",
      filter: "strategyId='fav-band' AND status IN ('won','lost','sold')",
      count: live.length,
    },
    backtest: args.includeBacktestRun
      ? { runId: args.includeBacktestRun, count: backtest.length }
      : null,
    cap50Json: cap50
      ? {
          path: cap50.path,
          note: "Summary-only audit (pnl/trades/wr). No per-position rows â€” cannot join ticks from this file alone.",
          row: (cap50.summary as { row?: unknown }).row ?? null,
          windowsComplete: (cap50.summary as { windowsComplete?: unknown }).windowsComplete ?? null,
        }
      : null,
  },
  counts: {
    total: features.length,
    win: wins.length,
    loss: losses.length,
    flat: flats.length,
    coverageOk: covered.length,
    coveragePartial: features.length - covered.length,
  },
  tickCacheSlugs: tickCache.size,
};

const datasetPath = join(OUT_DIR, `dataset-fav-band-patterns-${stamp}.json`);
const csvPath = join(OUT_DIR, `dataset-fav-band-patterns-${stamp}.csv`);
const latestJson = join(OUT_DIR, "dataset-latest.json");
const latestCsv = join(OUT_DIR, "dataset-latest.csv");
const metaPath = join(OUT_DIR, "dataset-meta-latest.json");

const payload = { meta, rows: features };
writeFileSync(datasetPath, JSON.stringify(payload));
writeFileSync(latestJson, JSON.stringify(payload));
const csv = toCsv(features);
writeFileSync(csvPath, csv);
writeFileSync(latestCsv, csv);
writeFileSync(metaPath, JSON.stringify(meta, null, 2));

console.log(
  JSON.stringify(
    {
      datasetPath,
      csvPath,
      latestJson,
      metaPath,
      counts: meta.counts,
      cap50Path: cap50?.path ?? null,
    },
    null,
    2,
  ),
);
