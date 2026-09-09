import type { BotConfig } from "../config.js";
import { log } from "../logger.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { tickSizeFromMarket } from "../utils/market.js";
import { MIN_CLOB_SHARES } from "../utils/prices.js";
import { EdgeConfirmBuffer } from "./edge-confirm.js";
import { round2 } from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";

/**
 * Edge-lead : on achète l'edge (favori) d'abord, puis le cheap en complément.
 *
 * findOpportunities émet :
 *  - (A) l'edge quand rien n'est posté/fillé et que le signal de confirmation
 *        (N ticks consécutifs dans la bande + série croissante) est prêt ;
 *  - (B) le cheap seul quand l'edge est posté ou fillé mais que le cheap est
 *        absent (retry après POST échoué, ou reconfirm après cancel hors bande).
 *
 * Le cheap est posté par le bot juste après le POST edge (postComplementCheap).
 */

/** Token edge = celui au best ask le plus haut (favori). */
function pickEdgeToken(books: TokenBook[]): TokenBook | null {
  const withAsk = books.filter((book) => book.bestAsk !== null);
  if (withAsk.length === 0) return null;
  return withAsk.reduce((highest, book) =>
    (book.bestAsk ?? 0) > (highest.bestAsk ?? 0) ? book : highest,
  );
}

/**
 * Taille 1:1 (shares) pour edge + cheap, contrainte CLOB : le cheap doit
 * passer 5 shares ET 1$ de notionnel. On dimensionne depuis le cheapLimit
 * (le plus cher des deux), puis on applique les deux budgets USDC :
 *  - edgeOrderUsdc     : edgePrice × size ≤ edgeOrderUsdc
 *  - edgeCheapOrderUsdc: cheapLimit × size ≤ edgeCheapOrderUsdc
 * La taille finale = min des deux contraintes.
 */
export function computeEdgeCheapSize(
  config: BotConfig,
  edgePrice: number,
): number | null {
  const cheapLimit = round2(1 - edgePrice - config.edgeCheapMargin);
  if (cheapLimit <= 0) return null;
  // CLOB : >= 5 shares et >= 1$ de notionnel sur le cheap.
  let size = Math.max(MIN_CLOB_SHARES, Math.ceil(1 / cheapLimit));
  if (size > config.maxSharesPerOrder) return null;
  // Budget edge : edgePrice × size ≤ edgeOrderUsdc.
  const maxByEdge = Math.floor(config.edgeOrderUsdc / edgePrice);
  // Budget cheap : cheapLimit × size ≤ edgeCheapOrderUsdc.
  const maxByCheap = Math.floor(config.edgeCheapOrderUsdc / cheapLimit);
  size = Math.min(size, maxByEdge, maxByCheap);
  if (size < MIN_CLOB_SHARES) return null;
  return size;
}

function appendOpportunity(
  tracker: TradeTracker,
  opportunities: TradeOpportunity[],
  event: UpDownEvent,
  token: TokenBook,
  kind: "cheap" | "expensive",
  price: number,
  size: number,
  maxOpenPerSide: number,
): void {
  const pairId = `${event.slug}:${event.windowEnd}`;
  // Anti 2e jambe : open + resting + legs DB déjà présents.
  if (
    tracker.countOpenPositionsForSide(event.slug, token.outcome) +
      tracker.countPendingOrdersForSide(event.slug, token.outcome) >=
    maxOpenPerSide
  ) {
    return;
  }
  if (tracker.countLegsByKind(pairId, kind) >= maxOpenPerSide) {
    return;
  }
  const tradeKey = tracker.makeKey(event.slug, token.outcome, kind, price);
  if (tracker.has(tradeKey)) return;

  opportunities.push({
    kind,
    event,
    token,
    price,
    size,
    tickSize: tickSizeFromMarket(event.market),
    negRisk: event.market.negRisk,
    tradeKey,
    pairId,
  });
}

/** Prix d'entrée de l'edge déjà posté/fillé pour une paire. */
function edgeEntryPrice(tracker: TradeTracker, pairId: string): number | null {
  const posted = tracker.getPostedOrdersForPair(pairId, "expensive");
  if (posted.length > 0) return posted[0].limitPrice;
  for (const position of tracker.getOpenPositions()) {
    if (position.pairId === pairId && position.kind === "expensive") {
      return position.fillPrice;
    }
  }
  return null;
}

/**
 * Outcome du token edge claimé (posté ou fillé) pour une paire. Sticky :
 * après POST/fill on ne reflip pas — on lit la bande sur ce token, pas sur
 * « le plus cher live ».
 */
export function edgeClaimedOutcome(tracker: TradeTracker, pairId: string): string | null {
  const posted = tracker.getPostedOrdersForPair(pairId, "expensive");
  if (posted.length > 0) return posted[0].outcome;
  for (const position of tracker.getOpenPositions()) {
    if (position.pairId === pairId && position.kind === "expensive") {
      return position.outcome;
    }
  }
  return null;
}

export class EdgeLeadStrategy implements TradingStrategy {
  readonly id = "edge-lead" as const;
  readonly label =
    "Edge-lead: confirmer N ticks que l'ask favori monte dans une bande, acheter l'edge GTC, puis cheap limit 1:1";
  readonly leadsWithEdge = true;
  private readonly buffer = new EdgeConfirmBuffer();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];
    const pairId = `${event.slug}:${event.windowEnd}`;

    // Book one-sided : pas de claim, reset buffer.
    if (books.filter((book) => book.bestAsk !== null).length < 2) {
      this.buffer.reset(pairId);
      return opportunities;
    }

    const edgeToken = pickEdgeToken(books);
    if (!edgeToken || edgeToken.bestAsk === null) {
      this.buffer.reset(pairId);
      return opportunities;
    }
    const cheapToken =
      books.find((book) => book.tokenId !== edgeToken.tokenId) ?? null;
    if (!cheapToken) return opportunities;

    const edgePosted =
      tracker.getPostedOrdersForPair(pairId, "expensive").length > 0;
    const edgeFilled = tracker.getFilledExpensiveSizeForPair(pairId) > 0;
    const cheapPosted =
      tracker.getPostedOrdersForPair(pairId, "cheap").length > 0;
    const cheapFilled = tracker.getFilledCheapSizeForPair(pairId) > 0;

    // --- Phase resting : edge posté ou fillé → cheap-only resume ---
    if (edgePosted || edgeFilled) {
      if (cheapPosted || cheapFilled) {
        return opportunities;
      }
      const edgePrice = edgeEntryPrice(tracker, pairId);
      if (edgePrice === null) return opportunities;
      // Sticky : le cheap complémentaire est l'autre token de l'edge claimé,
      // pas « le plus cher live » (sinon un flip posterait sur le mauvais côté).
      const claimedOutcome = edgeClaimedOutcome(tracker, pairId);
      const claimedEdgeBook = claimedOutcome
        ? books.find((book) => book.outcome === claimedOutcome) ?? null
        : null;
      const cheapBook =
        claimedEdgeBook
          ? books.find((book) => book.tokenId !== claimedEdgeBook.tokenId) ??
            null
          : cheapToken;
      if (!cheapBook) return opportunities;
      const cheapLimit = round2(1 - edgePrice - config.edgeCheapMargin);
      if (cheapLimit <= 0) return opportunities;
      const size = computeEdgeCheapSize(config, edgePrice);
      if (size === null) {
        log("Edge-lead cheap skipped - below CLOB minimums", {
          market: event.title,
          edgePrice,
          cheapLimit,
        });
        return opportunities;
      }
      // Edge resting (pas fillé) : retry cheap immédiat, sans reconfirm.
      // Edge fillé (favori nu) : le cheap a été annulé hors bande → on
      // re-confirme N ticks avant de re-poster le cheap.
      // Dans les deux cas, si l'edge est hors bande, on ne re-poste pas le
      // cheap (le buffer est reset ; il faudra re-confirmer quand l'edge
      // revient in-bande). Sinon manageRestingEdgeLead annulerait le cheap
      // et findOpportunities le re-posterait au même tick → boucle post/cancel.
      const claimedAsk = claimedEdgeBook?.bestAsk ?? null;
      const inBand =
        claimedAsk !== null &&
        claimedAsk >= config.edgeBandMin &&
        claimedAsk <= config.edgeBandMax;
      if (!inBand) {
        this.buffer.reset(pairId);
        return opportunities;
      }
      if (edgeFilled) {
        const ready = this.buffer.push(
          pairId,
          claimedAsk,
          claimedOutcome ?? edgeToken.outcome,
          config,
        );
        if (!ready) return opportunities;
      }
      appendOpportunity(
        tracker,
        opportunities,
        event,
        cheapBook,
        "cheap",
        cheapLimit,
        size,
        config.maxOpenPositionsPerSide,
      );
      return opportunities;
    }

    // --- Phase confirmation : rien de posté/fillé ---
    const inBand =
      edgeToken.bestAsk >= config.edgeBandMin &&
      edgeToken.bestAsk <= config.edgeBandMax;
    if (!inBand) {
      this.buffer.reset(pairId);
      return opportunities;
    }
    const ready = this.buffer.push(
      pairId,
      edgeToken.bestAsk,
      edgeToken.outcome,
      config,
    );
    if (!ready) return opportunities;

    const size = computeEdgeCheapSize(config, edgeToken.bestAsk);
    if (size === null) {
      log("Edge-lead edge skipped - below CLOB minimums", {
        market: event.title,
        edgeAsk: edgeToken.bestAsk,
        edgeOrderUsdc: config.edgeOrderUsdc,
      });
      return opportunities;
    }
    appendOpportunity(
      tracker,
      opportunities,
      event,
      edgeToken,
      "expensive",
      edgeToken.bestAsk,
      size,
      config.maxOpenPositionsPerSide,
    );
    return opportunities;
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    // Gestion resting edge+cheap via un chemin bot dédié (manageRestingEdgeLead).
    return "keep";
  }

  shouldDefend(_ctx: DefendContext): boolean {
    return false;
  }

  defendShares(_ctx: DefendContext): number {
    return 0;
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "edge-lead-managed-in-bot" };
  }
}
