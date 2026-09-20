/**
 * Validation open-entry : (1) verify-claims — réimplémentation INDÉPENDANTE
 * du moteur COMBO depuis la config (aucun import de open-sim), asserts
 * fills EXACTS + PnL ±0.05 + exits ; (2) overlap-check — triggers
 * approximatifs des moteurs existants (early-conviction, fav-band,
 * dip-revert), comptage même-côté vs côté-opposé sur l'intersection.
 */
import { loadUniverse, type Tick, type SideBook } from "./universe.mts";

// ---- config COMBO (copiée à la main depuis open-grid3, pas importée) ----
const CFG = {
  leanTrigger: 0.15,
  entryWindowSec: 300,
  fairMax: 1.02,
  slStructFlipDist: 0.2,
  slStructConfirmSec: 20,
  slStructDist: 0.1,
  slLateAfterSec: 300,
  slLateDist: 0.06,
  size: 10,
  slipCap: 0.04,
};

interface MyTrade {
  slug: string;
  day: string;
  entryAge: number;
  side: "up" | "down";
  entryPx: number;
  exitType: "resolution" | "sl-struct" | "sl-late" | "tp";
  exitAge: number;
  exitPx: number | null;
  won: boolean;
  pnl: number;
}

// ---- réimplémentation indépendante (structures de contrôle différentes) ----
function mySell(book: SideBook, size: number): number | null {
  const limit = (book.bid ?? NaN) - CFG.slipCap;
  if (!Number.isFinite(limit)) return null;
  const prices = [book.bid, book.bid2, book.bid3];
  const sizes = [book.bidSize, book.bid2Size, book.bid3Size];
  let left = size, cash = 0;
  for (let i = 0; i < 3 && left > 0; i++) {
    const p = prices[i], s = sizes[i];
    if (p == null || s == null || p < limit) continue;
    const take = Math.min(left, s);
    cash += take * p;
    left -= take;
  }
  return left > 0 ? null : cash / size;
}

function myWindow(ticks: Tick[], wsSec: number, winner: number): MyTrade | null {
  const t0 = wsSec * 1000;
  let trade: MyTrade | null = null;

  // phase 1 : entrée
  let fair: boolean | null = null;
  for (const t of ticks) {
    const a = (t.ts - t0) / 1000;
    if (t.up.ask == null || t.down.ask == null) continue;
    if (fair == null) fair = t.up.ask + t.down.ask <= CFG.fairMax;
    if (!fair || a > CFG.entryWindowSec) break;
    const d = t.up.ask - t.down.ask;
    if (Math.abs(d) >= CFG.leanTrigger) {
      const s: "up" | "down" = d > 0 ? "up" : "down";
      const book = s === "up" ? t.up : t.down;
      if (book.askSize != null && book.askSize >= CFG.size) {
        trade = { slug: "", day: new Date(t0).toISOString().slice(0, 10), entryAge: a, side: s, entryPx: book.ask, exitType: "resolution", exitAge: (ticks[ticks.length - 1].ts - t0) / 1000, exitPx: null, won: false, pnl: 0 };
        break;
      }
      // profondeur insuffisante : FOK serait tué — pas de blocage, retry au
      // tick suivant (règle du skill : jamais bloquer la ré-entrée après un
      // FOK rejeté) ; le scan continue jusqu'à la fin de la fenêtre d'entrée.
    }
  }
  if (!trade) return null;

  // phase 2 : gestion
  let adverseAt: number | null = null;
  let exited = false;
  for (const t of ticks) {
    if (exited) break;
    const a = (t.ts - t0) / 1000;
    if (a <= trade.entryAge) continue;
    const held = trade.side === "up" ? t.up : t.down;
    const other = trade.side === "up" ? t.down : t.up;
    if (held.ask == null || other.ask == null) continue;

    const leads = other.ask - held.ask >= CFG.slStructFlipDist;
    adverseAt = leads ? (adverseAt ?? a) : null;

    const doStruct =
      adverseAt != null &&
      a - adverseAt >= CFG.slStructConfirmSec &&
      held.bid != null &&
      held.bid <= trade.entryPx - CFG.slStructDist;
    const doLate =
      a >= CFG.slLateAfterSec &&
      held.bid != null &&
      held.bid <= trade.entryPx - CFG.slLateDist;
    if (!doStruct && !doLate) continue;

    const px = mySell(held, CFG.size);
    if (px == null) continue;
    trade.exitType = doStruct ? "sl-struct" : "sl-late";
    trade.exitAge = a;
    trade.exitPx = px;
    trade.pnl = CFG.size * (px - trade.entryPx);
    trade.won = trade.pnl > 0;
    exited = true;
  }

  if (!exited) {
    const won = winner === (trade.side === "up" ? 0 : 1);
    trade.pnl = CFG.size * (won ? 1 - trade.entryPx : -trade.entryPx);
    trade.won = won;
  }
  return trade;
}

// ---- comparaison vs open-sim ----
import { runSim, HOLD_REF } from "./open-sim.mts";
const comboCfg = {
  ...HOLD_REF,
  label: "COMBO verify",
  entryWindowSec: 300,
  slStruct: true,
  slStructFlipDist: 0.2,
  slStructConfirmSec: 20,
  slStructDist: 0.1,
  slLate: true,
  slLateAfterSec: 300,
  slLateDist: 0.06,
};

const uni = loadUniverse();
const official = runSim(uni, comboCfg);
console.log("open-sim COMBO:", official.fills, "fills, PnL", official.pnl.toFixed(2));

const mine: MyTrade[] = [];
for (const [slug, ticks] of uni.slugs) {
  const tr = myWindow(ticks, uni.wsMap.get(slug)!, uni.resMap.get(slug)!);
  if (tr) {
    tr.slug = slug;
    mine.push(tr);
  }
}
console.log("réimplémentation:", mine.length, "fills");

let pnlMine = 0;
const byKey = new Map(mine.map((t) => [t.slug, t]));
let mismatches = 0;
for (const t of official.trades) {
  const m = byKey.get(t.slug);
  pnlMine += m ? m.pnl : 0;
  if (!m) { mismatches++; console.log("MISSING", t.slug); continue; }
  const same =
    m.side === t.side &&
    Math.abs(m.entryAge - t.entryAge) < 1e-6 &&
    Math.abs(m.entryPx - t.entryPx) < 1e-9 &&
    m.exitType === t.exitType &&
    Math.abs(m.pnl - t.pnl) < 0.005;
  if (!same) {
    mismatches++;
    if (mismatches <= 5) console.log("MISMATCH", t.slug, JSON.stringify({ mine: m, sim: t }));
  }
}
const extra = mine.filter((m) => !official.trades.some((t) => t.slug === m.slug));
console.log("extras:", extra.length, "mismatches:", mismatches);
console.log("PnL réimpl:", pnlMine.toFixed(2), "vs sim:", official.pnl.toFixed(2), "| delta:", Math.abs(pnlMine - official.pnl).toFixed(3));

// ---- overlap-check (triggers approximatifs des moteurs existants) ----
function approxEarlyConviction(ticks: Tick[], wsSec: number): "up" | "down" | null {
  const t0 = wsSec * 1000;
  for (const t of ticks) {
    const a = (t.ts - t0) / 1000;
    if (a > 180) break;
    if (t.up.ask == null || t.down.ask == null) continue;
    const fav = t.up.ask >= t.down.ask ? "up" : "down";
    const ask = (fav === "up" ? t.up.ask : t.down.ask)!;
    if (ask >= 0.6) return fav; // 1er tick éligible ≈ FOK immédiat
  }
  return null;
}
function approxFavBand(ticks: Tick[], wsSec: number): "up" | "down" | null {
  const t0 = wsSec * 1000;
  for (const t of ticks) {
    const a = (t.ts - t0) / 1000;
    if (a < 200) continue;
    if (t.up.ask == null || t.down.ask == null) continue;
    const fav = t.up.ask >= t.down.ask ? "up" : "down";
    const ask = (fav === "up" ? t.up.ask : t.down.ask)!;
    if (ask >= 0.7 && ask <= 0.85) return fav;
  }
  return null;
}
function approxDipRevert(ticks: Tick[], wsSec: number): "up" | "down" | null {
  const t0 = wsSec * 1000;
  const lookbackMs = 60_000;
  let fav: "up" | "down" | null = null;
  const samples: Array<{ a: number; fav: "up" | "down"; ask: number }> = [];
  for (const t of ticks) {
    const a = (t.ts - t0) / 1000;
    if (a < 180) continue;
    if (t.up.ask == null || t.down.ask == null) continue;
    fav = t.up.ask >= t.down.ask ? "up" : "down";
    const ask = (fav === "up" ? t.up.ask : t.down.ask)!;
    samples.push({ a, fav, ask });
    const cutoff = a * 1000 - lookbackMs;
    const window = samples.filter((s) => s.a * 1000 >= cutoff && s.fav === fav).map((s) => s.ask);
    if (window.length < 10) continue;
    const span = window[window.length - 1] - window[0];
    if (span < lookbackMs * 0.7 / 1000) continue;
    const low = Math.min(...window);
    const drop = low === ask ? 0 : low + 0.15 - ask; // minDrop 0.15 approximé via rebound
    if (low <= ask - 0.15 && ask > low) return fav;
  }
  return null;
}

const myPicks = new Map(official.trades.map((t) => [t.slug, t.side]));
let ec = 0, fb = 0, dr = 0, ecSame = 0, ecOpp = 0, fbSame = 0, fbOpp = 0, drSame = 0, drOpp = 0;
for (const [slug, ticks] of uni.slugs) {
  const mine2 = myPicks.get(slug);
  if (!mine2) continue;
  const ws = uni.wsMap.get(slug)!;
  const ecP = approxEarlyConviction(ticks, ws);
  if (ecP) { ec++; if (ecP === mine2) ecSame++; else ecOpp++; }
  const fbP = approxFavBand(ticks, ws);
  if (fbP) { fb++; if (fbP === mine2) fbSame++; else fbOpp++; }
  const drP = approxDipRevert(ticks, ws);
  if (drP) { dr++; if (drP === mine2) drSame++; else drOpp++; }
}
console.log("\n=== Overlap (sur mes", myPicks.size, "trades) ===");
console.log(`early-conviction: tradé ${ec}, même côté ${ecSame}, opposé ${ecOpp}`);
console.log(`fav-band:         tradé ${fb}, même côté ${fbSame}, opposé ${fbOpp}`);
console.log(`dip-revert:       tradé ${dr}, même côté ${drSame}, opposé ${drOpp}`);