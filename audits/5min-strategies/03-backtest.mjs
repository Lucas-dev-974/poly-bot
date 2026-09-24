#!/usr/bin/env node
// 03-backtest.mjs — Moteur de backtest pour les stratégies 5m.
//
// Pour chaque fenêtre (ticks + résolution connus) et chaque stratégie :
//   1. La stratégie émet des ordres.
//   2. Le moteur simule les fills (market à l'ask, limit si ask ≤ prix).
//   3. Les positions sont soldées : hold jusqu'à la résolution OU vente au bid (SL).
//   4. PnL agrégé + stats.
//
// Frais : Polymarket CLOB ne facture pas de taker fee sur ces marchés (maker/taker 0).
// Slippage : négligé (tickets de 5-10 shares sur des books 20-500 shares).
//
// Usage :
//   node 03-backtest.mjs                      # toutes les stratégies
//   node 03-backtest.mjs --id=S1              # une seule
//   node 03-backtest.mjs --budget=2           # budget par trade (défaut 2 $)
//   node 03-backtest.mjs --min-ticks=100      # complétude mini par token
import { openDb, loadWindows, runStats } from "./lib/tickdb.js";
import { ALL_STRATEGIES } from "./lib/strategies.js";
import {
  seriesAtOrBefore, fillMarketBuy, fillLimitBuy, fillSellAtBid,
  resolvePnl, round2, round4,
} from "./lib/engine-helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);

const BUDGET = Number(args.budget ?? 2);
const MAX_SHARES = Number(args["max-shares"] ?? 40);
const MIN_TICKS = Number(args["min-ticks"] ?? 20);
const ONLY = args.id ? String(args.id) : null;
const RUN_ID = `run-${Date.now()}`;

const db = openDb();
const stats = runStats(db);
console.log(`[backtest] dataset: ${stats.withTicks} fenêtres complètes / ${stats.windows} résolues, ${stats.ticks} ticks, ${stats.runs} runs précédents`);

if (stats.withTicks === 0) {
  console.log("[backtest] pas de données — lance d'abord 01-collector.mjs et/ou 02-import-history.mjs");
  process.exit(1);
}

const windows = loadWindows(db, { minTicks: MIN_TICKS });
console.log(`[backtest] ${windows.length} fenêtres chargées (minTicks=${MIN_TICKS})`);
if (windows.length === 0) process.exit(1);

const strategies = ONLY
  ? ALL_STRATEGIES.filter((s) => s.id.toLowerCase().startsWith(ONLY.toLowerCase()))
  : ALL_STRATEGIES;
if (strategies.length === 0) {
  console.log(`[backtest] stratégie ${ONLY} introuvable`);
  process.exit(1);
}

const ctx = { budgetPerTrade: BUDGET, rng: null };
const results = [];

for (const strat of strategies) {
  const t0 = Date.now();
  let trades = 0, wins = 0, losses = 0, sells = 0;
  let pnl = 0, costTotal = 0;
  let maxWin = 0, maxLoss = 0;
  let entryElapsedSum = 0;
  const perDay = new Map();

  for (const win of windows) {
    const orders = strat.evaluate(win, ctx);
    if (!orders || orders.length === 0) continue;

    const s = { up: win.ticksUp, down: win.ticksDown };
    const open = []; // positions ouvertes dans cette fenêtre

    for (const order of orders) {
      if (order.kind === "market") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillMarketBuy(null, series, order.ts, order.budgetUsdc, MAX_SHARES);
        if (!fill) continue;
        open.push({
          side: order.side,
          entryTs: fill.ts,
          entryPrice: fill.price,
          shares: fill.shares,
          cost: round2(fill.price * fill.shares),
          signal: order.signal ?? null,
        });
        trades++;
        entryElapsedSum += (fill.ts - win.startTs * 1000) / 1000;
      } else if (order.kind === "limit") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillLimitBuy(series, order.ts, order.price, order.budgetUsdc, MAX_SHARES, win.endTs * 1000);
        if (!fill) continue; // jamais fillé → annulé, pas de coût
        open.push({
          side: order.side,
          entryTs: fill.ts,
          entryPrice: fill.price,
          shares: fill.shares,
          cost: round2(fill.price * fill.shares),
          signal: order.signal ?? null,
        });
        trades++;
        entryElapsedSum += (fill.ts - win.startTs * 1000) / 1000;
      } else if (order.kind === "sell") {
        // Vend la (les) position(s) ouverte(s) sur ce side au bid courant.
        const series = order.side === 0 ? s.up : s.down;
        const toClose = open.filter((p) => p.side === order.side && !p.sold);
        if (toClose.length === 0) continue;
        const fill = fillSellAtBid(series, order.ts);
        if (!fill) continue;
        for (const pos of toClose) {
          const credit = pos.shares * fill.price;
          const pnlLeg = round2(credit - pos.cost);
          pos.sold = true;
          pos.exitTs = order.ts;
          pos.exitPrice = fill.price;
          pos.status = "sold";
          pos.pnl = pnlLeg;
          pnl += pnlLeg;
          sells++;
          if (pnlLeg > 0) wins++;
          else losses++;
        }
      }
    }

    // Résolution des positions restantes (hold to resolution).
    for (const pos of open) {
      if (pos.sold) continue;
      const { won, pnl: pnlLeg } = resolvePnl(pos, win.winnerIndex);
      pos.status = won ? "won" : "lost";
      pos.pnl = pnlLeg;
      pos.exitTs = win.endTs;
      pos.exitPrice = won ? 1 : 0;
      pnl += pnlLeg;
      costTotal += pos.cost;
      if (won) { wins++; maxWin = Math.max(maxWin, pnlLeg); }
      else { losses++; maxLoss = Math.min(maxLoss, pnlLeg); }
    }

    // Agrégat par jour UTC.
    const day = new Date(win.startTs * 1000).toISOString().slice(0, 10);
    const dayAgg = perDay.get(day) ?? { trades: 0, wins: 0, pnl: 0 };
    dayAgg.trades += open.length;
    dayAgg.wins += open.filter((p) => p.status === "won" || (p.status === "sold" && p.pnl > 0)).length;
    dayAgg.pnl = round2(dayAgg.pnl + open.reduce((acc, p) => acc + (p.pnl ?? 0), 0));
    perDay.set(day, dayAgg);
  }

  const total = wins + losses;
  const winrate = total > 0 ? wins / total : 0;
  const avgPnl = trades > 0 ? pnl / trades : 0;
  const avgCost = trades > 0 ? costTotal / trades : 0;
  const profitFactor = Math.abs(
    losses > 0 && avgPnl < 0 ? pnl / Math.min(maxLoss * losses, -0.01) : pnl / Math.max(maxWin * wins, 0.01),
  );

  const result = {
    runId: RUN_ID,
    strategyId: strat.id,
    name: strat.name,
    desc: strat.desc,
    params: { budget: BUDGET, maxShares: MAX_SHARES, minTicks: MIN_TICKS },
    dataset: { windows: windows.length, period: windows.length > 0 ? [windows[0].slug, windows[windows.length - 1].slug] : null },
    metrics: {
      trades,
      wins,
      losses,
      sells,
      winrate: round4(winrate),
      pnl: round2(pnl),
      avgPnlPerTrade: round4(avgPnl),
      avgCostPerTrade: round2(avgCost),
      avgEntryElapsedSec: trades > 0 ? Math.round(entryElapsedSum / trades) : null,
      maxWin: round2(maxWin),
      maxLoss: round2(maxLoss),
      profitFactor: Number.isFinite(profitFactor) ? round2(profitFactor) : null,
      expectancyPerTrade: round4(avgPnl),
      tradesPerWindow: round4(trades / windows.length),
    },
    perDay: Object.fromEntries([...perDay.entries()].sort()),
  };

  results.push(result);

  console.log(`\n${strat.id} — ${strat.name}`);
  console.log(`  trades=${trades} winrate=${(winrate * 100).toFixed(1)}% pnl=${round2(pnl)}$ avgPnl/trade=${round4(avgPnl)}$`);
  console.log(`  avgCost=${round2(avgCost)}$ maxWin=${round2(maxWin)}$ maxLoss=${round2(maxLoss)}$ (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// Persiste le run.
db.prepare("INSERT INTO runs (id, startedAt, finishedAt, status, paramsJson, resultJson) VALUES (?, ?, ?, ?, ?, ?)")
  .run(RUN_ID, Date.now(), Date.now(), "done", JSON.stringify({ budget: BUDGET, minTicks: MIN_TICKS, only: ONLY }), JSON.stringify(results));

// Écrit le fichier de résultats.
const outFile = join(RESULTS_DIR, `${RUN_ID}.json`);
writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, startedAt: Date.now(), budget: BUDGET, results }, null, 1));

// Écrit un résumé lisible.
const lines = [];
lines.push(`# Backtest ${RUN_ID}`);
lines.push("");
lines.push(`Budget/trade : ${BUDGET}$ · maxShares ${MAX_SHARES} · minTicks ${MIN_TICKS} · fenêtres ${windows.length}`);
lines.push("");
lines.push("| Stratégie | Trades | Winrate | PnL | PnL/trade | Coût moy |");
lines.push("|---|---|---|---|---|---|");
for (const r of results) {
  lines.push(`| ${r.strategyId} | ${r.metrics.trades} | ${(r.metrics.winrate * 100).toFixed(1)}% | ${r.metrics.pnl}$ | ${r.metrics.avgPnlPerTrade}$ | ${r.metrics.avgCostPerTrade}$ |`);
}
writeFileSync(join(RESULTS_DIR, `${RUN_ID}-summary.md`), lines.join("\n") + "\n");
console.log(`\n[backtest] résultats: ${outFile}`);
db.close();