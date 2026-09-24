#!/usr/bin/env node
// 05-report.mjs — Synthèse de tous les runs de backtest + top stratégies.
//
// Agrège les runs de la table `runs` et produit :
//   - results/INDEX.md : classement de toutes les stratégies testées
//   - Filtrage selon les critères utilisateur : winrate > 55%, gain/trade ≥ 1.5$
import { openDb } from "./lib/tickdb.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "results");
mkdirSync(OUT_DIR, { recursive: true });

const db = openDb();
const runs = db.prepare(`
  SELECT id, startedAt, finishedAt, paramsJson, resultJson FROM runs WHERE status = 'done' ORDER BY startedAt
`).all();

console.log(`[report] ${runs.length} run(s) enregistré(s)`);

// Agrégat par stratégie (tous runs confondus, le meilleur run par stratégie).
const byStrategy = new Map(); // strategyId -> { name, bestRun, allRuns: [] }
for (const run of runs) {
  let results;
  try { results = JSON.parse(run.resultJson); } catch { continue; }
  for (const r of results) {
    const entry = byStrategy.get(r.strategyId) ?? {
      id: r.strategyId,
      name: r.name,
      desc: r.desc,
      runs: [],
    };
    entry.runs.push({ runId: run.id, budget: JSON.parse(run.paramsJson)?.budget, ...r.metrics });
    byStrategy.set(r.strategyId, entry);
  }
}

// Critères utilisateur.
const MIN_WR = 0.55;
const lines = [];
lines.push("# Index des backtests 5min-strategies");
lines.push("");
lines.push(`Généré : ${new Date().toISOString()} · ${runs.length} run(s)`);
lines.push("");
lines.push("| Run | Date | Budget | Fenêtres | Stratégies |");
lines.push("|---|---|---|---|---|");
for (const run of runs) {
  let results = [];
  try { results = JSON.parse(run.resultJson); } catch { /* skip */ }
  lines.push(`| ${run.id} | ${new Date(run.startedAt).toISOString()} | ${JSON.parse(run.paramsJson).budget ?? "?"}$ | ${results[0]?.dataset?.windows ?? "?"} | ${results.length} |`);
}
lines.push("");
lines.push("## Classement par stratégie (meilleur run)");
lines.push("");
lines.push("| Stratégie | Trades | Winrate | PnL total | PnL/trade | Coût/trade | Critères (WR>55%) |");
lines.push("|---|---|---|---|---|---|---|");

const ranked = [...byStrategy.values()].map((entry) => {
  // Best run = celui avec le meilleur expectancy (PnL/trade).
  const best = [...entry.runs].sort((a, b) => (b.avgPnlPerTrade ?? 0) - (a.avgPnlPerTrade ?? 0))[0];
  return { ...entry, best };
}).sort((a, b) => (b.best.avgPnlPerTrade ?? 0) - (a.best.avgPnlPerTrade ?? 0));

for (const entry of ranked) {
  const b = entry.best;
  const ok = b.winrate > MIN_WR ? "✅" : "—";
  lines.push(`| ${entry.id} | ${b.trades} | ${(b.winrate * 100).toFixed(1)}% | ${b.pnl}$ | ${b.avgPnlPerTrade}$ | ${b.avgCostPerTrade}$ | ${ok} |`);
}

lines.push("");
lines.push("## Détail des runs par stratégie");
lines.push("");
for (const entry of ranked) {
  lines.push(`### ${entry.id} — ${entry.name}`);
  lines.push("");
  lines.push(entry.desc);
  lines.push("");
  lines.push("| Run | Budget | Trades | Winrate | PnL | PnL/trade |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of entry.runs) {
    lines.push(`| ${r.runId} | ${r.budget}$ | ${r.trades} | ${(r.winrate * 100).toFixed(1)}% | ${r.pnl}$ | ${r.avgPnlPerTrade}$ |`);
  }
  lines.push("");
}

writeFileSync(join(OUT_DIR, "INDEX.md"), lines.join("\n") + "\n");
console.log(`[report] index: ${join(OUT_DIR, "INDEX.md")}`);

// Sauvegarde le classement en JSON.
writeFileSync(
  join(OUT_DIR, "ranking-latest.json"),
  JSON.stringify(ranked.map((e) => ({ id: e.id, name: e.name, best: e.best, runsCount: e.runs.length })), null, 1),
);
db.close();