import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { tickSizeFromMarket } from "../utils/market.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { pickEdgeToken } from "./edge-lead-strategy.js";
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
 * Dip-revert — NOUVELLE stratégie directionnelle (mean-reversion sur le favori).
 *
 * Signal empirique (313 fenêtres conformes, BTC/ETH 15m) : après ~180 s dans
 * la fenêtre, le favori (ask le plus haut) qui a subi une chute intra-fenêtre
 * d'au moins `dipRevertMinDrop` sur `dipRevertDropLookbackMs`, puis dont le
 * prix STABILISE/REBONDIT (ask actuel > minimum observé sur la fenêtre), gagne
 * à la clôture ~64 % du temps (vs ~52 % pour le favori moyen). Le marché
 * sur-pénalise temporairement le favori après une secousse ; la résolution
 * revient à la tendance dominante.
 *
 * Exécution : un seul FOK BUY du favori (bande dipRevertBandMin..dipRevertBandMax),
 * hold jusqu'à résolution. Pas de hedge, pas de cheap, pas de défense.
 * Distinct de fav-band (aucune condition de drop/rebond), d'edge-lead
 * (aucun cheap follow-up), et des moteurs hedgés arb/barbell.
 */
interface DipState {
  /** Fenêtre glissante des asks du favori courant (ts, ask). */
  samples: Array<{ ts: number; ask: number }>;
}

export class DipRevertStrategy implements TradingStrategy {
  readonly id = "dip-revert" as const;
  readonly label =
    "Dip-revert: FOK buy favorite after intra-window dip + stabilization; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  private readonly states = new Map<string, DipState>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const fav = pickEdgeToken(books); // token au best ask le plus haut
    if (!fav || fav.bestAsk === null) return opportunities;
    const ask = fav.bestAsk;
    const pairId = `${event.slug}:${event.windowEnd}`;

    // Fenêtre glissante : on push le sample DÈS LE DÉBUT, même hors bande ou
    // avant minElapsed. Le dip se mesure depuis l'ancien favori qui peut
    // sortir de la bande (ex 0.70 -> 0.60) ; sans ce sample le signal est mort.
    //
    // NB : on suit l'ask du favori REDÉFINI à chaque tick (max(ask_up, ask_down)).
    // Cette série est une mesure continue de la confiance du marché dans le
    // leader, valide même quand l'identité du favori flip (les deux asks sont
    // ~complémentaires autour de 0.5). C'est exactement ce que mesurait la
    // recherche `dip-confirmed.mjs` qui a identifié l'edge : ne PAS resetter
    // sur un flip, sinon on diverge du signal validé empiriquement.
    const state = this.stateFor(pairId, nowMs, ask, event.windowStart, config);

    // Une seule entrée par paire : un FOK réussi crée un leg (open ou résolu),
    // ce qui bloque les tentatives suivantes. Après un FOK raté (profondeur
    // insuffisante), countLegs reste 0 et on retente au tick suivant.
    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    const elapsedSec = nowMs / 1000 - event.windowStart;
    if (elapsedSec < config.dipRevertMinElapsedSec) {
      return opportunities;
    }
    if (
      config.dipRevertMaxElapsedSec != null &&
      elapsedSec > config.dipRevertMaxElapsedSec
    ) {
      return opportunities;
    }

    if (ask < config.dipRevertBandMin || ask > config.dipRevertBandMax) {
      return opportunities;
    }
    if (
      fav.bestBid !== null &&
      ask - fav.bestBid > config.dipRevertMaxSpread
    ) {
      return opportunities;
    }

    if (!this.dipSignalReady(state, ask, config)) {
      return opportunities;
    }

    const size = computeSize(
      config.dipRevertOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Profondeur SÛRE : le FOK exige la size complète. N'émettre que si la
    // taille visible au best ask couvre la commande entière ; sinon retry au
    // tick suivant (nouvelle opportunité, nouvelle clé) plutôt qu'un reject.
    if (fav.bestAskSize != null && fav.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, fav.outcome, "cheap", ask);
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: fav,
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
   * Fenêtre glissante : conserve les asks du favori depuis `eventStartSec*1000`
   * jusqu'à maintenant, en bornant à `dipRevertDropLookbackMs`.
   */
  private stateFor(
    pairId: string,
    nowMs: number,
    ask: number,
    windowStartSec: number,
    config: BotConfig,
  ): DipState {
    // Fenêtres clôturées : évite la fuite du Map (le bot tourne des jours ;
    // les paires passées ne repassent jamais dans findOpportunities).
    const staleness = Math.max(config.dipRevertDropLookbackMs, 60_000);
    for (const [key, st] of this.states) {
      const lastSample = st.samples[st.samples.length - 1];
      if (lastSample && nowMs - lastSample.ts > staleness * 2) {
        if (this.states.get(key) === st) this.states.delete(key);
      }
    }
    let state = this.states.get(pairId);
    if (!state) {
      state = { samples: [] };
      this.states.set(pairId, state);
    }
    // Fenêtre glissante configurable : utilise dipRevertDropLookbackMs, pas un
    // 60 s en dur (sinon tout lookback > 60 s ne mesure plus rien).
    const cutoff = Math.max(
      nowMs - config.dipRevertDropLookbackMs,
      windowStartSec * 1000,
    );
    while (state.samples.length > 0 && state.samples[0].ts < cutoff) {
      state.samples.shift();
    }
    const last = state.samples[state.samples.length - 1];
    if (!last || last.ts !== nowMs) {
      state.samples.push({ ts: nowMs, ask });
    }
    return state;
  }

  /**
   * Signal : dans la fenêtre glissante (>= 2 samples),
   *  - chute : ask le plus ancien de la fenêtre - ask actuel >= minDrop
   *  - rebond : ask actuel > minimum de la fenêtre (le prix a cessé de
   *    descendre / remonte).
   */
  private dipSignalReady(
    state: DipState,
    ask: number,
    config: BotConfig,
  ): boolean {
    if (state.samples.length < 2) return false;
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    // Fenêtre d'historique suffisante pour mesurer le drop (~lookback). Le
    // cutoff de stateFor garde les samples >= nowMs - lookback, donc le span
    // est ~lookback avec des ticks réguliers ; on tolère 70% (gaps, début).
    if (last.ts - first.ts < config.dipRevertDropLookbackMs * 0.7) {
      return false;
    }
    const low = Math.min(...state.samples.map((s) => s.ask));
    return (
      first.ask - ask >= config.dipRevertMinDrop &&
      ask > low &&
      ask - low >= 0.001
    );
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  shouldDefend(_ctx: DefendContext): boolean {
    return false;
  }

  defendShares(_ctx: DefendContext): number {
    return 0;
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "dip-revert-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
