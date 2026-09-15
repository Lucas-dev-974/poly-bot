// Live position analysis for the dip-revert strategy (trading réel)
// Reads data/bot-live.db read-only, emits stats + a timestamped MD report
// into audits/backtest/dip-revert/.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

const rows = db
  .prepare(
    `SELECT id, eventSlug, eventTitle, kind, fillPrice, sellPrice, size, cost, pnl,
            status, resolvedAt, createdAt, pairId, orderType, outcome
     FROM positions WHERE strategyId = 'dip-revert' ORDER BY createdAt ASC`,
  )
  .all() as any[];

const fmtTime = (ms: number | null) =>
  ms == null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

const round2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);

// ---- aggregates ----
const byStatus = new Map<string, { n: number; pnl: number }>();
let closedPnl = 0;
let wins = 0,
  losses = 0,
  sold = 0,
  open = 0;
let grossWin = 0,
  grossLoss = 0;
let maxWin = -Infinity,
  maxLoss = Infinity;

for (const r of rows) {
  const b = byStatus.get(r.status) ?? { n: 0, pnl: 0 };
  b.n++;
  if (r.pnl != null) b.pnl += r.pnl;
  byStatus.set(r.status, b);
  if (r.status === "open") {
    open++;
    continue;
  }
  const pnl = r.pnl ?? 0;
  closedPnl += pnl;
  if (r.status === "won") {
    wins++;
    grossWin += pnl;
    if (pnl > maxWin) maxWin = pnl;
  } else if (r.status === "lost") {
    losses++;
    grossLoss += pnl;
    if (pnl < maxLoss) maxLoss = pnl;
  } else if (r.status === "sold") {
    sold++;
    grossWin += pnl;
    if (pnl > maxWin) maxWin = pnl;
  }
}

const closed = wins + losses + sold;
const winrateStrict = wins / (wins + losses); // won vs lost only
const winrateWide = (wins + sold) / closed; // sold treated as positive exits
const avgWin = (grossWin + (byStatus.get("sold")?.pnl ?? 0)) / (wins + sold);
const avgLoss = grossLoss / losses;

// ---- daily breakdown (UTC day of createdAt) ----
const byDay = new Map<string, { n: number; wins: number; losses: number; sold: number; pnl: number }>();
for (const r of rows) {
  const day = new Date(r.createdAt).toISOString().slice(0, 10);
  const b = byDay.get(day) ?? { n: 0, wins: 0, losses: 0, sold: 0, pnl: 0 };
  b.n++;
  if (r.pnl != null) b.pnl += r.pnl;
  if (r.status === "won") b.wins++;
  else if (r.status === "lost") b.losses++;
  else if (r.status === "sold") b.sold++;
  byDay.set(day, b);
}

// ---- streaks over closed positions in chronological order ----
let curStreak = 0,
  maxLossStreak = 0,
  maxWinStreak = 0,
  curSign = 0;
for (const r of rows) {
  if (r.status === "open") continue;
  const sign = r.pnl > 0 ? 1 : r.pnl < 0 ? -1 : 0;
  if (sign === curSign && sign !== 0) curStreak++;
  else {
    curSign = sign;
    curStreak = 1;
  }
  if (sign > 0 && curStreak > maxWinStreak) maxWinStreak = curStreak;
  if (sign < 0 && curStreak > maxLossStreak) maxLossStreak = curStreak;
}

// ---- open position ----
const openPos = rows.filter((r) => r.status === "open");

// ---- orders joined via pairId: fill vs kill classification ----
const pairIds = rows.map((r) => r.pairId).filter(Boolean);
const orderStats = new Map<string, number>();
const qs = pairIds.map(() => "?").join(",");
const orderRows = pairIds.length
  ? db
      .prepare(`SELECT reason, COUNT(*) as n FROM orders WHERE pairId IN (${qs}) GROUP BY reason`)
      .all(...pairIds) as any[]
  : [];
for (const o of orderRows) orderStats.set(o.reason, o.n);

// ---- fill price distribution ----
const priceBuckets = new Map<string, number>();
for (const r of rows) {
  const p = r.sellPrice ?? r.fillPrice;
  if (p == null) continue;
  const lo = Math.floor(p * 20) / 20;
  const k = `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
  priceBuckets.set(k, (priceBuckets.get(k) ?? 0) + 1);
}

// ---- report ----
const lines: string[] = [];
lines.push(`# Dip-revert — positions LIVE (bot-live.db)`);
lines.push(``);
lines.push(`Généré: ${new Date().toISOString()} — données: data/bot-live.db (lecture seule)`);
lines.push(``);
lines.push(`## Vue d'ensemble`);
lines.push(``);
lines.push(`| Métrique | Valeur |`);
lines.push(`|---|---|`);
lines.push(`| Positions totales | ${rows.length} |`);
lines.push(`| Closed | ${closed} (won ${wins} / lost ${losses} / sold ${sold}) |`);
lines.push(`| Open | ${open} |`);
lines.push(`| Winrate (won/(won+lost)) | ${(winrateStrict * 100).toFixed(1)}% |`);
lines.push(`| Winrate (sold positif inclus) | ${(winrateWide * 100).toFixed(1)}% |`);
lines.push(`| PnL closed cumulé | ${round2(closedPnl)} USDC |`);
lines.push(`| PnL moyen / position | ${round2(closedPnl / closed)} USDC |`);
lines.push(`| Gain moyen (won+sold) | ${round2(avgWin)} USDC |`);
lines.push(`| Perte moyenne (lost) | ${round2(avgLoss)} USDC |`);
lines.push(`| Profit factor | ${(grossWin / Math.abs(grossLoss)).toFixed(2)} |`);
lines.push(`| Meilleure / pire trade | ${round2(maxWin)} / ${round2(maxLoss)} |`);
lines.push(`| Max win streak / max loss streak | ${maxWinStreak} / ${maxLossStreak} |`);
lines.push(``);
lines.push(`## Breakdown par jour (UTC)`);
lines.push(``);
lines.push(`| Jour | Positions | Won | Lost | Sold | PnL |`);
lines.push(`|---|---|---|---|---|---|`);
for (const [day, b] of [...byDay.entries()].sort()) {
  lines.push(`| ${day} | ${b.n} | ${b.wins} | ${b.losses} | ${b.sold} | ${round2(b.pnl)} |`);
}
lines.push(``);
lines.push(`## Raison des ordres liés (via pairId)`);
lines.push(``);
for (const [reason, n] of [...orderStats.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`- \`${reason}\`: ${n}`);
}
lines.push(``);
lines.push(`## Buckets de prix d'entrée (fillPrice, pas de 0.05)`);
lines.push(``);
for (const [k, n] of [...priceBuckets.entries()].sort()) lines.push(`- ${k}: ${n}`);
lines.push(``);
if (openPos.length) {
  lines.push(`## Position(s) ouverte(s)`);
  lines.push(``);
  for (const r of openPos) {
    lines.push(
      `- ${r.eventSlug} ${r.outcome} size=${r.size} cost=${r.cost} fill=${r.fillPrice} ouverte ${fmtTime(r.createdAt)}`,
    );
  }
  lines.push(``);
}
lines.push(`## Détail des 20 dernières positions closed`);
lines.push(``);
lines.push(`| ts (UTC) | slug | outcome | fill | pnl | status |`);
lines.push(`|---|---|---|---|---|---|`);
for (const r of rows.filter((x) => x.status !== "open").slice(-20).reverse()) {
  lines.push(
    `| ${fmtTime(r.createdAt)} | ${r.eventSlug} | ${r.outcome} | ${r.fillPrice} | ${round2(r.pnl)} | ${r.status} |`,
  );
}

const md = lines.join("\n");
const ts = Date.now();
mkdirSync("audits/backtest/dip-revert", { recursive: true });
writeFileSync(`audits/backtest/dip-revert/live-positions-${ts}.md`, md);
console.log(md);
db.close();