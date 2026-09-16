// Investigation de la 7e position antiflip (déchu 0.50 hors bande) :
// reconstruction tick-par-tick de la fenêtre 1789540200 autour de l'entrée.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/bot-live.db", { readOnly: true });
const SLUG = "btc-updown-15m-1789540200";

const pos = db
  .prepare("SELECT * FROM positions WHERE eventSlug = ? AND strategyId='antiflip-revert'")
  .get(SLUG);
console.log("position:", JSON.stringify({outcome: pos.outcome, fillPrice: pos.fillPrice, limitPrice: pos.limitPrice, size: pos.size, createdAt: new Date(pos.createdAt).toISOString()}));

const orders = db
  .prepare("SELECT * FROM orders WHERE eventSlug = ? ORDER BY ts")
  .all(SLUG);
console.log("\norders:");
for (const o of orders) {
  console.log(
    `  ${o.outcome} ${o.orderType} limit=${o.limitPrice} fill=${o.fillPrice} filled=${o.filled} reason=${o.reason} @ ${new Date(o.ts).toISOString()}`,
  );
}

// book de la fenêtre : 2 ticks autour de l'entrée
const slugStart = Number(SLUG.split("-").pop());
const t0 = pos.createdAt - 60_000;
const t1 = pos.createdAt + 10_000;
const snaps = db
  .prepare(
    `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize FROM book_snapshots
     WHERE eventSlug = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
  )
  .all(SLUG, t0, t1);
const byTs = new Map();
for (const s of snaps) {
  let e = byTs.get(s.ts);
  if (!e) {
    e = {};
    byTs.set(s.ts, e);
  }
  if (s.outcomeIndex === 0) {
    e.upAsk = s.bestAsk;
    e.upBid = s.bestBid;
    e.upSize = s.bestAskSize;
  } else {
    e.downAsk = s.bestAsk;
    e.downBid = s.bestBid;
    e.downSize = s.bestAskSize;
  }
}
console.log("\nbook (5 dernières secondes avant l'entrée + entrée):");
const sorted = [...byTs.entries()].sort((a, b) => a[0] - b[0]);
let prevFav = null;
let lastFlipTs = null;
for (const [ts, e] of sorted) {
  if (e.upAsk == null || e.downAsk == null) continue;
  const fav = e.upAsk >= e.downAsk ? 0 : 1;
  if (prevFav !== null && prevFav !== fav) {
    lastFlipTs = ts;
    console.log(`  FLIP @ ${((ts - slugStart * 1000) / 1000).toFixed(0)}s : now fav=${fav === 0 ? "Up" : "Down"}`);
  }
  prevFav = fav;
  const elapsed = ((ts - slugStart * 1000) / 1000).toFixed(0);
  if (ts >= pos.createdAt - 5000) {
    console.log(
      `  ${((ts - slugStart * 1000) / 1000).toFixed(0)}s | up ${e.upAsk}/${e.upBid} (sz ${e.upSize}) | down ${e.downAsk}/${e.downBid} (sz ${e.downSize})`,
    );
  }
}
const flipAge = lastFlipTs ? (pos.createdAt - lastFlipTs) / 1000 : null;
console.log(`flipAge à l'entrée: ${flipAge?.toFixed(0)}s`);
db.close();