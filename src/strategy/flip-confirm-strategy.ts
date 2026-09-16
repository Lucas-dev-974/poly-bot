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
 * Flip-confirm — suivre le NOUVEAU favori après un retournement précoce.
 *
 * Signal empirique (backtest calibré 2026-09-15, 393 fenêtres BTC 15m) : un
 * flip d'identité survenant tôt dans la fenêtre est INFORMATIONNEL (vrai
 * déséquilibre) ; le marché sous-ajuste d'abord. En achetant le nouveau
 * favori 0.55-0.65 dans la fenêtre d'entrée [flipConfirmMinElapsedSec,
 * flipConfirmMaxElapsedSec] (≤ flipConfirmFlipLookbackMs après le flip), on
 * capte le ré-ajustement : WR 66.5 %, t-stat 2.44, +$389. Le timing EST le
 * signal — la même entrée après 180s s'effondre (−$227 à 180s+, −$652 à
 * 240s+ : les flips tardifs sont du bruit de fin de fenêtre).
 *
 * Exécution : un seul FOK BUY du nouveau favori, hold jusqu'à résolution.
 * Pas de hedge. Robustesse : 0/188 entrées sur flip d'égalité pure ;
 * l'hystérésis (flip si lead ≥ 1 tick) améliore le PnL → le signal n'est pas
 * un artefact de tie-break.
 */
interface FlipConfirmState {
  lastFlipTs: number | null;
  prevFavIdx: 0 | 1 | null;
  lastSeenTs: number;
}

export class FlipConfirmStrategy implements TradingStrategy {
  readonly id = "flip-confirm" as const;
  readonly label =
    "Flip-confirm: FOK buy the NEW favorite shortly after an early identity flip, entry in [min,max] elapsed; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  private readonly states = new Map<string, FlipConfirmState>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const elapsedSec = nowMs / 1000 - event.windowStart;

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
    const favBook = favIdx === 0 ? up : down;
    const favAsk = favIdx === 0 ? up.bestAsk : down.bestAsk;
    if (favAsk == null) return opportunities;

    const state = this.stateFor(pairId, nowMs);
    if (state.prevFavIdx !== null && state.prevFavIdx !== favIdx) {
      state.lastFlipTs = nowMs;
    }
    state.prevFavIdx = favIdx;
    state.lastSeenTs = nowMs;

    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    if (elapsedSec < config.flipConfirmMinElapsedSec) {
      return opportunities;
    }
    if (
      config.flipConfirmMaxElapsedSec != null &&
      elapsedSec > config.flipConfirmMaxElapsedSec
    ) {
      return opportunities;
    }

    // Flip frais requis (≤ flipConfirmFlipLookbackMs avant l'entrée).
    if (state.lastFlipTs == null) return opportunities;
    if (nowMs - state.lastFlipTs > config.flipConfirmFlipLookbackMs) {
      return opportunities;
    }
    // Bande du nouveau favori.
    if (
      favAsk < config.flipConfirmBandMin ||
      favAsk > config.flipConfirmBandMax
    ) {
      return opportunities;
    }
    if (favBook.bestBid != null && favAsk - favBook.bestBid > config.flipConfirmMaxSpread) {
      return opportunities;
    }

    const size = computeSize(
      config.flipConfirmOrderUsdc,
      favAsk,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    if (favBook.bestAskSize != null && favBook.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, favBook.outcome, "cheap", round2(favAsk));
    if (tracker.has(tradeKey)) return opportunities;

    opportunities.push({
      kind: "cheap",
      event,
      token: favBook,
      price: round2(favAsk),
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      pairId,
      orderType: "FOK",
    });
    return opportunities;
  }

  private stateFor(pairId: string, nowMs: number): FlipConfirmState {
    for (const [key, st] of this.states) {
      if (nowMs - st.lastSeenTs > 2_700_000) {
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
    return { action: "skip", reason: "flip-confirm-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}