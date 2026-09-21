// R&D phase 1 — push fav-band S1 win rate from 75.2% toward 80%+.
// Axes swept one at a time from the S1 base (band 0.68-0.82, min200, no max,
// pause 3x8, inverse OFF, sizing 4.5/5sh/expo6/cap20), 909 complete BTC 15m windows:
//   A: favBandAskMin 0.70/0.72/0.74/0.76 (band cut by entry price)
//   B: minElapsed 300/450, + maxElapsed 600/780
//   C: pause variants 2x8 / 4x8 / 3x12 / OFF (isolate pause effect on WR)
//   D: whipsaw maxScore gate 70/60/50 (on top of pause 3x8)
// Also dumps 2-cent WR/PnL buckets per run to pick the optimal band cut.
// Usage: npx tsx scripts/research/fav-band-audit/wr-phase1.mts
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

// 2-cent entry-price buckets: WR + PnL per bucket → marginal band analysis.
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
  { label: "B0_base_S1", overrides: {} },
  // A — band cut by askMin
  { label: "A1_askMin0.70", overrides: { favBandAskMin: 0.7 } },
  { label: "A2_askMin0.72", overrides: { favBandAskMin: 0.72 } },
  { label: "A3_askMin0.74", overrides: { favBandAskMin: 0.74 } },
  { label: "A4_askMin0.76", overrides: { favBandAskMin: 0.76 } },
  // B — timing
  { label: "B1_min300", overrides: { favBandMinElapsedSec: 300 } },
  { label: "B2_min450", overrides: { favBandMinElapsedSec: 450 } },
  { label: "B3_min300_max600", overrides: { favBandMinElapsedSec: 300, favBandMaxElapsedSec: 600 } },
  { label: "B4_min200_max780", overrides: { favBandMaxElapsedSec: 780 } },
  // C — pause variants (C4 isolates the pause effect on WR)
  { label: "C1_pause2x8", overrides: { favBandWhipsawPauseAfterLosses: 2 } },
  { label: "C2_pause4x8", overrides: { favBandWhipsawPauseAfterLosses: 4 } },
  { label: "C3_pause3x12", overrides: { favBandWhipsawPauseWindows: 12 } },
  { label: "C4_pauseOFF", overrides: { favBandWhipsawEnabled: false } },
  // D — whipsaw score gate on top of pause 3x8
  { label: "D1_maxScore70", overrides: { favBandWhipsawMaxScore: 70 } },
  { label: "D2_maxScore60", overrides: { favBandWhipsawMaxScore: 60 } },
  { label: "D3_maxScore50", overrides: { favBandWhipsawMaxScore: 50 } },
];

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-wr1-${Date.now()}.db`);
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
let baseBuckets: unknown = null;

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

  const runId = `fav-wr1-${spec.label}-${Date.now()}`;
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
  if (spec.label === "B0_base_S1") baseBuckets = row.buckets;
}

mkdirSync(join("audits", "backtest", "fav-band"), { recursive: true });
const outPath = join("audits", "backtest", "fav-band", `fav-band-wr-phase1-${Date.now()}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ note: "WR R&D phase 1 — S1 base, one axis at a time (band cut / timing / pause / maxScore), 909 windows, cap20 sizing.", criteria, capital: CAPITAL, windows: selected.length, baseBuckets, rows }, null, 2),
);
console.log(JSON.stringify({ outPath, baseBuckets }, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}