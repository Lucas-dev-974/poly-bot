/**
 * Analyse de calibration — où le marché 15m se trompe-t-il systématiquement ?
 *
 * READ-ONLY sur data/bot-live.db. Univers : fenêtres complètes (801+ ticks,
 * gap <= 60s) AVEC résolution connue.
 *
 * Question posée : pour un état observable à l'instant T (prix du favori,
 * elapsed, ask-sum, momentum, retournement), quelle est la probabilité
 * RÉELLE que le favori courant gagne, vs la probabilité impliquée par le
 * marché ? Le gap (miscalibration) = l'edge exploitable par une stratégie.
 *
 * Axes mesurés (un échantillon par fenêtre/état — PAS par tick, cf. skill :
 * per-tick inflates par corrélation intra-fenêtre) :
 *   1. Calibration favorite-ask -> win (par tranche d'elapsed, par tranche de prix)
 *   2. Calibration ask-sum (marché sûr) -> win
 *   3. Reversal : favori qui vient de FLIPPER -> win
 *   4. Momentum vs reversion : favori montant/descendant -> win
 *   5. Open-gap : état initial de la fenêtre (premiers 60s) -> outcome
 *
 * Sortie : JSON dans audits/backtest/research-new-strats/
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB = "data/bot-live.db";
const OUT_DIR = join("audits", "backtest", "research-new-strats");

function completeWindows(db: DatabaseSync) {
  const windows = db
    .prepare(
      `SELECT eventSlug AS slug, MAX(windowStart) AS ws, MAX(windowEnd) AS we,
              COUNT(DISTINCT ts) AS ticks
       FROM market_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'
       GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= 801`,
    )
    .all() as Array<{ slug: string; ws: number; we: number; ticks: number }>;
  const gapStmt = db.prepare(
    `WITH t AS (SELECT DISTINCT ts FROM market_snapshots WHERE eventSlug = ?)
     SELECT MAX(d) AS g FROM
       (SELECT ts - LAG(ts) OVER (ORDER BY ts) AS d FROM t)`,
  );
  return windows.filter((w) => {
    const g = gapStmt.get(w.slug) as { g: number | null };
    return (g.g ?? 0) <= 60_000;
  });
}

function loadTicks(db: DatabaseSync, slug: string) {
  const rows = db
    .prepare(
      `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize, bestBidSize
       FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
    )
    .all(slug) as Array<{
    ts: number;
    outcomeIndex: number;
    bestAsk: number | null;
    bestBid: number | null;
    bestAskSize: number | null;
    bestBidSize: number | null;
  }>;
  const byTs = new Map<number, { up: S; down: S }>();
  const blank = (): S => ({ ask: null, bid: null, askSize: null, bidSize: null });
  for (const r of rows) {
    let e = byTs.get(r.ts);
    if (!e) {
      e = { up: blank(), down: blank() };
      byTs.set(r.ts, e);
    }
    const side = r.outcomeIndex === 0 ? e.up : e.down;
    side.ask = r.bestAsk;
    side.bid = r.bestBid;
    side.askSize = r.bestAskSize;
    side.bidSize = r.bestBidSize;
  }
  const ticks: T[] = [];
  for (const [ts, b] of byTs) {
    if (b.up.ask == null && b.down.ask == null) continue;
    ticks.push({ ts, up: b.up, down: b.down });
  }
  return ticks;
}

interface S {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
  bidSize: number | null;
}
interface T {
  ts: number;
  up: S;
  down: S;
}

// ---------- Bucketing helpers ----------
function bucketElapsed(sec: number): string {
  if (sec < 60) return "0-60";
  if (sec < 120) return "60-120";
  if (sec < 180) return "120-180";
  if (sec < 240) return "240-360";
  return "360+";
}
function bucketAsk(ask: number): string {
  if (ask < 0.30) return "<0.30";
  if (ask < 0.40) return "0.30-0.40";
  if (ask < 0.50) return "0.40-0.50";
  if (sec_ask(ask)) return "0.50-0.60";
  return ">=0.60";
}
function sec_ask(ask: number): boolean {
  return ask < 0.60;
}

function bucketMomentum(d: number): string {
  if (d <= -0.05) return "drop<=-5c";
  if (d <= -0.02) return "drop-5..-2c";
  if (d < 0.02) return "flat";
  if (d < 0.05) return "rise2..5c";
  return "rise>=5c";
}

// generic aggregator
class Agg {
  n = 0;
  wins = 0;
  add(win: boolean) {
    this.n++;
    if (win) this.wins++;
  }
}

interface Sample {
  favAsk: number;
  elapsed: number;
  askSum: number;
  momentum: number; // favAsk - favAsk N ticks before
  flippedRecently: boolean;
  won: boolean;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const db = new DatabaseSync(DB, { readOnly: true });

  const wins = completeWindows(db);
  const resRows = db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));

  let nResolved = 0;
  const calibFavAsk: Record<string, Agg> = {};
  const calibByElapsed: Record<string, Record<string, Agg>> = {};
  const calibAskSum: Record<string, Agg> = {};
  const calibFlip: Record<string, Agg> = {};
  const calibMomentum: Record<string, Agg> = {};
  // reversal = fav at elapsed in [180,420] that flipped within last 60s
  const calibReversal: Record<string, Agg> = {};
  const openState: Record<string, Agg> = first60OpenState();

  function first60OpenState(): Record<string, Agg> {
    return {};
  }

  const elapsedBuckets = ["0-60", "60-120", "120-180", "240-360", "360+"];
  for (const b of elapsedBuckets) calibByElapsed[b] = {};

  for (const w of wins) {
    const res = resMap.get(w.slug);
    if (res === undefined) continue;
    nResolved++;
    const ticks = loadTicks(db, w.slug);
    if (ticks.length === 0) continue;
    const wsMs = w.ws * 1000;

    // track favorite over time
    let lastFlipIdx = -1;
    const favHist: Array<{ i: number; favIdx: number }> = [];
    let prevFavIdx: 0 | 1 | null = null;
    const favAsks: number[] = [];
    const samplesByElapsed: Record<string, { favAsk: number; flippedRecently: boolean; momentum: number }> = {};

    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i];
      const favIdx: 0 | 1 =
        t.up.ask != null && (t.down.ask == null || t.up.ask >= t.down.ask) ? 0 : 1;
      const favAsk = favIdx === 0 ? t.up.ask : t.down.ask;
      if (favAsk == null) continue;
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;

      if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipIdx = i;
      prevFavIdx = favIdx;

      // momentum: change over last ~30 ticks
      const m = i >= 30 ? favAsk - (favAsks[i - 30] ?? favAsk) : 0;

      const bE = bucketElapsed(elapsed);
      const flippedRecently = lastFlipIdx >= 0 && i - lastFlipIdx <= 60;
      samplesByElapsed[bE] = { favAsk, flippedRecently, momentum: m };

      (calibFavAsk[bucketAsk(favAsk)] ??= new Agg()).add(favIdx === res);
      ((calibByElapsed[bE] ??= {})[bucketAsk(favAsk)] ??= new Agg()).add(favIdx === res);
      (calibAskSum[bucketAskSum(t.up.ask, t.down.ask)] ??= new Agg()).add(favIdx === res);
      (calibFlip[flippedRecently ? "recent-flip" : "stable"] ??= new Agg).add(favIdx === res);
      (calibMomentum[bucketMomentum(m)] ??= new Agg()).add(favIdx === res);
      // "reversal candidate": fav flipped recently AND favAsk in mid band
      if (flippedRecently && favAsk >= 0.45 && favAsk < 0.65) {
        (calibReversal["flip+mid-band"] ??= new Agg()).add(favIdx === res);
      }
      (calibFavAsk[bucketAsk(favAsk)] ??= new Agg()).add(favAnalysis(favIdx, res));
    }

    // first 60s state -> outcome
    const first = ticks.find((t) => t.ts >= wsMs && t.up.ask != null && t.down.ask != null);
    if (first) {
      const favIdx: 0 | 1 = first.up.ask >= first.down.ask ? 0 : 1;
      (openState[bucketAsk(first.up.ask ?? 0)] ??= new Agg()).add(favIdx === res);
    }
  }

  function favAnalysis(favIdx: 0 | 1, res: number): boolean {
    return favIdx === res;
  }

  function bucketAskSum(a: number | null, b: number | null): string {
    if (a == null || b == null) return "unknown";
    const s = a + b;
    if (s < 1.00) return "sum<1.00 (disequilibrium)";
    if (s < 1.03) return "sum 1.00-1.03";
    return "sum>=1.03 (expensive)";
  }

  // ---------- Output ----------
  const dump = (m: Record<string, Agg>): Array<{ key: string; n: number; wr: number | null }> =>
    Object.entries(m)
      .map(([k, a]) => ({ key: k, n: a.n, wr: a.n > 0 ? a.wins / a.n : null }))
      .sort((x, y) => x.n - y.n);

  const report = {
    phase: "calibration-analysis",
    generatedAt: new Date().toISOString(),
    sourceDb: DB,
    universe: {
      completeWindows: wins.length,
      resolvedWindows: nResolved,
      criteria: "801+ ticks, gap<=60s, resolution known",
    },
    calibrationFavAsk: dump(calibFavAsk),
    calibrationByElapsed: Object.fromEntries(
      Object.entries(calibByElapsed).map(([k, m]) => [k, dump(m)]),
    ),
    calibrationAskSum: dump(calibAskSum,
    ),
    calibrationFlip: dump(calibFlip),
    calibrationMomentum: dump(calibMomentum,
    ),
    calibrationReversal: dump(calibReversal),
    openStateFavAsk: dump(openState),
    notes: "Per-tick aggregation is INFLATED (intra-window correlation). Use the per-window first-trigger sampling in the follow-up sims. This report maps WHERE miscalibration lives.",
  };
  const outPath = join(OUT_DIR, `calibration-analysis-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, calibrationByElapsed: "see file", openStateFavAsk: "see file" }, null, 2));
  console.log("written:", outPath);
  db.close();
}

main();