/**
 * Dip-revert standalone research sim v2 — READ-ONLY on data/bot-live.db.
 *
 * v2 FIX: early-exit prices must come from the HELD token's own book, not the
 * current favorite's. v1 credited the favorite's bid on identity flips — an
 * artifact that cannot exist live (you can only sell what you hold).
 *
 * Guards identical to src/strategy/dip-revert-strategy.ts; one entry per
 * window; resolution via market_resolutions. Calibrated vs official backtest
 * (base => ~239 fills / ~65% WR / ~+$280 on 326 windows).
 *
 * Exit axes (all evaluated on the HELD token's book):
 *   exitWin   : held ask >= X -> FOK sell at held bid (3-level walk)
 *   exitStop  : held ask <= X -> FOK sell at held bid (stop on collapse)
 *   exitFav   : current-fav ask >= X AND fav != held -> sell held at its bid
 *               (market says we backed the loser; cut before resolution)
 *
 * NOTE: every exit axis DEGRADES PnL vs hold-to-resolution (confirmed by the
 * official runner, see recheck-official.mts). Use for discovery only; the
 * official runner is the ground truth.
 *
 * Standalone single run: npx tsx scripts/research/dip-revert-research/dip-sim.mts
 * Env: DR_EXIT_WIN DR_EXIT_STOP DR_EXIT_FAV DR_MAX_ELAPSED ... CSV=1
 */
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export interface SimParams {
  bandMin: number;
  bandMax: number;
  minDrop: number;
  lookbackMs: number;
  minElapsedSec: number;
  maxElapsedSec: number | null;
  maxSpread: number;
  depthGuard: boolean;
  minRebound: number | null;
  minBouncePct: number | null;
  volFloor: number | null;
  volCap: number | null;
  /** Held-token take-profit: sell when held ask >= X. */
  exitWin: number | null;
  /** Held-token stop: sell when held ask <= X (market pricing us as loser). */
  exitStop: number | null;
  /** Flip-stop: sell held when the CURRENT favorite ask >= X and fav != held. */
  exitFav: number | null;
  trendSec: number | null;
  trendDrop: number | null;
  orderUsdc: number;
}

export const BASE: SimParams = {
  bandMin: 0.55,
  bandMax: 0.65,
  minDrop: 0.03,
  lookbackMs: 60_000,
  minElapsedSec: 180,
  maxElapsedSec: null,
  maxSpread: 0.04,
  depthGuard: true,
  minRebound: null,
  minBouncePct: null,
  volFloor: null,
  volCap: null,
  exitWin: null,
  exitStop: null,
  exitFav: null,
  trendSec: null,
  trendDrop: null,
  orderUsdc: 15,
};

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

export interface Universe {
  slugs: Map<string, Tick[]>;
  resMap: Map<string, number>;
}

export function loadUniverse(dbPath = "data/bot-live.db"): Universe {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const windows = db
    .prepare(
      `SELECT eventSlug AS slug, MAX(windowStart) AS ws, MAX(windowEnd) AS we,
              COUNT(DISTINCT ts) AS ticks
       FROM market_snapshots WHERE eventSlug LIKE 'btc-updown-15m-%'
       GROUP BY eventSlug HAVING COUNT(DISTINCT ts) >= 801`,
    )
    .all() as Array<{ slug: string; ws: number; we: number; ticks: number }>;
  const completeSlugs: string[] = [];
  const gapStmt = db.prepare(
    `WITH t AS (SELECT DISTINCT ts FROM market_snapshots WHERE eventSlug = ?)
     SELECT MAX(d) AS g FROM
       (SELECT ts - LAG(ts) OVER (ORDER BY ts) AS d FROM t)`,
  );
  for (const w of windows) {
    const g = gapStmt.get(w.slug) as { g: number | null };
    if ((g.g ?? 0) <= 60_000) completeSlugs.push(w.slug);
  }

  const resRows = db
    .prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions")
    .all() as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));

  const slugs = new Map<string, Tick[]>();
  for (const slug of completeSlugs) {
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
    const byTs = new Map<
      number,
      { up: SideBook; down: SideBook }
    >();
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
  }
  db.close();
  return { slugs, resMap };
}

/** FOK sell walking the 3-level bid ladder; null when depth < size (killed). */
function sellFok(
  bids: Array<{ px: number; sz: number }>,
  size: number,
): { px: number; notional: number } | null {
  let left = size;
  let notional = 0;
  for (const lvl of bids) {
    if (left <= 0) break;
    const take = Math.min(left, lvl.sz);
    notional += take * lvl.px;
    left -= take;
  }
  if (left > 1e-9) return null;
  return { px: notional / size, notional };
}

export interface SimResult {
  fills: number;
  wins: number;
  losses: number;
  earlyExits: number;
  kills: number;
  pnl: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  maxDrawdown: number;
}

export function runSim(
  universe: Universe,
  P: SimParams,
  opts?: { slugFilter?: (slug: string) => boolean },
): SimResult {
  let fills = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    earlyExits = 0,
    kills = 0,
    peak = 0,
    maxDrawdown = 0;
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
    if (opts?.slugFilter && !opts.slugFilter(slug)) continue;
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wStartSec = Number(slug.split("-").pop());
    const wsMs = wStartSec * 1000;
    const samples: Array<{ ts: number; ask: number }> = [];
    let entry: {
      price: number;
      size: number;
      outcomeIdx: 0 | 1;
    } | null = null;
    let exited = false;

    for (const t of ticks) {
      const held = entry?.outcomeIdx === 1 ? t.down : t.up;
      const other = entry?.outcomeIdx === 1 ? t.up : t.down;
      const fav =
        t.up.ask != null && (t.down.ask == null || t.up.ask >= t.down.ask)
          ? t.up
          : t.down;

      // push sample BEFORE guards (favorite ask series, as the live strategy)
      const favAsk = fav.ask;
      if (favAsk != null) {
        const cutoff = Math.max(t.ts - P.lookbackMs, wsMs);
        while (samples.length > 0 && samples[0].ts < cutoff) samples.shift();
        samples.push({ ts: t.ts, ask: favAsk });
      }

      if (entry && !exited) {
        const heldBid = held.bid;
        const heldSpreadOk =
          heldBid != null && held.ask != null && held.ask - heldBid <= 0.05 + 1e-9;
        if (heldSpreadOk) {
          let exit = false;
          if (P.exitWin != null && (held.ask ?? 0) >= P.exitWin) exit = true;
          if (P.exitStop != null && (held.ask ?? 1) <= P.exitStop) exit = true;
          if (
            P.exitFav != null &&
            (fav.ask ?? 0) >= P.exitFav &&
            fav !== held
          )
            exit = true;
          if (exit) {
            const fill = heldBid != null ? sellFok(held.bids, entry.size) : null;
            if (!fill) {
              kills++;
            } else {
              const p = fill.notional - entry.price * entry.size;
              count(p);
              earlyExits++;
              exited = true;
            }
          }
        }
        continue;
      }
      if (entry) continue;

      const elapsedSec = t.ts / 1000 - wStartSec;
      if (elapsedSec < P.minElapsedSec) continue;
      if (P.maxElapsedSec != null && elapsedSec > P.maxElapsedSec) continue;
      if (favAsk == null) continue;
      if (favAsk < P.bandMin || favAsk > P.bandMax) continue;
      const favBid = fav.bid;
      if (favBid != null && favAsk - favBid > P.maxSpread) continue;
      const size = Math.min(P.orderUsdc / favAsk, 30);
      if (P.depthGuard && fav.askSize != null && fav.askSize < size) continue;
      if (samples.length < 2) continue;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.ts - first.ts < P.lookbackMs * 0.7) continue;
      const low = Math.min(...samples.map((s) => s.ask));
      if (first.ask - favAsk < P.minDrop) continue;
      if (!(favAsk > low)) continue;
      if (!(favAsk - low >= 0.001)) continue;
      if (P.minRebound != null && favAsk - low < P.minRebound) continue;
      if (P.minBouncePct != null && favAsk - low < P.minBouncePct * (first.ask - low))
        continue;
      if (P.volFloor != null || P.volCap != null) {
        const range = Math.max(...samples.map((s) => s.ask)) - low;
        if (P.volFloor != null && range < P.volFloor) continue;
        if (P.volCap != null && range > P.volCap) continue;
      }
      if (P.trendSec != null && P.trendDrop != null) {
        const tcutoff = t.ts - P.trendSec * 1000;
        let tFirst: { ts: number; ask: number } | null = null;
        for (const s of samples) {
          if (s.ts >= tcutoff) {
            tFirst = s;
            break;
          }
        }
        if (!tFirst) continue;
        if (tFirst.ask - favAsk >= P.trendDrop) continue;
      }

      entry = { price: favAsk, size, outcomeIdx: fav === t.up ? 0 : 1 };
      fills++;
    }

    if (!entry || exited) continue;
    const win = res === entry.outcomeIdx;
    const p = win ? (1 - entry.price) * entry.size : -entry.price * entry.size;
    count(p);
  }

  pnl = Math.round(pnl * 100) / 100;
  const avg = (a: number[]) =>
    a.length
      ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000
      : null;
  return {
    fills,
    wins,
    losses,
    earlyExits,
    kills,
    pnl,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    avgWin: avg(winPnls),
    avgLoss: avg(lossPnls),
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
  };
}

// --- standalone CLI ---
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = (k: string) => process.env[k];
  const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  const opt = (k: string): number | null => (env(k) === undefined ? null : num(env(k), 0));
  const P: SimParams = {
    ...BASE,
    bandMin: num(env("DR_BAND_MIN"), BASE.bandMin),
    bandMax: num(env("DR_BAND_MAX"), BASE.bandMax),
    minDrop: num(env("DR_MIN_DROP"), BASE.minDrop),
    lookbackMs: num(env("DR_LOOKBACK_MS"), BASE.lookbackMs),
    minElapsedSec: num(env("DR_MIN_ELAPSED"), BASE.minElapsedSec),
    maxElapsedSec: opt("DR_MAX_ELAPSED"),
    maxSpread: num(env("DR_MAX_SPREAD"), BASE.maxSpread),
    depthGuard: env("DR_DEPTH_GUARD") !== "0",
    minRebound: opt("DR_MIN_REBOUND"),
    minBouncePct: opt("DR_MIN_BOUNCE_PCT"),
    volFloor: opt("DR_VOL_FLOOR"),
    volCap: opt("DR_VOL_CAP"),
    exitWin: opt("DR_EXIT_WIN"),
    exitStop: opt("DR_EXIT_STOP"),
    exitFav: opt("DR_EXIT_FAV"),
    trendSec: opt("DR_TREND_SEC"),
    trendDrop: opt("DR_TREND_DROP"),
    orderUsdc: num(env("DR_ORDER_USDC"), BASE.orderUsdc),
  };
  const u = loadUniverse();
  const r = runSim(u, P);
  console.log(JSON.stringify({ label: env("LABEL") ?? "run", ...r }));
}