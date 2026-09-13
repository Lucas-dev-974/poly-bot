import { log } from "../logger.js";
import type { TradeOpportunity } from "../types.js";
import { computeSize, MIN_CLOB_SHARES, priceLevels } from "../utils/prices.js";
import { appendOpportunity } from "./edge-lead-strategy.js";
import {
  isAskInExpensiveBand,
  pickFavoriteToken,
  pickReverseToken,
  round2,
  shouldDefendUncoveredPair,
} from "./predicates.js";
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
 * Reverse bot — la stratégie documentée dans STRATEGY.md (§2bis).
 *
 * En début de fenêtre 15m, la foule sur-cote la tendance initiale et
 * sous-cote l'underdog. Le moteur « reverse » parie à contre-courant :
 *
 *  - Leg cheap : grille de limit BUY maker sur l'UNDERDOG (min ask), sur
 *    les niveaux [cheapBuyMin, cheapBuyMax] (défaut 7¢-10¢). Remplissage
 *    rare, mais rendement massif (> 10×) si l'underdog se retourne.
 *  - Leg hedge : grille de limit BUY maker sur le FAVORI (l'autre token),
 *    sur les niveaux [expensiveBuyMin, expensiveBuyMax] (défaut 90¢-95¢).
 *    Par défaut après un cheap fillé (`requireCheapFillBeforeExpensive`);
 *    sinon grille indépendante (naked hedge intentionnel).
 *
 * Chaque niveau est un ordre indépendant, dédupliqué via le tracker
 * (`makeKey`: slug:outcome:{cheap|expensive}-price). Ce n'est pas un arb
 * verrouillé : c'est une stratégie d'espérance positive via l'asymétrie.
 *
 * Phase 2 flags (all default off): reverseCancelCheapOffBand,
 * reverseDefendEnabled, reverseMaxGridLevels, reverseHedgeCapToFilledCheap.
 */

function takeGridLevels(levels: number[], max: number | null): number[] {
  if (max == null || max <= 0) return levels;
  return levels.slice(0, max);
}

export class ReverseStrategy implements TradingStrategy {
  readonly id = "reverse" as const;
  readonly label =
    "Reverse: grille maker cheap sur l'underdog (7-10¢) + grille hedge sur le favori (90-95¢) après fill cheap";
  readonly leadsWithEdge = false;
  readonly independentHedgeGrid = true;

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    // Carnet unilatéral (fetch échoué) : on ne peut pas sélectionner un
    // véritable underdog/favori, on s'abstient.
    if (books.filter((book) => book.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const cheapToken = pickReverseToken(books);
    if (!cheapToken || cheapToken.bestAsk === null) return opportunities;

    const expensiveToken = config.enableExpensiveHedge
      ? pickFavoriteToken(
          books,
          cheapToken,
          config.expensiveBuyMin,
          MIN_CLOB_SHARES,
        )
      : null;

    // --- Leg cheap : grille maker sur l'underdog ---
    // Si l'ask est déjà sous cheapBuyMin, un bid 7-10¢ croise tout de suite
    // et prend le token mort (4¢, 1¢…). Arb/barbell ont askAlive ; sans
    // cette garde le GTC live ferait la même chose que le backtest.
    if (cheapToken.bestAsk >= config.cheapBuyMin) {
      const cheapLevels = takeGridLevels(
        priceLevels(config.cheapBuyMin, config.cheapBuyMax),
        config.reverseMaxGridLevels,
      );
      for (const price of cheapLevels) {
        const size = computeSize(
          config.cheapOrderUsdc,
          price,
          config.maxSharesPerOrder,
        );
        if (size === null) continue;
        appendOpportunity(
          tracker,
          opportunities,
          event,
          cheapToken,
          "cheap",
          price,
          size,
          config.maxOpenPositionsPerSide,
        );
      }
    }

    // --- Leg hedge : seulement après un cheap fillé sur la paire ---
    const pairId = `${event.slug}:${event.windowEnd}`;
    const cheapFilled = tracker.getFilledCheapSizeForPair(pairId) > 0;
    const allowExpensive =
      !config.requireCheapFillBeforeExpensive || cheapFilled;
    if (
      config.enableExpensiveHedge &&
      allowExpensive &&
      expensiveToken &&
      expensiveToken.bestAsk !== null &&
      isAskInExpensiveBand(
        expensiveToken.bestAsk,
        config.expensiveBuyMin,
        config.expensiveBuyMax,
      )
    ) {
      const maxPrice = Math.min(
        expensiveToken.bestAsk,
        config.expensiveBuyMax,
      );
      const gridMax = Math.max(maxPrice, config.expensiveBuyMin);
      const expensiveLevels = takeGridLevels(
        priceLevels(config.expensiveBuyMin, gridMax),
        config.reverseMaxGridLevels,
      );

      // Cap only once cheap is actually filled. With requireCheapFill=false and
      // no fill yet, leave uncapped so intentional naked hedges still emit.
      // Subtract filled + resting expensive so the cap holds across ticks
      // (same-price keys are deduped; other levels must still consume budget).
      let remainingCap = Number.POSITIVE_INFINITY;
      if (config.reverseHedgeCapToFilledCheap) {
        const filledCheap = tracker.getFilledCheapSizeForPair(pairId);
        if (filledCheap > 0) {
          const committedExpensive = tracker.getExpensiveSizeForPair(pairId);
          remainingCap = Math.max(0, round2(filledCheap - committedExpensive));
        }
      }

      for (const price of expensiveLevels) {
        // Ne pas enchérir au-dessus de l'ask du favori (une limite qui
        // paierait plus que l'offre n'a aucun sens économique ici).
        if (price > expensiveToken.bestAsk) break;
        let size = computeSize(
          config.expensiveOrderUsdc,
          price,
          config.maxSharesPerOrder,
        );
        if (size === null) continue;
        if (Number.isFinite(remainingCap)) {
          size = round2(Math.min(size, remainingCap));
          if (size < MIN_CLOB_SHARES) continue;
        }
        const before = opportunities.length;
        appendOpportunity(
          tracker,
          opportunities,
          event,
          expensiveToken,
          "expensive",
          price,
          size,
          config.maxOpenPositionsPerSide,
        );
        // appendOpportunity may no-op (dedupe / maxOpen) — only consume cap
        // when a level was actually queued.
        if (
          Number.isFinite(remainingCap) &&
          opportunities.length > before
        ) {
          remainingCap = round2(remainingCap - size);
        }
      }
    }

    if (opportunities.length === 0) {
      // Ne logguer que si AUCUNE grille cheap n'a encore été posée pour cette
      // paire. Une fois les limites GTC déposées (dédupliquées par tracker),
      // le retour vide au repos est normal — pas un problème à signaler.
      const cheapPosted =
        tracker.getPostedOrdersForPair(pairId, "cheap").length > 0;
      if (!cheapPosted) {
        log("Reverse - no opportunity (no affordable size in bands)", {
          market: event.title,
          cheapAsk: cheapToken.bestAsk,
          expensiveAsk: expensiveToken?.bestAsk ?? null,
        });
      }
    }

    return opportunities;
  }

  /**
   * Default keep. With reverseCancelCheapOffBand: cancel resting cheap if
   * the live underdog ask left [cheapBuyMin, cheapBuyMax].
   */
  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    if (!ctx.config.reverseCancelCheapOffBand) return "keep";
    const ask = ctx.cheapBook?.bestAsk;
    if (ask === null || ask === undefined) return "keep";
    if (ask < ctx.config.cheapBuyMin || ask > ctx.config.cheapBuyMax) {
      return "cancel-lock";
    }
    return "keep";
  }

  /** Le GTC hedge reste au carnet (pas de cancel-band reverse). */
  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  /**
   * Default off. With reverseDefendEnabled: same trigger as arb — favorite
   * ask above expensiveBuyMax and uncovered cheap remains.
   */
  shouldDefend(ctx: DefendContext): boolean {
    if (!ctx.config.reverseDefendEnabled) return false;
    return (
      shouldDefendUncoveredPair(ctx.favoriteAsk, ctx.config.expensiveBuyMax) &&
      ctx.filledCheap > ctx.filledExpensive
    );
  }

  defendShares(ctx: DefendContext): number {
    if (!ctx.config.reverseDefendEnabled) return 0;
    return round2(Math.max(0, ctx.filledCheap - ctx.filledExpensive));
  }

  /**
   * Band revalidation for reverse lives in the executor via
   * `shouldPostIndependentHedge` (keeps grid limit prices). This method
   * stays a conservative skip if anything still calls it directly.
   */
  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "reverse-grid-band-checked-in-executor" };
  }

  /** Le reverse ne vend jamais l'edge nu (pas de suivi de tendance). */
  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
