/**
 * Discovery sim round 4 — contrôles causaux + WINSTREAK corrigé.
 * READ-ONLY. Univers complet+résolu, UN entry/fenêtre, FOK ask brut +
 * depth guard, hold-to-resolution, $15, maxShares 30.
 *
 * Round 3 (discovery-sim3-1789458668997.json) :
 *   ANTIFLIP m240 look60 dep40 : +$598.8 WR 52% EV 9¢/sh DD $103
 *   FIRSTFAV 0.60+ 0-30s       : +$332 WR 69.2% DD $78
 *   WINSTREAK : BUG encodage (targetIdx = n*10+side au lieu de side décodé)
 *               → à re-tester
 *
 * Contrôles causaux ANTIFLIP (le flip porte-t-il le signal ?) :
 *   CTRL-UNDERDOG  : underdog 0.35-0.45 à elapsed 240+ SANS condition de flip
 *   CTRL-FLIP-OLD  : deposed favorite mais flip > 180s (le signal s'éteint ?)
 *
 * npx tsx scripts/research/research-new-strats/discovery-sim4.mts
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
  family:
    | "antiflip"
    | "ctrl-underdog"
    | "ctrl-flip-old"
    | "firstfav"
    | "winstreak";
  entry: EntryParams;
  flipLookbackMs?: number;
  flipMinAgeMs?: number;    // ctrl-flip-old: flip must be OLDER than this
  deposedAskMin?: number;
  streakN?: number;
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
  byDay: Record<string, number>;
}

function runSim(
  universe: Universe,
  P: Variant,
  streakCtx?: Map<string, number>,
): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;
  const byDay: Record<string, number> = {};

  for (const [slug, ticks] of universe.slugs) {
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    let streakSide: 0 | 1 | null = null;
    let streakN = 0;
    if (P.family === "winstreak") {
      const v = streakCtx?.get(slug);
      if (v === undefined) continue;
      streakN = Math.floor(v / 10);
      streakSide = (v % 10) as 0 | 1;
      if (streakN < (P.streakN ?? 2)) continue;
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
      let targetAsk: number | null;

      if (P.family === "antiflip") {
        if (lastFlipTs == null) continue;
        const ageMs = t.ts - lastFlipTs;
        if (ageMs > (P.flipLookbackMs ?? 60_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
        if (targetAsk == null) continue;
        if (P.deposedAskMin != null && targetAsk < P.deposedAskMin) continue;
      } else if (P.family === "ctrl-underdog") {
        // pas de condition de flip : underdog tardif, même bande
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
      } else if (P.family === "ctrl-flip-old") {
        // le favori déchu mais avec un flip VIEUX (> flipMinAgeMs) —
        // même échantillon de prix, l'info "flip récent" retirée
        if (lastFlipTs == null) continue;
        const ageMs = t.ts - lastFlipTs;
        if (ageMs < (P.flipMinAgeMs ?? 180_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
        if (targetAsk == null) continue;
        if (P.deposedAskMin != null && targetAsk < P.deposedAskMin) continue;
      } else if (P.family === "firstfav") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      } else {
        // winstreak
        targetIdx = streakSide as 0 | 1;
        targetBook = targetIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      }

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
    const day = new Date(wsMs).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + p;
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
    byDay: Object.fromEntries(
      Object.entries(byDay).map(([d, v]) => [d, Math.round(v * 100) / 100]),
    ),
  };
}

/** Streak cross-fenêtre : pour chaque slug, (n*10+side) = n fenêtres
 * consécutives AVANT celle-ci résolues côté `side`. */
function buildStreakCtx(universe: Universe): Map<string, number> {
  const ordered = [...universe.slugs.keys()]
    .map((s) => ({ slug: s, ws: universe.wsMap.get(s) ?? 0, res: universe.resMap.get(s) }))
    .filter((x) => x.res !== undefined)
    .sort((a, b) => a.ws - b.ws);
  const ctx = new Map<string, number>();
  let runSide: number | null = null;
  let runN = 0;
  for (const { slug, res } of ordered) {
    // encode streak BEFORE this window
    if (runSide === null) ctx.set(slug, 0);
    else ctx.set(slug, runN * 10 + runSide);
    // update rolling with THIS window's resolution
    if (runSide === res) runN++;
    else {
      runSide = res!;
      runN = 1;
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
  // 1. Contrôles causaux ANTIFLIP
  { label: "CTRL-UNDERDOG_35-45_m240", family: "ctrl-underdog", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }) },
  { label: "CTRL-FLIP-OLD_dep40_m240", family: "ctrl-flip-old", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipMinAgeMs: 180_000, deposedAskMin: 0.40 },

  // 2. ANTIFLIP robustesse (autour du winner m240 l60 dep40)
  { label: "ANTIFLIP_m240_l60_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l90_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 90_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l30_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 30_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l60_dep38", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.38 },
  { label: "ANTIFLIP_m240_l60_dep42", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.42 },
  { label: "ANTIFLIP_m210_l60_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 210, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m270_l60_dep40", family: "antiflip", entry: BASE_E({ minElapsedSec: 270, bandMin: 0.35, bandMax: 0.45 }), flipLookbackMs: 60_000, deposedAskMin: 0.40 },
  { label: "ANTIFLIP_m240_l60_dep40_b35-50", family: "antiflip", entry: BASE_E({ minElapsedSec: 240, bandMin: 0.35, bandMax: 0.50 }), flipLookbackMs: 60_000, deposedAskMin: 0.40 },

  // 3. FIRSTFAV robustesse
  { label: "FIRSTFAV_a60_0-30", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 30 }) },
  { label: "FIRSTFAV_a60_0-45", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 45 }) },
  { label: "FIRSTFAV_a60-75_0-30", family: "firstfav", entry: BASE_E({ bandMin: 0.60, bandMax: 0.75, minElapsedSec: 0, maxElapsedSec: 30 }) },
  { label: "FIRSTFAV_a62_0-30", family: "firstfav", entry: BASE_E({ bandMin: 0.62, bandMax: 0.80, minElapsedSec: 0, maxElapsedSec: 30 }) },
  { label: "FIRSTFAV_a65_0-30", family: "firstfav", entry: BASE_E({ bandMin: 0.65, bandMax: 0.85, minElapsedSec: 0, maxElapsedSec: 30 }) },

  // 4. WINSTREAK corrigé
  { label: "WINSTREAK_n2_0-120_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 120, bandMin: 0.50, bandMax: 0.70 }), streakN: 2 },
  { label: "WINSTREAK_n3_0-120_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 120, bandMin: 0.50, bandMax: 0.70 }), streakN: 3 },
  { label: "WINSTREAK_n2_0-60_50-70", family: "winstreak", entry: BASE_E({ minElapsedSec: 0, maxElapsedSec: 60, bandMin: 0.50, bandMax: 0.70 }), streakN: 2 },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows`);

  const streakCtx = buildStreakCtx(universe);
  const n2 = [...streakCtx.values()].filter((v) => v >= 20).length;
  const n3 = [...streakCtx.values()].filter((v) => v >= 30).length;
  console.log(`streak windows: n>=2: ${n2}, n>=3: ${n3}`);

  const rows: SimResult[] = [];
  for (const P of variants) {
    const r = runSim(universe, P, P.family === "winstreak" ? streakCtx : undefined);
    rows.push(r);
    const days = Object.entries(r.byDay);
    const nPosDays = days.filter(([, v]) => v > 0).length;
    const nNegDays = days.filter(([, v]) => v < 0).length;
    console.log(
      `${r.label.padEnd(36)} fills=${String(r.fills).padStart(3)} WR=${String(r.winRate).padStart(5)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} EV/sh=${String(r.evPerShare).padStart(6)}c px=${r.avgEntryPrice} days+/-:${nPosDays}/${nNegDays}`,
    );
  }

  writeFileSync(
    join(OUT_DIR, `discovery-sim4-${Date.now()}.json`),
    JSON.stringify(
      {
        phase: "discovery-sim4",
        generatedAt: new Date().toISOString(),
        sourceDb: DB,
        universeSize: universe.slugs.size,
        variants: rows,
      },
      null,
      2,
    ),
  );
  console.log("written:", join(OUT_DIR, `discovery-sim4-${Date.now()}.json`));
}

main();