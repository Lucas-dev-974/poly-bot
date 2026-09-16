/**
 * verify-claims — contre-vérification indépendante des 3 stratégies retenues.
 * READ-ONLY. Réimplémentation INDÉPENDANTE du moteur de final-sim (cross-check),
 * puis tests de robustesse :
 *   1. Baseline : doit reproduire EXACTEMENT final-sim (fills/WR/PnL)
 *   2. Tie-break : combien d'entrées antiflip/flip-confirm sont déclenchées par
 *      un flip d'ÉGALITÉ (up.ask === down.ask, artefact du >=) ou near-tie
 *      (lead <= 0.01) — le signal est-il un artefact de tie-break ?
 *   3. HYSTÉRÉSIS : flip seulement si le nouveau favori mène de >= 0.01
 *      (les ties ne comptent plus comme flip) — les edges survivent-ils ?
 *   4. PnL par bucket d'elapsed d'entrée (antiflip) — l'edge est-il exécutable
 *      en live (pas concentré sur les 2 dernières minutes) ?
 *   5. Consistances : sum(byDay) == pnl, WR == wins/fills, t-stat recomposé,
 *      PnL % sur notional déployé (pour corriger l'index).
 *
 * npx tsx scripts/research/research-new-strats/verify-claims.mts
 */
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse } from "./universe.mts";

const OUT_DIR = join("audits", "backtest", "research-new-strats");

interface Cfg {
  label: string;
  family: "antiflip" | "firstfav" | "flipconfirm";
  minElapsed: number;
  maxElapsed: number | null;
  bandMin: number;
  bandMax: number;
  maxSpread: number;
  flipLookbackMs?: number;
  deposedAskMin?: number;
  hysteresis: boolean;
}

const ANTIFLIP_BASE: Cfg = { label: "antiflip-revert", family: "antiflip", minElapsed: 240, maxElapsed: null, bandMin: 0.35, bandMax: 0.45, maxSpread: 0.05, flipLookbackMs: 90_000, deposedAskMin: 0.40, hysteresis: false };
const FIRSTFAV_BASE: Cfg = { label: "early-conviction", family: "firstfav", minElapsed: 0, maxElapsed: 45, bandMin: 0.60, bandMax: 0.80, maxSpread: 0.05, hysteresis: false };
const FLIPCONF_BASE: Cfg = { label: "flip-confirm", family: "flipconfirm", minElapsed: 120, maxElapsed: 180, bandMin: 0.55, bandMax: 0.65, maxSpread: 0.05, flipLookbackMs: 90_000, hysteresis: false };

interface Entry {
  slug: string;
  elapsed: number;
  price: number;
  size: number;
  idx: 0 | 1;
  lead: number | null; // |up.ask - down.ask| at entry (null if one-sided)
  flipWasTie: boolean;
  win: boolean;
  pnl: number;
}

function runSim(
  u: ReturnType<typeof loadUniverse>,
  C: Cfg,
): {
  label: string;
  fills: number;
  wins: number;
  pnl: number;
  winRate: number | null;
  shares: number;
  notional: number;
  byElapsed: Record<string, { n: number; pnl: number; wins: number }>;
  tieFlipEntries: number;
  nearTieEntries: number;
  byDay: Record<string, number>;
} {
  let fills = 0,
    wins = 0,
    pnl = 0,
    shares = 0,
    notional = 0,
    tieFlipEntries = 0,
    nearTieEntries = 0;
  const byElapsed: Record<string, { n: number; pnl: number; wins: number }> = {};
  const byDay: Record<string, number> = {};
  const allEntries: Entry[] = [];

  for (const [slug, ticks] of u.slugs) {
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;

    let entry: Entry | null = null;
    let prevFav: 0 | 1 | null = null;
    let estFav: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;
    let lastFlipTie = false;

    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      const up = t.up.ask,
        down = t.down.ask;

      // instantaneous favorite (baseline definition, tie -> Up)
      let favIdx: 0 | 1 | null;
      if (up != null && down == null) favIdx = 0;
      else if (down != null && up == null) favIdx = 1;
      else if (up != null && down != null) favIdx = up >= down ? 0 : 1;
      else favIdx = null;
      if (favIdx == null) continue;

      if (C.hysteresis) {
        // flip only on a REAL crossing: new side leads by >= 0.01
        if (up != null && down != null) {
          if (estFav == null) {
            estFav = up >= down ? 0 : 1;
          } else {
            const cand: 0 | 1 = up >= down ? 0 : 1;
            if (cand !== estFav) {
              const candAsk = cand === 0 ? up : down;
              const estAsk = estFav === 0 ? up : down;
              if (candAsk - estAsk >= 0.01) {
                lastFlipTs = t.ts;
                estFav = cand;
              }
            }
          }
        }
      } else {
        if (prevFav !== null && prevFav !== favIdx) {
          lastFlipTs = t.ts;
          lastFlipTie = up != null && down != null && up === down;
        }
      }
      prevFav = favIdx;

      if (entry) continue;
      if (elapsed < C.minElapsed) continue;
      if (C.maxElapsed != null && elapsed > C.maxElapsed) continue;

      const effFav = C.hysteresis ? estFav : favIdx;
      if (effFav == null) continue;
      const effFavAsk = effFav === 0 ? up : down;
      if (effFavAsk == null) continue;

      let targetIdx: 0 | 1;
      let targetBook: { ask: number | null; bid: number | null; askSize: number | null };
      let flipTie = false;

      if (C.family === "antiflip") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (C.flipLookbackMs ?? 90_000)) continue;
        if (effFavAsk < 0.45 || effFavAsk > 0.65) continue;
        targetIdx = effFav === 0 ? 1 : 0;
        targetBook = effFav === 0 ? t.down : t.up;
        const dAsk = targetBook.ask;
        if (dAsk == null) continue;
        if (C.deposedAskMin != null && dAsk < C.deposedAskMin) continue;
        flipTie = lastFlipTie;
      } else if (C.family === "flipconfirm") {
        if (lastFlipTs == null) continue;
        if (t.ts - lastFlipTs > (C.flipLookbackMs ?? 90_000)) continue;
        targetIdx = effFav;
        targetBook = effFav === 0 ? t.up : t.down;
        flipTie = lastFlipTie;
      } else {
        targetIdx = effFav;
        targetBook = effFav === 0 ? t.up : t.down;
      }

      const targetAsk = targetBook.ask;
      if (targetAsk == null) continue;
      if (targetAsk < C.bandMin || targetAsk > C.bandMax) continue;
      const targetBid = targetBook.bid;
      if (targetBid != null && targetAsk - targetBid > C.maxSpread) continue;
      const size = Math.min(15 / targetAsk, 30);
      if (size < 5) continue;
      if (targetBook.askSize != null && targetBook.askSize < size) continue;

      const lead = up != null && down != null ? Math.abs(up - down) : null;
      entry = {
        slug,
        elapsed,
        price: targetAsk,
        size,
        idx: targetIdx,
        lead,
        flipWasTie: flipTie,
        win: false,
        pnl: 0,
      } as Entry;
      fills++;
      if (entry.flipWasTie) tieFlipEntries++;
      if (entry.lead != null && entry.lead <= 0.0101) nearTieEntries++;
      notional += entry.price * entry.size;
      shares += entry.size;
    }

    if (!entry) continue;
    const win = res === entry.idx;
    const p = win ? (1 - entry.price) * entry.size : -entry.price * entry.size;
    entry.win = win;
    entry.pnl = p;
    pnl += p;
    if (win) wins++;
    const b = Math.floor(entry.elapsed / 120) * 120;
    const bucket = `${b}-${b + 120}`;
    (byElapsed[bucket] ??= { n: 0, pnl: 0, wins: 0 });
    byElapsed[bucket].n++;
    byElapsed[bucket].pnl += p;
    if (win) byElapsed[bucket].wins++;
    const day = new Date(wsMs).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + p;
    allEntries.push(entry);
  }

  pnl = Math.round(pnl * 100) / 100;
  return {
    label: C.label + (C.hysteresis ? " [HYSTERESIS]" : ""),
    fills,
    wins,
    pnl,
    winRate: fills ? Math.round((wins / fills) * 1000) / 10 : null,
    shares: Math.round(shares),
    notional: Math.round(notional * 100) / 100,
    byElapsed: Object.fromEntries(
      Object.entries(byElapsed).map(([k, v]) => [
        k,
        { n: v.n, pnl: Math.round(v.pnl * 100) / 100, wins: v.wins },
      ]),
    ),
    tieFlipEntries,
    nearTieEntries,
    byDay: Object.fromEntries(
      Object.entries(byDay).map(([d, v]) => [d, Math.round(v * 100) / 100]),
    ),
  };
}

function tStat(fills: number, wr: number | null, px: number | null): number | null {
  if (!fills || wr == null || px == null) return null;
  const p = wr / 100;
  const ev = p * (1 - px) - (1 - p) * px;
  const e2 = p * (1 - px) ** 2 + (1 - p) * px ** 2;
  const std = Math.sqrt(Math.max(e2 - ev * ev, 1e-12));
  return Math.round((ev / (std / Math.sqrt(fills))) * 100) / 100;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows`);

  // final-sim reference numbers (from final-sim-1789459302926.json)
  const REF: Record<string, { fills: number; pnl: number; winRate: number }> = {
    "antiflip-revert": { fills: 232, pnl: 622.8, winRate: 52.2 },
    "early-conviction": { fills: 219, pnl: 330.41, winRate: 67.6 },
    "flip-confirm": { fills: 188, pnl: 389.35, winRate: 66.5 },
  };

  const out: Record<string, unknown> = {};

  // 1+2+4+5: baseline with instrumentation
  console.log("\n--- BASELINE (doit reproduire final-sim) ---");
  const baselines: Record<string, ReturnType<typeof runSim>> = {};
  for (const C of [ANTIFLIP_BASE, FIRSTFAV_BASE, FLIPCONF_BASE]) {
    const r = runSim(universe, C);
    baselines[C.label] = r;
    const ref = REF[C.label];
    const match =
      r.fills === ref.fills &&
      Math.abs(r.pnl - ref.pnl) < 0.02 &&
      Math.abs((r.winRate ?? 0) - ref.winRate) < 0.05;
    const daySum = Object.values(r.byDay).reduce((a, b) => a + b, 0);
    const px = r.shares ? r.notional / r.shares : null;
    console.log(
      `${r.label.padEnd(18)} fills=${r.fills} WR=${r.winRate}% PnL=${r.pnl} | vs final-sim: ${match ? "MATCH" : `MISMATCH (ref ${ref.fills}/$${ref.pnl}/${ref.winRate}%)`} | sum(byDay)=${Math.round(daySum * 100) / 100} | notional=$${r.notional} px=${px ? Math.round(px * 1000) / 1000 : null} | PnL/notional=${px && r.notional ? Math.round((r.pnl / r.notional) * 1000) / 10 : null}% | t=${tStat(r.fills, r.winRate, px)}`,
    );
  }

  // tie-flip exposure (baseline antiflip & flipconfirm)
  console.log("\n--- EXPOSITION TIE-FLIP (artefact d'égalité) ---");
  const hy: Record<string, ReturnType<typeof runSim>> = {};
  for (const [name, C0] of [
    ["antiflip-revert", ANTIFLIP_BASE],
    ["flip-confirm", FLIPCONF_BASE],
  ] as Array<[string, Cfg]>) {
    const b = baselines[name];
    console.log(
      `${name}: entrées dont le flip ouvrant était une ÉGALITÉ pure: ${b.tieFlipEntries}/${b.fills} (${Math.round((b.tieFlipEntries / b.fills) * 1000) / 10}%), near-tie (lead<=1 tick): ${b.nearTieEntries}/${b.fills}`,
    );
    // 3. hysteresis variant
    const CH = { ...C0, hysteresis: true, label: name };
    const rh = runSim(universe, CH);
    hy[name] = rh;
    const rb = baselines[name];
    console.log(
      `  HYSTERESIS: fills=${rh.fills} WR=${rh.winRate}% PnL=${rh.pnl} (baseline: ${rb.fills}/$${rb.pnl}) — delta PnL ${Math.round((rh.pnl - rb.pnl) * 100) / 100}`,
    );
  }

  // 4. antiflip by entry-elapsed
  console.log("\n--- ANTIFLIP: PnL par elapsed d'entrée (exécutabilité) ---");
  for (const [k, v] of Object.entries(baselines["antiflip-revert"].byElapsed)) {
    const wr = v.n ? Math.round((v.wins / v.n) * 1000) / 10 : null;
    console.log(`  elapsed ${k}s: n=${v.n} WR=${wr}% PnL=${Math.round(v.pnl * 100) / 100}`);
  }
  console.log("--- FLIP-CONFIRM: PnL par elapsed d'entrée ---");
  for (const [k, v] of Object.entries(baselines["flip-confirm"].byElapsed)) {
    const wr = v.n ? Math.round((v.wins / v.n) * 1000) / 10 : null;
    console.log(`  elapsed ${k}s: n=${v.n} WR=${wr}% PnL=${Math.round(v.pnl * 100) / 100}`);
  }
  console.log("\n--- EARLY-CONVICTION: PnL par elapsed d'entrée ---");
  for (const [k, v] of Object.entries(baselines["early-conviction"].byElapsed)) {
    const wr = v.n ? Math.round((v.wins / v.n) * 1000) / 10 : null;
    console.log(`  elapsed ${k}s: n=${v.n} WR=${wr}% PnL=${Math.round(v.pnl * 100) / 100}`);
  }

  const outPath = join(OUT_DIR, `verify-claims-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: "verify-claims",
        generatedAt: new Date().toISOString(),
        universe: universe.slugs.size,
        baseline: baselines,
        hysteresis: hy,
      },
      null,
      2,
    ),
  );
  console.log("written:", outPath);
}

main();