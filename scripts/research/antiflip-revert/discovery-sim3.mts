/**
 * Discovery sim round 3 — sculpter ANTIFLIP & FIRSTFAV + 3ᵉ candidat.
 * READ-ONLY. Univers complet+résolu, UN entry/fenêtre, FOK ask brut +
 * depth guard, hold-to-resolution, $15, maxShares 30.
 *
 * Round 2 (discovery-sim2-1789458565467.json) :
 *   ANTIFLIP min240_look60  +$449 WR 49%  (best PnL)
 *   FIRSTFAV 0.60+ 0-45s   +$340 WR 67.7% (best DD $82)
 *   fav-streak dominé par fav-band → abandonné
 *
 * Round 3 :
 *   1. ANTIFLIP sculpté : bandes, minElapsed, lookback, ask-min du déchu
 *   2. FIRSTFAV sculpté : fenêtre d'émergence, seuil d'ask
 *   3. FLIPCONFIRM : acheter le NOUVEAU favori après flip (0.55-0.65)
 *   4. LOTTO : underdog <= 0.12 quand favori >= 0.88, tardif (480-840s)
 *   5. WINSTREAK : continuité cross-fenêtre — si les N dernières fenêtres
 *      résolues ont gagné du même côté, acheter ce côté tôt (0-120s)
 *
 * npx tsx scripts/research/research-new-strats/discovery-sim3.mts
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DB = "data/bot-live.db";
const OUT_DIR = join("audits", "backtest", "research-new-strats");

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
  family: "antiflip" | "firstfav" | "flipconfirm" | "lotto" | "winstreak";
  entry: EntryParams;
  flipLookbackMs?: number;
  deposedAskMin?: number;   // antiflip: floor on the deposed token's ask
  newFavMin?: number;       // antiflip/flipconfirm: window on the new fav ask
  newFavMax?: number;
  favAskMin?: number;       // lotto: favorite min
  streakN?: number;         // winstreak: consecutive same-side wins
}

interface SimResult {
  label: string;
  family: string;
  fills: number;
  wins: number;
  losses: number;
  pnl: number;
  winRate: number | null;
  maxDrawdown: number;
  evPerShare: number | null;
  avgEntryPrice: number | null;
}

function runSim(
  universe: Universe,
  P: Variant,
  streakCtx?: Map<string, number>, // slug -> consecutive same-side wins before this window
): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;

  for (const [slug, ticks] of universe.slugs) {
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    if (P.family === "winstreak") {
      const side = streakCtx?.get(slug);
      if (side === undefined) continue;
      if (side < (P.streakN ?? 2)) continue;
    }

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
      const favAsk = favIdx === 0 ? t.up.ask : t.down.ask;
      if (favAsk == null) continue;

      if (prevFavIdx !== null && prevFavIdx !== favIdx) lastFlipTs = t.ts;
      prevFavIdx = favIdx;

      if (entry) continue;
      const E = P.entry;
      if (elapsedSec < E.minElapsedSec) continue;
      if (E.maxElapsedSec != null && elapsedSec > E.maxElapsedSec) continue;

      let targetIdx: 0 | 1;
      let targetBook: SideBook;

      if (P.family === "antiflip") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 60_000)) continue;
        const newFavAsk = favAsk;
        if (newFavAsk < (P.newFavMin ?? 0.45) || newFavAsk > (P.newFavMax ?? 0.65)) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        const dAsk = targetBook.ask;
        if (dAsk == null) continue;
        if (P.deposedAskMin != null && dAsk < P.deposedAskMin) continue;
      } else if (P.family === "firstfav") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
      } else if (P.family === "flipconfirm") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (P.flipLookbackMs ?? 60_000)) continue;
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
      } else if (P.family === "lotto") {
        // buy the UNDERDOG when favorite is expensive
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        if (favAsk < (P.favAskMin ?? 0.88)) continue;
      } else {
        // winstreak: buy the side that won the last streakN windows
        const side = streakCtx?.get(slug);
        if (side === undefined) continue;
        // side encodes the WINNING outcome index (0=Up,1=Down) of the streak
        targetIdx = side as 0 | 1;
        targetBook = targetIdx === 0 ? t.up : t.down;
        void P.streakN;
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
    if (p > 0) wins++;
    else losses++;
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
  }

  pnl = Math.round(pnl * 100) / 100;
  return {
    label: P.label,
    family: P.family,
    fills,
    wins,
    losses,
    pnl,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    evPerShare: fills && shares ? Math.round((pnl / shares) * 100) / 100 : null,
    avgEntryPrice: fills && shares ? Math.round((notional / shares) * 1000) / 1000 : null,
  };
}

/** Cross-window streak context: for each slug, the number of consecutive
 * windows (immediately before, same asset) resolved on the SAME side,
 * encoded 0/2/3+ as: -1 = no streak context (mixed/unknown), else the
 * winning side repeated n times (value = n * 10 + side). */
function buildStreakCtx(universe: Universe): Map<string, number> {
  // sort slugs by windowStart
  const slugs = [...universe.slugs.keys()]
    .map((s) => ({ slug: s, ws: universe.wsMap.get(s) ?? 0 }))
    .sort((a, b) => a.ws - b.ws);
  const ctx = new Map<string, number>();
  let prevSide: number | null = null;
  let prevStreak: { side: number; n: number } | null = null;
  const byWs = new Map<number, { slug: string; side: number }>();
  for (const s of slugs) {
    const res = universe.resMap.get(s.slug);
    if (res === undefined) continue;
    byWs.set(s.ws, { slug: s.slug, side: res });
  }
  const ordered = [...byWs.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, { slug, side }] of ordered) {
    // encode: streak of N consecutive wins of `side` ending just BEFORE this window
    if (prevStreak && prevStreak.side === side) {
      ctx.set(slug, (prevStreak.n + 1) * 10 + side);
    } else {
      ctx.set(slug, 1 * 10 + side);
    }
    // update rolling
    if (prevSide === null) {
      prevSide = side;
      prevStreak = { side, n: 1 };
    } else if (prevSide === side && prevStreak) {
      prevStreak.n++;
    } else {
      prevSide = side;
      prevStreak = { side, n: 1 };
    }
  }
  return ctx;
}

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
  // 1. ANTIFLIP sculpté
  { label: "ANTIFLIP_m240_l60", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_m240_l90", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 90_000 },
  { label: "ANTIFLIP_m240_l45", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 45_000 },
  { label: "ANTIFLIP_m270_l60", family: "antiflip", entry: BASE_E({ minElapsedSec: 270, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_m240_l60_b30-40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.30, bandMax: 0.40 }), flipLookbackMs: 60_000 },
  { label: "ANTIFLIP_m240_l60_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l60_nf50-70", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, newFavMin: 0.50, newFavMax: 0.70 },

  // 2. FIRSTFAV sculpté
  { label: "FIRSTFAV_a60_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 45 }) },
  { label: "FIRSTFAV_a60_0-30", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 30 }) },
  { label: "FIRSTFAV_a60_0-60", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 60 }) },
  { label: "FIRSTFAV_a65_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.65, bandMax: 0.85, minElapsedSec: 0, maxElapsedSec: 45 }) },
  { label: "FIRSTFAV_a55_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.55, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 45 }) },
  { label: "FIRSTFAV_a60-70_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.70, minElapsedSec: 0, maxElapsedSec: 45 }) },

  // 3. FLIPCONFIRM — acheter le NOUVEAU favori post-flip
  { label: "FLIPCONFIRM_m120_l60_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 120, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 60_000 },
  { label: "FLIPCONFIRM_m180_l60_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 180, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 60_000 },
  { label: "FLIPCONFIRM_m240_l60_55-65", family: "flipconfirm", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.55, bandMax: 0.65 }), flipLookbackMs: 60_000 },

  // 4. LOTTO — underdog quand favori sur-pricé
  { label: "LOTTO_fav88_ud0.02-0.12_480-840", family: "lotto", entry: BASE_E({ minElapsedSec: 480, maxElapsedSec: 840, bandMin: 0.02, bandMax: 0.12 }), favAskMin: 0.88 },
  { label: "LOTTO_fav85_ud0.02-0.15_480-840", family: "lotto", entry: BASE_E({ minElapsedSec: 480, maxElapsedSec: 840, bandMin: 0.02, bandMax: 0.15 }), favAskMin: 0.85 },
  { label: "LOTTO_fav90_ud0.01-0.10_540-840", family: "lotto", entry: BASE_E({ minElapsedSec: 540, maxElapsedSec: 840, bandMin: 0.01, bandMax: 0.10 }), favAskMin: 0.90 },

  // 5. WINSTREAK — continuité cross-fenêtre
  { label: "WINSTREAK_n2_0-120_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 120, bandMin: 0.50, bandMax: 0.70 }), streakN: 2 },
  { label: "WINSTREAK_n3_0-120_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 120, bandMin: 0.50, bandMax: 0.70 }), streakN: 3 },
  { label: "WINSTREAK_n2_0-180_45-65", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 180, bandMin: 0.45, bandMax: 0.65 }), streakN: 2 },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows`);

  const streakCtx = buildStreakCtx(universe);
  const n2 = [...streakCtx.values()].filter((v) => v >= 20 && v < 30).length;
  const n3 = [...streakCtx.values()].filter((v) => v >= 30).length;
  console.log(`streak windows available: n>=2: ${n2}, n>=3: ${n3}`);

  const rows: SimResult[] = [];
  for (const P of variants) {
    const r = runSim(universe, P, P.family === "winstreak" ? streakCtx : undefined);
    rows.push(r);
    console.log(
      `${r.label.padEnd(40)} fills=${String(r.fills).padStart(3)} WR=${String(r.winRate).padStart(5)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} EV/sh=${String(r.evPerShare).padStart(6)}c px=${r.avgEntryPrice}`,
    );
  }

  writeFileSync(
    join(OUT_DIR, `discovery-sim3-${Date.now()}.json`),
    JSON.stringify(
      {
        phase: "discovery-sim3",
        generatedAt: new Date().toISOString(),
        sourceDb: DB,
        universeSize: universe.slugs.size,
        variants: rows,
      },
      null,
      2,
    ),
  );
  console.log("written:", join(OUT_DIR, `discovery-sim3-${Date.now()}.json`));
}

main();