/**
 * verify-claims dip-guard — contre-vérification indépendante (round 2).
 * READ-ONLY. Réimplémentation INDÉPENDANTE du moteur dip-guard-sim.mts,
 * recodée depuis la SPEC (pas importée de la sim), puis instrumentation :
 *   1. Baseline : doit reproduire EXACTEMENT les 3 configs round-2
 *      (INV-hold, d35-40 tp0.85, BEST fav<=0.65 tp0.85) — fills exacts,
 *      PnL ±0.05, exits décomposés, DD.
 *   2. Consistances : sum(byDay) == pnl, WR == wins/fills,
 *      invariant fills == tpExits + holds.
 *   3. PnL par bucket d'elapsed d'entrée — l'edge est-il exécutable en live ?
 *   4. PnL % sur notional déployé (base unique) + histogramme prix.
 *
 * npx tsx scripts/research/dip-guard/verify-claims.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type SideBook } from "./universe.mts";

const OUT_DIR = join("audits", "backtest", "dip-guard");

interface Cfg {
  label: string;
  detectMin: number;
  detectMax: number;
  favMax: number | null;
  tpBid: number | null;
  entryMaxSec: number;
  maxSpread: number;
}

// Références round-2 (sortie CLI dip-guard-sim-1789549414091.json)
const REF: Record<
  string,
  { fills: number; pnl: number; wrPct: number; tp: number; hold: number; dd: number }
> = {
  "INV-hold": { fills: 486, pnl: 404.76, wrPct: 66, tp: 0, hold: 486, dd: 175.28 },
  "d35-40 tp0.85": { fills: 482, pnl: 436.7, wrPct: 75, tp: 318, hold: 164, dd: 78.12 },
  "BEST fav<=0.65 tp0.85": { fills: 478, pnl: 433.57, wrPct: 75, tp: 314, hold: 164, dd: 82.14 },
};

const CONFIGS: Cfg[] = [
  { label: "INV-hold", detectMin: 0.3, detectMax: 0.4, favMax: null, tpBid: null, entryMaxSec: 300, maxSpread: 0.05 },
  { label: "d35-40 tp0.85", detectMin: 0.35, detectMax: 0.4, favMax: null, tpBid: 0.85, entryMaxSec: 300, maxSpread: 0.05 },
  { label: "BEST fav<=0.65 tp0.85", detectMin: 0.35, detectMax: 0.4, favMax: 0.65, tpBid: 0.85, entryMaxSec: 300, maxSpread: 0.05 },
];

/** Walk FOK sell worst-price, recodé indépendamment depuis la spec CLOB. */
function sellWalk(
  book: Pick<SideBook, "bid" | "bidSize" | "bid2" | "bid2Size" | "bid3" | "bid3Size">,
  size: number,
  trigger: number,
): number | null {
  const worst = Math.max(0.01, trigger - 0.02);
  const levels: Array<[number | null, number | null]> = [
    [book.bid, book.bidSize],
    [book.bid2, book.bid2Size],
    [book.bid3, book.bid3Size],
  ];
  let remaining = size;
  let cost = 0;
  for (const [px, sz] of levels) {
    if (px == null || px < worst) break;
    const take = Math.min(remaining, sz ?? 0);
    cost += take * px;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  return remaining > 1e-9 ? null : cost / size;
}

interface Pos {
  price: number;
  size: number;
  idx: 0 | 1;
  entryElapsed: number;
}

function runVerify(u: ReturnType<typeof loadUniverse>, C: Cfg) {
  let fills = 0,
    tpExits = 0,
    holds = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDD = 0,
    shares = 0,
    notional = 0;
  const byDay: Record<string, number> = {};
  const byElapsed: Record<string, { n: number; pnl: number; wins: number }> = {};
  const entryPxHist: Record<string, number> = {};
  const tradePnls: number[] = [];

  const close = (pos: Pos, exitPx: number, kind: "tp" | "hold", day: string) => {
    const p = (exitPx - pos.price) * pos.size;
    pnl += p;
    tradePnls.push(p);
    if (kind === "tp") tpExits++;
    else holds++;
    if (p > 0) wins++;
    else losses++;
    peak = Math.max(peak, pnl);
    maxDD = Math.max(maxDD, peak - pnl);
    byDay[day] = (byDay[day] ?? 0) + p;
    const b = Math.floor(pos.entryElapsed / 60) * 60;
    const bucket = `${b}-${b + 59}s`;
    (byElapsed[bucket] ??= { n: 0, pnl: 0, wins: 0 });
    byElapsed[bucket].n++;
    byElapsed[bucket].pnl += p;
    if (p > 0) byElapsed[bucket].wins++;
  };

  for (const [slug, ticks] of u.slugs) {
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;
    const day = new Date(wsMs).toISOString().slice(0, 10);

    let pos: Pos | null = null;
    let done = false;

    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      if (done) break;

      // ----- exit take-profit sur le carnet du token détenu -----
      if (pos) {
        const book = pos.idx === 0 ? t.up : t.down;
        const bid = book.bid;
        if (C.tpBid != null && bid != null && bid >= C.tpBid) {
          const px = sellWalk(book, pos.size, bid);
          if (px != null) {
            close(pos, px, "tp", day);
            pos = null;
            done = true;
            continue;
          }
        }
        continue;
      }

      // ----- détection underdog dans la bande (le moins cher si 2) -----
      if (elapsed > C.entryMaxSec) continue;
      let det: { idx: 0 | 1; book: SideBook } | null = null;
      let detAsk = Infinity;
      for (const idx of [0, 1] as const) {
        const book = idx === 0 ? t.up : t.down;
        if (book.ask == null) continue;
        if (book.ask < C.detectMin || book.ask > C.detectMax) continue;
        if (book.ask < detAsk) {
          detAsk = book.ask;
          det = { idx, book };
        }
      }
      if (!det) continue;
      // cible = l'AUTRE jambe (le favori)
      const target = det.idx === 0 ? t.down : t.up;
      if (target.ask == null) continue;
      if (target.ask <= 0.5) continue; // garde de cohérence
      if (C.favMax != null && target.ask > C.favMax) continue;
      const bid = target.bid;
      if (bid != null && target.ask - bid > C.maxSpread) continue;
      const size = Math.min(15 / target.ask, 30);
      if (size < 5) continue; // MIN_CLOB_SHARES
      if (target.askSize != null && target.askSize < size) continue;
      pos = {
        price: target.ask,
        size,
        idx: det.idx === 0 ? 1 : 0,
        entryElapsed: elapsed,
      };
      fills++;
      shares += size;
      notional += target.ask * size;
      const pxKey = String(Math.round(target.ask * 100));
      entryPxHist[pxKey] = (entryPxHist[pxKey] ?? 0) + 1;
    }

    // ----- fin de fenêtre : hold-to-resolution -----
    if (!pos) continue;
    const win = res === pos.idx;
    close(pos, win ? 1 : 0, "hold", day);
  }

  const round = (x: number, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
  const mean = tradePnls.reduce((a, b) => a + b, 0) / (tradePnls.length || 1);
  const variance =
    tradePnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (tradePnls.length || 1);
  const std = Math.sqrt(variance);
  const avgEntry = shares ? notional / shares : null;
  const wr = fills ? (wins / fills) * 100 : null;
  // t-stat empirique sur les PnL par trade
  const tEmp = tradePnls.length ? (mean / (std / Math.sqrt(tradePnls.length))) : null;
  return {
    label: C.label,
    fills,
    tpExits,
    holds,
    wins,
    losses,
    pnl: round(pnl),
    maxDD: round(maxDD * 100) / 100,
    shares: round(shares),
    notional: round(notional),
    winRate: round(wr, 1),
    avgEntry: avgEntry ? round(avgEntry, 3) : null,
    evPerShare: shares ? round(pnl / shares, 3) : null,
    pnlPctNotional: notional ? round((pnl / notional) * 1000, 1) : null,
    tStatEmpirical: tEmp ? round(tEmp, 2) : null,
    sumByDay: round(Object.values(byDay).reduce((a, b) => a + b, 0)),
    byDay: Object.fromEntries(Object.entries(byDay).map(([d, v]) => [d, round(v)])),
    byElapsed: Object.fromEntries(
      Object.entries(byElapsed).map(([k, v]) => [
        k,
        { n: v.n, pnl: round(v.pnl), wins: v.wins },
      ]),
    ),
    entryPxHist,
  };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const u = loadUniverse();
  console.log(`universe: ${u.slugs.size} windows`);

  const results: Record<string, ReturnType<typeof runVerify>> = {};
  let allMatch = true;
  for (const C of CONFIGS) {
    const r = runVerify(u, C);
    results[C.label] = r;
    const ref = REF[C.label];
    const invariant = r.fills === r.tpExits + r.holds;
    const dayOk = Math.abs(r.sumByDay - r.pnl) < 0.02;
    const wrOk = Math.abs((r.winRate ?? 0) - (r.wins / r.fills) * 100) < 0.05;
    const match =
      r.fills === ref.fills &&
      Math.abs(r.pnl - ref.pnl) < 0.05 &&
      r.tpExits === ref.tp &&
      r.holds === ref.hold &&
      Math.abs(r.maxDD - ref.dd) < 0.05 &&
      invariant &&
      dayOk &&
      wrOk;
    if (!match) allMatch = false;
    console.log(
      `${r.label.padEnd(24)} fills=${r.fills} tp=${r.tpExits} hold=${r.holds} WR=${r.winRate}% PnL=${r.pnl} DD=${r.maxDD} | vs sim: ${match ? "MATCH" : `MISMATCH (ref ${ref.fills}/$${ref.pnl}/tp${ref.tp}/hold${ref.hold}/dd${ref.dd})`} | sum(byDay)=${r.sumByDay} | PnL/notional=${r.pnlPctNotional}% | t_emp=${r.tStatEmpirical}`,
    );
  }
  console.log(allMatch ? "\nALL BASELINES MATCH — signal indépendamment reproduit" : "\n!! MISMATCH — la sim d'origine ne reproduit pas son rapport");

  const outPath = join(OUT_DIR, `verify-claims-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: "verify-claims dip-guard (round 2)",
        generatedAt: new Date().toISOString(),
        universe: u.slugs.size,
        allMatch,
        results,
      },
      null,
      2,
    ),
  );
  console.log("written:", outPath);
}

if (process.argv[1]?.endsWith("verify-claims.mts")) main();