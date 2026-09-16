/**
 * overlap-check — chevauchement réel entre les 3 nouvelles stratégies
 * (les signaux "flip" sont-ils les mêmes fenêtres ?) et vs fav-band.
 * Quantifie l'avertissement de corrélation du rapport.
 * npx tsx scripts/research/research-new-strats/overlap-check.mts
 */
import { loadUniverse } from "./universe.mts";
import { runStratSim, ANTIFLIP, FIRSTFAV, FLIPCONFIRM } from "./final-sim.mts";

const u = loadUniverse();

// collecte des slugs tradés par stratégie
function slugSet(S: typeof ANTIFLIP): Set<string> {
  const set = new Set<string>();
  // re-run sim but collect slugs: reuse runStratSim? it doesn't expose slugs.
  // quick proxy: run and diff byDay? No — reimplement minimal trigger pass.
  // Simpler: temporarily monkey-run via runStratSim on subsets is heavy;
  // instead re-run the trigger logic quickly here (same code shape).
  const { ANTIFLIP: _a, FIRSTFAV: _f, FLIPCONFIRM: _c } = { ANTIFLIP, FIRSTFAV, FLIPCONFIRM };
  void _a; void _f; void _c;
  return set;
}

// Réimplémentation minima de la détection de trigger (mêmes règles que final-sim)
function triggers(S: typeof ANTIFLIP): Set<string> {
  const set = new Set<string>();
  for (const [slug, ticks] of u.slugs) {
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    let entry = false;
    let prevFav: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;
    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      const up = t.up.ask, down = t.down.ask;
      const favIdx: 0 | 1 | null =
        up != null && down == null ? 0 : down != null && up == null ? 1 : up != null && down != null ? (up >= down ? 0 : 1) : null;
      if (favIdx == null) continue;
      const favAsk = favIdx === 0 ? up : down;
      if (favAsk == null) continue;
      if (prevFav !== null && prevFav !== favIdx) lastFlipTs = t.ts;
      prevFav = favIdx;
      if (entry) continue;
      if (elapsed < S.minElapsedSec) continue;
      if (S.maxElapsedSec != null && elapsed > S.maxElapsedSec) continue;

      let targetAsk: number | null = null;
      let targetBook: { ask: number | null; bid: number | null; askSize: number | null } | null = null;
      if (S.family === "antiflip") {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetBook = favIdx === 0 ? t.down : t.up;
        targetAsk = targetBook.ask;
        if (targetAsk == null) continue;
        if (S.deposedAskMin != null && targetAsk < S.deposedAskMin) continue;
      } else if (S.family === "firstfav") {
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      } else {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        targetBook = favIdx === 0 ? t.up : t.down;
        targetAsk = targetBook.ask;
      }
      if (targetAsk == null) continue;
      if (targetAsk < S.bandMin || targetAsk > S.bandMax) continue;
      const bid = targetBook!.bid;
      if (bid != null && targetAsk - bid > S.maxSpread) continue;
      const size = Math.min(S.orderUsdc / targetAsk, S.maxShares);
      if (size < 5) continue;
      if (targetBook!.askSize != null && targetBook!.askSize < size) continue;
      entry = true;
      set.add(slug);
    }
  }
  return set;
}

const a = triggers(ANTIFLIP);
const f = triggers(FIRSTFAV);
const c = triggers(FLIPCONFIRM);
console.log(`antiflip: ${a.size}, early-conviction: ${f.size}, flip-confirm: ${c.size}`);

const inter = (x: Set<string>, y: Set<string>) => [...x].filter((s) => y.has(s)).length;
console.log(`antiflip ∩ flip-confirm: ${inter(a, c)} fenêtres communes`);
console.log(`antiflip ∩ early-conviction: ${inter(a, f)}`);
console.log(`flip-confirm ∩ early-conviction: ${inter(c, f)}`);
console.log(`toutes les 3: ${[...a].filter((s) => c.has(s) && f.has(s)).length}`);

// côtés sur les fenêtres communes : opposés (couverture mutuelle) ou identiques (risque doublé) ?
function sideMap(S: typeof ANTIFLIP): Map<string, 0 | 1> {
  const out = new Map<string, 0 | 1>();
  for (const slug of triggers(S)) {
    const ticks = u.slugs.get(slug)!;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    let picked: 0 | 1 | null = null;
    let prevFav: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;
    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      const up = t.up.ask, down = t.down.ask;
      const favIdx: 0 | 1 | null =
        up != null && down == null ? 0 : down != null && up == null ? 1 : up != null && down != null ? (up >= down ? 0 : 1) : null;
      if (favIdx == null) continue;
      const favAsk = favIdx === 0 ? up : down;
      if (favAsk == null) continue;
      if (prevFav !== null && prevFav !== favIdx) lastFlipTs = t.ts;
      prevFav = favIdx;
      if (picked != null) continue;
      if (elapsed < S.minElapsedSec) continue;
      if (S.maxElapsedSec != null && elapsed > S.maxElapsedSec) continue;
      if (S.family === "antiflip") {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        const bk = favIdx === 0 ? t.down : t.up;
        if (bk.ask == null) continue;
        if (S.deposedAskMin != null && bk.ask < S.deposedAskMin) continue;
        if (bk.ask < S.bandMin || bk.ask > S.bandMax) continue;
        const bid = bk.bid;
        if (bid != null && bk.ask - bid > S.maxSpread) continue;
        const size = Math.min(S.orderUsdc / bk.ask, S.maxShares);
        if (size < 5) continue;
        if (bk.askSize != null && bk.askSize < size) continue;
        picked = favIdx === 0 ? 1 : 0;
      } else if (S.family === "firstfav") {
        const bk = favIdx === 0 ? t.up : t.down;
        if (bk.ask == null) continue;
        if (bk.ask < S.bandMin || bk.ask > S.bandMax) continue;
        const bid = bk.bid;
        if (bid != null && bk.ask - bid > S.maxSpread) continue;
        const size = Math.min(S.orderUsdc / bk.ask, S.maxShares);
        if (size < 5) continue;
        if (bk.askSize != null && bk.askSize < size) continue;
        picked = favIdx;
      } else {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        const bk = favIdx === 0 ? t.up : t.down;
        if (bk.ask == null) continue;
        if (bk.ask < S.bandMin || bk.ask > S.bandMax) continue;
        const bid = bk.bid;
        if (bid != null && bk.ask - bid > S.maxSpread) continue;
        const size = Math.min(S.orderUsdc / bk.ask, S.maxShares);
        if (size < 5) continue;
        if (bk.askSize != null && bk.askSize < size) continue;
        picked = favIdx;
      }
      if (picked != null) out.set(slug, picked);
    }
  }
  return out;
}

const sa = sideMap(ANTIFLIP);
const sc = sideMap(FLIPCONFIRM);
const sf = sideMap(FIRSTFAV);
const sharedAC = [...a].filter((s) => c.has(s));
const sameAC = sharedAC.filter((s) => sa.get(s) === sc.get(s)).length;
const sharedAF = [...a].filter((s) => f.has(s));
const sameAF = sharedAF.filter((s) => sa.get(s) === sf.get(s)).length;
const sharedCF = [...c].filter((s) => f.has(s));
const sameCF = sharedCF.filter((s) => sc.get(s) === sf.get(s)).length;
console.log(`\nantiflip∩flipconfirm: ${sharedAC.length} communes — même côté: ${sameAC}, côté OPPOSÉ: ${sharedAC.length - sameAC}`);
console.log(`antiflip∩early-conv: ${sharedAF.length} communes — même côté: ${sameAF}, opposé: ${sharedAF.length - sameAF}`);
console.log(`flipconfirm∩early-conv: ${sharedCF.length} communes — même côté: ${sameCF}, opposé: ${sharedCF.length - sameCF}`);