#!/usr/bin/env node
// 08-final.mjs — Validation finale des finalistes (sweeps v1/v2/v3).
//
// Pour chaque finaliste :
//   1. Run complet (toutes fenêtres).
//   2. Split chronologique in-sample (1re moitié) / out-of-sample (2e moitié)
//      → l'edge doit survivre hors des données de calibrage.
//   3. Agrégats par jour UTC (stabilité).
//   4. Répartition Up/Down (biais directionnel ?).
//
// Usage : node 08-final.mjs --budget=4
import { openDb, loadWindows, runStats } from "./lib/tickdb.js";
import { ALL_STRATEGIES } from "./lib/strategies.js";
import { buildSweep } from "./lib/variants.js";
import { buildSweepV2 } from "./lib/variants2.js";
import { buildSweepV3 } from "./lib/variants3.js";
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
const MIN_TICKS = Number(args["min-ticks"] ?? 100);
const RUN_ID = `final-${Date.now()}`;

// Finalistes par sweep + références défavorables (documentées comme non viables).
const FINALISTS = [
  // v1
  "A-antiflip-0.3-0.5-d0s-w0.6",
  "A-antiflip-0.3-0.45-d5s-w0.6",
  "B-dogmom-0.3-0.45-g0.1-l45000",
  "B-dogmom-0.3-0.45-g0.08-l45000",
  // v2
  "H-antiflip-sharp-d0.25-0.3-0.4",
  "H-antiflip-sharp-d0.12-0.3-0.45",
  "H-antiflip-sharp-d0.12-0.35-0.5",
  "H-antiflip-sharp-d0.12-0.3-0.4",
  "I-lateflip-0.4-0.75-0.3-0.45",
  // v3
  // v3 — les deux variantes bandMax (0.52 / 0.60) ont des ids distincts.
  "K-antiflip-bounce0.08-floor0.4-m0.52",
  "K-antiflip-bounce0.08-floor0.4-m0.6",
  "K-antiflip-bounce0.05-floor0.4-m0.52",
  "K-antiflip-bounce0.05-floor0.4-m0.6",
  "K-antiflip-bounce0.03-floor0.33-m0.52",
  "K-antiflip-bounce0.03-floor0.33-m0.6",
  "J-antiflip-bounce0.03-0.3-0.45-e0.9",
  // Références défavorables (attente : WR < 50 % / PnL négatif)
  "C-favband-0.7-0.82-sp0.1-t45",
  "C-favband-0.7-0.82-sp0.1-t60",
  "E-favlimit-0.7-t30s",
  "D-doglimit-0.1-t60",
];

const db = openDb();
const stats = runStats(db);
console.log(`[final] dataset: ${stats.withTicks}/${stats.windows} fenêtres, ${stats.ticks} ticks`);
const windows = loadWindows(db, { minTicks: MIN_TICKS });
console.log(`[final] ${windows.length} fenêtres chargées (budget ${BUDGET}$, minTicks=${MIN_TICKS})`);
if (windows.length === 0) process.exit(1);

const pool = new Map();
for (const s of [...ALL_STRATEGIES, ...buildSweep(), ...buildSweepV2(), ...buildSweepV3()]) {
  if (pool.has(s.id)) continue; // premier enregistrement gagne
  pool.set(s.id, s);
}
const finalists = FINALISTS.map((id) => pool.get(id)).filter(Boolean);
const missing = FINALISTS.filter((id) => !pool.has(id));
if (missing.length > 0) console.warn(`[final] introuvables: ${missing.join(", ")}`);
console.log(`[final] ${finalists.length} finalistes\n`);

const ctx = { budgetPerTrade: BUDGET, rng: null };
const midIdx = Math.floor(windows.length / 2);

function simulate(strat) {
  let trades = 0, wins = 0, losses = 0;
  let pnl = 0, costTotal = 0;
  let maxWin = 0, maxLoss = 0;
  const perDay = new Map();
  const halves = { is: { t: 0, w: 0, pnl: 0 }, oos: { t: 0, w: 0, pnl: 0 } };
  const sides = { up: { t: 0, w: 0 }, down: { t: 0, w: 0 } };

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const half = i < midIdx ? "is" : "oos";
    const orders = strat.evaluate(win, ctx);
    if (!orders || orders.length === 0) continue;
    const s = { up: win.ticksUp, down: win.ticksDown };
    const open = [];

    for (const order of orders) {
      if (order.kind === "market") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillMarketBuy(null, series, order.ts, order.budgetUsdc, MAX_SHARES);
        if (!fill) continue;
        open.push({
          side: order.side, entryTs: fill.ts, entryPrice: fill.price,
          shares: fill.shares, cost: round2(fill.price * fill.shares),
        });
        trades++;
      } else if (order.kind === "limit") {
        const series = order.side === 0 ? s.up : s.down;
        const fill = fillLimitBuy(series, order.ts, order.price, order.budgetUsdc, MAX_SHARES, win.endTs * 1000);
        if (!fill) continue;
        open.push({
          side: order.side, entryTs: fill.ts, entryPrice: fill.price,
          shares: fill.shares, cost: round2(fill.price * fill.shares),
        });
        trades++;
      } else if (order.kind === "sell") {
        const series = order.side === 0 ? s.up : s.down;
        const toClose = open.filter((p) => p.side === order.side && !p.sold);
        if (toClose.length === 0) continue;
        const fill = fillSellAtBid(series, order.ts);
        if (!fill) continue;
        for (const pos of toClose) {
          const credit = pos.shares * fill.price;
          const leg = round2(credit - pos.cost);
          pos.sold = true; pos.status = "sold"; pos.pnl = leg;
          pnl += leg; costTotal += pos.cost;
          if (leg > 0) { wins++; maxWin = Math.max(maxWin, leg); }
          else { losses++; maxLoss = Math.min(maxLoss, leg); }
          book(half, pos.side, leg > 0, leg);
        }
      }
    }

    for (const pos of open) {
      if (pos.sold) continue;
      const { won, pnl: leg } = resolvePnl(pos, win.winnerIndex);
      pos.status = won ? "won" : "lost"; pos.pnl = leg;
      pnl += leg; costTotal += pos.cost;
      if (won) { wins++; maxWin = Math.max(maxWin, leg); }
      else { losses++; maxLoss = Math.min(maxLoss, leg); }
      book(half, pos.side, won, leg);
    }

    function book(half, side, won, leg) {
      const h = halves[half];
      h.t++; h.pnl += leg; if (won) h.w++;
      const sd = side === 0 ? sides.up : sides.down;
      sd.t++; if (won) sd.w++;
      const day = new Date(win.startTs * 1000).toISOString().slice(0, 10);
      const d = perDay.get(day) ?? { t: 0, w: 0, pnl: 0 };
      d.t++; if (won) d.w++;
      d.pnl = round2(d.pnl + leg);
      perDay.set(day, d);
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
      maxWin: round2(maxWin),
      maxLoss: round2(maxLoss),
      tradesPerWindow: round4(trades / windows.length),
      wrUp: sides.up.t > 0 ? round4(sides.up.w / sides.up.t) : null,
      wrDown: sides.down.t > 0 ? round4(sides.down.w / sides.down.t) : null,
      nUp: sides.up.t,
      nDown: sides.down.t,
    },
    inSample: {
      trades: halves.is.t,
      winrate: round4(halves.is.t > 0 ? halves.is.w / halves.is.t : 0),
      pnl: round2(halves.is.pnl),
    },
    outOfSample: {
      trades: halves.oos.t,
      winrate: round4(halves.oos.t > 0 ? halves.oos.w / halves.oos.t : 0),
      pnl: round2(halves.oos.pnl),
    },
    perDay: Object.fromEntries([...perDay.entries()].sort()),
  };
}

const results = finalists.map((strat) => {
  const r = simulate(strat);
  const m = r.metrics;
  console.log(
    `${strat.id}: trades=${m.trades} wr=${(m.winrate * 100).toFixed(1)}% pnl=${m.pnl}$ avg=${m.avgPnlPerTrade}$`
    + ` | IS ${(r.inSample.winrate * 100).toFixed(0)}% (n=${r.inSample.trades})`
    + ` OOS ${(r.outOfSample.winrate * 100).toFixed(0)}% (n=${r.outOfSample.trades})`
    + ` | up ${m.wrUp != null ? (m.wrUp * 100).toFixed(0) + "%" : "-"} down ${m.wrDown != null ? (m.wrDown * 100).toFixed(0) + "%" : "-"}`,
  );
  return r;
});

db.prepare("INSERT INTO runs (id, startedAt, finishedAt, status, paramsJson, resultJson) VALUES (?, ?, ?, ?, ?, ?)")
  .run(RUN_ID, Date.now(), Date.now(), "done", JSON.stringify({ type: "final", budget: BUDGET, minTicks: MIN_TICKS }), JSON.stringify(results));
const outFile = join(RESULTS_DIR, `${RUN_ID}.json`);
writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, type: "final", budget: BUDGET, minTicks: MIN_TICKS, windows: windows.length, results }, null, 1));
console.log(`\n[final] résultats: ${outFile}`);
db.close();