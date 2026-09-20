import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TradeOpportunity } from "../types.js";
import { tickSizeFromMarket } from "../utils/market.js";
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
 * Open-entry — entrée sur le favori ÉMERGENT dans les premières minutes,
 * échelle de stop-loss contextuelle, hold to resolution sinon.
 *
 * Signal empirique (backtest calibré 2026-09-19, 724 fenêtres BTC 15m,
 * sim runner-fidèle, vérifiée contre le runner officiel) : à l'ouverture
 * (t≈0.5s) le marché est FAIR (somme des asks p50 = 1.01) et sans
 * inclinaison mesurable — l'edge d'ouverture vit dans le favori qui
 * ÉMERGE (diff up/down ≥ 0.10 à p50 6 s). On achète le 1er favori menant
 * de `openEntryLeanTrigger` dans la fenêtre [0, `openEntryMaxElapsedSec`],
 * marché ouvert fair (askSum ≤ `openEntryFairAskSumMax`). +$471, WR 37 %,
 * t 2.88, vr 0.105 à sizing 15 $ ; hold nu $351 — la valeur est dans les
 * SL, pas dans l'entrée.
 *
 * Sortie (pipeline defend, `usesDefendAsExit`, précédent dip-revert TP) —
 * le TP pur est re-confirmé mort (4ᵉ audit) : c'est l'ÉCHELLE de stop qui
 * porte la valeur :
 *  - SL structurel : le token OPPOSÉ mène de >= flipDist depuis >=
 *    confirmSec ET le bid tenu a perdu >= dist depuis l'entrée (jamais
 *    l'un seul : le flip seul coupe les rebonds, le dégât seul coupe le bruit).
 *  - SL tardif : passé `openEntrySlLateAfterSec`, un petit dégât
 *    (`slLateDist`) suffit — la thèse a eu le temps de se vérifier.
 * ATTENTION (backtest 2026-09-19) : ces exits DÉGRAIDENT l'entrée
 * early-conviction ($361 vs $437 hold) — ils ne sont validés QUE pour
 * cette entrée lean. Ne pas copier ce bloc sur un autre moteur.
 *
 * État par paire en mémoire (côté, prix de fill, début du flip adverse
 * courant) : perdu au restart, claims/fills survivent en DB (pattern
 * EdgeConfirmBuffer). Purge : les paires ne repassent JAMAIS dans
 * findOpportunities après leur fenêtre — states supprimés à la clôture
 * (windowEnd < now) au tick suivant.
 */
interface OpenEntryState {
  /** Fair gate du 1er tick deux-côtés (le régime d'ouverture est unique). */
  fairOpen: boolean;
  /** Prix de référence des SL, posé au fill réel ; null avant fill. */
  entryPrice: number | null;
  /** Début du flip adverse courant (nowMs) ; null = pas de flip en cours. */
  adverseSinceMs: number | null;
  /** windowEnd (s) de la paire — purge. */
  windowEndSec: number;
  /** windowStart (s) — SL tardif dérivé de la fenêtre réelle du slug. */
  windowStartSec: number;
}

const STALE_MS = 2 * 900 * 1000; // 2 fenêtres max, au-delà = purge

export class OpenEntryStrategy implements TradingStrategy {
  readonly id = "open-entry" as const;
  readonly label =
    "Open-entry: FOK buy the emerging favorite (lead >= trigger within the entry window, fair open); dual-scale structural stop-loss then hold to resolve (no hedge)";
  readonly leadsWithEdge = false;
  /** SL exits reuse the defend pipeline (dip-revert TP precedent). */
  readonly usesDefendAsExit = true;

  private readonly states = new Map<string, OpenEntryState>();

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

    if (elapsedSec < 0) return opportunities;
    if (elapsedSec > config.openEntryMaxElapsedSec) return opportunities;

    const up = books.find((b) => b.outcomeIndex === 0) ?? null;
    const down = books.find((b) => b.outcomeIndex === 1) ?? null;
    if (!up || !down || up.bestAsk === null || down.bestAsk === null) {
      return opportunities;
    }
    const askSum = up.bestAsk + down.bestAsk;

    // Marché ouvert fair : la fair-ness est une propriété de l'OUVERTURE —
    // évaluée au PREMIER tick deux-côtés vu pour la paire puis mémorisée
    // (le signal backtesté 2026-09-19 la mesurait au 1er tick deux-côtés ;
    // la ré-évaluer chaque tick admet des entrées hors signal — dilution
    // WR/per-fill mesurée sur le runner officiel).
    let state = this.states.get(pairId);
    if (!state) {
      state = {
        fairOpen: askSum <= config.openEntryFairAskSumMax,
        entryPrice: null,
        adverseSinceMs: null,
        windowEndSec: event.windowEnd,
        windowStartSec: event.windowStart,
      };
      this.states.set(pairId, state);
    }
    if (!state.fairOpen) return opportunities;

    const diff = up.bestAsk - down.bestAsk; // >0 = UP mène
    const leaderAsk = Math.max(up.bestAsk, down.bestAsk);
    const margin = Math.abs(diff);
    if (margin < config.openEntryLeanTrigger) return opportunities;
    const leaderBid = (diff > 0 ? up : down).bestBid;
    if (leaderBid !== null && leaderAsk - leaderBid > config.openEntryMaxSpread) {
      return opportunities;
    }

    const size = computeSize(
      config.openEntryOrderUsdc,
      leaderAsk,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Profondeur SÛRE : le FOK exige la size complète au niveau 1 ; sinon
    // retry au tick suivant plutôt qu'un reject silencieux en masse.
    const leaderSize = (diff > 0 ? up : down).bestAskSize;
    if (leaderSize != null && leaderSize < size) {
      return opportunities;
    }

    const leader = diff > 0 ? up : down;
    const tradeKey = tracker.makeKey(
      event.slug,
      leader.outcome,
      "cheap",
      round2(leaderAsk),
    );
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: leader,
      price: round2(leaderAsk),
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      pairId,
      orderType: "FOK",
    });
    return opportunities;
  }

  /** Prix de référence des SL, posé au fill réel (runner + live). */
  onBuyCommitted(opportunity: TradeOpportunity): void {
    const state = this.states.get(opportunity.pairId);
    if (state) {
      state.entryPrice = opportunity.price;
    } else {
      this.states.set(opportunity.pairId, {
        fairOpen: true,
        entryPrice: opportunity.price,
        adverseSinceMs: null,
        windowEndSec: opportunity.event.windowEnd,
        windowStartSec: opportunity.event.windowStart,
      });
    }
  }

  /**
   * SL dual-scale sur le token TENU. Le runner appelle `shouldDefend`
   * chaque tick (manageRestingPolicy → defendCheapLegs) avec
   * `cheapAsk` = ask du token tenu et `favoriteAsk` = ask de l'autre jambe ;
   * le live `defendPair` re-dérive la même paire avec un book frais.
   * Switch d'activation : `openEntrySlEnabled` (défaut true = config
   * backtestée 2026-09-19). False = hold intégral (le contrôle exits-OFF
   * du backtest).
   */
  shouldDefend(ctx: DefendContext): boolean {
    if (!ctx.config.openEntrySlEnabled) return false;
    if (ctx.filledCheap <= 0) return false;
    const nowMs = ctx.nowMs ?? Date.now();
    const state = this.states.get(ctx.pairId);
    if (!state || state.entryPrice == null) return false;
    if (ctx.cheapAsk == null || ctx.favoriteAsk == null) return false;

    // Fenêtre DÉRIVÉE de l'événement (pas de 900 en dur, pattern
    // multi-timeframe) — le SL tardif est relatif au windowStart réel.
    const elapsedSec = nowMs / 1000 - state.windowStartSec;

    // flip adverse : l'autre jambe mène de >= slStructFlipDist (état mesuré
    // tick par tick, persistant tant que confirmé, réarmé sinon).
    const otherLeads =
      ctx.favoriteAsk - ctx.cheapAsk >= ctx.config.openEntrySlStructFlipDist;
    if (!otherLeads) {
      state.adverseSinceMs = null;
    } else if (state.adverseSinceMs == null) {
      state.adverseSinceMs = nowMs;
    }

    // SL structurel : flip confirmé ET dégât prix sur l'ask tenu. Le runner
    // vend au bid ; déclencher sur ask > bid d'au moins 1 tick = le bid
    // réel est <= trigger quand le fill arrive (worst-price honnête).
    if (
      state.adverseSinceMs != null &&
      nowMs - state.adverseSinceMs >= ctx.config.openEntrySlStructConfirmSec * 1000 &&
      ctx.cheapAsk <= state.entryPrice - ctx.config.openEntrySlStructDist - 0.01
    ) {
      return true;
    }

    // SL tardif : passé N s de fenêtre, un petit dégât suffit.
    if (
      elapsedSec >= ctx.config.openEntrySlLateAfterSec &&
      ctx.cheapAsk <= state.entryPrice - ctx.config.openEntrySlLateDist - 0.01
    ) {
      return true;
    }
    return false;
  }

  defendShares(ctx: DefendContext): number {
    if (!this.shouldDefend(ctx)) return 0;
    return round2(ctx.filledCheap);
  }

  /** Purge : les paires ne reviennent jamais après leur fenêtre. */
  private purgeStaleStates(nowMs: number): void {
    for (const [key, st] of this.states) {
      if (st.windowEndSec * 1000 + STALE_MS < nowMs) {
        this.states.delete(key);
      }
    }
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "open-entry-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}