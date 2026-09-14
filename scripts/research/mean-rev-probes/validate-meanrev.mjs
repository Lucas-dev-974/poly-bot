/**
 * Validation du signal mean-reversion : favori qui vient de baisser.
 *
 * Découpe par : bande de prix, taille du drop, âge du marché (elapsed),
 * nombre de fenêtres distinctes. Compte les échantillons PAR FENÊTRE
 * (1 tick par fenêtre max quand même — sinon corrélation intra-fenêtre).
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
      return {
        ts,
        upAsk: up.bestAsk,
        downAsk: down.bestAsk,
        favAsk: Math.min(up.bestAsk, down.bestAsk),
        favIdx: up.bestAsk <= down.bestAsk ? 0 : 1,
      };
    })
    .filter(Boolean);
}

const bands = [
  [0.35, 0.45],
  [0.45, 0.55],
  [0.50, 0.60],
  [0.55, 0.65],
  [0.60, 0.70],
  [0.70, 0.85],
];
const drops = [0.001, 0.01, 0.02, 0.03];
const elapsedBins = [
  [0, 180],
  [180, 360],
  [360, 540],
  [540, 900],
];
const LOOKBACK = 60_000;

// key = `band|drop|elapsedBin` -> {n, win, nWindows}
const agg = new Map();
// per-window summary of the main signal: drop >= 0.01 in 0.50-0.60, elapsed >= 180
const mainSignal = { n: 0, win: 0, windows: new Set() };

for (const w of closed) {
  const winIdx = resolutions.get(w.eventSlug);
  if (winIdx === undefined) continue;
  const series = seriesFor(w.eventSlug, w.windowStart, w.windowEnd);
  if (series.length === 0) continue;

  // échantillon : au plus 1 tick par fenêtre par bucket (premier déclenchement)
  // = mode réaliste « première entrée » d'une stratégie
  const triggered = new Map(); // bucketKey -> first tick
  let firstMain = null;

  let j = 0;
  for (let i = 0; i < series.length; i++) {
    while (series[j].ts <= series[i].ts - LOOKBACK) j++;
    if (j >= i) continue;
    const prev = series[j];
    const cur = series[i];
    const drop = prev.favAsk - cur.favAsk;
    const elapsedSec = cur.ts / 1000 - w.windowStart;
    const band = bands.find(([lo, hi]) => cur.favAsk >= lo && cur.favAsk < hi);
    if (!band) continue;
    const bandKey = `${band[0].toFixed(2)}-${band[1].toFixed(2)}`;
    const elapsedBin = elapsedBins.find(([lo, hi]) => elapsedSec >= lo && elapsedSec < hi);

    for (const d of drops) {
      if (drop < d) continue;
      const key = `${bandKey}|${d}|${elapsedBin ? elapsedBin[0] : "?"}`;
      if (triggered.has(key)) continue;
      triggered.set(key, cur);
    }

    // bucket principal : bande 0.45-0.55, drop >= 0.01, elapsed >= 180
    if (
      cur.favAsk >= 0.45 &&
      cur.favAsk < 0.55 &&
      drop >= 0.01 &&
      elapsedSec >= 180 &&
      firstMain === null
    ) {
      firstMain = cur;
    }
  }
  for (const [key, tick] of triggered) {
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { n: 0, win: 0, windows: new Set() }));
    a.n++;
    a.windows.add(w.eventSlug);
    if (tick.favIdx === winIdx) a.win++;
  }
  if (firstMain) {
    mainSignal.n++;
    mainSignal.windows.add(w.eventSlug);
    if (firstMain.favIdx === winIdx) mainSignal.win++;
  }
  // end
}

const rows = [];
for (const [key, a] of agg) {
  if (a.n < 20) continue;
  const [band, drop, elapsed] = key.split("|");
  rows.push({
    band,
    drop: Number(drop),
    elapsedBin: elapsed + "+",
    n: a.n,
    nWindows: a.windows.size,
    winRate: Number(((a.win / a.n) * 100).toFixed(1)),
    winRateByWindow: Number(
      ((a.win / a.windows.size) * 100).toFixed(1),
    ),
  });
}
rows.sort((x, y) => y.winRate - x.winRate);

const out = {
  phase: "validate-meanrev",
  LOOKBACK,
  mainSignal: {
    n: mainSignal.n,
    nWindows: mainSignal.windows.size,
    win: mainSignal.win,
    winRate: Number(((mainSignal.win / (mainSignal.n || 1)) * 100).toFixed(1)),
  },
  rows: rows.slice(0, 50),
};
const outPath = join(auditDir, `validate-meanrev-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.mainSignal, null, 2));
console.log("--- rows ---");
for (const r of rows.slice(0, 35))
  console.log(`${r.band.padEnd(10)} drop=${r.drop} elapsed=${String(r.elapsedBin).padEnd(5)} n=${String(r.n).padStart(5)} win=${String(r.winRate).padStart(5)}% (windows ${r.nWindows})`);
console.log("OUT", outPath);
