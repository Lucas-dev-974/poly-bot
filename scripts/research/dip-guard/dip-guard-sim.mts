/**
 * Dip-guard — sim de découverte (officiel-aligned, exits intraday fidèles CLOB).
 *
 * Signal (spec utilisateur 2026-09-16) :
 *   - ENTREE : dans les 5 premières minutes (elapsed <= 300s), un token
 *     cote ask 0.30-0.40 -> achat FOK (si les deux tokens sont dans la
 *     bande : le moins cher).
 *   - STOP   : si le bid du token détenu descend a 0.20 -> vente (stop-loss).
 *     (Variante grille : 0.15.) Inactif quand le trailing est armé.
 *   - TRAIL  : si le bid monte a 0.50 -> arme un trailing stop 0.20
 *     (stop = pic de bid - 0.20).
 *   - Sinon hold-to-resolution (payout 1.00 si gagnant, 0 si perdant).
 *   - UNE SEULE entrée par fenêtre, pas de ré-entrée après sortie.
 *
 * Fidélité d'exécution (leçons dip-revert / clob-market-orders) :
 *   - Les sorties sont pricées sur le carnet du token DETENU (bid, bid2,
 *     bid3), jamais sur l'autre token.
 *   - Un stop émis au prix exact du trigger ne remplit que le niveau 1
 *     (worst-price limit) et se fait tuer en crash — modèle live : prix
 *     limite = trigger - 0.02 (2 ticks de slippage cap), walk des niveaux
 *     de bid >= limite, kill si la profondeur 3 niveaux ne couvre pas la
 *     taille -> retry au tick suivant tant que la condition tient.
 *   - Depth guard a l'entree sur bestAskSize (FOK buy one-shot).
 *
 * npx tsx scripts/research/dip-guard/dip-guard-sim.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, type SideBook, type Universe } from "./universe.mts";

const OUT_DIR = join("audits", "backtest", "dip-guard");

export interface DipGuardConfig {
  label: string;
  /** bande d'ask a l'entree (inclusive) */
  bandMin: number;
  bandMax: number;
  /** fenetre d'entree : elapsed <= entryMaxElapsedSec */
  entryMaxElapsedSec: number;
  /** stop-loss : bid <= stopLossBid -> sell (null = off) */
  stopLossBid: number | null;
  /** arme le trailing quand bid >= armBid (null = off) */
  armBid: number | null;
  /** trailing : stop = pic de bid - trailDist */
  trailDist: number | null;
  /** fenêtre d'activité du stop-loss après l'entrée en secondes (null = toute la vie) */
  stopWindowSec: number | null;
  /** elapsed min avant de pouvoir entrer (laisser le marché se former) */
  minElapsedSec: number;
  /** l'autre token (favori) doit coter ask <= favMax à l'entrée (null = off) */
  favMax: number | null;
  /** take-profit discret : bid >= tpBid -> sell marketable (null = off) */
  tpBid: number | null;
  /** direction inversée : détecter l'underdog dans la bande, acheter le FAVORI */
  invert: boolean;
  /** ticks de slippage autorises sous le trigger pour un sell marketable */
  sellSlipTicks: number;
  /** ecart ask-bid max a l'entree */
  maxSpread: number;
  orderUsdc: number;
  maxShares: number;
}

export const BASE: DipGuardConfig = {
  label: "base stop0.20 trail0.20@0.50",
  bandMin: 0.3,
  bandMax: 0.4,
  entryMaxElapsedSec: 300,
  stopLossBid: 0.2,
  armBid: 0.5,
  trailDist: 0.2,
  stopWindowSec: null,
  minElapsedSec: 0,
  favMax: null,
  tpBid: null,
  invert: false,
  sellSlipTicks: 2,
  maxSpread: 0.05,
  orderUsdc: 15,
  maxShares: 30,
};

export interface Position {
  entryPrice: number;
  size: number;
  outcomeIdx: 0 | 1;
  entryElapsedSec: number;
  peakBid: number;
  armed: boolean;
}

/**
 * Sell marketable fidèle : walk des niveaux de bid >= worstPrice
 * (= trigger - sellSlipTicks ticks), kill si la profondeur ne couvre pas.
 */
export function priceMarketSell(
  book: Pick<
    SideBook,
    "bid" | "bidSize" | "bid2" | "bid2Size" | "bid3" | "bid3Size"
  >,
  size: number,
  triggerPrice: number,
  slipTicks: number,
): number | null {
  const worst = Math.max(0.01, triggerPrice - slipTicks * 0.01);
  const levels: Array<[number | null, number | null]> = [
    [book.bid, book.bidSize],
    [book.bid2, book.bid2Size],
    [book.bid3, book.bid3Size],
  ];
  let remaining = size;
  let cost = 0;
  for (const [px, sz] of levels) {
    if (px == null) break;
    if (px < worst) break; // worst-price limit : sous la limite interdit
    const avail = sz ?? 0;
    const take = Math.min(remaining, avail);
    cost += take * px;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) return null; // depth insuffisante -> kill
  return cost / size;
}

export interface ExitStats {
  label: string;
  fills: number;
  closedTrades: number;
  wins: number;
  losses: number;
  pnl: number;
  maxDrawdown: number;
  shares: number;
  notionalUsdc: number;
  stopExits: number;
  trailExits: number;
  heldToRes: number;
  killedSellTicks: number;
  entriesDepthRejected: number;
  entriesSpreadRejected: number;
  avgEntryPrice: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  evPerShare: number | null;
  byDay: Record<string, number>;
  byEntryBucket: Record<string, number>;
}

const TRADE_BUCKETS = ["30", "35", "40"] as const;
void TRADE_BUCKETS; // réservé diagnostics futures

export function runDipGuardSim(
  universe: Universe,
  P: DipGuardConfig,
  opts?: { slugFilter?: (slug: string) => boolean },
): ExitStats {
  let fills = 0,
    closedTrades = 0,
    wins = 0,
    losses = 0,
    pnl = 0,
    peak = 0,
    maxDrawdown = 0;
  let shares = 0,
    notional = 0;
  let stopExits = 0,
    trailExits = 0,
    heldToRes = 0,
    killedSellTicks = 0;
  let entriesDepthRejected = 0,
    entriesSpreadRejected = 0;
  const winPnls: number[] = [];
  const lossPnls: number[] = [];
  const byDay: Record<string, number> = {};
  const byEntryBucket: Record<string, number> = {};

  const closeTrade = (
    exitPrice: number,
    entry: Position,
    kind: "stop" | "trail" | "hold",
    day: string,
  ) => {
    const p = (exitPrice - entry.entryPrice) * entry.size;
    pnl += p;
    closedTrades++;
    if (p > 0) {
      wins++;
      winPnls.push(p);
    } else {
      losses++;
      lossPnls.push(p);
    }
    peak = Math.max(peak, pnl);
    maxDrawdown = Math.max(maxDrawdown, peak - pnl);
    byDay[day] = (byDay[day] ?? 0) + p;
    if (kind === "stop") stopExits++;
    else if (kind === "trail") trailExits++;
    else heldToRes++;
  };

  for (const [slug, ticks] of universe.slugs) {
    if (opts?.slugFilter && !opts.slugFilter(slug)) continue;
    const res = universe.resMap.get(slug);
    if (res === undefined) continue;
    const wsMs = (universe.wsMap.get(slug) ?? 0) * 1000;
    if (!wsMs) continue;
    const day = new Date(wsMs).toISOString().slice(0, 10);

    let entry: Position | null = null;
    let done = false; // une seule entrée par fenêtre, pas de ré-entrée

    for (const t of ticks) {
      const elapsedSec = (t.ts - wsMs) / 1000;
      if (elapsedSec < 0 || elapsedSec >= 900) continue;
      if (done) break;

      // ----- gestion de la position ouverte : exits d'abord -----
      if (entry) {
        const book = entry.outcomeIdx === 0 ? t.up : t.down;
        const bid = book.bid;
        let exitPrice: number | null = null;
        let kind: "stop" | "trail" | null = null;
        if (bid != null) {
          if (P.armBid != null && bid >= P.armBid) {
            entry.peakBid = Math.max(entry.peakBid, bid);
            entry.armed = true;
          }
          // 1) stop-loss (inactif quand le trailing est armé — le trail
          //    stop >= armBid - trailDist déclenche avant de toute façon)
          const stopActive =
            P.stopWindowSec == null ||
            elapsedSec - entry.entryElapsedSec <= P.stopWindowSec;
          if (P.stopLossBid != null && !entry.armed && stopActive && bid <= P.stopLossBid) {
            const px = priceMarketSell(book, entry.size, P.stopLossBid, P.sellSlipTicks);
            if (px != null) {
              exitPrice = px;
              kind = "stop";
            } else {
              killedSellTicks++;
            }
          }
          // 2) take-profit discret : bid >= tpBid -> sell
          if (kind == null && P.tpBid != null && bid >= P.tpBid) {
            const px = priceMarketSell(book, entry.size, bid, P.sellSlipTicks);
            if (px != null) {
              exitPrice = px;
              kind = "trail"; // compté avec les exits anticipés gagnants
            } else {
              killedSellTicks++;
            }
          }
          // 3) trailing armé : bid <= pic - trailDist
          if (kind == null && entry.armed && P.trailDist != null) {
            const stop = entry.peakBid - P.trailDist;
            if (bid <= stop) {
              const px = priceMarketSell(book, entry.size, stop, P.sellSlipTicks);
              if (px != null) {
                exitPrice = px;
                kind = "trail";
              } else {
                killedSellTicks++;
              }
            }
          }
        }
        if (exitPrice != null && kind != null) {
          closeTrade(exitPrice, entry, kind, day);
          entry = null;
          done = true;
          continue;
        }
        continue; // position toujours ouverte : pas d'entree ce tick
      }

      // ----- recherche d'entree -----
      if (elapsedSec < P.minElapsedSec) continue;
      if (elapsedSec > P.entryMaxElapsedSec) continue;
      // détecter un token (l'underdog) dans la bande d'ask 0.30-0.40
      const candidates: Array<{ idx: 0 | 1; book: SideBook; ask: number }> = [];
      for (const idx of [0, 1] as const) {
        const book = idx === 0 ? t.up : t.down;
        if (book.ask == null) continue;
        if (book.ask < P.bandMin || book.ask > P.bandMax) continue;
        candidates.push({ idx, book, ask: book.ask });
      }
      if (candidates.length === 0) continue;
      // si les deux tokens sont dans la bande : le moins cher
      candidates.sort((a, b) => a.ask - b.ask);
      const c = candidates[0];
      // axe contexte : l'autre jambe (favori) doit coter <= favMax
      if (P.favMax != null) {
        const other = c.idx === 0 ? t.down : t.up;
        if (other.ask == null || other.ask > P.favMax) continue;
      }
      // axe direction : inverser -> on achète le FAVORI (l'autre jambe)
      let targetBook: SideBook;
      if (P.invert) {
        targetBook = c.idx === 0 ? t.down : t.up;
        if (targetBook.ask == null) continue;
        // garde de cohérence : le favori ne doit pas être plus cher que 1 - bandMin
        if (targetBook.ask <= 0.5) continue;
      } else {
        targetBook = c.book;
      }
      const bid = targetBook.bid;
      const entryAsk = targetBook.ask;
      if (bid != null && entryAsk - bid > P.maxSpread) {
        entriesSpreadRejected++;
        continue;
      }
      const size = Math.min(P.orderUsdc / entryAsk, P.maxShares);
      if (size < 5) continue; // MIN_CLOB_SHARES
      if (targetBook.askSize != null && targetBook.askSize < size) {
        entriesDepthRejected++;
        continue;
      }
      entry = {
        entryPrice: entryAsk,
        size,
        outcomeIdx: P.invert ? (c.idx === 0 ? 1 : 0) : c.idx,
        entryElapsedSec: elapsedSec,
        peakBid: bid ?? entryAsk,
        armed: false,
      };
      fills++;
      shares += size;
      notional += entryAsk * size;
      const b = String(Math.round(entry.entryPrice * 100));
      byEntryBucket[b] = (byEntryBucket[b] ?? 0) + 1;
    }

    // ----- fin de fenêtre : position restante -> hold-to-resolution -----
    if (entry) {
      const payout = res === entry.outcomeIdx ? 1 : 0;
      closeTrade(payout, entry, "hold", day);
    }
  }

  const round = (x: number, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
  const avg = (a: number[]) =>
    a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 3) : null;
  return {
    label: P.label,
    fills,
    closedTrades,
    wins,
    losses,
    pnl: round(pnl),
    maxDrawdown: round(maxDrawdown),
    shares: round(shares),
    notionalUsdc: round(notional),
    stopExits,
    trailExits,
    heldToRes,
    killedSellTicks,
    entriesDepthRejected,
    entriesSpreadRejected,
    avgEntryPrice: shares ? round(notional / shares, 3) : null,
    avgWin: avg(winPnls),
    avgLoss: avg(lossPnls),
    evPerShare: shares ? round(pnl / shares, 3) : null,
    byDay: Object.fromEntries(Object.entries(byDay).map(([d, v]) => [d, round(v)])),
    byEntryBucket: Object.fromEntries(
      Object.entries(byEntryBucket).map(([d, v]) => [d, v]),
    ),
  };
}

// ---------- CLI : base + grille ----------
const isMain = process.argv[1]?.endsWith("dip-guard-sim.mts");
if (isMain) {
  const universe = loadUniverse();
  console.log(`universe: ${universe.slugs.size} windows (official-aligned)`);
  mkdirSync(OUT_DIR, { recursive: true });

  // --- Grille OPTIMISATION (axe par axe, base incluse, hold-ref) ---
  // Axes déjà mesurés morts en round 1 (discovery) : stop 0.15 < stop 0.20,
  // trail 0.10/0.30 < trail 0.20, arm 0.45/0.55 < arm 0.50, band 0.28-0.42 /
  // 0.35-0.40 < band 0.30-0.40, entry 180s/420s < 300s, stopWindow 120s pire.
  const grid: DipGuardConfig[] = [
    BASE,
    { ...BASE, label: "HOLD-ref (no exits)", stopLossBid: null, armBid: null, trailDist: null },
    // A. axe timing d'entrée (laisser le marché se former)
    { ...BASE, label: "minElapsed60", minElapsedSec: 60 },
    { ...BASE, label: "minElapsed120", minElapsedSec: 120 },
    { ...BASE, label: "minElapsed180", minElapsedSec: 180 },
    // B. axe contexte marché : état du favori à l'entrée
    { ...BASE, label: "favMax0.55", favMax: 0.55 },
    { ...BASE, label: "favMax0.60", favMax: 0.60 },
    { ...BASE, label: "favMax0.65", favMax: 0.65 },
    // C. axe take-profit discret (remplace le trailing)
    { ...BASE, label: "tp0.45 (no trail)", tpBid: 0.45, armBid: null, trailDist: null },
    { ...BASE, label: "tp0.50 (no trail)", tpBid: 0.5, armBid: null, trailDist: null },
    { ...BASE, label: "tp0.55 (no trail)", tpBid: 0.55, armBid: null, trailDist: null },
    // D. axe stop plus profond (moins de whipsaw)
    { ...BASE, label: "stop0.10", stopLossBid: 0.1 },
    { ...BASE, label: "no-stop no-trail (hold)", stopLossBid: null, armBid: null, trailDist: null },
    // E. direction inversée : acheter le FAVORI quand l'underdog cote 0.30-0.40
    {
      ...BASE,
      label: "INVERT buy-fav stop0.65 tp0.80",
      invert: true,
      stopLossBid: 0.65,
      armBid: null,
      trailDist: null,
      tpBid: 0.8,
    },
    {
      ...BASE,
      label: "INVERT buy-fav stop0.60 tp0.85",
      invert: true,
      stopLossBid: 0.6,
      armBid: null,
      trailDist: null,
      tpBid: 0.85,
    },
    {
      ...BASE,
      label: "INVERT buy-fav hold",
      invert: true,
      stopLossBid: null,
      armBid: null,
      trailDist: null,
    },
    // F. sweep de la variante INVERSÉE (acheter le favori quand l'underdog 0.30-0.40)
    // F1. timing
    { ...BASE, invert: true, label: "INV minElapsed60 hold", minElapsedSec: 60, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV minElapsed120 hold", minElapsedSec: 120, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV entry<=240 hold", entryMaxElapsedSec: 240, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV entry<=420 hold", entryMaxElapsedSec: 420, stopLossBid: null, armBid: null, trailDist: null },
    // F2. bande de détection underdog (le trigger, pas le prix d'achat)
    { ...BASE, invert: true, label: "INV detect 0.30-0.35 hold", bandMax: 0.35, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV detect 0.35-0.40 hold", bandMin: 0.35, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV detect 0.28-0.42 hold", bandMin: 0.28, bandMax: 0.42, stopLossBid: null, armBid: null, trailDist: null },
    // F3. stops / TP sur le favori détenu
    { ...BASE, invert: true, label: "INV stop0.70 tp0.80", invert: true, stopLossBid: 0.7, tpBid: 0.8, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV tp0.75 only", invert: true, stopLossBid: null, tpBid: 0.75, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV tp0.80 only", invert: true, stopLossBid: null, tpBid: 0.8, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV tp0.85 only", invert: true, stopLossBid: null, tpBid: 0.85, armBid: null, trailDist: null },
    // F4. filtre contexte : bande serrée du favori à l'entrée
    { ...BASE, invert: true, label: "INV fav<=0.60 hold", favMax: 0.6, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV fav<=0.65 hold", favMax: 0.65, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV fav<=0.70 hold", favMax: 0.7, stopLossBid: null, armBid: null, trailDist: null },
    // F5. combos des survivants : bande 0.35-0.40 + filtre favori + TP haut
    { ...BASE, invert: true, label: "INV d35-40 tp0.85", bandMin: 0.35, tpBid: 0.85, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV d35-40 fav<=0.65 tp0.85", bandMin: 0.35, favMax: 0.65, tpBid: 0.85, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV d35-40 fav<=0.65 tp0.90", bandMin: 0.35, favMax: 0.65, tpBid: 0.9, stopLossBid: null, armBid: null, trailDist: null },
    { ...BASE, invert: true, label: "INV d35-40 fav<=0.65 tp0.85 e420", bandMin: 0.35, favMax: 0.65, tpBid: 0.85, entryMaxElapsedSec: 420, stopLossBid: null, armBid: null, trailDist: null },
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const P of grid) {
    const r = runDipGuardSim(universe, P);
    const closed = r.wins + r.losses;
    const wr = closed ? Math.round((100 * r.wins) / closed) : 0;
    console.log(
      `${P.label.padEnd(42)} fills=${String(r.fills).padStart(4)} closed=${String(r.closedTrades).padStart(4)} WR=${String(wr).padStart(3)}% PnL=${String(r.pnl).padStart(8)} DD=${String(r.maxDrawdown).padStart(7)} stop=${r.stopExits} trail=${r.trailExits} hold=${r.heldToRes} killT=${r.killedSellTicks}`,
    );
    if (r.closedTrades !== r.fills) {
      console.log(`  !! INVARIANT FAIL: closedTrades (${r.closedTrades}) != fills (${r.fills})`);
      process.exitCode = 1;
    }
    results.push({ config: P, result: r });
  }

  // Split-half temporel sur le meilleur combo (contrôle de robustesse)
  const allWs = [...universe.wsMap.values()].sort((a, b) => a - b);
  const medianWs = allWs[Math.floor(allWs.length / 2)];
  const older = (slug: string) => (universe.wsMap.get(slug) ?? 0) < medianWs;
  const newer = (slug: string) => (universe.wsMap.get(slug) ?? 0) >= medianWs;
  const BEST: DipGuardConfig = {
    ...BASE,
    invert: true,
    bandMin: 0.35,
    favMax: 0.65,
    tpBid: 0.85,
    stopLossBid: null,
    armBid: null,
    trailDist: null,
    label: "BEST INV d35-40 fav<=0.65 tp0.85",
  };
  const bestFull = runDipGuardSim(universe, BEST);
  const bestOld = runDipGuardSim(universe, BEST, { slugFilter: older });
  const bestNew = runDipGuardSim(universe, BEST, { slugFilter: newer });
  console.log(
    `split-half ${BEST.label}: OLD fills=${bestOld.fills} PnL=${bestOld.pnl} | NEW fills=${bestNew.fills} PnL=${bestNew.pnl}`,
  );
  results.push({ splitHalf: { boundary: new Date(medianWs * 1000).toISOString(), full: bestFull, oldHalf: bestOld, newHalf: bestNew } });

  const outPath = join(OUT_DIR, `dip-guard-sim-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: "dip-guard discovery sim",
        generatedAt: new Date().toISOString(),
        universeSize: universe.slugs.size,
        criteria: { minTicks: 801, maxGapMs: 60_000 },
        note: "Offline only — live bot untouched. Exits priced on HELD token book, marketable sell walk 3 bid levels, slippage cap 2 ticks. One entry per window, no re-entry.",
        rows: results,
      },
      null,
      2,
    ),
  );
  console.log("written:", outPath);
}