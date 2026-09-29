import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { tickSizeFromMarket, windowSecondsFromSlug } from "../utils/market.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { round2 } from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";

/**
 * Early-low — acheter un token UP/DOWN très décoté au tout début d'un
 * marché 15m, puis hold intégral jusqu'à la résolution (config optimisée
 * 2026-09-29).
 *
 * Entrée : dans les `earlyLowMaxElapsedSec` premières secondes (défaut 150
 * = 2,5 min) de la fenêtre, si un token UP/DOWN descend sous
 * `earlyLowBuyAskMax` (défaut 0.12 = 12 ¢), achat FOK de `earlyLowOrderUsdc`
 * ($1 par défaut). Un seul trade par paire ; retry au tick suivant si le FOK
 * est tué par la profondeur (pattern open-entry / dip-revert).
 *
 * Sortie par défaut : HOLD jusqu'à la résolution (`earlyLowExitEnabled`
 * false). Optimisation multi-split 2026-09-29 (4 splits, 8 segments) :
 * hold intégral = positif sur 8/8 segments (+$33.6 / 21 jours) alors que
 * l'exit wait-and-see 0.40 est négatif partout — l'exit coupe des gagnants
 * qui allaient payer 1 $ à la résolution. Le wait-and-see reste disponible
 * (pattern dip-revert TP / open-entry SL, pipeline defend) :
 *  1. l'ask du token TENU atteint `earlyLowExitAsk` → on ARME l'observation,
 *  2. tant que l'ask progresse (≥ `earlyLowExitMomentumMin`) entre deux
 *     observations, on HOLD,
 *  3. au premier tick de stagnation/baisse, FOK SELL complet au bid.
 *
 * Options d'exit additionnelles (toutes off par défaut) :
 * - trailing : offset soustrait au momentum exigé (tolérance de repli) ;
 * - stop-loss : bid ≤ `earlyLowStopLossBidMax` → vente immédiate (coupe
 *   les trajectoires mortes avant expiration à 0) ;
 * - deadline : après `earlyLowExitMaxElapsedSec`, un exit armé est vendu.
 *
 * `earlyLow15mOnly` (défaut true, gate à la antiflip5mOnly) : refuse les
 * marchés non-15m — la dynamique "dip extrême à l'ouverture" n'est pas
 * transférable aux autres timeframes. Le gate vit DANS le moteur pour
 * couvrir live ET paper trading.
 */
interface EarlyLowState {
  /** Ts (ms) d'armement de l'observation TP ; null = pas encore au seuil. */
  exitArmedAtMs: number | null;
  /** Dernier ask observé pendant l'observation (mesure du momentum). */
  exitLastAsk: number | null;
  /** Dernier tick vu — purge des états de paires clôturées. */
  lastSeenMs: number;
  /** WindowStart (s) si connu via findOpportunities (deadline exit). */
  windowStartSec?: number;
}

interface EntryHistoryEntry {
  ts: number;
  ask: number;
}

interface EntryHistory {
  lastSeenMs: number;
  ticks: EntryHistoryEntry[];
}

const STALE_MS = 2 * 900 * 1000; // 2 fenêtres 15m max, au-delà = purge
const HISTORY_MAX_ENTRIES = 700; // ~11 min à 1 tick/s, garde-fou mémoire

export class EarlyLowStrategy implements TradingStrategy {
  readonly id = "early-low" as const;
  readonly label =
    "Early-low: FOK buy a token below 12c in the first 2.5 min of a 15m market; hold to resolution (optional wait-and-see exit at 40c, optional bid stop-loss)";
  readonly leadsWithEdge = false;
  /** TP exit reuses the defend pipeline (dip-revert TP precedent). */
  readonly usesDefendAsExit = true;

  private readonly states = new Map<string, EarlyLowState>();
  /** Historique (ts, lowAsk) par paire pour l'entrée drop confirmé. */
  private readonly entryHistory = new Map<string, EntryHistory>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const elapsedSec = nowMs / 1000 - event.windowStart;

    this.purgeStaleStates(nowMs);

    // 15m uniquement (gate type antiflip5mOnly sur la durée 900 s).
    if (config.earlyLow15mOnly && windowSecondsFromSlug(event.slug) !== 900) {
      return opportunities;
    }

    // Un seul trade par paire : un FOK réussi crée un leg (open ou résolu),
    // ce qui bloque les tentatives suivantes. Après un FOK raté (profondeur
    // insuffisante), countLegs reste 0 → retry au tick suivant (règle :
    // ne JAMAIS bloquer la ré-entrée après un FOK rejeté — incident dip-revert).
    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    const up = books.find((b) => b.outcomeIndex === 0) ?? null;
    const down = books.find((b) => b.outcomeIndex === 1) ?? null;
    if (!up || !down || up.bestAsk === null || down.bestAsk === null) {
      return opportunities;
    }

    // Fenêtre d'entrée : [0, earlyLowMaxElapsedSec] (défaut 150 = 2,5 min).
    if (elapsedSec < 0) return opportunities;
    if (elapsedSec > config.earlyLowMaxElapsedSec) {
      return opportunities;
    }

    // Token décoté = ask minimal (le moins cher des deux tokens).
    const lowToken = up.bestAsk <= down.bestAsk ? up : down;
    const ask = lowToken.bestAsk as number;

    // OPT: historique lowAsk pour l'entrée drop confirmé (fenêtre d'entrée).
    if (config.earlyLowDropEntryEnabled) {
      this.recordLowAsk(pairId, nowMs, ask);
    }

    // Bande d'achat : ask < earlyLowBuyAskMax (12 ¢). Bande min optionnelle.
    if (ask >= config.earlyLowBuyAskMax) {
      return opportunities;
    }
    if (config.earlyLowBuyAskMin > 0 && ask < config.earlyLowBuyAskMin) {
      return opportunities;
    }

    // OPT: entrée drop confirmé — une vraie chute in-window est exigée
    // (référence ≥ dropEntryPriceMin vu il y a ≥ dropMinElapsedSec, drop
    // d'au moins dropMin). Sans chute passée, pas d'achat.
    if (
      config.earlyLowDropEntryEnabled &&
      !this.dropConfirmed(config, pairId, event.windowStart, nowMs, ask)
    ) {
      return opportunities;
    }

    // Spread gate sur le token ciblé (liquidité).
    if (
      lowToken.bestBid != null &&
      ask - lowToken.bestBid > config.earlyLowMaxSpread
    ) {
      return opportunities;
    }

    const size = computeSize(
      config.earlyLowOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Profondeur SÛRE : le FOK exige la size complète au best ask ; sinon
    // retry au tick suivant plutôt qu'un reject silencieux en masse.
    if (lowToken.bestAskSize != null && lowToken.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, lowToken.outcome, "cheap", round2(ask));
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: lowToken,
      price: round2(ask),
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      pairId,
      orderType: "FOK",
    });
    return opportunities;
  }

  /**
   * Wait-and-see exit (pattern dip-revert TP / open-entry SL, pipeline
   * defend). Dès que l'ask du token tenu atteint `earlyLowExitAsk` (40 ¢),
   * on ARME l'observation : on ne vend PAS au tick d'armement. Ensuite,
   * tant que l'ask progresse d'au moins `earlyLowExitMomentumMin` entre
   * deux observations, on HOLD. Au premier tick où la progression tombe
   * sous le seuil (stagnation ou baisse), on vend tout (FOK au bid).
   *
   * Trailing optionnel : offset soustrait à la progression exigée
   * (momentum effectif = momentumMin − offset ; offset 0.02 avec momentum 0
   * = trailing tolérant 2 ¢ de repli depuis chaque plus-haut).
   *
   * Stop-loss optionnel : bid ≤ stopLossBidMax → vente immédiate, armé ou
   * non (coupe les trajectoires mortes avant expiration à 0).
   *
   * Deadline optionnelle : au-delà de exitMaxElapsedSec, un exit armé est
   * vendu au premier tick (plus de momentum à prouver).
   */
  shouldDefend(ctx: DefendContext): boolean {
    if (ctx.filledCheap <= 0) return false;

    // OPT: stop-loss avant tout — armé ou non, le bid cassé = trajectoire
    // morte ; vendre au market coupe avant l'expiration à 0.
    if (
      ctx.config.earlyLowStopLossEnabled &&
      ctx.cheapBid != null &&
      ctx.cheapBid <= ctx.config.earlyLowStopLossBidMax
    ) {
      return true;
    }

    if (!ctx.config.earlyLowExitEnabled) return false;
    if (ctx.cheapAsk == null) return false;
    const nowMs = ctx.nowMs ?? Date.now();

    let state = this.states.get(ctx.pairId);
    if (!state) {
      state = { exitArmedAtMs: null, exitLastAsk: null, lastSeenMs: nowMs };
      this.states.set(ctx.pairId, state);
    }
    state.lastSeenMs = nowMs;

    // Armement : le seuil d'armement est atteint → début de l'observation. On ne
    // vend jamais au tick d'armement (le user spec: "attendre et voir").
    if (state.exitArmedAtMs == null) {
      if (ctx.cheapAsk >= ctx.config.earlyLowExitAsk) {
        state.exitArmedAtMs = nowMs;
        state.exitLastAsk = ctx.cheapAsk;
      }
      return false;
    }

    // OPT: deadline — un exit armé mais non déclenché après exitMaxElapsedSec
    // est vendu au premier tick (l'extension n'a plus de momentum à prouver).
    const windowStartSec = state.windowStartSec ?? this.windowStartFromPairId(ctx.pairId);
    if (
      windowStartSec != null &&
      ctx.config.earlyLowExitMaxElapsedSec > 0 &&
      nowMs / 1000 - windowStartSec > ctx.config.earlyLowExitMaxElapsedSec
    ) {
      return true;
    }

    // Observation : progression tick-à-tick ≥ momentum min → hold.
    // OPT trailing : l'offset est soustrait au seuil (momentum effectif =
    // momentumMin − offset), ce qui tolère un repli jusqu'à offset depuis
    // chaque nouveau plus-haut avant la vente.
    const effectiveMomentum =
      ctx.config.earlyLowExitMomentumMin -
      (ctx.config.earlyLowTrailingEnabled ? ctx.config.earlyLowTrailingOffset : 0);
    const progressed =
      state.exitLastAsk != null &&
      ctx.cheapAsk - state.exitLastAsk >= effectiveMomentum;
    // On mémorise l'ask uniquement sur progression. Sur stagnation/baisse la
    // vente part tout de suite ; si elle est tuée (profondeur), l'ask de
    // référence reste le pic : le re-déclenchement exige un prix sous la
    // dernière valeur montante — un sell-kill pendant une remontée ne
    // repeuple pas un faux signal de baisse.
    if (progressed) {
      state.exitLastAsk = ctx.cheapAsk;
    }
    // Stagnation/baisse → SELL (FOK au bid).
    return !progressed;
  }

  defendShares(ctx: DefendContext): number {
    if (!this.shouldDefend(ctx)) return 0;
    return round2(ctx.filledCheap);
  }

  /** Purge : les paires ne reviennent jamais après leur fenêtre fermée. */
  private purgeStaleStates(nowMs: number): void {
    for (const [key, st] of this.states) {
      if (nowMs - st.lastSeenMs > STALE_MS) {
        this.states.delete(key);
      }
    }
    for (const [key, hist] of this.entryHistory) {
      if (nowMs - hist.lastSeenMs > STALE_MS) {
        this.entryHistory.delete(key);
      }
    }
  }

  private recordLowAsk(pairId: string, nowMs: number, lowAsk: number): void {
    let hist = this.entryHistory.get(pairId);
    if (!hist) {
      hist = { lastSeenMs: nowMs, ticks: [] };
      this.entryHistory.set(pairId, hist);
    }
    hist.lastSeenMs = nowMs;
    hist.ticks.push({ ts: nowMs, ask: lowAsk });
    if (hist.ticks.length > HISTORY_MAX_ENTRIES) {
      hist.ticks.splice(0, hist.ticks.length - HISTORY_MAX_ENTRIES);
    }
  }

  /**
   * Chute confirmée : un snapshot passé (âgé d'au moins
   * `earlyLowDropMinElapsedSec`, dans la fenêtre) doit avoir coté
   * ≥ `earlyLowDropEntryPriceMin`, avec un drop d'au moins `earlyLowDropMin`
   * jusqu'à l'ask courant.
   */
  private dropConfirmed(
    config: BotConfig,
    pairId: string,
    windowStartSec: number,
    nowMs: number,
    currentAsk: number,
  ): boolean {
    const hist = this.entryHistory.get(pairId);
    if (!hist) return false;
    const minAgeMs = config.earlyLowDropMinElapsedSec * 1000;
    for (const tick of hist.ticks) {
      if (nowMs - tick.ts < minAgeMs) continue;
      if (tick.ts < windowStartSec * 1000) continue; // hors fenêtre
      if (tick.ask < config.earlyLowDropEntryPriceMin) continue;
      if (tick.ask - currentAsk >= config.earlyLowDropMin) return true;
    }
    return false;
  }

  /** Déduit windowStart (s) du pairId `slug:windowEnd` (fenêtre 15m). */
  private windowStartFromPairId(pairId: string): number | undefined {
    const end = Number(pairId.split(":").pop());
    if (!Number.isFinite(end) || end <= 0) return undefined;
    return end - 900;
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "early-low-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}