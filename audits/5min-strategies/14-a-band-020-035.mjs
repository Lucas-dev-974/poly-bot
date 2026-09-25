#!/usr/bin/env node
// 14-a-band-020-035.mjs — A re-entry avec bande resserrée [0.20, 0.35]
// (demande utilisateur). Réplique exacte de la variante A-antiflip : flip →
// +5s, ancien favori, bande configurable ici, maxElapsedFrac 0.6, hold →
// résolution. Budget 2$, 5 shares. Toutes les fenêtres du dataset.
import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";
import { buildSeries, favoriteOf } from "./lib/strategies.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET = 2;
const MAX_SHARES = 5;
const DELAY_MS = 5000;
// Bandes testées : la demandée + voisines pour contexte (référence = 0.30-0.45).
const BANDS = [
  [0.2, 0.35],
  [0.2, 0.4],
  [0.25, 0.35],
  [0.3, 0.45], // référence (preset A)
];

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[14] ${windows.length} fenêtres chargées`);
if (windows.length === 0) process.exit(1);
const mid = Math.floor(windows.length / 2);

function runWindow(win, winIdx, bandMin, bandMax) {
  const s = buildSeries(win);
  const windowMs = s.endMs - s.startMs;
  let prevFav = null;
  let flipT = null;
  const flipSearchEnd = s.startMs + 0.6 * windowMs;
  for (let t = s.startMs; t < flipSearchEnd; t += 1000) {
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) continue;
    const fav = favoriteOf(u, d);
    if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
    prevFav = fav.side;
  }
  if (flipT == null) return null;
  const tEntry = flipT + DELAY_MS;
  const uE = seriesAtOrBefore(s.up, tEntry);
  const dE = seriesAtOrBefore(s.down, tEntry);
  if (!uE?.ask || !dE?.ask) return null;
  const deposedAsk = prevFav === 0 ? uE.ask : dE.ask;
  if (deposedAsk < bandMin || deposedAsk > bandMax) return null;
  if (BUDGET / deposedAsk < 5) return null; // lot 5 shares
  const cost = Math.round(5 * deposedAsk * 100) / 100;
  const won = prevFav === win.winnerIndex;
  return {
    pnl: Math.round(((won ? 5 : 0) - cost) * 100) / 100,
    isIS: winIdx < mid,
  };
}

const results = [];
for (const [bandMin, bandMax] of BANDS) {
  const R = { band: `${bandMin}-${bandMax}`, trades: 0, wins: 0, pnl: 0, winSum: 0, lossSum: 0, isT: 0, isW: 0, oosT: 0, oosW: 0, entrySum: 0 };
  for (let i = 0; i < windows.length; i++) {
    const t = runWindow(windows[i], i, bandMin, bandMax);
    if (!t) continue;
    R.trades++;
    R.pnl += t.pnl;
    if (t.pnl > 0) { R.wins++; R.winSum += t.pnl; } else { R.lossSum += t.pnl; }
    if (t.isIS) { R.isT++; if (t.pnl > 0) R.isW++; } else { R.oosT++; if (t.pnl > 0) R.oosW++; }
    R.entrySum += t.cost / 5;
  }
  R.wr = R.trades ? R.wins / R.trades : 0;
  R.avg = R.trades ? R.pnl / R.trades : 0;
  R.avgWin = R.wins ? R.winSum / R.wins : 0;
  R.avgLoss = R.wins ? R.lossSum / (R.trades - R.wins || 1) : 0;
  R.isWr = R.isT ? R.isW / R.isT : 0;
  R.oosWr = R.oosT ? R.oosW / R.oosT : 0;
  results.push(R);
}

const money = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}$`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const header = "| Bande | Trades | Prix moyen | WR | EV/trade | PnL | Avg win | Avg loss | IS/OOS |";
const sep = "|---|---|---|---|---|---|---|---|---|";
const rows = results.map((r) =>
  `| [${r.band}] | ${r.trades} | ${money(r.entrySum / (r.trades || 1) * 1).replace("$", "")} | ${pct(r.wr)} | ${money(r.avg)} | ${money(r.pnl)} | ${money(r.avgWin)} | ${money(r.avgLoss)} | ${pct(r.isWr)} / ${pct(r.oosWr)} |`
    .replace(/\| ([^|]+) \|/, (m) => m), // noop keep
);
const table = [header, sep, ...rows].join("\n");
console.log(table);
writeFileSync(join(HERE, "results", "14-a-band-020-035.json"), JSON.stringify({ generatedAt: new Date().toISOString(), windows: windows.length, results }, null, 2));
console.log(`\n[14] → results/14-a-band-020-035.json`);