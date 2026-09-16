import type { BotConfig } from "../config.js";
import type { TradeOpportunity } from "../types.js";
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
 * Early-conviction — acheter le favori déjà établi dans les premières secondes.
 *
 * Signal empirique (backtest calibré 2026-09-15, 393 fenêtres BTC 15m) : un
 * marché qui se fixe INSTANTANÉMENT (favori ≥ earlyConvictionAskMin dès les
 * `earlyConvictionMaxElapsedSec` premières secondes) est un trend unilatéral
 * — le favori gagne 67.6 % du temps à un prix moyen 0.615 (t-stat 1.93,
 * +$330, DD $82 le plus bas du panel). La vitesse d'établissement EST
 * l'information. Attention : t-stat sous le seuil conventionnel 2.0.
 *
 * Sans état interne (aucun flip à tracker). Sans hedge, hold to resolution.
 * Le même achat avec un seuil 0.55 s'effondre (−$202, WR 55 %) : l'edge vit
 * dans la zone "vite ET fort", pas "vite".
 */
export class EarlyConvictionStrategy implements TradingStrategy {
  readonly id = "early-conviction" as const;
  readonly label =
    "Early-conviction: FOK buy the favorite when it already prices >= min within the first seconds; hold to resolve (no hedge)";
  readonly leadsWithEdge = false;

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const elapsedSec = nowMs / 1000 - event.windowStart;

    const fav = pickEdgeToken(books); // token au best ask le plus haut
    if (!fav || fav.bestAsk === null) return opportunities;
    const ask = fav.bestAsk;

    if (tracker.getFilledCheapSizeForPair(pairId) > 0) {
      return opportunities;
    }
    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    // La conviction doit être précoce : fenêtre [0, earlyConvictionMaxElapsedSec].
    if (elapsedSec < 0) return opportunities;
    if (elapsedSec > config.earlyConvictionMaxElapsedSec) {
      return opportunities;
    }

    // Bande de conviction : [askMin, askMax].
    if (ask < config.earlyConvictionAskMin || ask > config.earlyConvictionAskMax) {
      return opportunities;
    }
    if (fav.bestBid != null && ask - fav.bestBid > config.earlyConvictionMaxSpread) {
      return opportunities;
    }

    const size = computeSize(
      config.earlyConvictionOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    if (fav.bestAskSize != null && fav.bestAskSize < size) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(event.slug, fav.outcome, "cheap", round2(ask));
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
    return { action: "skip", reason: "early-conviction-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}