/**
 * Dip-revert combo grid — top entry axes from dip-grid3 combined.
 * Run: npx tsx scripts/research/dip-revert-research/dip-grid3-combos.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";

const axes: Array<{ name: string; params: Partial<SimParams> }> = [
  { name: "base", params: {} },
  { name: "e120", params: { minElapsedSec: 120 } },
  { name: "d050", params: { minDrop: 0.05 } },
  { name: "s003", params: { maxSpread: 0.03 } },
  { name: "e120+d050", params: { minElapsedSec: 120, minDrop: 0.05 } },
  { name: "e120+s003", params: { minElapsedSec: 120, maxSpread: 0.03 } },
  { name: "d050+s003", params: { minDrop: 0.05, maxSpread: 0.03 } },
  { name: "e120+d050+s003", params: { minElapsedSec: 120, minDrop: 0.05, maxSpread: 0.03 } },
  { name: "e150+d050", params: { minElapsedSec: 150, minDrop: 0.05 } },
  { name: "e120+d040", params: { minElapsedSec: 120, minDrop: 0.04 } },
  { name: "d045+s003", params: { minDrop: 0.045, maxSpread: 0.03 } },
];

const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);

const u = loadUniverse();
const days = [...new Set([...u.slugs.keys()].map(dayOf))].sort();

const rows: any[] = [];
for (const axis of axes) {
  const P: SimParams = { ...BASE, ...axis.params };
  const r = runSim(u, P);
  const byDay: Record<string, number> = {};
  for (const d of days) {
    const rd = runSim(u, P, { slugFilter: (slug) => dayOf(slug) === d });
    byDay[d] = rd.pnl;
  }
  rows.push({ name: axis.name, ...r, byDay });
  process.stderr.write(`${axis.name}: fills=${r.fills} wr=${r.winRate} pnl=${r.pnl}\n`);
}

const ranked = [...rows].sort((a, b) => b.pnl - a.pnl);
for (const r of ranked) {
  const dayStr = days.map((d) => `${d.slice(5)}:${r.byDay[d] ?? 0}`).join(" ");
  console.log(
    `${r.name.padEnd(18)} fills=${String(r.fills).padStart(3)} wr=${String(r.winRate).padStart(5)} pnl=${String(r.pnl).padStart(7)} dd=${String(r.maxDrawdown).padStart(6)} | ${dayStr}`,
  );
}

mkdirSync(join("audits", "backtest", "dip-revert"), { recursive: true });
const outPath = join("audits", "backtest", "dip-revert", `dip-grid3-combos-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(rows, null, 2));
console.log(`\nsaved: ${outPath}`);