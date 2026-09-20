// One-off probe: per-UTC-day PnL attribution for the LIVE fav-band config on the current universe.
import { existsSync, writeFileSync, rmSync } from "node:fs";
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

const presets = listStrategyPresets();
const basePreset = presets.find((p) => p.id === "fav-band");
if (!basePreset) throw new Error("fav-band preset missing");

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-day-${Date.now()}.db`);
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
const selected = listBacktestWindows(repos, {
  completeness: { minTicks: 601, maxGapMs: 60_000, maxEdgeGapMs: null },
}).filter((w) => w.complete);

const config = testConfig({ strategyId: "fav-band", dryRun: true, enableExpensiveHedge: false });
const patch = sanitizePatch({
  ...basePreset.settings,
  strategyId: "fav-band",
  favBandAskMin: 0.6, favBandAskMax: 0.74, favBandMinElapsedSec: 200,
  favBandMaxElapsedSec: 600, favBandOrderUsdc: 15,
  maxSharesPerOrder: 5, maxExposureUsdc: 15,
  favBandInverseEnabled: false,
});
for (const [k, v] of Object.entries(patch)) {
  if (v !== undefined) (config as Record<string, unknown>)[k] = v;
}
config.dryRun = true;
config.strategyId = "fav-band";
config.enableExpensiveHedge = false;
config.arbAskLockOnly = false;

const result = await runBacktest({
  runId: `fav-liveband-day-${Date.now()}`,
  config,
  windows: selected,
  repos,
  hooks: { shouldCancel: () => false, onProgress: () => undefined },
  skippedIncomplete: 0,
});

const byDay = new Map<string, { n: number; pnl: number; wins: number }>();
for (const w of result.windows) {
  if (w.tradeCount === 0 || w.pnl == null) continue;
  const ws = Number(w.eventSlug.match(/-(\d{10})$/)?.[1] ?? 0) * 1000;
  const day = new Date(ws).toISOString().slice(0, 10);
  const b = byDay.get(day) ?? { n: 0, pnl: 0, wins: 0 };
  b.n++;
  b.pnl = Math.round((b.pnl + w.pnl) * 100) / 100;
  if (w.pnl > 0) b.wins++;
  byDay.set(day, b);
}
const rows = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([day, b]) => ({ day, ...b }));
console.log(JSON.stringify(rows, null, 2));
const outPath = join("audits", "backtest", "fav-band", `live-band-perday-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ config: "live band 060-074 sizing 5sh/15exp", rows }, null, 2));

try {
  (db as { close?: () => void }).close?.();
} catch {}
try {
  rmSync(workDb, { force: true });
  for (const suf of ["-wal", "-shm"] as const) {
    if (existsSync(workDb + suf)) rmSync(workDb + suf, { force: true });
  }
} catch {}