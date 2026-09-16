/**
 * Dip-revert backtest — 3 DERNIERS JOURS uniquement (09-13, 09-14, 09-15 UTC).
 *
 * Re-run des axes qui comptent pour la décision en cours:
 *   - hold (référence base officielle)
 *   - axes d'entrée gagnants (e150+d050, +deadline 420)
 *   - configs live candidates
 *   - meilleur trailing (0.15 armé) pour re-vérifier sur la période récente
 * Breakdown par jour UTC. Read-only, aucune DB source écrite.
 *
 * Usage: npx tsx scripts/research/dip-revert-research/dip-last3days.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, loadUniverse, runSim, type SimParams } from "./dip-sim.mts";
import { runTrailSim, type TrailParams } from "./dip-trailing-sim.mts";
import type { Universe } from "./dip-sim.mts";

const u = loadUniverse() as unknown as Universe;
const dayOf = (slug: string) =>
  new Date(Number(slug.split("-").pop()) * 1000).toISOString().slice(0, 10);
const LAST3 = new Set(["2026-09-13", "2026-09-14", "2026-09-15"]);
const in3 = (slug: string) => LAST3.has(dayOf(slug));
const days = ["2026-09-13", "2026-09-14", "2026-09-15"];

const rows: any[] = [];

// --- entry axes via runSim ---
function pushSim(label: string, P: SimParams) {
  const r = runSim(u, P, { slugFilter: in3 });
  const byDay: Record<string, number> = {};
  for (const d of days) {
    const rd = runSim(u, P, { slugFilter: (s) => in3(s) && dayOf(s) === d });
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  rows.push({ label, engine: "entry", ...r, byDay });
  process.stderr.write(`${label}: fills=${r.fills} wr=${r.winRate} pnl=${r.pnl}\n`);
}

// --- trailing via runTrailSim ---
function pushTrail(label: string, P: TrailParams) {
  const r = runTrailSim(u, P, in3);
  const byDay: Record<string, number> = {};
  for (const d of days) {
    const rd = runTrailSim(u, P, (s) => in3(s) && dayOf(s) === d);
    byDay[d] = Math.round(rd.pnl * 100) / 100;
  }
  rows.push({ label, engine: "trail", ...r, byDay });
}

const OVR = (p: Partial<SimParams>): SimParams => ({ ...BASE, ...p });

// référence hold
pushSim("hold-base", OVR({}));
// axes d'entrée
pushSim("e150+d050", OVR({ minElapsedSec: 150, minDrop: 0.05 }));
pushSim("e150+d050+max420", OVR({ minElapsedSec: 150, minDrop: 0.05, maxElapsedSec: 420 }));
pushSim("e120", OVR({ minElapsedSec: 120 }));
pushSim("d050", OVR({ minDrop: 0.05 }));
pushSim("s003", OVR({ maxSpread: 0.03 }));
// configs live candidates
pushSim("live-band0.63", OVR({ bandMax: 0.63 }));
pushSim("live-e480", OVR({ minElapsedSec: 480 }));
// trailing re-vérif sur la période récente
pushTrail("trail-0.15-arm4", { trailAbs: 0.15, trailPct: null, armCents: 0.04, entryBase: "official" });
pushTrail("trail-0.12-arm4-winner", { trailAbs: 0.12, trailPct: null, armCents: 0.04, entryBase: "winner" });
pushTrail("hold-trail-ref", { trailAbs: null, trailPct: null, armCents: 0, entryBase: "official" });

mkdirSync(join("audits", "backtest", "dip-revert"), { recursive: true });
const outPath = join("audits", "backtest", "dip-revert", `dip-last3days-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(rows, null, 2));

const base = rows.find((r) => r.label === "hold-base")!;
console.log(`\n=== 3 DERNIERS JOURS (09-13, 09-14, 09-15) — ranked ===`);
console.log(`hold-base: fills=${base.fills} wr=${base.winRate}% pnl=${base.pnl}\n`);
for (const r of [...rows].sort((a, b) => b.pnl - a.pnl)) {
  const dayStr = days.map((d) => `${d.slice(5)}:${r.byDay[d] ?? 0}`).join(" ");
  const d3 = Math.round((r.pnl - base.pnl) * 100) / 100;
  console.log(
    `${r.label.padEnd(22)} fills=${String(r.fills).padStart(3)} wr=${String(r.winRate).padStart(5)} pnl=${String(r.pnl).padStart(8)} d=${String(d3).padStart(7)} | ${dayStr}`,
  );
}
console.log(`\nsaved: ${outPath}`);