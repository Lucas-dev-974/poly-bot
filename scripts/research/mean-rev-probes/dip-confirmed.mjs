/**
 * Test « dip-buy confirmé » : acheter le FAVORI (pas le cheap) après une
 * baisse puis un début de rebond. Une seule entrée par fenêtre (1er tick validé).
 *
 * Conditions :
 *  - elapsed >= minElapsed
 *  - favori ask dans bande [bandMin, bandMax)
 *  - drop 60s du favori >= minDrop  (le favori VIENT de baisser)
 *  - ask actuel > min(ask sur fenêtre reboundWin) + 0  → rebond confirmé
 *    (le prix a cessé de baisser)
 *  - spread favori <= 0.04 (liquidité)
 *
 * Sortie : win rate hold-to-close, EV par share, nb fenêtres distinctes.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = process.cwd();
const auditDir = join(root, "audits", "arb-backtest", "dip-revert");
const coverageDir = join(root, "audits", "arb-backtest", "coverage");
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
      const fav = favIdx === 0 ? up : down;
      return {
        ts,
        favAsk: fav.bestAsk,
        favBid: fav.bestBid,
        favIdx,
        cheapIdx,
      };
    })
    .filter(Boolean);
}

const LOOKBACK_DROP = 60_000;
const bandMins = [0.45, 0.50, 0.55];
const bandMax = 0.65;
const minDrops = [0.015, 0.02, 0.025, 0.03];
const minElapsedList = [180, 240, 360];
const reboundWinMs = 60_000; // le prix doit être > min des 60 dernières sec = pas en train de baisser

const agg = new Map(); // key -> {n, win, pnl}

for (const w of closed) {
  const winIdx = resolutions.get(w.eventSlug);
  if (winIdx === undefined) continue;
  const series = seriesFor(w.eventSlug, w.windowStart, w.windowEnd);
  if (series.length === 0) continue;

  const firsts = new Map();
  let j = 0;
  const asks = []; // {ts, ask} pour fenêtre glissante de min
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    const elapsedSec = cur.ts / 1000 - w.windowStart;
    asks.push({ ts: cur.ts, ask: cur.favAsk });
    while (asks[0] && asks[0].ts <= cur.ts - reboundWinMs) asks.shift();
    while (series[j].ts <= cur.ts - LOOKBACK_DROP) j++;
    if (j >= i) continue;
    const prev = series[j];
    const drop = prev.favAsk - cur.favAsk;
    const low = Math.min(...asks.map((a) => a.ask));
    const rebound = cur.favAsk > low; // pas au minimum de la fenêtre de rebond

    for (const bmin of bandMins) {
      if (cur.favAsk < bmin || cur.favAsk >= bandMax) continue;
      for (const md of minDrops) {
        if (drop < md) continue;
        if (!rebound) continue;
        for (const mel of minElapsedList) {
          if (elapsedSec < mel) continue;
          if (cur.favBid == null || cur.favAsk - cur.favBid > 0.04) continue;
          const key = `b${bmin}|d${md}|e${mel}`;
          if (!firsts.has(key)) firsts.set(key, cur);
        }
      }
    }
  }

  for (const [key, tick] of firsts) {
    const win = tick.favIdx === winIdx;
    const pnl = win ? 1 - tick.favAsk : -tick.favAsk;
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { n: 0, win: 0, pnl: 0 }));
    a.n++;
    if (win) a.win++;
    a.pnl += pnl;
  }
}

const rows = [];
for (const [key, a] of agg) {
  if (a.n < 20) continue;
  const [b, d, e] = key.split("|");
  const winRate = a.win / a.n;
  rows.push({
    bandMin: Number(b.slice(1)),
    drop: Number(d.slice(1)),
    elapsed: Number(e.slice(1)),
    nWindows: a.n,
    winRate: Number((winRate * 100).toFixed(1)),
    evPerShareCents: Number(((a.pnl / a.n) * 100).toFixed(2)),
  });
}
rows.sort((x, y) => y.evPerShareCents - x.evPerShareCents);

mkdirSync(auditDir, { recursive: true });
const outPath = join(auditDir, `dip-confirmed-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify({ phase: "dip-confirmed", rows: rows.slice(0, 60) }, null, 2));
console.log("=== DIP CONFIRMED (top 25) ===");
for (const r of rows.slice(0, 25))
  console.log(
    `band>=${r.bandMin} drop>=${r.drop} elapsed>=${r.elapsed}s n=${String(r.nWindows).padStart(4)} win=${String(r.winRate).padStart(5)}% EV=${String(r.evPerShareCents).padStart(7)}c/share`,
  );
console.log("OUT", outPath);
