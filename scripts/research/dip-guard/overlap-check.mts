/**
 * overlap-check dip-guard — chevauchement réel de la variante inversée
 * (acheter le favori quand l'underdog cote 0.35–0.40) avec les 3
 * stratégies retenues (antiflip-revert, flip-confirm, early-conviction)
 * et vs dip-revert. Question : les PnL sont-ils additifs ? antiflip
 * achète le côté opposé au favori post-flip — la famille est proche.
 *
 * Sortie : slugs communs, même côté vs côté OPPOSÉ (antiflip opposé =
 * couverture mutuelle ; même côté = risque doublé), et PnL conjoint.
 *
 * npx tsx scripts/research/dip-guard/overlap-check.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type Universe } from "./universe.mts";

const OUT_DIR = join("audits", "backtest", "dip-guard");

// ------------------------------------------------------------------
// dip-guard INVERT BEST (d35-40, fav<=0.65, tp0.85) — trigger pass
// ------------------------------------------------------------------
function dipGuardEntries(u: Universe): Map<string, { idx: 0 | 1; price: number }> {
  const out = new Map<string, { idx: 0 | 1; price: number }>();
  for (const [slug, ticks] of u.slugs) {
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;
    let pos: { idx: 0 | 1; price: number } | null = null;
    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      if (pos) break;
      if (elapsed > 300) continue;
      let detIdx: 0 | 1 | null = null;
      let detAsk = Infinity;
      for (const idx of [0, 1] as const) {
        const book = idx === 0 ? t.up : t.down;
        if (book.ask == null) continue;
        if (book.ask < 0.35 || book.ask > 0.4) continue;
        if (book.ask < detAsk) {
          detAsk = book.ask;
          detIdx = idx;
        }
      }
      if (detIdx == null) continue;
      const target = detIdx === 0 ? t.down : t.up;
      if (target.ask == null || target.ask <= 0.5 || target.ask > 0.65) continue;
      const bid = target.bid;
      if (bid != null && target.ask - bid > 0.05) continue;
      const size = Math.min(15 / target.ask, 30);
      if (size < 5) continue;
      if (target.askSize != null && target.askSize < size) continue;
      pos = { idx: detIdx === 0 ? 1 : 0, price: target.ask };
      out.set(slug, pos);
      break;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Réimplémentation minima des triggers des 3 stratégies (final-sim)
// ------------------------------------------------------------------
interface StratCfg {
  name: string;
  family: "antiflip" | "firstfav" | "flipconfirm";
  minElapsedSec: number;
  maxElapsedSec: number | null;
  bandMin: number;
  bandMax: number;
  flipLookbackMs?: number;
  deposedAskMin?: number;
}

const STRATS: StratCfg[] = [
  { name: "antiflip-revert", family: "antiflip", minElapsedSec: 240, maxElapsedSec: null, bandMin: 0.35, bandMax: 0.45, flipLookbackMs: 90_000, deposedAskMin: 0.4 },
  { name: "early-conviction", family: "firstfav", minElapsedSec: 0, maxElapsedSec: 45, bandMin: 0.6, bandMax: 0.8 },
  { name: "flip-confirm", family: "flipconfirm", minElapsedSec: 120, maxElapsedSec: 180, bandMin: 0.55, bandMax: 0.65, flipLookbackMs: 90_000 },
];

function stratEntries(
  u: Universe,
  S: StratCfg,
): Map<string, { idx: 0 | 1; price: number }> {
  const out = new Map<string, { idx: 0 | 1; price: number }>();
  for (const [slug, ticks] of u.slugs) {
    const res = u.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (u.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;
    let pos: { idx: 0 | 1; price: number } | null = null;
    let prevFav: 0 | 1 | null = null;
    let lastFlipTs: number | null = null;
    for (const t of ticks) {
      const elapsed = (t.ts - wsMs) / 1000;
      if (elapsed < 0 || elapsed >= 900) continue;
      const up = t.up.ask,
        down = t.down.ask;
      const favIdx: 0 | 1 | null =
        up != null && down == null
          ? 0
          : down != null && up == null
            ? 1
            : up != null && down != null
              ? up >= down
                ? 0
                : 1
              : null;
      if (favIdx == null) continue;
      const favAsk = favIdx === 0 ? up : down;
      if (favAsk == null) continue;
      if (prevFav !== null && prevFav !== favIdx) lastFlipTs = t.ts;
      prevFav = favIdx;
      if (pos) continue;
      if (elapsed < S.minElapsedSec) continue;
      if (S.maxElapsedSec != null && elapsed > S.maxElapsedSec) continue;
      let targetBook: { ask: number | null; bid: number | null; askSize: number | null };
      let targetIdx: 0 | 1;
      if (S.family === "antiflip") {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        if (favAsk < 0.45 || favAsk > 0.65) continue;
        targetIdx = favIdx === 0 ? 1 : 0;
        targetBook = favIdx === 0 ? t.down : t.up;
        if (targetBook.ask == null) continue;
        if (S.deposedAskMin != null && targetBook.ask < S.deposedAskMin) continue;
      } else if (S.family === "firstfav") {
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        if (targetBook.ask == null) continue;
      } else {
        if (lastFlipTs == null || t.ts - lastFlipTs > (S.flipLookbackMs ?? 90_000)) continue;
        targetIdx = favIdx;
        targetBook = favIdx === 0 ? t.up : t.down;
        if (targetBook.ask == null) continue;
      }
      if (targetBook.ask == null) continue;
      if (targetBook.ask < S.bandMin || targetBook.ask > S.bandMax) continue;
      const bid = targetBook.bid;
      if (bid != null && targetBook.ask - bid > 0.05) continue;
      const size = Math.min(15 / targetBook.ask, 30);
      if (size < 5) continue;
      if (targetBook.askSize != null && targetBook.askSize < size) continue;
      pos = { idx: targetIdx, price: targetBook.ask };
      out.set(slug, pos);
    }
  }
  return out;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const u = loadUniverse();
  console.log(`universe: ${u.slugs.size} windows`);

  const dg = dipGuardEntries(u);
  console.log(`\ndip-guard INVERT: ${dg.size} fenêtres tradées`);
  const sets: Record<string, Map<string, { idx: 0 | 1; price: number }>> = { "dip-guard INVERT": dg };
  for (const S of STRATS) {
    const e = stratEntries(u, S);
    sets[S.name] = e;
    console.log(`${S.name}: ${e.size} fenêtres tradées`);
  }

  const inter = <T>(x: Map<string, T>, y: Map<string, T>) =>
    [...x.keys()].filter((s) => y.has(s));
  const report: Record<string, unknown> = {
    phase: "overlap-check dip-guard",
    generatedAt: new Date().toISOString(),
    universe: u.slugs.size,
    dipGuardSize: dg.size,
    pairs: [],
  };
  for (const S of STRATS) {
    const other = sets[S.name];
    const shared = inter(dg, other);
    const sameSide = shared.filter((s) => dg.get(s)!.idx === other.get(s)!.idx);
    const oppSide = shared.filter((s) => dg.get(s)!.idx !== other.get(s)!.idx);
    console.log(
      `\ndip-guard ∩ ${S.name}: ${shared.length} communes — même côté: ${sameSide.length}, côté OPPOSÉ: ${oppSide.length}`,
    );
    report.pairs.push({
      other: S.name,
      shared: shared.length,
      sameSide: sameSide.length,
      oppositeSide: oppSide.length,
    });
  }

  // chevauchement avec les 2 autres nouvelles stratégies aussi
  const pairs2: Array<[string, string]> = [
    ["antiflip-revert", "flip-confirm"],
    ["antiflip-revert", "early-conviction"],
    ["flip-confirm", "early-conviction"],
  ];
  for (const [x, y] of pairs2) {
    const shared = inter(sets[x], sets[y]);
    console.log(`${x} ∩ ${y}: ${shared.length}`);
  }

  const outPath = join(OUT_DIR, `overlap-check-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("written:", outPath);
}

main();