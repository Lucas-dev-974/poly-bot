/**
 * Phase 2 / Task 2.2 — SIM du signal chainlink-lag (prérequise au wiring).
 *
 * Simule le moteur sur l'historique : ordres FOK sur les VRAIS carnets
 * (book_snapshots), hold to resolution, PnL réel. Premier trigger uniquement
 * par fenêtre (pitfall per-window). Univers aligné runner (>= 801 ticks,
 * gap <= 60 s, résolution requise — cf. early-conviction/universe.mts).
 *
 * Familles (plan §4 Task 2.2) :
 *   A  : projection vs BARRE (famille principale — barre BACKWARD validée A6)
 *   B  : contrôle causal naïf spot-vs-TWAPnow (même bande, mauvais comparateur
 *        — doit SOUS-performer pour valider que la projection porte le signal)
 *   C  : projection + confirmation multi-ticks (anti-pip)
 *   CTRL : contrôle causal sans move (premier tick éligible, achat du favori,
 *        même bande/spread/profondeur) — baseline à battre
 *
 * Signal (révision 4 du plan) :
 *   projected = spot                                  si remaining >= 60 s
 *             = (spot×remaining + twap60×(60−remaining))/60   sinon
 *   movePct   = (projected − twap60AtWindowStart)/twap60AtWindowStart × 100
 *   côté      = Up (0) si move > 0, Down (1) sinon ; tie → Up
 *
 * Feed simulé : klines 1s Binance (cache data.binance.vision, Phase 0).
 *
 * Sortie : audits/chainlink-lag/SIGNAL-<stamp>.md + .json (+ SIGNAL.md)
 *
 *   npx tsx scripts/research/chainlink-lag/04-signal-sim.mts
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Constantes (défauts du plan §3.5) ───────────────────────────────────────
const DB_PATH = "data/bot-live.db";
const KLINES_DIR = "data/chainlink-lag-cache/klines-1s";
const WINDOW_SEC = 900;
const TWAP_SEC = 60;
const OUT_DIR = "audits/chainlink-lag";
// Gates moteur (§3.4)
const MIN_ASK = 0.1;
const MAX_ASK = 0.8;
const MAX_SPREAD = 0.03;
const MIN_ELAPSED_SEC = 30;
const MAX_ELAPSED_SEC = 600;
const ORDER_USDC = 5;
const MAX_SHARES = 30;
const MIN_CLOB_SHARES = 5;
// Univers aligné runner
const MIN_TICKS = 801;
const MAX_GAP_MS = 60_000;
// Grille
const THRESHOLDS = [0.1, 0.15, 0.2, 0.25, 0.3];
const CONFIRM_TICKS = [1, 2, 3];

const PREFIXES = [
  { prefix: "btc-updown-15m", symbol: "BTCUSDT", asset: "btc" },
  { prefix: "eth-updown-15m", symbol: "ETHUSDT", asset: "eth" },
];

// ── Klines (cache par jour, cf. 01-twap-proxy.mts) ──────────────────────────
async function loadKlines(symbol: string): Promise<Map<number, number>> {
  const dir = join(KLINES_DIR, symbol);
  const out = new Map<number, number>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const raw = JSON.parse(await readFile(join(dir, f), "utf8")) as Array<[number, number]>;
    for (const [sec, close] of raw) out.set(sec, close);
  }
  return out;
}

// ── Types ───────────────────────────────────────────────────────────────────
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

// ── Univers (aligné runner) ─────────────────────────────────────────────────
function parseWindowStart(slug: string): number | null {
  const parts = slug.split("-");
  const startSec = Number(parts[parts.length - 1]);
  return Number.isFinite(startSec) && startSec > 1e9 ? startSec : null;
}

function buildUniverse(db: DatabaseSync, resMap: Map<string, number>): Map<string, Tick[]> {
  const out = new Map<string, Tick[]>();
  for (const { prefix } of PREFIXES) {
    const rows = db
      .prepare(
        `SELECT eventSlug AS slug, ts, outcomeIndex, bestAsk, bestBid, bestAskSize
         FROM book_snapshots WHERE eventSlug LIKE ? ORDER BY eventSlug, ts`,
      )
      .all(prefix + "-%") as unknown as Array<{ slug: string; ts: number; outcomeIndex: number; bestAsk: number | null; bestBid: number | null; bestAskSize: number | null }>;

    const bySlug = new Map<string, Map<number, { up: SideBook; down: SideBook }>>();
    for (const r of rows) {
      let m = bySlug.get(r.slug);
      if (!m) {
        m = new Map();
        bySlug.set(r.slug, m);
      }
      let e = m.get(r.ts);
      if (!e) {
        e = { up: { ask: null, bid: null, askSize: null }, down: { ask: null, bid: null, askSize: null } };
        m.set(r.ts, e);
      }
      const side = r.outcomeIndex === 0 ? e.up : e.down;
      side.ask = r.bestAsk;
      side.bid = r.bestBid;
      side.askSize = r.bestAskSize;
    }

    for (const [slug, m] of bySlug) {
      const wsSec = parseWindowStart(slug);
      if (wsSec == null) continue;
      if (!resMap.has(slug)) continue;
      const wsMs = wsSec * 1000;
      const weMs = (wsSec + WINDOW_SEC) * 1000;
      const tsList = [...m.keys()].filter((ts) => ts >= wsMs && ts <= weMs).sort((a, b) => a - b);
      if (tsList.length < MIN_TICKS) continue;
      let maxGap = 0;
      for (let i = 1; i < tsList.length; i++) {
        const g = tsList[i] - tsList[i - 1];
        if (g > maxGap) maxGap = g;
      }
      if (maxGap > MAX_GAP_MS) continue;
      const ticks: Tick[] = [];
      for (const ts of tsList) {
        const e = m.get(ts)!;
        if (e.up.ask == null && e.down.ask == null) continue;
        ticks.push({ ts, up: e.up, down: e.down });
      }
      out.set(slug, ticks);
    }
  }
  return out;
}

// ── Précalcul des signaux par fenêtre ───────────────────────────────────────
interface Pre {
  moveProj: Float64Array; // vs barre (famille A/C) ; NaN = feed absent
  moveNaive: Float64Array; // spot vs twapnow (famille B)
  bar: number; // TWAP-60s BACKWARD figée à ws (NaN si indisponible)
}

function precompute(
  wsSec: number,
  weSec: number,
  ticks: Tick[],
  closes: Map<number, number>,
): Pre {
  const loSec = wsSec - TWAP_SEC;
  const hiSec = weSec;
  const n = hiSec - loSec + 1;
  const sums = new Float64Array(n + 1); // prefix sums des closes
  const counts = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const sec = loSec + i;
    const v = closes.get(sec);
    sums[i + 1] = sums[i] + (v ?? 0);
    counts[i + 1] = counts[i] + (v == null ? 0 : 1);
  }
  const twapAt = (endSec: number): number => {
    // moyenne des closes sur [endSec−59, endSec]
    const hiIdx = endSec - loSec + 1;
    const loIdx = hiIdx - TWAP_SEC;
    if (loIdx < 0) return NaN;
    const cnt = counts[hiIdx] - counts[loIdx];
    if (cnt < 55) return NaN;
    return (sums[hiIdx] - sums[loIdx]) / cnt;
  };
  const bar = twapAt(wsSec); // convention BACKWARD validée A6

  const m = ticks.length;
  const moveProj = new Float64Array(m);
  const moveNaive = new Float64Array(m);
  const weMs = weSec * 1000;
  for (let i = 0; i < m; i++) {
    const s = Math.floor(ticks[i].ts / 1000);
    const sp = closes.has(s) ? closes.get(s)! : NaN;
    const t60 = twapAt(s);
    if (Number.isFinite(sp) && Number.isFinite(t60) && Number.isFinite(bar) && bar > 0) {
      const remaining = (weMs - ticks[i].ts) / 1000;
      const projected = remaining >= 60 ? sp : (sp * remaining + t60 * (60 - remaining)) / 60;
      moveProj[i] = ((projected - bar) / bar) * 100;
      moveNaive[i] = ((sp - t60) / t60) * 100;
    } else {
      moveProj[i] = NaN;
      moveNaive[i] = NaN;
    }
  }
  return { moveProj, moveNaive, bar: Number.isFinite(bar) ? bar : NaN };
}

// ── Sim ─────────────────────────────────────────────────────────────────────
interface Trade {
  slug: string;
  asset: string;
  ts: number; // heure du trigger
  wsSec: number; // ouverture de la fenêtre (pour split-half / concurrence)
  elapsed: number;
  side: number; // 0=Up 1=Down
  ask: number;
  shares: number;
  cost: number; // mise engagée ($)
  movePct: number;
  winner: boolean;
  pnl: number; // $ (hold to resolution)
  pnlPct: number;
}

function sideBookOf(t: Tick, side: number): SideBook {
  return side === 0 ? t.up : t.down;
}

function sharesFor(ask: number): { shares: number; reason: string | null } {
  const raw = Math.min(ORDER_USDC / ask, MAX_SHARES);
  const shares = Math.floor(raw * 100) / 100;
  if (shares < MIN_CLOB_SHARES) return { shares, reason: "engine-mute (< 5 shares)" };
  return { shares, reason: null };
}

interface WinCtx {
  slug: string;
  asset: string;
  wsSec: number;
  weSec: number;
  winner: number;
  ticks: Tick[];
  pre: Pre;
}

function runFamily(
  wins: WinCtx[],
  kind: "proj" | "naive",
  threshold: number,
  confirmN: number,
): { trades: Trade[]; rejects: Map<string, number> } {
  const trades: Trade[] = [];
  const rejects = new Map<string, number>();
  const bump = (r: string) => rejects.set(r, (rejects.get(r) ?? 0) + 1);

  for (const w of wins) {
    const moves = kind === "naive" ? w.pre.moveNaive : w.pre.moveProj;
    const wsMs = w.wsSec * 1000;
    const weMs = w.weSec * 1000;
    let streak = 0;
    let done = false;
    for (let i = 0; i < w.ticks.length && !done; i++) {
      const t = w.ticks[i];
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < MIN_ELAPSED_SEC) continue;
      if (elapsed > MAX_ELAPSED_SEC) break;
      const mv = moves[i];
      if (!Number.isFinite(mv)) continue; // feed absent à ce tick
      if (Math.abs(mv) >= threshold) {
        streak++;
        if (streak < confirmN) continue;
      } else {
        streak = 0;
        continue;
      }
      // trigger à CE tick
      const side = mv > 0 ? 0 : 1;
      const book = sideBookOf(t, side);
      const ask = book.ask;
      const bid = book.bid;
      if (ask == null || !Number.isFinite(ask)) {
        bump("ask-null");
        break;
      }
      if (ask < MIN_ASK || ask > MAX_ASK) {
        bump(`ask-band(${ask.toFixed(2)})`);
        break;
      }
      if (bid == null || !Number.isFinite(bid) || ask - bid > MAX_SPREAD) {
        bump("spread");
        break;
      }
      const { shares, reason } = sharesFor(ask);
      if (reason) {
        bump(reason);
        break;
      }
      if (book.askSize == null || book.askSize < shares) {
        bump("depth");
        break;
      }
      const winner = w.winner === side;
      const cost = shares * ask;
      const pnl = shares * (winner ? 1 : 0) - cost;
      trades.push({
        slug: w.slug,
        asset: w.asset,
        ts: t.ts,
        wsSec: w.wsSec,
        elapsed,
        side,
        ask,
        shares,
        cost,
        movePct: mv,
        winner,
        pnl,
        pnlPct: (pnl / cost) * 100,
      });
      done = true;
    }
    void weMs;
  }
  return { trades, rejects };
}

/** Contrôle causal : achat du FAVORI au premier tick éligible (sans move). */
function runControl(wins: WinCtx[]): { trades: Trade[]; rejects: Map<string, number> } {
  const trades: Trade[] = [];
  const rejects = new Map<string, number>();
  const bump = (r: string) => rejects.set(r, (rejects.get(r) ?? 0) + 1);
  for (const w of wins) {
    const wsMs = w.wsSec * 1000;
    for (const t of w.ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < MIN_ELAPSED_SEC) continue;
      if (elapsed > MAX_ELAPSED_SEC) break;
      const upAsk = t.up.ask ?? NaN;
      const downAsk = t.down.ask ?? NaN;
      if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk)) continue;
      const side = upAsk >= downAsk ? 0 : 1; // favori = ask le plus haut
      const book = sideBookOf(t, side);
      const ask = book.ask!;
      if (ask < MIN_ASK || ask > MAX_ASK) {
        bump("ask-band");
        break;
      }
      const bid = book.bid;
      if (bid == null || !Number.isFinite(bid) || ask - bid > MAX_SPREAD) {
        bump("spread");
        break;
      }
      const { shares, reason } = sharesFor(ask);
      if (reason) {
        bump(reason);
        break;
      }
      if (book.askSize == null || book.askSize < shares) {
        bump("depth");
        break;
      }
      const winner = w.winner === side;
      const cost = shares * ask;
      const pnl = shares * (winner ? 1 : 0) - cost;
      trades.push({ slug: w.slug, asset: w.asset, ts: t.ts, wsSec: w.wsSec, elapsed, side, ask, shares, cost, movePct: NaN, winner, pnl, pnlPct: (pnl / cost) * 100 });
      break;
    }
  }
  return { trades, rejects };
}

// ── Stats ───────────────────────────────────────────────────────────────────
interface Financials {
  n: number;
  wr: number | null;
  pnl: number;
  pnlPctMean: number;
  pnlPctTotal: number;
  avgAsk: number;
  tStat: number;
  winsN: number;
  lossesN: number;
  avgWin: number | null; // $ par trade gagnant
  avgLoss: number | null; // $ par trade perdant (négatif)
  maxWin: number;
  maxLoss: number;
  avgCost: number; // mise effective moyenne ($)
  totalStaked: number; // exposition totale ($)
  maxDrawdown: number; // drawdown max de la courbe de capital ($)
  baseCapital: number; // capital de base = max drawdown + 1 mise moyenne
  roiOnBase: number; // PnL / capital de base × 100
}

function stats(trades: Trade[]): Financials {
  const n = trades.length;
  if (n === 0) {
    return { n: 0, wr: null, pnl: 0, pnlPctMean: NaN, pnlPctTotal: 0, avgAsk: NaN, tStat: NaN, winsN: 0, lossesN: 0, avgWin: null, avgLoss: null, maxWin: 0, maxLoss: 0, avgCost: NaN, totalStaked: 0, maxDrawdown: 0, baseCapital: 0, roiOnBase: 0 };
  }
  const winsN = trades.filter((t) => t.winner).length;
  const lossesN = n - winsN;
  const wr = (winsN / n) * 100;
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const pnlPctMean = trades.reduce((a, t) => a + t.pnlPct, 0) / n;
  const pnlPctTotal = trades.reduce((a, t) => a + t.pnlPct, 0);
  const avgAsk = trades.reduce((a, t) => a + t.ask, 0) / n;
  const sd = Math.sqrt(trades.reduce((a, t) => a + (t.pnlPct - pnlPctMean) ** 2, 0) / (n - 1));
  const tStat = sd > 0 ? pnlPctMean / (sd / Math.sqrt(n)) : NaN;
  const winTrades = trades.filter((t) => t.winner);
  const lossTrades = trades.filter((t) => !t.winner);
  const avgWin = winTrades.length ? winTrades.reduce((a, t) => a + t.pnl, 0) / winTrades.length : null;
  const avgLoss = lossTrades.length ? lossTrades.reduce((a, t) => a + t.pnl, 0) / lossTrades.length : null;
  const maxWin = winTrades.length ? Math.max(...winTrades.map((t) => t.pnl)) : 0;
  const maxLoss = lossTrades.length ? Math.min(...lossTrades.map((t) => t.pnl)) : 0;
  const avgCost = trades.reduce((a, t) => a + t.cost, 0) / n;
  const totalStaked = trades.reduce((a, t) => a + t.cost, 0);
  // Courbe de capital (trades triés par ts réels)
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  const baseCapital = maxDd + avgCost;
  return {
    n, wr, pnl, pnlPctMean, pnlPctTotal, avgAsk, tStat,
    winsN, lossesN, avgWin, avgLoss, maxWin, maxLoss,
    avgCost, totalStaked, maxDrawdown: maxDd, baseCapital,
    roiOnBase: baseCapital > 0 ? (pnl / baseCapital) * 100 : 0,
  };
}

const fmt = (x: number | null | undefined, suffix = ""): string =>
  x == null || Number.isNaN(x) ? "—" : x.toFixed(2) + suffix;

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const t0 = Date.now();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const resRows = db.prepare("SELECT eventSlug, winnerOutcomeIndex FROM market_resolutions").all() as unknown as Array<{ eventSlug: string; winnerOutcomeIndex: number }>;
  const resMap = new Map(resRows.map((r) => [r.eventSlug, r.winnerOutcomeIndex]));
  const universe = buildUniverse(db, resMap);
  db.close();
  console.log(`univers aligné runner: ${universe.size} fenêtres (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const klines = new Map<string, Map<number, number>>();
  for (const { symbol } of PREFIXES) {
    klines.set(symbol, await loadKlines(symbol));
  }

  const wins: WinCtx[] = [];
  for (const [slug, ticks] of universe) {
    const p = PREFIXES.find((x) => slug.startsWith(x.prefix))!;
    const wsSec = parseWindowStart(slug)!;
    const closes = klines.get(p.symbol)!;
    const pre = precompute(wsSec, wsSec + WINDOW_SEC, ticks, closes);
    wins.push({ slug, asset: p.asset, wsSec, weSec: wsSec + WINDOW_SEC, winner: resMap.get(slug)!, ticks, pre });
  }
  console.log(`précalculs: ${wins.length} fenêtres (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const withBar = wins.filter((w) => Number.isFinite(w.pre.bar));

  const grid: Array<{ family: string; threshold: number; confirm: number; res: Financials; rejects: Map<string, number>; trades: Trade[] }> = [];
  for (const thr of THRESHOLDS) {
    const a = runFamily(wins, "proj", thr, 1);
    grid.push({ family: "A-proj", threshold: thr, confirm: 1, res: stats(a.trades), rejects: a.rejects, trades: a.trades });
    const b = runFamily(wins, "naive", thr, 1);
    grid.push({ family: "B-naive", threshold: thr, confirm: 1, res: stats(b.trades), rejects: b.rejects, trades: b.trades });
    for (const c of CONFIRM_TICKS.slice(1)) {
      const r = runFamily(withBar, "proj", thr, c);
      grid.push({ family: `C-confirm${c}`, threshold: thr, confirm: c, res: stats(r.trades), rejects: r.rejects, trades: r.trades });
    }
  }
  const ctrl = runControl(wins);
  const ctrlRes = stats(ctrl.trades);
  console.log(`familles évaluées: ${grid.length} + contrôle (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ── Rapport ───────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# Phase 2 — SIGNAL sim chainlink-lag");
  lines.push("");
  lines.push(`- Généré: ${new Date().toISOString()}`);
  lines.push(`- Univers aligné runner: ${universe.size} fenêtres résolues (>= ${MIN_TICKS} ticks, gap <= 60 s), avec barre: ${withBar.length}`);
  lines.push(`- Feed simulé: klines 1s Binance (data.binance.vision) ; barre BACKWARD (A6)`);
  lines.push(`- Gates: ask ∈ [${MIN_ASK}, ${MAX_ASK}], spread <= ${MAX_SPREAD}, depth FOK, elapsed ∈ [${MIN_ELAPSED_SEC}, ${MAX_ELAPSED_SEC}] s, 1 trigger/fenêtre`);
  lines.push(`- Sizing: ${ORDER_USDC}$ / ask (cap ${MAX_SHARES} shares, min CLOB ${MIN_CLOB_SHARES}) ; hold to resolution`);
  lines.push("");

  lines.push("## Grille familles × seuils");
  lines.push("");
  lines.push("| Famille | Seuil | n | WR | PnL$ | PnL%/trade | t-stat | Ask moyen (breakeven) |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const g of grid) {
    const r = g.res;
    lines.push(
      `| ${g.family} | ${g.threshold} | ${r.n} | ${fmt(r.wr, "%")} | ${fmt(r.pnl, "$")} | ${fmt(r.pnlPctMean, "%")} | ${fmt(r.tStat)} | ${fmt(r.avgAsk)} |`,
    );
  }
  lines.push("");

  // ── Détail financier des configs principales ────────────────────────────
  const keyConfigs = [
    { label: "A-proj @ 0.1 (meilleur n de la famille principale)", g: grid.find((x) => x.family === "A-proj" && x.threshold === 0.1) },
    { label: "A-proj @ 0.15 (défaut plan)", g: grid.find((x) => x.family === "A-proj" && x.threshold === 0.15) },
    { label: `Contrôle (favori sans signal)`, g: { res: ctrlRes } as never as { res: Financials } },
  ];
  lines.push("## Détail financier (configs principales)");
  lines.push("");
  for (const { label, g } of keyConfigs) {
    if (!g) continue;
    const r = g.res;
    if (r.n === 0) continue;
    const payoff = r.avgLoss != null && r.avgWin != null && r.avgLoss !== 0 ? (r.avgWin / Math.abs(r.avgLoss)).toFixed(2) : "—";
    lines.push(`### ${label}`);
    lines.push("");
    lines.push("| Métrique | Valeur |");
    lines.push("|---|---|");
    lines.push(`| **Capital de base** (max drawdown + 1 mise) | **${fmt(r.baseCapital, "$")}** |`);
    lines.push(`| Mise par trade (cost = shares × ask, cap ${MAX_SHARES} sh) | ${fmt(r.avgCost, "$")} en moyenne (${fmt(r.totalStaked, "$")} engagés au total) |`);
    lines.push(`| AVG Win / AVG Loss | +${fmt(r.avgWin, "$")} / ${fmt(r.avgLoss, "$")} (payoff ${r.avgWin != null && r.avgLoss != null && r.avgLoss !== 0 ? (r.avgWin / Math.abs(r.avgLoss)).toFixed(2) : "—"}) |`);
    lines.push(`| Max Win / Max Loss | +${fmt(r.maxWin, "$")} / ${fmt(r.maxLoss, "$")} |`);
    lines.push(`| Trades gagnants / perdants | ${r.winsN} / ${r.lossesN} (WR ${fmt(r.wr, "%")}) |`);
    lines.push(`| WR breakeven (payoff-driven) | ${r.avgWin != null && r.avgLoss != null ? fmt((Math.abs(r.avgLoss) / (r.avgWin + Math.abs(r.avgLoss))) * 100, "%") : "—"} (WR réel ${fmt(r.wr, "%")}) |`);
    lines.push(`| Max drawdown (courbe cumulée) | ${fmt(r.maxDrawdown, "$")} |`);
    lines.push(`| ROI sur capital de base | ${fmt(r.roiOnBase, "%")} |`);
    lines.push(`| t-stat (EV/trade vs 0) | ${fmt(r.tStat)} |`);
    lines.push("");
  }

  // ── Split-half + par asset (famille A, meilleur seuil viable) ───────────
  const candidates = grid.filter((g) => g.family === "A-proj" && g.res.n >= 100);
  const best = candidates.sort((a, b) => (b.res.pnlPctMean || -Infinity) - (a.res.pnlPctMean || -Infinity))[0];
  lines.push("## Split-half (famille A, meilleur seuil viable)");
  lines.push("");
  if (best) {
    const trades = [...best.trades].sort((a, b) => a.wsSec - b.wsSec);
    const half = Math.floor(trades.length / 2);
    for (const [label, part] of [
      ["moitié ancienne", trades.slice(0, half)],
      ["moitié récente", trades.slice(half)],
    ] as const) {
      const r = stats(part);
      lines.push(`- ${label}: n=${r.n}, WR ${fmt(r.wr, "%")}, PnL%/trade ${fmt(r.pnlPctMean, "%")}, PnL ${fmt(r.pnl, "$")}`);
    }
    for (const asset of ["btc", "eth"]) {
      const r = stats(best.trades.filter((t) => t.asset === asset));
      lines.push(`- ${asset}: n=${r.n}, WR ${fmt(r.wr, "%")}, PnL%/trade ${fmt(r.pnlPctMean, "%")}`);
    }
    const rej = [...best.rejects.entries()].sort((a, b) => b[1] - a[1]);
    lines.push("");
    lines.push(`- Rejets (par fenêtre, au premier blocage): ${rej.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } else {
    lines.push("- aucune config famille A avec n >= 100");
  }
  lines.push("");

  // ── Verdict ──────────────────────────────────────────────────────────────
  lines.push("## Verdict");
  lines.push("");
  const okConfigs = grid.filter((g) => g.res.n >= 100 && g.res.pnlPctMean > 0 && g.res.tStat >= 2);
  if (okConfigs.length > 0) {
    const b = okConfigs.sort((a, b) => b.res.pnlPctMean - a.res.pnlPctMean)[0];
    lines.push(`**SURVIT** — ${b.family} @ ${b.threshold}% : n=${b.res.n}, WR ${fmt(b.res.wr, "%")}, PnL%/trade ${fmt(b.res.pnlPctMean, "%")}, t=${fmt(b.res.tStat)}. Passer au wiring (Phase 3) après split-half OK.`);
  } else {
    const bestAny = grid.filter((g) => g.res.n > 0).sort((a, b) => (b.res.pnlPctMean || -Infinity) - (a.res.pnlPctMean || -Infinity))[0];
    if (bestAny) {
      lines.push(`**DEAD** — aucune config avec n >= 100 ET PnL%/trade > 0 ET t >= 2. Meilleure: ${bestAny.family}@${bestAny.threshold} (n=${bestAny.res.n}, PnL%/trade ${fmt(bestAny.res.pnlPctMean, "%")}, t=${fmt(bestAny.res.tStat)}). Ne PAS wirer le moteur.`);
    } else {
      lines.push("**DEAD** — aucun trigger généré (vérifier la couverture feed/univers).");
    }
  }
  lines.push("");

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now();
  const md = lines.join("\n");
  writeFileSync(`audits/chainlink-lag/SIGNAL-${stamp}.md`, md);
  writeFileSync(`audits/chainlink-lag/SIGNAL-${stamp}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), grid: grid.map((g) => ({ family: g.family, threshold: g.threshold, res: g.res, rejects: [...g.rejects] })), control: { res: ctrlRes, rejects: [...ctrl.rejects] } }, null, 2));
  writeFileSync("audits/chainlink-lag/SIGNAL.md", md);
  console.log(md);
  console.log(`\nÉcrit: audits/chainlink-lag/SIGNAL-${stamp}.md + .json (+ SIGNAL.md)`);
  console.log(`Durée totale: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});