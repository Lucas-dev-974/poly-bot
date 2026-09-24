#!/usr/bin/env node
// 11-bankroll.mjs — Simulation de capital évolutif (banque) pour les finalistes.
//
// Modèle :
//   - Capital initial C0 (par défaut 20 $).
//   - Chaque trade déduit son coût réel (5 shares × ask) du capital.
//   - À la résolution (≤ 5 min), crédite 5 $/share gagnant (hold to resolution).
//   - Un trade est sauté si le capital < coût du trade (jamais observé à 20 $).
//   - Équité suivie trade par trade → courbe de capital, drawdown max.
//
// Deux modes :
//   1. Solo   : chaque stratégie seule avec son propre capital de C0.
//   2. Portfolio : les 3 stratégies se partagent UN capital de C0
//      (dans une même fenêtre, jusqu'à 3 positions concurrentes).
//
// Usage : node 11-bankroll.mjs --capital=20 --budget=2
import { openDb, loadWindows } from "./lib/tickdb.js";
import { buildSweep } from "./lib/variants.js";
import { buildSweepV2 } from "./lib/variants2.js";
import { buildSweepV3 } from "./lib/variants3.js";
import { fillMarketBuy, resolvePnl, round2 } from "./lib/engine-helpers.js";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);
const C0 = Number(args.capital ?? 20);
const BUDGET_CAP = Number(args.budget ?? 2);   // plafond d'engagement par trade
const MAX_SHARES = 5;

const IDS = [
  "A-antiflip-0.3-0.45-d5s-w0.6",
  "H-antiflip-sharp-d0.12-0.3-0.45",
  "K-antiflip-bounce0.08-floor0.4-m0.52",
  "K-antiflip-bounce0.08-floor0.4-m0.6",
];

const db = openDb();
const windows = loadWindows(db, { minTicks: 100 });
const pool = new Map();
for (const s of [...buildSweep(), ...buildSweepV2(), ...buildSweepV3()]) if (!pool.has(s.id)) pool.set(s.id, s);

function solo(strat) {
  let cap = C0, peak = C0, maxDd = 0, trades = 0, skipped = 0;
  let wins = 0, losses = 0, min = C0;
  const curve = [];
  for (const win of windows) {
    const orders = strat.evaluate(win, { budgetPerTrade: BUDGET_CAP, rng: null });
    if (!orders?.length) continue;
    const s = { up: win.ticksUp, down: win.ticksDown };
    for (const o of orders) {
      if (o.kind !== "market") continue;
      const f = fillMarketBuy(null, o.side === 0 ? s.up : s.down, o.ts, o.budgetUsdc, MAX_SHARES);
      if (!f) continue;
      const pos = { side: o.side, shares: f.shares, cost: round2(f.price * f.shares) };
      if (pos.cost > cap) { skipped++; continue; }
      cap = round2(cap - pos.cost);
      trades++;
      const { won, pnl: leg } = resolvePnl(pos, win.winnerIndex);
      cap = round2(cap + pos.shares * (won ? 1 : 0));
      min = Math.min(min, cap);
      peak = Math.max(peak, cap);
      maxDd = Math.max(maxDd, round2(peak - cap));
      if (won) wins++; else losses++;
      curve.push(cap);
    }
  }
  return { id: strat.id, trades, skipped, wins, losses, wr: wins / Math.max(wins + losses, 1), cap0: C0, cap: cap, min: round2(min), maxDd, curve };
}

// Portfolio : les 4 stratégies sur UN capital partagé.
function portfolio(strats) {
  let cap = C0, peak = C0, maxDd = 0, trades = 0, skipped = 0;
  let wins = 0, losses = 0, min = C0;
  const curve = [];
  for (const win of windows) {
    const s = { up: win.ticksUp, down: win.ticksDown };
    const pending = []; // positions de la fenêtre (toutes stratégies)
    for (const strat of strats) {
      const orders = strat.evaluate(win, { budgetPerTrade: BUDGET_CAP, rng: null });
      if (!orders?.length) continue;
      for (const o of orders) {
        if (o.kind !== "market") continue;
        const f = fillMarketBuy(null, o.side === 0 ? s.up : s.down, o.ts, o.budgetUsdc, MAX_SHARES);
        if (!f) continue;
        const pos = { side: o.side, shares: f.shares, cost: round2(f.price * f.shares) };
        if (pos.cost > cap) { skipped++; continue; }
        cap = round2(cap - pos.cost);
        pending.push(pos);
        trades++;
      }
    }
    // Résolution de la fenêtre (≤ 5 min, toutes les positions se règlent ici).
    for (const pos of pending) {
      const { won } = resolvePnl(pos, win.winnerIndex);
      cap = round2(cap + pos.shares * (won ? 1 : 0));
      if (won) wins++; else losses++;
    }
    if (pending.length > 0) {
      min = Math.min(min, cap);
      peak = Math.max(peak, cap);
      maxDd = Math.max(maxDd, round2(peak - cap));
      curve.push(cap);
    }
  }
  return { trades, skipped, wins, losses, wr: wins / Math.max(wins + losses, 1), cap0: C0, cap, min: round2(min), maxDd, curve };
}

const strats = IDS.map((id) => pool.get(id)).filter(Boolean);

console.log(`\n=== SOLO — capital initial ${C0}$, budget/trade ≤ ${BUDGET_CAP}$, 5 shares ===`);
for (const strat of strats) {
  const r = solo(strat);
  console.log(
    `${r.id}: final=${r.cap}$ (${r.cap >= C0 ? "+" : ""}${round2(r.cap - C0)}$) `
    + `trades=${r.trades} wr=${(r.wr * 100).toFixed(1)}% min=${r.min}$ maxDD=${r.maxDd}$ skipped=${r.skipped}`,
  );
}

console.log(`\n=== PORTFOLIO (4 stratégies, un seul capital ${C0}$) ===`);
const p = portfolio(strats);
console.log(`final=${p.cap}$ (${p.cap >= C0 ? "+" : ""}${round2(p.cap - C0)}$) trades=${p.trades} wr=${(p.wr * 100).toFixed(1)}% min=${p.min}$ maxDD=${p.maxDd}$ skipped=${p.skipped}`);

// Courbes d'équité (échantillonnées, pour graphique) : JSON compact.
const sample = (arr, n) => {
  if (arr.length <= n) return arr.map((v) => round2(v));
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * (arr.length - 1)) / (n - 1))]);
  return out;
};
// Export JSON complet (pour rapport canvas).
const OUT = {
  c0: C0,
  budgetCap: BUDGET_CAP,
  solo: strats.map((s) => ({ ...solo(s), curve: sample(solo(s).curve, 60) })),
  portfolio: { ...portfolio(strats), curve: sample(portfolio(strats).curve, 60) },
};
writeFileSync("audits/5min-strategies/results/bankroll-20.json", JSON.stringify(OUT, null, 1));
console.log("[bankroll] export: audits/5min-strategies/results/bankroll-20.json");
db.close();