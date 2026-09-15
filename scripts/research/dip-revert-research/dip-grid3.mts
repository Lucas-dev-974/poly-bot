/**
 * Dip-revert entry-axis grid v3 — READ-ONLY on data/bot-live.db.
 *
 * Axes NOT covered by the 2026-09-14 v1/v2 sweeps (those covered exits,
 * minRebound/bounce, vol floor/cap, trend filter, maxElapsed deadline):
 *   maxSpread, lookbackMs, minElapsedSec, minDrop, bandMin/bandMax.
 * Base = official base config (band 0.55-0.65, drop 0.03, lookback 60s,
 * minElapsed 180, maxSpread 0.04). Live runs bandMax=0.63 — included as a row.
 *
 * Each row reports total + per-UTC-day PnL/WR so a "winner" concentrated on
 * one market regime is visible immediately.
 *
 * Run: npx tsx scripts/research/dip-revert-research/dip-grid3.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";

type Axis = { name: string; params: Partial<SimParams> };

const axes: Axis[] = [
  { name: "base", params: {} },
  // --- maxSpread (base 0.04) ---
  { name: "spread-0.03", params: { maxSpread: 0.03 } },
  { name: "spread-0.05", params: { maxSpread: 0.05 } },
  { name: "spread-0.06", params: { maxSpread: 0.06 } },
  { name: "spread-0.08", params: { maxSpread: 0.08 } },
  // --- lookback (base 60s) ---
  { name: "lookback-45s", params: { lookbackMs: 45_000 } },
  { name: "lookback-75s", params: { lookbackMs: 75_000 } },
  { name: "lookback-90s", params: { lookbackMs: 90_000 } },
  { name: "lookback-120s", params: { lookbackMs: 120_000 } },
  // --- minElapsed (base 180s) ---
  { name: "elapsed-120", params: { minElapsedSec: 120 } },
  { name: "elapsed-150", params: { minElapsedSec: 150 } },
  { name: "elapsed-210", params: { minElapsedSec: 210 } },
  { name: "elapsed-240", params: { minElapsedSec: 240 } },
  // --- minDrop (base 0.03) ---
  { name: "drop-0.025", params: { minDrop: 0.025 } },
  { name: "drop-0.035", params: { minDrop: 0.035 } },
  { name: "drop-0.04", params: { minDrop: 0.04 } },
  { name: "drop-0.05", params: { minDrop: 0.05 } },
  // --- band (base 0.55-0.65; live 0.55-0.63) ---
  { name: "band-0.55-0.63-live", params: { bandMax: 0.63 } },
  { name: "band-min-0.58", params: { bandMin: 0.58 } },
  { name: "band-max-0.68", params: { bandMax: 0.68 } },
  { name: "band-max-0.70", params: { bandMax: 0.70 } },
  { name: "band-min-0.52", params: { bandMin: 0.52 } },
];

// UTC day of a window from its slug (windowStart epoch sec is the last token).
const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);

const u = loadUniverse();
const days = [...new Set([...u.slugs.keys()].map(dayOf))].sort();

interface Row {
  name: string;
  fills: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  maxDrawdown: number;
  byDay: Record<string, { fills: number; pnl: number; wins: number; losses: number }>;
}

const rows: Row[] = [];
for (const axis of axes) {
  const P: SimParams = { ...BASE, ...axis.params };
  const byDay: Row["byDay"] = {};
  for (const d of days) byDay[d] = { fills: 0, pnl: 0, wins: 0, losses: 0 };
  const r = runSim(u, P, {
    slugFilter: (slug) => {
      const d = dayOf(slug);
      // attribute fills/pnl per day via a side-channel: run per-day sims
      return true;
    },
  });
  // per-day attribution: re-run per day (cheap enough, universe in memory)
  for (const d of days) {
    const rd = runSim(u, P, { slugFilter: (slug) => dayOf(slug) === d });
    byDay[d] = {
      fills: rd.fills,
      pnl: rd.pnl,
      wins: rd.wins,
      losses: rd.losses,
    };
  }
  rows.push({
    name: axis.name,
    fills: r.fills,
    wins: r.wins,
    losses: r.losses,
    winRate: r.winRate,
    pnl: r.pnl,
    maxDrawdown: r.maxDrawdown,
    byDay,
  });
  process.stderr.write(`${axis.name}: fills=${r.fills} wr=${r.winRate} pnl=${r.pnl}\n`);
}

const baseRow = rows.find((x) => x.name === "base")!;
const delta = (p: number) => Math.round((p - baseRow.pnl) * 100) / 100;

const outDir = join("audits", "backtest", "dip-revert");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `dip-grid3-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ base: baseRow, rows }, null, 2));

// compact console table ranked by pnl
const ranked = [...rows].sort((a, b) => b.pnl - a.pnl);
for (const r of ranked) {
  const dayStr = days
    .map((d) => `${d.slice(5)}:${r.byDay[d]?.pnl ?? 0}`)
    .join(" ");
  console.log(
    `${r.name.padEnd(22)} fills=${String(r.fills).padStart(3)} wr=${String(r.winRate).padStart(5)} pnl=${String(r.pnl).padStart(7)} dd=${String(r.maxDrawdown).padStart(6)} d=${delta(r.pnl)} | ${dayStr}`,
  );
}
console.log(`\nsaved: ${outPath}`);