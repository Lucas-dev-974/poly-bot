import type { BotConfig } from "../config.js";
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
 * Antiflip-revert — acheter l'ANCIEN favori après un retournement d'identité.
 *
 * Signal empirique (backtest calibré 2026-09-15, 393 fenêtres BTC 15m, sim
 * reproduite par le runner officiel à ±0.3 % fills) : quand le favori FLIPPE
 * (identité du leader inversée) après `antiflipMinElapsedSec`, le marché
 * SUR-réagit — l'ancien favori, replacé ~0.35-0.45, re-gagne ~52 % du temps
 * (EV +9¢/share vs prix moyen 0.43). Le flip doit être FRAIS (≤
 * `antiflipFlipLookbackMs`) et le nouveau favori incertain (0.45-0.65) ;
 * au-delà le marché a digéré le retournement et l'edge disparaît (contrôle
 * causal : flip ancien → +$3 ; flip récent → +$623).
 *
 * Exécution : un seul FOK BUY du favori déchu, hold jusqu'à résolution.
 * Pas de hedge, pas de défense. Un seul déclenchement par paire
 * (getFilledCheapSizeForPair / countLegsByKind), retry après un FOK tué.
 */
interface FlipState {
  /** Timestamp du dernier changement d'identité du favori (ms), null si aucun. */
  lastFlipTs: number | null;
  /** Identité estimée du favori au tick précédent (null = pas encore connu). */
  prevFavIdx: 0 | 1 | null;
  /** Dernier tick vu pour la purge des états de fenêtres clôturées. */
  lastSeenTs: number;
}

export class AntiflipRevertStrategy implements TradingStrategy {
  readonly id = "antiflip-revert" as const;
  readonly label =
    "Antiflip-revert: FOK buy the deposed favorite right after an identity flip; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  private readonly states = new Map<string, FlipState>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const elapsedSec = nowMs / 1000 - event.windowStart;

    // Identité du favori instantanée (tie -> Up, comme dans la sim calibrée).
    const up = books.find((b) => b.outcomeIndex === 0) ?? null;
    const down = books.find((b) => b.outcomeIndex === 1) ?? null;
    if (!up || !down) return opportunities;
    const favIdx: 0 | 1 | null =
      up.bestAsk != null && down.bestAsk == null
        ? 0
        : down.bestAsk != null && up.bestAsk == null
          ? 1
          : up.bestAsk != null && down.bestAsk != null
            ? up.bestAsk >= down.bestAsk
              ? 0
              : 1
            : null;
    if (favIdx == null) return opportunities;
    const favAsk = favIdx === 0 ? up.bestAsk : down.bestAsk;
    if (favAsk == null) return opportunities;

    const state = this.stateFor(pairId, nowMs);
    // Flip détecté : changement d'identité du favori entre deux ticks.
    if (state.prevFavIdx !== null && state.prevFavIdx !== favIdx) {
      state.lastFlipTs = nowMs;
    }
    state.prevFavIdx = favIdx;
    state.lastSeenTs = nowMs;

    // Un seul déclenchement par paire ; un FOK tué (profondeur) reste retirable.
    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    if (elapsedSec < config.antiflipMinElapsedSec) {
      return opportunities;
    }
    if (
      config.antiflipMaxElapsedSec != null &&
      elapsedSec > config.antiflipMaxElapsedSec
    ) {
      return opportunities;
    }

    // Gate 1 : flip frais.
    if (state.lastFlipTs == null) return opportunities;
    if (nowMs - state.lastFlipTs > config.antiflipFlipLookbackMs) {
      return opportunities;
    }
    // Gate 2 : le NOUVEAU favori doit être incertain (0.45-0.65).
    if (favAsk < 0.45 || favAsk > 0.65) return opportunities;
    // Gate 3 : le favori déchu doit coter dans la bande et passer le floor.
    const deposed = favIdx === 0 ? down : up;
    const deposedAsk = favIdx === 0 ? down.bestAsk : up.bestAsk;
    if (deposed.bestAsk == null) return opportunities;
    if (
      deposed.bestAsk < config.antiflipBandMin ||
      deposed.bestAsk > config.antiflipBandMax
    ) {
      return opportunities;
    }
    if (
      config.antiflipDeposedAskMin != null &&
      deposed.bestAsk < config.antiflipDeposedAskMin
    ) {
      return opportunities;
    }
    // Gate spread sur le token ciblé (le déchu).
    if (deposed.bestBid != null && deposed.bestAsk - deposed.bestBid > config.antiflipMaxSpread) {
      return opportunities;
    }

    const size = computeSize(
      config.antiflipOrderUsdc,
      deposed.bestAsk,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Profondeur : le FOK exige la size complète au best ask du déchu.
    if (deposed.bestAskSize != null && deposed.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, deposed.outcome, "cheap", round2(deposed.bestAsk));
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: deposed,
      price: round2(deposed.bestAsk),
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
   * État par paire : dernier flip + favori précédent. Les fenêtres passées
   * sont purgées (le bot tourne des jours, le Map doit rester borné).
   */
  private stateFor(pairId: string, nowMs: number): FlipState {
    for (const [key, st] of this.states) {
      if (nowMs - st.lastSeenTs > 2_700_000) {
        // ~3 fenêtres : la paire ne repassera jamais.
        this.states.delete(key);
      }
    }
    let state = this.states.get(pairId);
    if (!state) {
      state = { lastFlipTs: null, prevFavIdx: null, lastSeenTs: nowMs };
      this.states.set(pairId, state);
    }
    return state;
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
    return { action: "skip", reason: "antiflip-revert-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}

