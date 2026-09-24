#!/usr/bin/env node
// 10-sweep-v4.mjs — Sweep des variantes L (calibration antiflip-delay).
import { openDb, loadWindows } from "./lib/tickdb.js";
import { buildSweepV4 } from "./lib/variants4.js";
import {
  fillMarketBuy, fillLimitBuy, fillSellAtBid, resolvePnl, round2, round4,
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
const BUDGET = Number(args.budget ?? 4);
const MAX_SHARES = Number(args["max-shares"] ?? 40);
const RUN_ID = `sweep4-${Date.now()}`;

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
console.log(`[sweep4] ${windows.length} fenêtres (budget ${BUDGET}$, maxShares ${MAX_SHARES})`);

const variants = buildSweepV4();
const ctx = { budgetPerTrade: BUDGET, rng: null };
const results = [];

for (const strat of variants) {
  const t0 = Date.now();
  let trades = 0, wins = 0, losses = 0;
  let pnl = 0, costTotal = 0, winSum = 0;
  for (const win of windows) {
    const orders = strat.evaluate(win, ctx);
    if (!orders || orders.length === 0) continue;
    const s = { up: win.ticksUp, down: win.ticksDown };
    const open = [];
    for (const order of orders) {
      if (order.kind === "market") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillMarketBuy(null, series, order.ts, order.budgetUsdc, MAX_SHARES);
        if (!fill) continue;
        open.push({ side: order.side, entryPrice: fill.price, shares: fill.shares, cost: round2(fill.price * fill.shares) });
        trades++;
      } else if (order.kind === "limit") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillLimitBuy(series, order.ts, order.price, order.budgetUsdc, MAX_SHARES, win.endTs * 1000);
        if (!fill) continue;
        open.push({ side: order.side, entryPrice: fill.price, shares: fill.shares, cost: round2(fill.price * fill.shares) });
        trades++;
      } else if (order.kind === "sell") {
        const series = order.side === 0 ? s.up : s.down;
        const toClose = open.filter((p) => p.side === order.side && !p.sold);
        if (toClose.length === 0) continue;
        const fill = fillSellAtBid(series, order.ts);
        if (!fill) continue;
        for (const pos of toClose) {
          const leg = round2(pos.shares * fill.price - pos.cost);
          pos.sold = true; pos.status = "sold"; pos.pnl = leg;
          pnl += leg; costTotal += pos.cost;
          if (leg > 0) { wins++; winSum += leg; } else losses++;
        }
      }
    }
    for (const pos of open) {
      if (pos.sold) continue;
      const { won, pnl: leg } = resolvePnl(pos, win.winnerIndex);
      pos.status = won ? "won" : "lost"; pos.pnl = leg;
      pnl += leg; costTotal += pos.cost;
      if (won) { wins++; winSum += leg; } else losses++;
    }
  }
  const total = wins + losses;
  const m = {
    trades,
    wins,
    losses,
    winrate: round4(total > 0 ? wins / total : 0),
    pnl: round2(pnl),
    avgPnlPerTrade: round4(trades > 0 ? pnl / trades : 0),
    avgCost: round2(trades > 0 ? costTotal / trades : 0),
    avgWin: round2(wins > 0 ? winSum / wins : 0),
    tradesPerWindow: round4(trades / windows.length),
  };
  results.push({ strategyId: strat.id, name: strat.name, desc: strat.desc, metrics: m, elapsedMs: Date.now() - t0 });
  console.log(`${strat.id}: trades=${m.trades} wr=${(m.winrate * 100).toFixed(1)}% pnl=${m.pnl}$ avg=${m.avgPnlPerTrade}$ (${m.elapsedMs ?? Date.now() - t0}ms)`);
}

const ranked = [...results].sort((a, b) => b.metrics.pnl - a.metrics.pnl);
console.log("\n=== TOP 10 ===");
for (const [i, r] of ranked.slice(0, 10).entries()) {
  console.log(`${i + 1}. ${r.strategyId} wr=${(r.metrics.winrate * 100).toFixed(1)}% pnl=${r.metrics.pnl}$ avg=${r.metrics.avgPnlPerTrade}$ trades=${r.metrics.trades}`);
}

db.prepare("INSERT INTO runs (id, startedAt, finishedAt, status, paramsJson, resultJson) VALUES (?, ?, ?, ?, ?, ?)")
  .run(RUN_ID, Date.now(), Date.now(), "done", JSON.stringify({ type: "sweep4", budget: BUDGET }), JSON.stringify(results));
const outFile = join(RESULTS_DIR, `${RUN_ID}.json`);
writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, type: "sweep4", budget: BUDGET, maxShares: MAX_SHARES, results }, null, 1));
console.log(`\n[sweep4] résultats: ${outFile}`);
db.close();