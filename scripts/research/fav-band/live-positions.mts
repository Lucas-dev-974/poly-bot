// Live position analysis for the fav-band strategy (trading réel)
// Reads data/bot-live.db read-only, emits stats + a timestamped MD report
// into audits/backtest/fav-band/. Reusable: swap the strategyId filter.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });

const rows = db
  .prepare(
    `SELECT id, eventSlug, eventTitle, kind, fillPrice, sellPrice, size, cost, pnl,
            status, resolvedAt, createdAt, pairId, orderType, outcome
     FROM positions WHERE strategyId = 'fav-band' ORDER BY createdAt ASC`,
  )
  .all() as any[];

const fmtTime = (ms: number | null) =>
  ms == null ? "-" : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

const round2 = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);

// slug: {asset}-updown-{dur}{m|h}-{windowStartSec10}
const parseSlug = (slug: string) => {
  const m = slug.match(/-updown-(\d+)(m|h)-(\d{10})$/);
  if (!m) return null;
  return {
    durationSec: Number(m[1]) * (m[2] === "h" ? 3600 : 60),
    windowStartSec: Number(m[3]),
  };
};

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
const winrateStrict = closed > 0 ? wins / (wins + losses) : 0;
const winrateWide = closed > 0 ? (wins + sold) / closed : 0;
const avgWin = wins + sold > 0 ? (grossWin + (byStatus.get("sold")?.pnl ?? 0)) / (wins + sold) : 0;
const avgLoss = losses > 0 ? grossLoss / losses : 0;

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

// ---- streaks ----
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

// ---- entry timing (createdAt - windowStart) correlated with PnL ----
const elapsedBuckets = new Map<string, { n: number; wins: number; losses: number; pnl: number }>();
let parsedFail = 0;
for (const r of rows) {
  if (r.status === "open") continue;
  const p = parseSlug(r.eventSlug);
  if (!p) {
    parsedFail++;
    continue;
  }
  const elapsed = (r.createdAt - p.windowStartSec * 1000) / 1000;
  const lo = Math.floor(elapsed / 100) * 100;
  const k = `${lo}-${lo + 100}s`;
  const b = elapsedBuckets.get(k) ?? { n: 0, wins: 0, losses: 0, pnl: 0 };
  b.n++;
  if (r.pnl != null) b.pnl += r.pnl;
  if (r.status === "won") b.wins++;
  else if (r.status === "lost") b.losses++;
  elapsedBuckets.set(k, b);
}

// ---- entry price buckets (0.05) with win counts + band check ----
const BAND_MIN = 0.6;
const BAND_MAX = 0.74;
const priceBuckets = new Map<string, { n: number; wins: number; pnl: number }>();
const bandOut: any[] = [];
for (const r of rows) {
  if (r.status === "open") continue;
  const p = r.fillPrice;
  if (p == null) continue;
  const lo = Math.floor(p * 20) / 20;
  const k = `${lo.toFixed(2)}-${(lo + 0.05).toFixed(2)}`;
  const b = priceBuckets.get(k) ?? { n: 0, wins: 0, pnl: 0 };
  b.n++;
  if (r.pnl != null) b.pnl += r.pnl;
  if (r.status === "won") b.wins++;
  priceBuckets.set(k, b);
  if (p > BAND_MAX + 0.005 || p < BAND_MIN - 0.06) {
    bandOut.push(r);
  }
}

// ---- orders classification (via pairId) ----
const pairIds = rows.map((r) => r.pairId).filter(Boolean);
const orderStats = new Map<string, number>();
const qs = pairIds.map(() => "?").join(",");
const orderRows = pairIds.length
  ? db
      .prepare(`SELECT reason, COUNT(*) as n FROM orders WHERE pairId IN (${qs}) GROUP BY reason`)
      .all(...pairIds) as any[]
  : [];
for (const o of orderRows) orderStats.set(o.reason, o.n);

// ---- resolution delay (resolvedAt - windowEnd) ----
const resDelays: number[] = [];
for (const r of rows) {
  if (r.status !== "won" && r.status !== "lost") continue;
  const p = parseSlug(r.eventSlug);
  if (!p || r.resolvedAt == null) continue;
  const delay = (r.resolvedAt - (p.windowStartSec + p.durationSec) * 1000) / 1000;
  resDelays.push(delay);
}
resDelays.sort((a, b) => a - b);
const resP50 = resDelays.length ? resDelays[Math.floor(resDelays.length / 2)] : null;
const resP95 = resDelays.length ? resDelays[Math.floor(resDelays.length * 0.95)] : null;
const resMax = resDelays.length ? resDelays[resDelays.length - 1] : null;

// ---- open position ----
const openPos = rows.filter((r) => r.status === "open");

// ---- report ----
const lines: string[] = [];
lines.push(`# Fav-band — positions LIVE (bot-live.db)`);
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
lines.push(`| Winrate strict (won/(won+lost)) | ${(winrateStrict * 100).toFixed(1)}% |`);
lines.push(`| Winrate large (sold positif inclus) | ${(winrateWide * 100).toFixed(1)}% |`);
lines.push(`| PnL closed cumulé | ${round2(closedPnl)} USDC |`);
lines.push(`| PnL moyen / position closed | ${round2(closedPnl / closed)} USDC |`);
lines.push(`| Gain moyen (won+sold) | ${round2(avgWin)} USDC |`);
lines.push(`| Perte moyenne (lost) | ${round2(avgLoss)} USDC |`);
lines.push(`| Profit factor | ${(grossWin / Math.abs(grossLoss)).toFixed(2)} |`);
lines.push(`| Meilleure / pire trade | ${round2(maxWin)} / ${round2(maxLoss)} |`);
lines.push(`| Max win streak / max loss streak | ${maxWinStreak} / ${maxLossStreak} |`);
lines.push(`| Résolution p50 / p95 / max (s après windowEnd) | ${resP50?.toFixed(0)} / ${resP95?.toFixed(0)} / ${resMax?.toFixed(0)} |`);
lines.push(``);
lines.push(`## Breakdown par jour (UTC)`);
lines.push(``);
lines.push(`| Jour | Positions | Won | Lost | Sold | PnL |`);
lines.push(`|---|---|---|---|---|---|`);
for (const [day, b] of [...byDay.entries()].sort()) {
  lines.push(`| ${day} | ${b.n} | ${b.wins} | ${b.losses} | ${b.sold} | ${round2(b.pnl)} |`);
}
lines.push(``);
lines.push(`## Timing d'entrée (elapsed depuis windowStart, buckets 100s)`);
lines.push(``);
lines.push(`| Bucket | Trades | Won | Lost | PnL |`);
lines.push(`|---|---|---|---|---|`);
for (const [k, b] of [...elapsedBuckets.entries()].sort()) {
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${b.losses} | ${round2(b.pnl)} |`);
}
lines.push(``);
lines.push(`## Buckets de prix d'entrée (fillPrice, pas de 0.05) — bande live [${BAND_MIN}, ${BAND_MAX}]`);
lines.push(``);
lines.push(`| Bucket | Trades | Won | PnL |`);
lines.push(`|---|---|---|---|`);
for (const [k, b] of [...priceBuckets.entries()].sort()) {
  lines.push(`| ${k} | ${b.n} | ${b.wins} | ${round2(b.pnl)} |`);
}
lines.push(``);
lines.push(`## Raison des ordres liés (via pairId)`);
lines.push(``);
for (const [reason, n] of [...orderStats.entries()].sort((a, b) => b[1] - a[1])) {
  lines.push(`- \`${reason}\`: ${n}`);
}
lines.push(``);
lines.push(`## Fills hors bande`);
lines.push(``);
if (bandOut.length === 0) {
  lines.push(`Aucun fill hors bande (amélioration de prix légère sous ${BAND_MIN} tolérée).`);
} else {
  lines.push(`${bandOut.length} fill(s) hors bande — à reconstruire depuis orders + book_snapshots :`);
  for (const r of bandOut.slice(0, 20)) {
    lines.push(`- ${fmtTime(r.createdAt)} ${r.eventSlug} fill=${r.fillPrice} pnl=${round2(r.pnl)} ${r.status}`);
  }
}
lines.push(``);
if (openPos.length) {
  lines.push(`## Position(s) ouverte(s)`);
  lines.push(``);
  for (const r of openPos) {
    const age = ((Date.now() - r.createdAt) / 60000).toFixed(0);
    lines.push(`- ${r.eventSlug} ${r.outcome} size=${r.size} cost=${r.cost} fill=${r.fillPrice} ouverte depuis ${age} min`);
  }
  lines.push(``);
}
lines.push(`## Détail des 20 dernières positions closed`);
lines.push(``);
lines.push(`| ts (UTC) | slug | outcome | fill | sell | pnl | status |`);
lines.push(`|---|---|---|---|---|---|---|`);
for (const r of rows.filter((x) => x.status !== "open").slice(-20).reverse()) {
  lines.push(
    `| ${fmtTime(r.createdAt)} | ${r.eventSlug} | ${r.outcome} | ${r.fillPrice} | ${r.sellPrice ?? "-"} | ${round2(r.pnl)} | ${r.status} |`,
  );
}

const md = lines.join("\n");
const ts = Date.now();
mkdirSync("audits/backtest/fav-band", { recursive: true });
writeFileSync(join("audits", "backtest", "fav-band", `live-positions-${ts}.md`), md);
console.log(md);
console.log(`\n[report] audits/backtest/fav-band/live-positions-${ts}.md`);
db.close();