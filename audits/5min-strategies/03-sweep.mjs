#!/usr/bin/env node
// 03-sweep.mjs — Sweep de variantes : teste une grille de paramètres pour
// chaque famille de stratégies et classe par expectancy.
//
// Usage :
//   node 03-sweep.mjs                       # budget 2$ (contrainte ticket 1-2$)
//   node 03-sweep.mjs --budget=4            # budget 4$ (favori 0.60-0.80 possible)
//   node 03-sweep.mjs --family=A            # une seule famille
import { openDb, loadWindows } from "./lib/tickdb.js";
import { buildSweep } from "./lib/variants.js";
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
const MIN_TICKS = Number(args["min-ticks"] ?? 100);
const FAMILY = args.family ? String(args.family).toUpperCase() : null;
const RUN_ID = `sweep-${Date.now()}`;

const db = openDb();
const windows = loadWindows(db, { minTicks: MIN_TICKS });
console.log(`[sweep] ${windows.length} fenêtres chargées (budget ${BUDGET}$, minTicks ${MIN_TICKS})`);
if (windows.length === 0) process.exit(1);

let variants = buildSweep();
if (FAMILY) {
  variants = variants.filter((v) => v.id.startsWith(FAMILY.toLowerCase()));
  console.log(`[sweep] famille ${FAMILY}: ${variants.length} variantes`);
}

console.log(`[sweep] ${variants.length} variantes à tester`);

const ctx = { budgetPerTrade: BUDGET, rng: null };
const results = [];

// Précharge les séries par fenêtre une fois (perf).
const seriesCache = windows.map((win) => {
  const mk = (rows) => rows.map((r) => ({
    ts: r.ts, bid: r.bid ?? null, ask: r.ask ?? null,
    price: r.price ?? null, size: r.size ?? null, tradeSide: r.tradeSide ?? null,
  }));
  return {
    win,
    up: mk(win.ticksUp),
    down: mk(win.ticksDown),
    startMs: win.startTs * 1000,
    endMs: win.endTs * 1000,
  };
});

function runStrategy(strat) {
  let trades = 0, wins = 0, losses = 0;
  let pnl = 0, costTotal = 0;
  let maxWin = 0, maxLoss = 0;

  for (const { win, up, down, startMs, endMs } of seriesCache) {
    const orders = strat.evaluate(
      { ...win, startTs: startMs / 1000, endTs: endMs / 1000, ticksUp: win.ticksUp, ticksDown: win.ticksDown },
      ctx,
    );
    if (!orders || orders.length === 0) continue;

    const open = [];
    for (const order of orders) {
      if (order.kind === "market") {
        const series = order.side === 0 ? up : down;
        const fill = fillMarketBuy(null, series, order.ts, order.budgetUsdc, MAX_SHARES);
        if (!fill) continue;
        open.push({ side: order.side, entryTs: fill.ts, entryPrice: fill.price, shares: fill.shares, cost: round2(fill.price * fill.shares), sold: false });
        trades++;
      } else if (order.kind === "limit") {
        const series = order.side === 0 ? up : down;
        const fill = fillLimitBuy(series, order.ts, order.price, order.budgetUsdc, MAX_SHARES, endMs);
        if (!fill) continue;
        open.push({ side: order.side, entryTs: fill.ts, entryPrice: fill.price, shares: fill.shares, cost: round2(fill.price * fill.shares), sold: false });
        trades++;
      } else if (order.kind === "sell") {
        const series = order.side === 0 ? up : down;
        const toClose = open.filter((p) => p.side === order.side && !p.sold);
        if (toClose.length === 0) continue;
        const fill = fillSellAtBid(series, order.ts);
        if (!fill) continue;
        for (const pos of toClose) {
          const credit = pos.shares * fill.price;
          const pnlLeg = round2(credit - pos.cost);
          pos.sold = true;
          pos.status = "sold";
          pos.pnl = pnlLeg;
          pnl += pnlLeg;
          costTotal += pos.cost;
          if (pnlLeg > 0) wins++; else losses++;
        }
      }
    }

    for (const pos of open) {
      if (pos.sold) continue;
      const { won, pnl: pnlLeg } = resolvePnl(pos, win.winnerIndex);
      pos.status = won ? "won" : "lost";
      pos.pnl = pnlLeg;
      pnl += pnlLeg;
      costTotal += pos.cost;
      if (won) { wins++; maxWin = Math.max(maxWin, pnlLeg); }
      else { losses++; maxLoss = Math.min(maxLoss, pnlLeg); }
    }
  }

  const total = wins + losses;
  return {
    strategyId: strat.id,
    name: strat.name,
    desc: strat.desc,
    metrics: {
      trades,
      wins,
      losses,
      winrate: round4(total > 0 ? wins / total : 0),
      pnl: round2(pnl),
      avgPnlPerTrade: round4(trades > 0 ? pnl / trades : 0),
      avgCostPerTrade: round2(trades > 0 ? costTotal / trades : 0),
      tradesPerWindow: round4(trades / windows.length),
      maxWin: round2(maxWin),
      maxLoss: round2(maxLoss),
    },
  };
}

for (const variant of variants) {
  const t0 = Date.now();
  const result = runStrategy(variant);
  result.elapsedMs = Date.now() - t0;
  results.push(result);
  const m = result.metrics;
  console.log(`${result.strategyId}: trades=${m.trades} wr=${(m.winrate * 100).toFixed(0)}% pnl=${m.pnl}$ avg=${m.avgPnlPerTrade}$ (${result.elapsedMs}ms)`);
}

// Classement.
const sorted = [...results].sort((a, b) => b.metrics.avgPnlPerTrade - a.metrics.avgPnlPerTrade);
console.log("\n=== TOP 15 par expectancy (PnL/trade) ===");
for (const [i, r] of sorted.slice(0, 15).entries()) {
  const m = r.metrics;
  console.log(`${i + 1}. ${r.strategyId} wr=${(m.winrate * 100).toFixed(1)}% pnl=${m.pnl}$ avg=${m.avgPnlPerTrade}$ trades=${m.trades}`);
}

// Persiste.
db.prepare("INSERT INTO runs (id, startedAt, finishedAt, status, paramsJson, resultJson) VALUES (?, ?, ?, ?, ?, ?)")
  .run(RUN_ID, Date.now(), Date.now(), "done", JSON.stringify({ type: "sweep", budget: BUDGET, family: FAMILY }), JSON.stringify(results));
const outFile = join(RESULTS_DIR, `${RUN_ID}.json`);
writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, type: "sweep", budget: BUDGET, results: sorted }, null, 1));
console.log(`\n[sweep] résultats: ${outFile}`);
db.close();