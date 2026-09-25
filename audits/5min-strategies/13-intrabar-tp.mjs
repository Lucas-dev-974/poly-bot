#!/usr/bin/env node
// 13-intrabar-tp.mjs — Intra-market : entrées antiflip (A / H) + clôture
// anticipée quand la position gagne +X% de la mise.
//
// Question utilisateur : au lieu de hold-to-resolution, vendre dès que la
// position vaut +X% de la mise (mise = coût d'entrée = 5 × entryAsk).
// La sortie se fait au BID réel du tick (pas bid=ask−1¢, pas d'hypothèse).
//
// Variantes testées :
//   - baseline hold (A, H) — référence des runs précédents
//   - TP% ∈ {8,10,12,15,20,25,30} × SL ∈ {aucun, 10%, 20%}
//   - TP% + time-stop 60s avant la clôture (sortie au bid, pas de résolution)
//
// Mesures : WR des trades soldés (TP/SL), EV/trade, ratio, hold moyen,
// IS/OOS (split chrono 50/50). Seuil de validation : n ≥ 40 trades.

import { openDb, loadWindows } from "./lib/tickdb.js";
import { seriesAtOrBefore } from "./lib/engine-helpers.js";
import { buildSeries, favoriteOf } from "./lib/strategies.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const BUDGET = 2;
const MAX_SHARES = 5;
const MIN_N = 40;

const TPS = [0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3];
const SLS = [null, 0.1, 0.2];

// ── Moteur : une fenêtre, un mode d'entrée (A|H), un mode de sortie ────────
// Retourne { trade: null | {outcome, pnl, entryAsk, entryTs, exitTs, holdSec,
// resolvedAt, wouldWin} } — 1 trade max par fenêtre (pas de re-entry).
function runWindow(win, entryMode, exitCfg) {
  const s = buildSeries(win);
  const windowMs = s.endMs - s.startMs;

  // --- détection du PREMIER flip (réplique variants.js / variants2.js) ---
  let prevFav = null;
  let flipT = null;
  const flipSearchEnd = s.startMs + 0.6 * windowMs; // maxElapsedFrac = 0.6 (185s/300s)
  for (let t = s.startMs; t < flipSearchEnd; t += 1000) {
    const u = seriesAtOrBefore(s.up, t);
    const d = seriesAtOrBefore(s.down, t);
    if (!u?.ask || !d?.ask) continue;
    const fav = favoriteOf(u, d);
    if (prevFav !== null && fav.side !== prevFav) { flipT = t; break; }
    prevFav = fav.side;
  }
  if (flipT == null) return null;

  // --- entrée à flipT + 5s (réplique A) ---
  const tEntry = flipT + 5000;
  const uE = seriesAtOrBefore(s.up, tEntry);
  const dE = seriesAtOrBefore(s.down, tEntry);
  if (!uE?.ask || !dE?.ask) return null;
  const deposedAsk = prevFav === 0 ? uE.ask : dE.ask;
  if (deposedAsk < 0.3 || deposedAsk > 0.4) return null; // bande A/H
  if (entryMode === "H") {
    const depSeries = prevFav === 0 ? s.up : s.down;
    const peak = seriesAtOrBefore(depSeries, flipT - 3000);
    const drop = (peak?.ask ?? 1) - deposedAsk;
    if (drop < 0.12) return null;
  }
  // fill market buy : budget 2$, max 5 shares → 5 shares ssi ask ≤ 0.40
  if (BUDGET / deposedAsk < 5) return null;
  const entryCost = Math.round(5 * deposedAsk * 100) / 100;
  const held = prevFav === 0 ? s.up : s.down;
  const hasExit = exitCfg.tp != null || exitCfg.sl != null || exitCfg.timeStopSec != null;
  const tpBid = exitCfg.tp != null ? deposedAsk * (1 + exitCfg.tp) : null;
  const slBid = exitCfg.sl != null ? deposedAsk * (1 - exitCfg.sl) : null;
  const timeStopTs = exitCfg.timeStopSec != null ? s.endMs - exitCfg.timeStopSec * 1000 : null;

  // --- boucle de sortie : TP au bid ≥ cible, SL au bid ≤ cible, time-stop ---
  if (hasExit) {
    for (let t = tEntry + 2000; t < s.endMs - 10_000; t += 1000) {
      const p = seriesAtOrBefore(held, t);
      if (!p?.bid) continue; // pas de bid → pas de sortie possible
      if (tpBid != null && p.bid >= tpBid) {
        const pnl = Math.round((5 * p.bid - entryCost) * 100) / 100;
        return { outcome: "TP", pnl, entryAsk: deposedAsk, entryTs: tEntry, exitTs: t, holdSec: (t - tEntry) / 1000, entrySide: prevFav };
      }
      if (slBid != null && p.bid <= slBid) {
        const pnl = Math.round((5 * p.bid - entryCost) * 100) / 100;
        return { outcome: "SL", pnl, entryAsk: deposedAsk, entryTs: tEntry, exitTs: t, holdSec: (t - tEntry) / 1000, entrySide: prevFav };
      }
      if (timeStopTs != null && t >= timeStopTs) {
        const pnl = Math.round((5 * p.bid - entryCost) * 100) / 100;
        return { outcome: "TSTOP", pnl, entryAsk: deposedAsk, entryTs: tEntry, exitTs: t, holdSec: (t - tEntry) / 1000, entrySide: prevFav };
      }
    }
  }

  // --- hold jusqu'à résolution ---
  const won = prevFav === win.winnerIndex;
  const pnl = Math.round(((won ? 5 : 0) - entryCost) * 100) / 100;
  return { outcome: won ? "WON" : "LOST", pnl, entryAsk: deposedAsk, entryTs: tEntry, exitTs: s.endMs - 10_000, holdSec: (s.endMs - 10_000 - tEntry) / 1000, entrySide: prevFav };
}

// ── Sweep ────────────────────────────────────────────────────────────────────
const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[13] ${windows.length} fenêtres chargées`);
if (windows.length === 0) process.exit(1);

const mid = Math.floor(windows.length / 2);
const variants = [];
for (const mode of ["A", "H"]) {
  variants.push({ mode, tp: null, sl: null, timeStopSec: null, label: `${mode}-hold (baseline)` });
  for (const tp of TPS) {
    for (const sl of SLS) {
      variants.push({ mode, tp, sl, timeStopSec: null, label: `${mode}-TP${Math.round(tp * 100)}%` + (sl == null ? "" : `-SL${Math.round(sl * 100)}%`) });
    }
  }
  for (const tp of TPS) {
    variants.push({ mode, tp, sl: null, timeStopSec: 60, label: `${mode}-TP${Math.round(tp * 100)}%-tstop60` });
  }
}

const results = [];
for (const v of variants) {
  const R = { ...v, trades: 0, pnl: 0, wins: 0, losses: 0, winSum: 0, lossSum: 0, tpHits: 0, slHits: 0, tstops: 0, resolved: 0, holdSum: 0, costSum: 0, isTrades: 0, isPnl: 0, isWins: 0, oosTrades: 0, oosPnl: 0, oosWins: 0, maxWin: 0, maxLoss: 0 };
  for (let i = 0; i < windows.length; i++) {
    const trade = runWindow(windows[i], v.mode, { tp: v.tp, sl: v.sl, timeStopSec: v.timeStopSec });
    if (!trade) continue;
    const isIS = i < mid;
    R.trades++;
    R.pnl += trade.pnl;
    R.holdSum += trade.holdSec;
    R.costSum += 5 * trade.entryAsk;
    if (trade.pnl > 0) { R.wins++; R.winSum += trade.pnl; }
    else { R.losses++; R.lossSum += trade.pnl; }
    if (trade.outcome === "TP") R.tpHits++;
    else if (trade.outcome === "SL") R.slHits++;
    else if (trade.outcome === "TSTOP") R.tstops++;
    else R.resolved++;
    R.maxWin = Math.max(R.maxWin, trade.pnl);
    R.maxLoss = Math.min(R.maxLoss, trade.pnl);
    if (isIS) { R.isTrades++; R.isPnl += trade.pnl; if (trade.pnl > 0) R.isWins++; }
    else { R.oosTrades++; R.oosPnl += trade.pnl; if (trade.pnl > 0) R.oosWins++; }
  }
  R.avgPnl = R.trades ? R.pnl / R.trades : 0;
  R.wr = R.trades ? R.wins / R.trades : 0;
  R.avgWin = R.wins ? R.winSum / R.wins : 0;
  R.avgLoss = R.losses ? R.lossSum / R.losses : 0;
  R.avgHold = R.trades ? R.holdSum / R.trades : 0;
  R.isWr = R.isTrades ? R.isWins / R.isTrades : 0;
  R.oosWr = R.oosTrades ? R.oosWins / R.oosTrades : 0;
  results.push(R);
}

// ── Rapport ──────────────────────────────────────────────────────────────────
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const money = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}$`;
const fmtRow = (R) =>
  `| ${R.label} | ${R.trades} | ${pct(R.wr)} | ${money(R.avgPnl)} | ${money(R.pnl)} | ${money(R.avgWin)} | ${money(R.avgLoss)} | ${R.avgHold.toFixed(0)}s | TP ${R.tpHits} · SL ${R.slHits} · TS ${R.tstops} · rés ${R.resolved} | ${pct(R.isWr)}/${pct(R.oosWr)} |`;

const table = [
  "| Variante | Trades | WR soldés | EV/trade | PnL total | Avg win | Avg loss | Hold moyen | Sorties | WR IS/OOS |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...results.map(fmtRow),
].join("\n");

const baselines = results.filter((r) => r.tp == null);
const valid = results.filter((r) => r.trades >= MIN_N).sort((a, b) => b.avgPnl - a.avgPnl);

let md = `# 13 — Intra-market : TP en % de la mise (entrées A/H, sortie au bid)

Dataset : ${windows.length} fenêtres BTC Up/Down 5m résolues (ticks book bid+ask).
Entrées = réplique exacte de A (flip → +5s, déposé [0.30-0.40]) et H (idem + sharp drop ≥ 12¢).
Mise = 5 shares × ask ≈ 1.50-2.00$. Sortie = vente au **bid réel** du tick.
Split IS/OOS chrono 50/50. Seuil de lecture : n ≥ ${MIN_N} trades.

## Baselines (hold to resolution)

${["| Variante | Trades | WR | EV/trade | PnL total |", "|---|---|---|---|---|",
   ...baselines.map((r) => `| ${r.label} | ${r.trades} | ${pct(r.wr)} | ${money(r.avgPnl)} | ${money(r.pnl)} |`)].join("\n")}

## Toutes les variantes (triées par EV)

${table}

## Lecture

- **TP bas (8-12%)** : beaucoup de sorties rapides, mais chaque sortie paie le
  spread bid/ask — l'EV dépend du rebond réel du bid après l'entrée.
- **TP haut (25-30%)** : se comporte presque comme le hold (la résolution
  crédite 1$ = +X% selon le prix d'entrée).
- Un TP vaut le hold uniquement s'il **augmente le WR des trades soldés**
  davantage qu'il ne coût en spread — à lire dans la colonne WR.
`;
writeFileSync(join(RESULTS_DIR, "13-intrabar-tp.md"), md);
writeFileSync(join(RESULTS_DIR, "13-intrabar-tp.json"), JSON.stringify({ generatedAt: new Date().toISOString(), windows: windows.length, results }, null, 2));

console.log(table);
console.log(`\n[13] rapport → results/13-intrabar-tp.md (${results.length} variantes)`);