#!/usr/bin/env node
// 04-analyze.mjs — Analyse statistique du dataset 5m.
//
// Répond aux questions :
//   - Distribution des prix (asks) par décile de fenêtre (0-10%, ... 90-100%)
//   - Volatilité (amplitude ask par fenêtre), fréquence des flips
//   - Probabilité de victoire conditionnelle : quand le leader cote X à t%,
//     quelle est la probabilité qu'il gagne ?
//   - Corrélation entre le prix du leader à différents instants et la résolution
//
// Usage : node 04-analyze.mjs
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "results");
const db = openDb();

const windows = loadWindows(db, { minTicks: 20 });
console.log(`[analyze] ${windows.length} fenêtres chargées`);
if (windows.length === 0) process.exit(1);

// 1. Calibration : P(leader à t% gagne | prix du leader à t%)
// Déciles de fenêtre : 10%, 20%, ..., 90%.
const DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const PRICE_BUCKETS = [];
for (let p = 0.05; p < 1.0; p += 0.05) PRICE_BUCKETS.push(Number(p.toFixed(2)));

const calibration = {}; // decile -> bucket -> { n, wins }
for (const d of DECILES) calibration[d] = {};

let flipsTotal = 0;
let flipsEarly = 0; // flip dans les 120 premières s
const amplitudeBuckets = new Array(10).fill(0); // amplitude ask du leader
const upWins = windows.filter((w) => w.winnerIndex === 0).length;

for (const win of windows) {
  const up = win.ticksUp;
  const down = win.ticksDown;

  // Leader et prix par décile.
  const samples = [];
  for (const d of DECILES) {
    const t = (win.startTs + d * (win.endTs - win.startTs)) * 1000;
    const u = seriesAtOrBefore(up, t);
    const dn = seriesAtOrBefore(down, t);
    if (!u || !dn) continue;
    const leaderAsk = Math.min(u.ask ?? 1, dn.ask ?? 1);
    const leader = (u.ask ?? 1) <= (dn.ask ?? 1) ? 0 : 1;
    samples.push({ d, leader, leaderAsk });
  }

  // Calibration.
  for (const { d, leader, leaderAsk } of samples) {
    const bucket = Math.min(Math.floor(leaderAsk / 0.05), 19);
    const key = (bucket * 0.05).toFixed(2);
    calibration[d][key] = calibration[d][key] ?? { n: 0, wins: 0 };
    calibration[d][key].n++;
    if (leader === win.winnerIndex) calibration[d][key].wins++;
  }

  // Flips (changement de leader via ask).
  let prevLeader = null;
  let flips = 0;
  let firstFlipT = null;
  let maxAsk = 0, minAsk = 1;
  for (let i = 0; i < Math.min(up.length, down.length); i++) {
    const u = up[i], dn = down[i];
    if (u?.ask == null || dn?.ask == null) continue;
    const leader = u.ask <= dn.ask ? 0 : 1;
    if (prevLeader !== null && leader !== prevLeader) {
      flips++;
      if (firstFlipT == null) {
        firstFlipT = u.ts;
        if (u.ts - win.startTs * 1000 <= 120_000) flipsEarly++;
      }
    }
    prevLeader = leader;
    const leaderAsk = Math.min(u.ask, dn.ask);
    maxAsk = Math.max(maxAsk, leaderAsk);
    minAsk = Math.min(minAsk, leaderAsk);
  }
  flipsTotal += flips;
  const amp = maxAsk - minAsk;
  amplitudeBuckets[Math.min(Math.floor(amp * 10), 9)]++;
}

// Rapport.
const lines = [];
lines.push(`# Analyse dataset BTC 5m — ${new Date().toISOString()}`);
lines.push("");
lines.push(`Fenêtres analysées : ${windows.length} (Up wins: ${upWins} = ${((upWins / windows.length) * 100).toFixed(1)}%)`);
lines.push(`Flips de leader : ${flipsTotal} total, ${flipsEarly} dans les 120 premières s`);
lines.push(`Flips/fenêtre : ${(flipsTotal / windows.length).toFixed(2)}`);
lines.push("");
lines.push("Amplitude ask du leader (max-min) :");
lines.push("");
lines.push("| Amplitude | Fenêtres | % |");
lines.push("|---|---|---|");
let cum = 0;
for (let i = 0; i < amplitudeBuckets.length; i++) {
  const pct = (amplitudeBuckets[i] / windows.length * 100);
  cum += pct;
  lines.push(`| ${(i * 0.1).toFixed(1)}-${((i + 1) * 0.1).toFixed(1)} | ${amplitudeBuckets[i]} | ${pct.toFixed(1)}% |`);
}
lines.push("");
lines.push("## Calibration : P(leader gagne | prix du leader au décile t)");
lines.push("");
for (const d of DECILES) {
  const buckets = Object.entries(calibration[d]).filter(([k, v]) => v.n >= 10);
  if (buckets.length === 0) continue;
  lines.push(`### t = ${Math.round(d * 100)}% de la fenêtre`);
  lines.push("");
  lines.push("| Prix leader | n | P(win) |");
  lines.push("|---|---|---|");
  for (const [key, { n, wins }] of buckets.sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`| ${key} | ${n} | ${(wins / n * 100).toFixed(1)}% |`);
  }
  lines.push("");
}

// 2. Momentum : si le leader à 30% cote X, quelle est la distribution de son prix à 50% ?
lines.push("## Persistance du leader (t=30% → t=70%)");
lines.push("");
let persist = 0, count = 0;
for (const win of windows) {
  const t30 = (win.startTs + 0.3 * (win.endTs - win.startTs)) * 1000;
  const t70 = (win.startTs + 0.7 * (win.endTs - win.startTs)) * 1000;
  const u30 = seriesAtOrBefore(win.ticksUp, t30);
  const d30 = seriesAtOrBefore(win.ticksDown, t30);
  const u70 = seriesAtOrBefore(win.ticksUp, t70);
  const d70 = seriesAtOrBefore(win.ticksDown, t70);
  if (!u30?.ask || !d30?.ask || !u70?.ask || !d70?.ask) continue;
  const l30 = u30.ask <= d30.ask ? 0 : 1;
  const l70 = u70.ask <= d70.ask ? 0 : 1;
  count++;
  if (l30 === l70) persist++;
}
if (count > 0) lines.push(`Leader à 30% = leader à 70% : ${persist}/${count} = ${(persist / count * 100).toFixed(1)}%`);
lines.push("");

const outPath = join(OUT_DIR, "analysis-latest.md");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`[analyze] rapport: ${outPath}`);
console.log(lines.slice(0, 12).join("\n"));

// Persiste la calibration en JSON pour le backtest.
writeFileSync(join(OUT_DIR, "analysis-latest.json"), JSON.stringify({ calibration, flipsTotal, flipsEarly, amplitudeBuckets }, null, 1));
db.close();