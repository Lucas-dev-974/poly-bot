// R&D phase 2 — combine the phase-1 winners to push WR toward 80%+.
// Phase-1 facts: max780 = free lunch (DD 38.35, PnL/DD 3.46); entries >= 0.72 run
// WR 80-83% (0.70-0.72 bucket is toxic: 68.2%); pausing earlier than 300s is
// value-destructive (the 200-300s entries are among the most profitable).
// Combos swept here, 911 complete BTC 15m windows, S1 sizing, cap20:
//   F: high band cuts x max780 (0.72/0.74/0.76/0.78)
//   G: earlier entry (min150) alone and paired with askMin 0.72
//   H: best-DD variants (askMin 0.76 + max780 + pause 3x12)
// Usage: npx tsx scripts/research/fav-band-audit/wr-phase2.mts
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
import type { BacktestPositionRow } from "../../../src/db/repositories.ts";

const criteria: CompletenessCriteria = { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null };
const CAPITAL = 20;
const SIZING = { favBandOrderUsdc: 4.5, maxSharesPerOrder: 5, maxExposureUsdc: 6, maxOpenPositionsPerSide: 3, simulatedCapital: CAPITAL };

function metrics(result: BacktestResult) {
  const traded = result.windows.filter((w) => w.tradeCount > 0 && w.pnl != null);
  const wins = traded.filter((w) => (w.pnl ?? 0) > 0).length;
  const losses = traded.filter((w) => (w.pnl ?? 0) < 0).length;
  let equity = result.capitalStart;
  let peak = equity;
  let maxDd = 0;
  for (const w of result.windows) {
    if (w.pnl == null) continue;
    equity = Math.round((equity + w.pnl) * 100) / 100;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDd) maxDd = peak - equity;
  }
  return {
    trades: traded.length,
    wins,
    losses,
    wr: traded.length ? Number(((wins / traded.length) * 100).toFixed(2)) : 0,
    pnl: result.pnl,
    maxDd: Number(maxDd.toFixed(2)),
    endEquity: Number(equity.toFixed(2)),
  };
}

const BUCKET_EDGES = [0.68, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82];
function bucketStats(rows: BacktestPositionRow[]) {
  const buckets = new Map<string, { pnl: number; won: number; lost: number; n: number }>();
  for (const r of rows) {
    if (r.side !== "BUY" || r.status === "open") continue;
    const fp = r.fillPrice ?? 0;
    if (fp < BUCKET_EDGES[0] || fp > BUCKET_EDGES[BUCKET_EDGES.length - 1]) continue;
    let label = "";
    for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
      const inBucket = fp >= BUCKET_EDGES[i] && (fp < BUCKET_EDGES[i + 1] || (i === BUCKET_EDGES.length - 2 && fp === BUCKET_EDGES[i + 1]));
      if (inBucket) {
        label = `${BUCKET_EDGES[i].toFixed(2)}-${BUCKET_EDGES[i + 1].toFixed(2)}`;
        break;
      }
    }
    if (!label) continue;
    const b = buckets.get(label) ?? { pnl: 0, won: 0, lost: 0, n: 0 };
    b.pnl = Math.round((b.pnl + (r.pnl ?? 0)) * 100) / 100;
    b.n += 1;
    if ((r.pnl ?? 0) > 0) b.won += 1;
    else if ((r.pnl ?? 0) < 0) b.lost += 1;
    buckets.set(label, b);
  }
  return [...buckets.entries()]
    .map(([bucket, v]) => ({ bucket, n: v.n, wrPct: v.n ? Number(((v.won / v.n) * 100).toFixed(1)) : 0, pnl: v.pnl }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

type Spec = { label: string; overrides: Record<string, unknown> };
const BASE = {
  favBandAskMin: 0.68,
  favBandAskMax: 0.82,
  favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: null,
  favBandInverseEnabled: false,
  favBandWhipsawEnabled: true,
  favBandWhipsawPauseAfterLosses: 3,
  favBandWhipsawPauseWindows: 8,
  favBandExitEnabled: false,
};

const specs: Spec[] = [
  // F — high band x max780
  { label: "F1_askMin0.72_max780", overrides: { favBandAskMin: 0.72, favBandMaxElapsedSec: 780 } },
  { label: "F2_askMin0.74_max780", overrides: { favBandAskMin: 0.74, favBandMaxElapsedSec: 780 } },
  { label: "F3_askMin0.76_max780", overrides: { favBandAskMin: 0.76, favBandMaxElapsedSec: 780 } },
  { label: "F4_askMin0.78_max780", overrides: { favBandAskMin: 0.78, favBandMaxElapsedSec: 780 } },
  { label: "F5_askMin0.78", overrides: { favBandAskMin: 0.78 } },
  // G — earlier entry
  { label: "G1_min150", overrides: { favBandMinElapsedSec: 150 } },
  { label: "G2_min150_askMin0.72", overrides: { favBandMinElapsedSec: 150, favBandAskMin: 0.72 } },
  { label: "G3_min120_askMin0.74", overrides: { favBandMinElapsedSec: 120, favBandAskMin: 0.74 } },
  // H — DD-trim of the best combo
  { label: "H1_askMin0.76_max780_p3x12", overrides: { favBandAskMin: 0.76, favBandMaxElapsedSec: 780, favBandWhipsawPauseWindows: 12 } },
  { label: "H2_askMin0.74_max720", overrides: { favBandAskMin: 0.74, favBandMaxElapsedSec: 720 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-wr2-${Date.now()}.db`);
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
const selected = listBacktestWindows(repos, { prefix: "btc-updown-15m", completeness: criteria }).filter((w) => w.complete);
console.error(JSON.stringify({ selected: selected.length, specs: specs.length }, null, 2));

const rows: Record<string, unknown>[] = [];

for (const spec of specs) {
  const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false, simulatedCapital: CAPITAL });
  const patch = sanitizePatch({ ...basePreset.settings, strategyId: "fav-band", ...SIZING, ...BASE, ...spec.overrides });
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (config as Record<string, unknown>)[k] = v;
  }
  config.dryRun = true;
  config.strategyId = "fav-band";
  config.enableExpensiveHedge = false;
  config.arbAskLockOnly = false;
  const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
  validateConfigCoherence(config, { leadsWithEdge });

  const runId = `fav-wr2-${spec.label}-${Date.now()}`;
  process.stderr.write(`\n=== ${spec.label} ===\n`);
  const t0 = Date.now();
  const result = await runBacktest({
    runId,
    config,
    windows: selected,
    repos,
    hooks: {
      shouldCancel: () => false,
      onProgress: (cur, total) => {
        if (cur === total || cur % 300 === 0) process.stderr.write(`\r${spec.label} ${cur}/${total}   `);
      },
    },
    skippedIncomplete: 0,
  });
  process.stderr.write("\n");
  const m = metrics(result);
  const row = {
    label: spec.label,
    ms: Date.now() - t0,
    ...m,
    pnlPerDd: m.maxDd > 0 ? Number((result.pnl / m.maxDd).toFixed(3)) : result.pnl > 0 ? 999 : 0,
    buckets: bucketStats(repos.backtestPositions.byRun(runId)),
  };
  rows.push(row);
  console.log(JSON.stringify({ label: row.label, trades: row.trades, wr: row.wr, pnl: row.pnl, maxDd: row.maxDd, pnlPerDd: row.pnlPerDd, endEquity: row.endEquity }));
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-wr-phase2-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "WR R&D phase 2 — combos of phase-1 winners (high band x max780 x earlier entry), 911 windows, cap20 sizing.", criteria, capital: CAPITAL, windows: selected.length, rows }, null, 2),
);
console.log(JSON.stringify({ outPath }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}