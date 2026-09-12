import { log } from "../logger.js";
import type { TradeOpportunity } from "../types.js";
import { computeSize, MIN_CLOB_SHARES, priceLevels } from "../utils/prices.js";
import { appendOpportunity } from "./edge-lead-strategy.js";
import { pickFavoriteToken, pickReverseToken } from "./predicates.js";
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
 * Reverse bot — la stratégie documentée dans STRATEGY.md (§2-§4).
 *
 * En début de fenêtre 15m, la foule sur-cote la tendance initiale et
 * sous-cote l'underdog. Le moteur « reverse » parie à contre-courant :
 *
 *  - Leg cheap : grille de limit BUY maker sur l'UNDERDOG (min ask), sur
 *    les niveaux [cheapBuyMin, cheapBuyMax] (défaut 7¢-10¢). Remplissage
 *    rare, mais rendement massif (> 10×) si l'underdog se retourne.
 *  - Leg hedge : grille de limit BUY maker sur le FAVORI (l'autre token),
 *    sur les niveaux [expensiveBuyMin, expensiveBuyMax] (défaut 90¢-95¢).
 *    Émise seulement après qu'au moins un cheap de la paire a été fillé.
 *
 * Chaque niveau est un ordre indépendant, dédupliqué via le tracker
 * (`makeKey`: slug:outcome:{cheap|expensive}-price). Ce n'est pas un arb
 * verrouillé : c'est une stratégie d'espérance positive via l'asymétrie.
 */
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
      for (const price of priceLevels(
        config.cheapBuyMin,
        config.cheapBuyMax,
      )) {
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
      expensiveToken.bestAsk !== null
    ) {
      const maxPrice = Math.min(
        expensiveToken.bestAsk,
        config.expensiveBuyMax,
      );
      const gridMax = Math.max(maxPrice, config.expensiveBuyMin);
      for (const price of priceLevels(
        config.expensiveBuyMin,
        gridMax,
      )) {
        // Ne pas enchérir au-dessus de l'ask du favori (une limite qui
        // paierait plus que l'offre n'a aucun sens économique ici).
        if (price > expensiveToken.bestAsk) break;
        const size = computeSize(
          config.expensiveOrderUsdc,
          price,
          config.maxSharesPerOrder,
        );
        if (size === null) continue;
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

  /** Une grille maker GTC reste au carnet : on ne le prend ni l'annule. */
  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  /** Le GTC hedge reste au carnet (pas de cancel-band reverse). */
  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  /** Le reverse n'est pas un arb verrouillé : pas de défense FOK du cheap. */
  shouldDefend(_ctx: DefendContext): boolean {
    return false;
  }

  defendShares(_ctx: DefendContext): number {
    return 0;
  }

  /**
   * Inutilisé : l'exécuteur / runner n'appellent pas hedgeAtPostTime
   * quand `independentHedgeGrid` est true (la grille est déjà pricée
   * dans findOpportunities). Skip conservé comme filet si un appel survit.
   */
  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "reverse-grid-managed-in-find" };
  }

  /** Le reverse ne vend jamais l'edge nu (pas de suivi de tendance). */
  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
