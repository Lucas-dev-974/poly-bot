/**
 * Mesure scalping avec double sortie (take-profit + stop-loss).
 *
 * ENTRÉE : elapsed >= 240s, ask(cheap) <= buyMax, favourite ask >= favMin,
 *          spread cheap <= spreadCap. Achat à l'ask (maker agressif).
 * SORTIES : TP si bid(cheap) >= buy + tp ; SL si bid(cheap) <= buy*slFactor ;
 *           sinon hold jusqu'à résolution (perte = -buy si perd, 1-buy sinon).
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

const MIN_ELAPSED = 240;
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

const buyMaxs = [0.25, 0.30, 0.35, 0.40];
const favMins = [0.55, 0.60];
const spreadCaps = [0.02, 0.04];
const tps = [0.02, 0.03, 0.05];
const sls = [0.5, 0.6, 0.7];

const agg = new Map();

for (const w of closed) {
  const winIdx = resolutions.get(w.eventSlug);
  if (winIdx === undefined) continue;
  const series = seriesFor(w.eventSlug, w.windowStart, w.windowEnd);
  if (series.length === 0) continue;

  const firsts = new Map();
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    const elapsedSec = cur.ts / 1000 - w.windowStart;
    if (elapsedSec < MIN_ELAPSED) continue;
    for (const max of buyMaxs) {
      if (cur.cheapAsk > max) continue;
      for (const fmin of favMins) {
        if (cur.favAsk < fmin) continue;
        for (const sc of spreadCaps) {
          if (cur.cheapBid == null || cur.cheapAsk - cur.cheapBid > sc) continue;
          for (const tp of tps) {
            for (const sl of sls) {
              const key = `${max}|${fmin}|${sc}|${tp}|${sl}`;
              if (!firsts.has(key)) firsts.set(key, { i, buy: cur.cheapAsk, idx: cur.cheapIdx });
            }
          }
        }
      }
    }
  }

  for (const [key, entry] of firsts) {
    const [, , , tpStr, slStr] = key.split("|").map(Number);
    const tp = tpStr;
    const sl = slStr;
    let exit = null; // 'tp' | 'sl'
    let sellPrice = null;
    for (let i = entry.i + 1; i < series.length; i++) {
      const cur = series[i];
      if (cur.cheapIdx !== entry.idx) continue;
      if (cur.cheapBid != null && cur.cheapBid >= entry.buy + tp) {
        exit = "tp";
        sellPrice = cur.cheapBid;
        break;
      }
      if (cur.cheapBid != null && cur.cheapBid <= entry.buy * sl) {
        exit = "sl";
        sellPrice = cur.cheapBid;
        break;
      }
    }
    const heldWin = exit === null && entry.idx === winIdx;
    const pnl = exit === "tp" ? sellPrice - entry.buy : exit === "sl" ? sellPrice - entry.buy : heldWin ? 1 - entry.buy : -entry.buy;
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { n: 0, tp: 0, sl: 0, heldWin: 0, pnl: 0 }));
    a.n++;
    if (exit === "tp") a.tp++;
    if (exit === "sl") a.sl++;
    if (heldWin) a.heldWin++;
    a.pnl += pnl;
  }
}

const rows = [];
for (const [key, a] of agg) {
  if (a.n < 20) continue;
  const [max, fmin, sc, tp, sl] = key.split("|");
  rows.push({
    buyMax: Number(max),
    favMin: Number(fmin),
    spreadCap: Number(sc),
    tp: Number(tp),
    sl: Number(sl),
    nWindows: a.n,
    tpPct: Number(((a.tp / a.n) * 100).toFixed(1)),
    slPct: Number(((a.sl / a.n) * 100).toFixed(1)),
    heldWinPct: Number(((a.heldWin / a.n) * 100).toFixed(1)),
    evPerShareCents: Number(((a.pnl / a.n) * 100).toFixed(2)),
  });
}
rows.sort((x, y) => y.evPerShareCents - x.evPerShareCents);

mkdirSync(auditDir, { recursive: true });
const outPath = join(auditDir, `measure-scalp-tpsl-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ phase: "scalp-tpsl", minElapsed: MIN_ELAPSED, rows: rows.slice(0, 60) }, null, 2));
console.log("=== SCALP TP+SL (top 25) ===");
for (const r of rows.slice(0, 25))
  console.log(
    `buy<=${r.buyMax} fav>=${r.favMin} spr<=${r.spreadCap} tp=${r.tp} sl=${r.sl} n=${String(r.nWindows).padStart(4)} tp=${String(r.tpPct).padStart(5)}% sl=${String(r.slPct).padStart(4)}% heldW=${String(r.heldWinPct).padStart(4)}% EV=${String(r.evPerShareCents).padStart(7)}c/share`,
  );
console.log("OUT", outPath);
