/**
 * Exploration des données pour trouver un edge de momentum intra-fenêtre.
 *
 * Pour chaque fenêtre conforme (audit > 800 ticks, gaps <= 60s) :
 *   - construit la série du favori (token avec ask le plus bas)
 *   - joint la résolution réelle (market_resolutions)
 *   - mesure par tick : prix favori, momentum lookback (delta ask),
 *     win rate conditionnel et EV d'un achat marketable hold-to-close
 *
 * Usage : node scripts/research/momentum/explore-momentum.mjs
 * Sortie : audits/arb-backtest/explore-momentum-<ts>.json
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.cwd();
const auditDir = join(root, "audits", "arb-backtest", "momentum");
const coverageDir = join(root, "audits", "arb-backtest", "coverage");
const audits = readdirSync(coverageDir)
  .filter((f) => f.startsWith("audit-data-coverage-") && f.endsWith(".json"))
  .sort();
if (audits.length === 0) throw new Error("Aucun audit JSON trouvé");
const auditPath = join(coverageDir, audits[audits.length - 1]);
const audit = JSON.parse(readFileSync(auditPath, "utf8"));
const windows = audit.completeWindows;
const closed = windows.filter((w) => w.windowEnd <= Date.now() / 1000);
console.log(`audit=${auditPath} windows=${windows.length} closed=${closed.length}`);

const db = new DatabaseSync(join(root, "data", "bot-live.db"), { readOnly: true });
const resolutions = new Map(
  db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all()
    .map((r) => [r.eventSlug, r.winnerOutcomeIndex]),
);
console.log(`resolutions chargees=${resolutions.size}`);

function seriesFor(slug, startSec, endSec) {
  const rows = db
    .prepare(
      `SELECT ts, outcomeIndex, bestBid, bestAsk
       FROM book_snapshots
       WHERE eventSlug = ? AND ts BETWEEN ? AND ?
       ORDER BY ts, outcomeIndex`,
    )
    .all(slug, startSec * 1000, endSec * 1000);
  const byTs = new Map();
  for (const r of rows) {
    let e = byTs.get(r.ts);
    if (!e) byTs.set(r.ts, (e = {}));
    e[r.outcomeIndex] = r;
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, pair]) => {
      const up = pair[0];
      const down = pair[1];
      if (!up || !down || up.bestAsk == null || down.bestAsk == null) return null;
      const favAsk = Math.min(up.bestAsk, down.bestAsk);
      const favIdx = up.bestAsk <= down.bestAsk ? 0 : 1;
      const favBid = favIdx === 0 ? up.bestBid : down.bestBid;
      return { ts, favAsk, favBid, favIdx };
    })
    .filter(Boolean);
}

const LOOKBACKS = [60_000, 120_000, 240_000, 360_000];
const priceBands = [
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
];
function bandOf(p) {
  for (const [lo, hi] of priceBands) if (p >= lo && p < hi) return `${lo.toFixed(2)}-${hi.toFixed(2)}`;
  return null;
}

// key = `lk|band|momsign|priceband` -> {n, win, costSum}
const agg = new Map();
const byPriceOnly = new Map();
let totalSamples = 0;
let withLookback = 0;
const windowEdges = [];

for (const w of closed) {
  const winIdx = resolutions.get(w.eventSlug);
  if (winIdx === undefined) continue;
  const series = seriesFor(w.eventSlug, w.windowStart, w.windowEnd);
  if (series.length === 0) continue;

  // par lookback, on garde un index croissant des prix
  for (const lk of LOOKBACKS) {
    let j = 0;
    for (let i = 0; i < series.length; i++) {
      // vieux ticks (plus vieux que lk) en tete de scan
      while (series[j].ts <= series[i].ts - lk) j++;
      if (j >= i) continue; // pas encore d'historique suffisant
      const prev = series[j];
      const cur = series[i];
      totalSamples++;
      withLookback++;
      const mom = cur.favAsk - prev.favAsk;
      const momSign = mom < -0.001 ? "down" : mom > 0.001 ? "up" : "flat";
      const band = bandOf(cur.favAsk);
      if (!band) continue;
      const key = `${lk}|${band}|${momSign}`;
      let a = agg.get(key);
      if (!a) agg.set(key, (a = { n: 0, win: 0, costSum: 0 }));
      a.n++;
      a.costSum += cur.favAsk;
      if (cur.favIdx === winIdx) a.win++;

      const k2 = band;
      let b = byPriceOnly.get(k2);
      if (!b) byPriceOnly.set(k2, (b = { n: 0, win: 0, costSum: 0 }));
      b.n++;
      b.costSum += cur.favAsk;
      if (cur.favIdx === winIdx) b.win++;
    }
  }

  // edge par fenêtre : dernier ~3 min
  const tail = series.slice(-20);
  const lastFavIdx = tail.length ? tail[tail.length - 1].favIdx : series[series.length - 1].favIdx;
  windowEdges.push({
    slug: w.eventSlug,
    winIdx,
    lastFavIdx,
    favWinAtEnd: lastFavIdx === winIdx,
    ticks: series.length,
  });
}

const rows = [];
for (const [key, a] of agg) {
  if (a.n < 50) continue;
  const [lk, band, momSign] = key.split("|");
  const winRate = a.win / a.n;
  const avgCost = a.costSum / a.n;
  const ev = winRate - avgCost;
  rows.push({
    lookback: Number(lk) / 1000 + "s",
    band,
    momentum: momSign,
    n: a.n,
    winRate: Number((winRate * 100).toFixed(1)),
    avgCost,
    ev,
    pnlPerShare: Number((ev * 100).toFixed(2)),
  });
}
rows.sort((a, b) => b.ev - a.ev);

const priceRows = [];
for (const [band, b] of byPriceOnly) {
  if (b.n < 50) continue;
  const winRate = b.win / b.n;
  const avgCost = b.costSum / b.n;
  priceRows.push({
    band,
    n: b.n,
    winRate: Number((winRate * 100).toFixed(1)),
    avgCost: Number(avgCost.toFixed(3)),
    ev: Number((winRate - avgCost).toFixed(3)),
  });
}
priceRows.sort((a, b) => b.ev - a.ev);

const endFavWin = windowEdges.filter((e) => e.favWinAtEnd).length;
const out = {
  phase: "explore-momentum",
  auditPath,
  windowsClosed: closed.length,
  windowsWithResolution: windowEdges.length,
  totalSamples: totalSamples,
  samplesWithLookback: withLookback,
  favHoldsToClose: {
    n: windowEdges.length,
    win: endFavWin,
    winRate: Number(((endFavWin / (windowEdges.length || 1)) * 100).toFixed(1)),
  },
  priceOnly: priceRows,
  momentum: rows.slice(0, 45),
};

mkdirSync(auditDir, { recursive: true });
const outPath = join(auditDir, `explore-momentum-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(JSON.stringify(out.momentum.slice(0, 25), null, 2));
console.log("--- priceOnly ---");
console.log(JSON.stringify(out.priceOnly, null, 2));
console.log("--- favHoldsToClose ---", JSON.stringify(out.favHoldsToClose, null, 2));
console.log("OUT", outPath);
