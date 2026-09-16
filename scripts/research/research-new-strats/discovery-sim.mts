/**
 * Discovery sim — 3 familles de nouvelles stratégies directionnelles.
 * READ-ONLY sur data/bot-live.db. Univers : fenêtres complètes (801+ ticks,
 * gap <= 60s) AVEC résolution. Échantillonnage UN entry par fenêtre
 * (premier trigger), FOK à l'ask brut avec depth guard, hold-to-resolution.
 *
 * Familles (issues de calibration-analysis, 394 fenêtres résolues) :
 *   A. anti-flip-revert  : le favori vient de FLIPPER (<= flipLookbackMs) et
 *                         cote mid-band -> on achète l'ANCIEN favori (déchu).
 *                         Thèse : sur-réaction au retournement (recent-flip
 *                         WR 49.7% per-tick).
 *   B. cheap-leader      : entrée précoce (elapsed 30-120s) sur le favori
 *                         avec askSum < seuil (leader sous-pricé).
 *   C. fav-streak        : favori STABLE (pas de flip depuis streakMs) cote
 *                         0.60-0.75 à elapsed 240s+ (stable WR 75.7%).
 *
 * Toutes variantes : $15/order, maxShares 30, depthGuard, MIN_CLOB_SHARES 5.
 *
 * npx tsx scripts/research/research-new-strats/discovery-sim.mts
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB = "data/bot-live.db";
const OUT_DIR = join("audits", "backtest", "research-new-strats");

// ---------- universe loader (shared shape with dip-sim) ----------
interface SideBook {
  ask: number | null;
  bid: number | null;
  askSize: number | null;
  bids: Array<{ px: number; sz: number }>;
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
  const completeSlugs = windows
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
  for (const { slug, ws } of completeSlugs) {
    if (resMap.get(slug) === undefined) continue;
    const rows = db
      .prepare(
        `SELECT ts, outcomeIndex, bestAsk, bestBid, bestAskSize, bestBidSize,
                bid2, bid2Size, bid3, bid3Size
         FROM book_snapshots WHERE eventSlug = ? ORDER BY ts`,
      )
      .all(slug) as Array<{
      ts: number;
      outcomeIndex: number;
      bestAsk: number | null;
      bestBid: number | null;
      bestAskSize: number | null;
      bestBidSize: number | null;
      bid2: number | null;
      bid2Size: number | null;
      bid3: number | null;
      bid3Size: number | null;
    }>;
    const byTs = new Map<number, { up: SideBook; down: SideBook }>();
    const blank = (): SideBook => ({ ask: null, bid: null, askSize: null, bids: [] });
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
      const bids: Array<{ px: number; sz: number }> = [];
      if (r.bestBid != null) bids.push({ px: r.bestBid, sz: r.bestBidSize ?? 0 });
      if (r.bid2 != null) bids.push({ px: r.bid2, sz: r.bid2Size ?? 0 });
      if (r.bid3 != null) bids.push({ px: r.bid3, sz: r.bid3Size ?? 0 });
      bids.sort((x, y) => y.px - x.px);
      side.bids = bids;
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

// ---------- sim core ----------
interface EntryParams {
  minElapsedSec: number;
  maxElapsedSec: number | null;
  bandMin: number;
  bandMax: number;
  maxSpread: number;
  orderUsdc: number;
  maxShares: number;
}

interface FamilyParams {
  label: string;
  family: "anti-flip" | "cheap-leader" | "fav-streak";
  entry: EntryParams;
  flipLookbackMs?: number; // A
  askSumMax?: number;      // B
  streakMs?: number;       // C
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

function runSim(universe: Universe, P: FamilyParams): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shareCount = 0,
    notional = 0;
  const winPnls: number[] = [];
  const lossPnls: number[] = [];

  const count = (p: number) => {
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
  };

  for (const [slug, ticks] of universe.slugs) {
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    let entry: { price: number; size: number; outcomeIdx: 0 | 1 } | null = null;
    let prevFavIdx: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;

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

      if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipTs = t.ts;
      prevFavIdx = favIdx;

      if (entry) continue;

      const E = P.entry;
      if (elapsedSec < E.minElapsedSec) continue;
      if (E.maxElapsedSec != null && elapsedSec > E.maxElapsedSec) continue;

      let targetIdx: 0 | 1;
      let targetBook: SideBook;
      let targetAsk: number | null;

      if (P.family === "anti-flip") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 60_000)) continue;
        targetIdx = favIdx === 0 ? 1 : 0; // the deposed favorite
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
        const newFavAsk = favIdx === 0 ? t.up.ask : t.down.ask;
        if (newFavAsk == null) continue;
        if (newFavAsk < 0.45 || newFavAsk > 0.65) continue;
      } else if (P.family === "cheap-leader") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
        const otherAsk = favIdx === 0 ? t.down.ask : t.up.ask;
        if (targetAsk == null || otherAsk == null) continue;
        if (targetAsk + otherAsk > (P.askSumMax ?? 1.0)) continue;
      } else {
        // fav-streak
        if (lastFlipTs != null && t.ts - lastFlipTs < (P.streakMs ?? 180_000)) continue;
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      }

      if (targetAsk == null) continue;
      if (targetAsk < E.bandMin || targetAsk > E.bandMax) continue;
      const targetBid = targetBook.bid;
      if (targetBid != null && targetAsk - targetBid > E.maxSpread) continue;
      const size = Math.min(E.orderUsdc / targetAsk, E.maxShares);
      if (size < 5) continue; // MIN_CLOB_SHARES
      if (targetBook.askSize != null && targetBook.askSize < size) continue;

      entry = { price: targetAsk, size, outcomeIdx: targetIdx };
      fills++;
    }

    if (!entry) continue;
    notional += entry.price * entry.size;
    shareCount += entry.size;
    const win = res === entry.outcomeIdx;
    const p = win ? (1 - entry.price) * entry.size : -entry.price * entry.size;
    count(p);
  }

  pnl = Math.round(pnl * 100) / 100;
  const avg = (a: number[]) =>
    a.length
      ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000
      : null;
  const avgEntry = fills && shareCount ? Math.round((notional / shareCount) * 1000) / 1000 : null;
  const evPerShare =
    fills && avgEntry != null
      ? Math.round(((pnl / shareCount) * 100)) / 100
      : null;
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
    evPerShare,
    avgEntryPrice: avgEntry,
  };
}

// ---------- variant grid ----------
const A_ENTRY = (bandMin: number, bandMax: number, minElapsed: number, lookMs: number): FamilyParams => ({
  label: `anti-flip_${bandMin}-${bandMax}_min${minElapsed}_look${lookMs / 1000}s`,
  family: "anti-flip",
  entry: { minElapsedSec: minElapsed, maxElapsedSec: null, bandMin, bandMax, maxSpread: 0.05, orderUsdc: 15, maxShares: 30 },
  flipLookbackMs: lookMs,
});

const B_ENTRY = (bandMin: number, bandMax: number, minElapsed: number, maxElapsed: number, askSumMax: number): FamilyParams => ({
  label: `cheap-leader_${bandMin}-${bandMax}_${minElapsed}-${maxElapsed}s_sum${askSumMax}`,
  family: "cheap-leader",
  entry: { minElapsedSec: minElapsed, maxElapsedSec: maxElapsed, bandMin, bandMax, maxSpread: 0.05, orderUsdc: 15, maxShares: 30 },
  askSumMax,
});

const C_ENTRY = (bandMin: number, bandMax: number, minElapsed: number, streakMs: number): FamilyParams => ({
  label: `fav-streak_${bandMin}-${bandMax}_min${minElapsed}_streak${streakMs / 1000}s`,
  family: "fav-streak",
  entry: { minElapsedSec: minElapsed, maxElapsedSec: null, bandMin, bandMax, maxSpread: 0.05, orderUsdc: 15, maxShares: 30 },
  streakMs,
});

const families: FamilyParams[] = [
  // A. anti-flip-revert
  A_ENTRY(0.35, 0.45, 120, 60_000),
  A_ENTRY(0.35, 0.45, 120, 30_000),
  A_ENTRY(0.35, 0.45, 120, 90_000),
  A_ENTRY(0.30, 0.40, 120, 60_000),
  A_ENTRY(0.35, 0.45, 60, 60_000),
  A_ENTRY(0.35, 0.45, 180, 60_000),
  A_ENTRY(0.40, 0.50, 120, 60_000),
  // B. cheap-leader
  B_ENTRY(0.40, 0.60, 30, 120, 1.0),
  B_ENTRY(0.40, 0.60, 30, 120, 0.98),
  B_ENTRY(0.40, 0.50, 30, 120, 1.0),
  B_ENTRY(0.45, 0.60, 30, 90, 1.0),
  B_ENTRY(0.40, 0.60, 60, 180, 1.0),
  // C. fav-streak
  C_ENTRY(0.60, 0.75, 240, 180_000),
  C_ENTRY(0.60, 0.75, 240, 120_000),
  C_ENTRY(0.65, 0.75, 240, 180_000),
  C_ENTRY(0.60, 0.75, 300, 180_000),
  C_ENTRY(0.55, 0.70, 240, 180_000),
];

// ---------- main ----------
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(
    `universe: ${universe.slugs.size} windows (complete+resolved), criteria 801+/60s`,
  );

  const rows: SimResult[] = [];
  for (const P of families) {
    const r = runSim(universe, P);
    rows.push(r);
    console.log(
      `${r.label.padEnd(48)} fills=${String(r.fills).padStart(3)} WR=${String(r.winRate).padStart(5)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} EV/sh=${String(r.evPerShare).padStart(6)}c entryPx=${r.avgEntryPrice}`,
    );
  }

  const outPath = join(OUT_DIR, `discovery-sim-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: "discovery-sim",
        generatedAt: new Date().toISOString(),
        sourceDb: DB,
        universeSize: universe.slugs.size,
        families: rows,
      },
      null,
      2,
    ),
  );
  console.log("written:", outPath);
}

main();