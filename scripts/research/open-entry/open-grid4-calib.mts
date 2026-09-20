/**
 * Grille 4 open-entry : sim calibrée runner.
 *
 * Deux deltas mécaniques vs les grilles 1-3 (le runner officiel est la
 * vérité terrain) :
 *  - exits L1-only : sellFillAgainstBook du runner ne remplit qu'au niveau 1
 *    avec requireFullSize — la sim 3 niveaux est plus permissive ;
 *  - sizing runner : computeSize(orderUsdc=15, prix) floor 2 décimales,
 *    plafonné par maxSharesPerOrder=30 (10 shares fixes avant).
 * Entrée : mode "ec" = early-conviction exact (favori max-ask dans
 * [askMin, askMax], spread ≤ max, fenêtre [0, maxElapsedSec]) pour que la
 * calibration runner ↔ sim soit un ancrage honnête (le moteur natif existe) ;
 * mode "lean" = open-entry momentum (recherche).
 */
import { loadUniverse, type Tick, type SideBook } from "./universe.mts";

export interface RConfig {
  label: string;
  entryMode: "ec" | "lean";
  leanTrigger: number;
  entryWindowSec: number;
  fairMax: number;
  // early-conviction
  askMin: number;
  askMax: number;
  maxSpread: number;
  maxElapsedSec: number;
  // exits
  slStructFlipDist: number;
  slStructConfirmSec: number;
  slStructDist: number;
  slLateAfterSec: number;
  slLateDist: number;
  // sizing runner-fidèle
  orderUsdc: number;
  maxSharesPerOrder: number;
}

export const RC_REF: RConfig = {
  label: "ec hold (runner-cal)",
  entryMode: "ec",
  leanTrigger: 0.15,
  entryWindowSec: 300,
  fairMax: 1.02,
  askMin: 0.6,
  askMax: 0.8,
  maxSpread: 0.05,
  maxElapsedSec: 45,
  slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1,
  slLateAfterSec: 300, slLateDist: 0.06,
  orderUsdc: 15, maxSharesPerOrder: 30,
};

const SLIP = 0; // exits runner : fill au bid L1 exact (comme le runner)

function rSell(book: SideBook, size: number): number | null {
  if (book.bid == null) return null;
  const bidSize = book.bidSize;
  if (bidSize == null || bidSize <= 0) return null;
  if (bidSize + 1e-12 < size) return null; // requireFullSize L1-only
  return book.bid; // fill au bid exact, limit 0
}

function rSize(orderUsdc: number, price: number, maxShares: number): number | null {
  const px = Math.max(price, 0.01);
  let size = Math.floor(Math.min(orderUsdc / px, maxShares) * 100) / 100;
  if (size < 5) return null;
  if (size * px < 1) return null; // pas de bump (slack 2¢ jamais actif ici)
  return size;
}

interface RTrade {
  slug: string;
  day: string;
  entryAge: number;
  side: "up" | "down";
  entryPx: number;
  size: number;
  exitType: "resolution" | "sl-struct" | "sl-late" | "tp";
  exitAge: number;
  exitPx: number | null;
  won: boolean;
  pnl: number;
}

function runRWindow(ticks: Tick[], wsSec: number, winner: number, cfg: RConfig): RTrade | null {
  const t0 = wsSec * 1000;
  const age = (t: Tick) => (t.ts - t0) / 1000;

  // --- entrée (ec ou lean) + sizing runner ---
  let side: "up" | "down" | null = null;
  let entryPx = 0, entryAge = 0, size = 0;
  for (const t of ticks) {
    const a = age(t);
    if (t.up.ask == null || t.down.ask == null) continue;
    if (cfg.entryMode === "ec") {
      const fav = t.up.ask >= t.down.ask ? t.up : t.down;
      const favSide: "up" | "down" = t.up.ask >= t.down.ask ? "up" : "down";
      if (fav.ask == null) continue;
      const ask = fav.ask;
      if (a < 0) continue;
      if (a > cfg.maxElapsedSec) return null;
      if (ask < cfg.askMin || ask > cfg.askMax) continue;
      if (fav.bid != null && ask - fav.bid > cfg.maxSpread) continue;
      const s = rSize(cfg.orderUsdc, ask, cfg.maxSharesPerOrder);
      if (s == null) continue;
      if (fav.askSize != null && fav.askSize < s) continue; // FOK full-size L1
      side = favSide;
      entryPx = ask;
      entryAge = a;
      size = s;
      break;
    } else {
      // lean : fair gate (évaluée au 1er tick deux-côtés) + diff >= trigger
      let fair = true; // lazy : fairMax 1.14 = off
      if (cfg.fairMax < 1.1) {
        // la fair check est portée par le PREMIER tick de la fenêtre
        const first = ticks.find((x) => x.up.ask != null && x.down.ask != null);
        if (first) fair = first.up.ask! + first.down.ask! <= cfg.fairMax;
      }
      if (!fair) return null;
      if (a > cfg.entryWindowSec) return null;
      const d = t.up.ask - t.down.ask;
      if (Math.abs(d) < cfg.leanTrigger) continue;
      const lSide: "up" | "down" = d > 0 ? "up" : "down";
      const book = lSide === "up" ? t.up : t.down;
      const s = rSize(cfg.orderUsdc, book.ask!, cfg.maxSharesPerOrder);
      if (s == null) continue;
      if (book.askSize != null && book.askSize < s) continue;
      side = lSide;
      entryPx = book.ask!;
      entryAge = a;
      size = s;
      break;
    }
  }
  if (side == null) return null;

  // --- gestion (exits L1-only) ---
  let adverseSince: number | null = null;
  let exitType: RTrade["exitType"] = "resolution";
  let exitAge = (ticks[ticks.length - 1].ts - t0) / 1000;
  let exitPx: number | null = null;
  for (const t of ticks) {
    const a = age(t);
    if (a <= entryAge) continue;
    const held = side === "up" ? t.up : t.down;
    const other = side === "up" ? t.down : t.up;
    if (held.ask == null || other.ask == null) continue;
    const leads = other.ask - held.ask >= cfg.slStructFlipDist;
    adverseSince = leads ? (adverseSince ?? a) : null;
    const structHit =
      adverseSince != null &&
      a - adverseSince >= cfg.slStructConfirmSec &&
      held.bid != null &&
      held.bid <= entryPx - cfg.slStructDist;
    const lateHit =
      a >= cfg.slLateAfterSec &&
      held.bid != null &&
      held.bid <= entryPx - cfg.slLateDist;
    if (!structHit && !lateHit) continue;
    const px = rSell(held, size);
    if (px == null) continue;
    exitType = structHit ? "sl-struct" : "sl-late";
    exitAge = a;
    exitPx = px;
    break;
  }

  const pnl = exitPx != null ? size * (exitPx - entryPx) : size * (winner === (side === "up" ? 0 : 1) ? 1 - entryPx : -entryPx);
  const won = exitPx != null ? pnl > 0 : winner === (side === "up" ? 0 : 1);
  return {
    slug: "", day: new Date(t0).toISOString().slice(0, 10),
    entryAge, side, entryPx, size,
    exitType, exitAge, exitPx, won, pnl,
  };
}

export function runRSim(uni: ReturnType<typeof loadUniverse>, cfg: RConfig): RTrade[] {
  const trades: RTrade[] = [];
  for (const [slug, ticks] of uni.slugs) {
    const tr = runRWindow(ticks, uni.wsMap.get(slug)!, uni.resMap.get(slug)!, cfg);
    if (tr) {
      tr.slug = slug;
      trades.push(tr);
    }
  }
  return trades;
}

export function summarize(trades: RTrade[]): string {
  const fills = trades.length;
  if (fills === 0) return "(aucun fill)";
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const notional = trades.reduce((s, t) => s + t.entryPx * t.size, 0);
  const mean = pnl / fills;
  const std = Math.sqrt(trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (fills - 1));
  const tStat = std > 0 ? (mean / std) * Math.sqrt(fills) : 0;
  const winP = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const lossP = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const byDay: Record<string, number> = {};
  for (const t of trades) byDay[t.day] = (byDay[t.day] ?? 0) + t.pnl;
  const days = Object.values(byDay);
  const dMean = days.reduce((a, b) => a + b, 0) / days.length;
  const dStd = Math.sqrt(days.reduce((s, p) => s + (p - dMean) ** 2, 0) / (days.length - 1));
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.exitType] = (byExit[t.exitType] ?? 0) + 1;
  return `fills=${fills} WR=${((wins / fills) * 100).toFixed(1)}% PnL=$${pnl.toFixed(2)} %/notional=${((pnl / notional) * 100).toFixed(0)}% t=${tStat.toFixed(2)} PF=${lossP > 0 ? (winP / lossP).toFixed(2) : "∞"} vr=${(dStd / Math.abs(pnl)).toFixed(3)} exits=${JSON.stringify(byExit)}`;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const uni = loadUniverse();
  console.log("universe:", uni.slugs.size);
  const rows: RConfig[] = [
    RC_REF,
    { ...RC_REF, label: "ec + SL struct", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 9999 },
    { ...RC_REF, label: "ec + SL late", slStructFlipDist: 9, slStructConfirmSec: 20, slStructDist: 1, slLateAfterSec: 300, slLateDist: 0.06 },
    { ...RC_REF, label: "ec + SL struct+late", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
    // lean (open-entry momentum) en sizing runner
    { ...RC_REF, label: "lean hold (runner-cal)", entryMode: "lean", slLateAfterSec: 9999, slStructFlipDist: 9, slStructDist: 9, slLateDist: 9 },
    { ...RC_REF, label: "lean + struct+late", entryMode: "lean", slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
    { ...RC_REF, label: "lean300 + struct+late", entryMode: "lean", entryWindowSec: 300, slStructFlipDist: 0.2, slStructConfirmSec: 20, slStructDist: 0.1, slLateAfterSec: 300, slLateDist: 0.06 },
  ];
  for (const cfg of rows) {
    const tr = runRSim(uni, cfg);
    console.log(`${cfg.label} | ${summarize(tr)}`);
  }
}