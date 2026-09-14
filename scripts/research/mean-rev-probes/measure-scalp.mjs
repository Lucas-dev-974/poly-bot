/**
 * Mesure de la capturabilité du scalping mean-reversion sur le token cheap.
 *
 * Règle candidate (« dip-buy + take-profit ») :
 *   ENTRÉE : elapsed >= 240s, ask(cheap) <= buyMax, favorite ask >= favMin,
 *            spread cheap <= 0.04 (liquidité), achat GTC maker à limit(ask).
 *   SORTIE : dès que bid(cheap) >= achat + takeProfit → vendre tout.
 *            Sinon hold jusqu'à résolution.
 *
 * On mesure pour chaque fenêtre le 1er déclenchement et sa suite.
 * Sortie : taux de take-profit, gain moyen, perte moyenne, EV/share.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.cwd();
const auditDir = join(root, "audits", "backtest", "momentum");
const coverageDir = join(root, "audits", "backtest", "coverage");
const audits = readdirSync(coverageDir)
  .filter((f) => f.startsWith("audit-data-coverage-") && f.endsWith(".json"))
  .sort();
const windowList = JSON.parse(
  readFileSync(join(coverageDir, audits[audits.length - 1]), "utf8"),
).completeWindows;
const closed = windowList.filter((w) => w.windowEnd <= Date.now() / 1000);

const db = new DatabaseSync(join(root, "data", "bot-live.db"), { readOnly: true });
const resolutions = new Map(
  db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all()
    .map((r) => [r.eventSlug, r.winnerOutcomeIndex]),
);

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
      const cheapIdx = up.bestAsk <= down.bestAsk ? 0 : 1;
      const favIdx = cheapIdx === 0 ? 1 : 0;
      const cheap = cheapIdx === 0 ? up : down;
      const fav = cheapIdx === 0 ? down : up;
      return {
        ts,
        cheapAsk: cheap.bestAsk,
        cheapBid: cheap.bestBid,
        cheapIdx,
        favAsk: fav.bestAsk,
      };
    })
    .filter(Boolean);
}

const MIN_ELAPSED = 240;
const spreadCap = [0.02, 0.03, 0.04];
const buyMax = [0.30, 0.35, 0.40];
const favMin = [0.55, 0.60];
const takeProfit = [0.02, 0.03, 0.04];

// key = `elapsed|buyMax|favMin|spread|tp` -> stats
const agg = new Map();
const tradeLog = [];

for (const w of closed) {
  const winIdx = resolutions.get(w.eventSlug);
  if (winIdx === undefined) continue;
  const series = seriesFor(w.eventSlug, w.windowStart, w.windowEnd);
  if (series.length === 0) continue;

  const firsts = new Map(); // bucketKey -> {i, buyPrice, cheapIdx}

  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    const elapsedSec = cur.ts / 1000 - w.windowStart;
    if (elapsedSec < MIN_ELAPSED) continue;
    for (const max of buyMax) {
      if (cur.cheapAsk > max) continue;
      for (const fmin of favMin) {
        if (cur.favAsk < fmin) continue;
        for (const sc of spreadCap) {
          if (cur.cheapBid == null || cur.cheapAsk - cur.cheapBid > sc) continue;
          for (const tp of takeProfit) {
            const key = `${MIN_ELAPSED}|${max}|${fmin}|${sc}|${tp}`;
            if (firsts.has(key)) continue;
            firsts.set(key, { i, buyPrice: cur.cheapAsk, cheapIdx: cur.cheapIdx });
          }
        }
      }
    }
  }

  for (const [key, entry] of firsts) {
    // suite : cherche le 1er tick où bid cheap >= buyPrice + tp
    let sold = false;
    let sellPrice = null;
    for (let i = entry.i + 1; i < series.length; i++) {
      const cur = series[i];
      if (cur.cheapIdx !== entry.cheapIdx) continue;
      if (cur.cheapBid != null && cur.cheapBid >= entry.buyPrice + Number(key.split("|")[4])) {
        sold = true;
        sellPrice = cur.cheapBid;
        break;
      }
    }
    const win = sold ? 1 : entry.cheapIdx === winIdx ? 1 : 0;
    const pnlPerShare = sold
      ? sellPrice - entry.buyPrice
      : win
        ? 1 - entry.buyPrice
        : -entry.buyPrice;
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { n: 0, sold: 0, win: 0, pnl: 0 }));
    a.n++;
    if (sold) a.sold++;
    if (win) a.win++;
    a.pnl += pnlPerShare;
    if (tradeLog.length < 4000) tradeLog.push({ key, slug: w.eventSlug, buy: entry.buyPrice, sold, sellPrice, pnl: pnlPerShare });
  }
}

const rows = [];
for (const [key, a] of agg) {
  if (a.n < 20) continue;
  const [elapsed, buyMax, favMin, spread, tp] = key.split("|");
  rows.push({
    buyMax: buyMax,
    favMin: favMin,
    spreadCap: spread,
    takeProfit: tp,
    nWindows: a.n,
    soldPct: Number(((a.sold / a.n) * 100).toFixed(1)),
    winPct: Number(((a.win / a.n) * 100).toFixed(1)),
    evPerShareCents: Number(((a.pnl / a.n) * 100).toFixed(2)),
  });
}
rows.sort((x, y) => y.evPerShareCents - x.evPerShareCents);

const out = {
  phase: "measure-scalp",
  minElapsed: MIN_ELAPSED,
  rows: rows.slice(0, 40),
};
mkdirSync(auditDir, { recursive: true });
const outPath = join(auditDir, `measure-scalp-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("=== SCALP measure (top 25) ===");
for (const r of out.rows.slice(0, 25))
  console.log(
    `buy<=${r.buyMax} fav>=${r.favMin} spread<=${r.spreadCap} tp=${r.takeProfit} n=${String(r.nWindows).padStart(4)} sold=${String(r.soldPct).padStart(5)}% win=${String(r.winPct).padStart(5)}% EV=${String(r.evPerShareCents).padStart(7)}c/share`,
  );
console.log("OUT", outPath);
