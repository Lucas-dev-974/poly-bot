/**
 * Discovery sim round 2 — affiner les candidats + head-to-head vs fav-band.
 * READ-ONLY. Mêmes conventions : univers complet+résolu, UN entry/fenêtre,
 * FOK à l'ask brut + depth guard, hold-to-resolution, $15, maxShares 30.
 *
 * Round 1 (discovery-sim-1789458387800.json, 394 fenêtres) :
 *   - anti-flip tardif (minElapsed 180s) : +$181.8, WR 45%, EV +2.3¢/sh
 *   - fav-streak (0.60-0.75, streak 180s, min 240s) : +$119, WR 71.1%
 *   - cheap-leader : MORT
 *
 * Round 2 mesure :
 *   1. fav-band REPRODUCTION (0.70-0.85, min 200s) sur le même univers —
 *      baseline pour le head-to-head fav-streak (le gate streak apporte-t-il
 *      un delta vs la même bande SANS gate ?)
 *   2. anti-flip tardif sculpté : elapsed, lookback, bandes
 *   3. late-lock : favori tardif (< 840s, prix 0.55-0.92)
 *   4. first-favorite : favori émergeant immédiatement (elapsed < 60s,
 *      ask >= 0.55)
 *   5. momentum corrigé (delta favAsk sur fenêtre 30s) comme gate
 *      additionnel sur fav-streak
 *
 * npx tsx scripts/research/research-new-strats/discovery-sim2.mts
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB = "data/bot-live.db";
const OUT_DIR = join("audits", "backtest", "research-new-strats");

// ---------- universe ----------
interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
}
interface Tick {
  ts: number;
  up: SideBook;
  down: SideBook;
}
interface Universe {
  slugs: Map<string, Tick[]>;
  resMap: Map<string, number>;
  wsMap: Map<string, number>;
}

function loadUniverse(dbPath = DB): Universe {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const windows = db
    .prepare(
      `SELECT eventSlug AS slug, MAX(windowStart) AS ws, COUNT(DISTINCT ts) AS ticks
       FROM market_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'
       GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= 801`,
    )
    .all() as Array<{ slug: string; ws: number; ticks: number }>;
  const gapStmt = db.prepare(
    `WITH t AS (SELECT DISTINCT ts FROM market_snapshots WHERE eventSlug = ?)
     SELECT MAX(d) AS g FROM
       (SELECT ts - LAG(ts) OVER (ORDER BY ts) AS d FROM t)`,
  );
  const complete = windows
    .filter((w) => {
      const g = gapStmt.get(w.slug) as { g: number | null };
      return (g.g ?? 0) <= 60_000;
    })
    .map((w) => ({ slug: w.slug, ws: w.ws }));

  const resRows = db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));

  const slugs = new Map<string, Tick[]>();
  const wsMap = new Map<string, number>();
  for (const { slug, ws } of complete) {
    if (resMap.get(slug) === undefined) continue;
    const rows = db
      .prepare(
        `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize
         FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
      )
      .all(slug) as Array<{
      ts: number;
      outcomeIndex: number;
      bestAsk: number | null;
      bestBid: number | null;
      bestAskSize: number | null;
    }>;
    const byTs = new Map<number, { up: SideBook; down: SideBook }>();
    const blank = (): SideBook => ({ ask: null, bid: null, askSize: null });
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
    }
    const ticks: Tick[] = [];
    for (const [ts, b] of byTs) {
      if (b.up.ask == null && b.down.ask == null) continue;
      ticks.push({ ts, up: b.up, down: b.down });
    }
    slugs.set(slug, ticks);
    wsMap.set(slug, ws);
  }
  db.close();
  return { slugs, resMap, wsMap };
}

// ---------- sim ----------
interface EntryParams {
  minElapsedSec: number;
  maxElapsedSec: number | null;
  bandMin: number;
  bandMax: number;
  maxSpread: number;
  orderUsdc: number;
  maxShares: number;
}

interface Variant {
  label: string;
  family:
    | "fav-band-repro"
    | "anti-flip-late"
    | "fav-streak"
    | "late-lock"
    | "first-fav"
    | "streak+momentum";
  entry: EntryParams;
  flipLookbackMs?: number;   // anti-flip
  streakMs?: number;         // fav-streak
  momentumSec?: number;      // streak+momentum: favAsk rise over momentumSec >= threshold
  momentumMin?: number;
}

interface SimResult {
  label: string;
  family: string;
  fills: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number;
  evPerShare: number | null;
  avgEntryPrice: number | null;
}

function runSim(universe: Universe, P: Variant): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;
  const winPnls: number[] = [];
  const lossPnls: number[] = [];

  for (const [slug, ticks] of universe.slugs) {
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    let entry: { price: number; size: number; outcomeIdx: 0 | 1 } | null = null;
    let prevFavIdx: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;
    // momentum series: fav ask sampled per tick
    const favAsks: Array<{ ts: number; ask: number }> = [];

    for (const t of ticks) {
      const elapsedSec = (t.ts - wsMs) / 1000;
      if (elapsedSec < 0 || elapsedSec >= 900) continue;

      const favIdx: 0 | 1 | null =
        t.up.ask != null && t.down.ask == null
          ? 0
          : t.down.ask != null && t.up.ask == null
            ? 1
            : t.up.ask != null && t.down.ask != null
              ? t.up.ask >= t.down.ask
                ? 0
                : 1
              : null;
      if (favIdx == null) continue;
      const favAsk = favIdx === 0 ? t.up.ask : t.down.ask;
      if (favAsk == null) continue;

      if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipTs = t.ts;
      prevFavIdx = favIdx;

      favAsks.push({ ts: t.ts, ask: favAsk });

      if (entry) continue;

      const E = P.entry;
      if (elapsedSec < E.minElapsedSec) continue;
      if (E.maxElapsedSec != null && elapsedSec > E.maxElapsedSec) continue;

      // family gates
      if (P.family === "anti-flip-late") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 60_000)) continue;
        const newFavAsk = favAsk;
        if (newFavAsk < 0.45 || newFavAsk > 0.65) continue;
        // target = the DEPOSED favorite
        var targetIdx: 0 | 1 = favIdx === 0 ? 1 : 0;
        var targetBook: SideBook = favIdx === 0 ? t.down : t.up;
      } else if (P.family === "fav-band-repro" || P.family === "fav-streak" || P.family === "late-lock" || P.family === "first-fav") {
        if (P.family === "fav-streak") {
          if (lastFlipTs != null && t.ts - lastFlipTs < (P.streakMs ?? 180_000)) continue;
        }
        var targetIdx: 0 | 1 = favIdx;
        var targetBook: SideBook = favIdx === 0 ? t.up : t.down;
      } else if (P.family === "streak+momentum") {
        if (lastFlipTs != null && t.ts - lastFlipTs < (P.streakMs ?? 180_000)) continue;
        // momentum: favAsk rose by >= momentumMin over the last momentumSec
        const cutoff = t.ts - (P.momentumSec ?? 30) * 1000;
        let ref: number | null = null;
        for (let j = favAsks.length - 1; j >= 0; j--) {
          if (favAsks[j].ts <= cutoff) {
            ref = favAsks[j].ask;
            break;
          }
        }
        if (ref == null) continue;
        if (favAsk - ref < (P.momentumMin ?? 0.02)) continue;
        var targetIdx: 0 | 1 = favIdx;
        var var_targetBook: SideBook = favIdx === 0 ? t.up : t.down;
        var targetBook = var_targetBook;
      }

      const targetAsk = targetBook.ask;
      if (targetAsk == null) continue;
      if (targetAsk < E.bandMin || targetAsk > E.bandMax) continue;
      const targetBid = targetBook.bid;
      if (targetBid != null && targetAsk - targetBid > E.maxSpread) continue;
      const size = Math.min(E.orderUsdc / targetAsk, E.maxShares);
      if (size < 5) continue;
      if (targetBook.askSize != null && targetBook.askSize < size) continue;

      entry = { price: targetAsk, size, outcomeIdx: targetIdx };
      fills++;
    }

    if (!entry) continue;
    notional += entry.price * entry.size;
    shares += entry.size;
    const win = res === entry.outcomeIdx;
    const p = win ? (1 - entry.price) * entry.size : -entry.price * entry.size;
    pnl += p;
    if (p > 0) {
      wins++;
      winPnls.push(p);
    } else {
      losses++;
      lossPnls.push(p);
    }
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
  }

  pnl = Math.round(pnl * 100) / 100;
  const avg = (a: number[]) =>
    a.length
      ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000
      : null;
  const avgEntry = fills && shares ? Math.round((notional / shares) * 1000) / 1000 : null;
  return {
    label: P.label,
    family: P.family,
    fills,
    wins,
    losses,
    pnl,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    avgWin: avg(winPnls),
    avgLoss: avg(lossPnls),
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    evPerShare: fills && shares ? Math.round((pnl / shares) * 100) / 100 : null,
    avgEntryPrice: avgEntry,
  };
}

// ---------- grid ----------
const BASE_E = (o: Partial<EntryParams> = {}): EntryParams => ({
  minElapsedSec: 0,
  maxElapsedSec: null,
  bandMin: 0.5,
  bandMax: 0.95,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
  ...o,
});

const variants: Variant[] = [
  // 1. fav-band reproduction (baseline officielle 0.70-0.85 min 200s)
  { label: "FAVBAND-REPRO_070-085_min200", family: "fav-band-repro", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200 }) },
  { label: "FAVBAND-REPRO_070-085_min200_sp04", family: "fav-band-repro", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200, maxSpread: 0.04 }) },

  // 2. anti-flip tardif sculpté (round 1 winner)
  { label: "ANTIFLIP_min180_look60_band35-45", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 180, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_min180_look45", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 180, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 45_000 },
  { label: "ANTIFLIP_min180_look30", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 180, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 30_000 },
  { label: "ANTIFLIP_min180_look60_b35-50", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 180, bandMin: 0.35, bandMax: 0.50 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_min240_look60", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_min300_look60", family: "anti-flip-late", entry: BASE_E({ minElapsedSec: 300, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000 },

  // 3. fav-streak affiné + gate momentum
  { label: "STREAK_060-075_min240_st180", family: "fav-streak", entry: BASE_E({ bandMin: 0.6, bandMax: 0.75, minElapsedSec: 240 }), streakMs: 180_000 },
  { label: "STREAK_060-075_min240_st120", family: "fav-streak", entry: BASE_E({ bandMin: 0.6, bandMax: 0.75, minElapsedSec: 240 }), streakMs: 120_000 },
  { label: "STREAK_070-085_min200_st180", family: "fav-streak", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200 }), streakMs: 180_000 },
  { label: "STREAK_070-085_min200_st300", family: "fav-streak", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200 }), streakMs: 300_000 },
  { label: "STREAK+MOM_070-085_st180_mom30s+2c", family: "streak+momentum", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200 }), streakMs: 180_000, momentumSec: 30, momentumMin: 0.02 },
  { label: "STREAK+MOM_070-085_st180_mom60s+3c", family: "streak+momentum", entry: BASE_E({ bandMin: 0.7, bandMax: 0.85, minElapsedSec: 200 }), streakMs: 180_000, momentumSec: 60, momentumMin: 0.03 },
  { label: "STREAK+MOM_060-075_st180_mom30s+2c", family: "streak+momentum", entry: BASE_E({ bandMin: 0.6, bandMax: 0.75, minElapsedSec: 240 }), streakMs: 180_000, momentumSec: 30, momentumMin: 0.02 },

  // 4. late-lock : favori tardif
  { label: "LATELOCK_060-092_min600_max840", family: "late-lock", entry: BASE_E({ bandMin: 0.6, bandMax: 0.92, minElapsedSec: 600, maxElapsedSec: 840 }) },
  { label: "LATELOCK_055-085_min600_max840", family: "late-lock", entry: BASE_E({ bandMin: 0.55, bandMax: 0.85, minElapsedSec: 600, maxElapsedSec: 840 }) },
  { label: "LATELOCK_070-090_min660_max840", family: "late-lock", entry: BASE_E({ bandMin: 0.7, bandMax: 0.90, minElapsedSec: 660, maxElapsedSec: 840 }) },

  // 5. first-fav : émergence immédiate
  { label: "FIRSTFAV_ask55+_min0_max60", family: "first-fav", entry: BASE_E({ bandMin: 0.55, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 60 }) },
  { label: "FIRSTFAV_ask60+_min0_max45", family: "first-fav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 45 }) },
];

// ---------- main ----------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows`);

  const rows: SimResult[] = [];
  for (const P of variants) {
    try {
      const r = runSim(universe, P);
      rows.push(r);
      console.log(
        `${r.label.padEnd(44)} fills=${String(r.fills).padStart(3)} WR=${String(r.winRate).padStart(5)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} EV/sh=${String(r.evPerShare).padStart(6)}c px=${r.avgEntryPrice}`,
      );
    } catch (e) {
      console.log(`${P.label} ERROR: ${(e as Error).message}`);
    }
  }

  writeFileSync(
    join(OUT_DIR, `discovery-sim2-${Date.now()}.json`),
    JSON.stringify(
      {
        phase: "discovery-sim2",
        generatedAt: new Date().toISOString(),
        sourceDb: DB,
        universeSize: universe.slugs.size,
        variants: rows,
      },
      null,
      2,
    ),
  );
  console.log("written:", join(OUT_DIR, `discovery-sim2-${Date.now()}.json`));
}

main();