import type { BotConfig } from "../config.js";
import { log } from "../logger.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { tickSizeFromMarket } from "../utils/market.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { EdgeConfirmBuffer } from "./edge-confirm.js";
import { round2 } from "./predicates.js";
import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  EdgeSellContext,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "./trading-strategy.js";

/**
 * Edge-lead : on achète l'edge (favori) d'abord, on attend le fill, puis le cheap.
 *
 * findOpportunities émet :
 *  - (A) l'edge quand rien n'est posté/fillé et que le signal de confirmation
 *        (N ticks consécutifs dans la bande + série croissante) est prêt ;
 *  - (B) le cheap seul quand l'edge est **fillé** (pas seulement posté) et que
 *        le cheap est absent. Taille cheap = budget cheap / ask, indépendante
 *        de la size edge.
 *
 * Le cheap n'est jamais posté tant que l'edge GTC n'a pas fillé.
 * Après fill, poster si l'ask cheap est dans
 * [edgeCheapBandMin, edgeCheapBandMax]. Un GTC cheap resting hors bande
 * est annulé (unmark) ; il est re-posté au tick où l'ask rentre.
 */

/** Token edge = celui au best ask le plus haut (favori). */
export function pickEdgeToken(books: TokenBook[]): TokenBook | null {
  const withAsk = books.filter((book) => book.bestAsk !== null);
  if (withAsk.length === 0) return null;
  return withAsk.reduce((highest, book) =>
    (book.bestAsk ?? 0) > (highest.bestAsk ?? 0) ? book : highest,
  );
}

/** Ask cheap dans la bande d'entrée configurable. */
export function cheapAskInBand(ask: number, config: BotConfig): boolean {
  return ask >= config.edgeCheapBandMin && ask <= config.edgeCheapBandMax;
}

/** Ask edge hors [edgeBandMin, edgeBandMax] → cancel le GTC favori. */
export function configEdgeOrderAction(
  ask: number | null | undefined,
  config: BotConfig,
): EdgeOrderAction {
  if (ask == null) return "keep";
  return ask < config.edgeBandMin || ask > config.edgeBandMax
    ? "cancel-lock"
    : "keep";
}

/**
 * Size edge selon le mode de sizing.
 * - "shares" : nombre fixe edgeSharesEdge (garde >= MIN_CLOB_SHARES).
 * - "pusd"   : budget edgeOrderUsdc / prix, plafonné par maxShareEdge.
 * - "dynamic": comportement actuel (budget USDC + confirmation).
 * En mode shares/pusd, la confirmation et les bandes restent appliquées ;
 * seul le calcul de taille change.
 */
export function computeEdgeLeadEdgeSize(
  config: BotConfig,
  edgePrice: number,
): number | null {
  const mode = config.edgeSizingMode ?? "dynamic";
  if (mode === "shares") {
    return config.edgeSharesEdge >= MIN_CLOB_SHARES ? config.edgeSharesEdge : null;
  }
  return computeSize(
    config.edgeOrderUsdc,
    edgePrice,
    config.maxShareEdge ?? config.maxSharesPerOrder,
  );
}

/**
 * Size cheap selon le mode de sizing.
 * - "shares" : nombre fixe edgeSharesCheap (garde >= MIN_CLOB_SHARES).
 * - "pusd"   : budget edgeCheapOrderUsdc / ask, plafonné par maxSharesPerOrder.
 * - "dynamic": comportement actuel (budget USDC + confirmation).
 */
export function computeEdgeLeadCheapSize(
  config: BotConfig,
  cheapPrice: number,
): number | null {
  const mode = config.edgeSizingMode ?? "dynamic";
  if (mode === "shares") {
    return config.edgeSharesCheap >= MIN_CLOB_SHARES ? config.edgeSharesCheap : null;
  }
  return computeSize(
    config.edgeCheapOrderUsdc,
    cheapPrice,
    config.maxSharesPerOrder,
  );
}

export function appendOpportunity(
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
  // Same-tick queue: reverse (and graph loops) emit a whole grid before any
  // order is posted. Open/pending counters are still 0, so we also count
  // opportunities already pushed this call — otherwise maxOpenPerSide is a no-op.
  const pendingSameSide = opportunities.filter(
    (o) => o.event.slug === event.slug && o.token.outcome === token.outcome,
  ).length;
  const pendingSameKind = opportunities.filter(
    (o) => o.pairId === pairId && o.kind === kind,
  ).length;
  if (
    tracker.countOpenPositionsForSide(event.slug, token.outcome) +
      tracker.countPendingOrdersForSide(event.slug, token.outcome) +
      pendingSameSide >=
    maxOpenPerSide
  ) {
    return;
  }
  if (tracker.countLegsByKind(pairId, kind) + pendingSameKind >= maxOpenPerSide) {
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

/**
 * Outcome du token edge claimé (posté ou fillé) pour une paire. Sticky :
 * après POST/fill on ne reflip pas — le cheap est l'autre token, pas
 * « le moins cher live ».
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
    "Edge-lead: confirmer N ticks, GTC edge au budget edge, cheap au budget cheap seulement après fill edge";
  readonly leadsWithEdge = true;
  private readonly buffer = new EdgeConfirmBuffer();
  /** Début (ms) de la perte continue de l'edge par paire, pour la vente. */
  private readonly lossStart = new Map<string, number>();

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];
    const pairId = `${event.slug}:${event.windowEnd}`;

    const edgePosted =
      tracker.getPostedOrdersForPair(pairId, "expensive").length > 0;
    const edgeFilled = tracker.getFilledExpensiveSizeForPair(pairId) > 0;
    const cheapPosted =
      tracker.getPostedOrdersForPair(pairId, "cheap").length > 0;
    const cheapFilled = tracker.getFilledCheapSizeForPair(pairId) > 0;

    // Edge resting, pas encore fillé : attendre le fill, ne pas poster le cheap.
    if (edgePosted && !edgeFilled) {
      return opportunities;
    }

    // --- Phase cheap : uniquement après fill edge ---
    // Seule condition : l'ask cheap est dans sa bande. La bande edge et le
    // buffer de confirmation ne servent qu'à l'entrée edge ; une fois fillé,
    // un favori qui monte (cheap qui baisse) ne doit pas bloquer le cheap.
    if (edgeFilled) {
      if (cheapPosted || cheapFilled) {
        return opportunities;
      }

      const claimedOutcome = edgeClaimedOutcome(tracker, pairId);
      if (!claimedOutcome) return opportunities;
      const cheapBook =
        books.find((book) => book.outcome !== claimedOutcome) ?? null;
      if (!cheapBook) return opportunities;

      const cheapAsk = cheapBook.bestAsk;
      if (cheapAsk === null) return opportunities;
      const cheapPrice = round2(cheapAsk);
      if (!cheapAskInBand(cheapPrice, config)) {
        return opportunities;
      }
      const size = computeEdgeLeadCheapSize(config, cheapPrice);
      if (size === null) {
        log("Edge-lead cheap skipped - budget below CLOB minimums", {
          market: event.title,
          cheapPrice,
          edgeCheapOrderUsdc: config.edgeCheapOrderUsdc,
        });
        return opportunities;
      }

      appendOpportunity(
        tracker,
        opportunities,
        event,
        cheapBook,
        "cheap",
        cheapPrice,
        size,
        config.maxOpenPositionsPerSide,
      );
      return opportunities;
    }

    // --- Phase confirmation : rien de posté/fillé ---
    if (books.filter((book) => book.bestAsk !== null).length < 2) {
      this.buffer.reset(pairId);
      return opportunities;
    }
    const edgeToken = pickEdgeToken(books);
    if (!edgeToken || edgeToken.bestAsk === null) {
      this.buffer.reset(pairId);
      return opportunities;
    }
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

    const cheapForGate =
      books.find((book) => book.outcome !== edgeToken.outcome) ?? null;
    const cheapAskForGate = cheapForGate?.bestAsk ?? null;
    if (config.edgeRequireCheapReady) {
      if (cheapAskForGate === null) return opportunities;
      if (!cheapAskInBand(round2(cheapAskForGate), config)) {
        return opportunities;
      }
    }
    if (config.edgeAskSumMax !== null && cheapAskForGate !== null) {
      const askSum = round2(edgeToken.bestAsk + cheapAskForGate);
      if (askSum > config.edgeAskSumMax) return opportunities;
    }

    const size = computeEdgeLeadEdgeSize(config, edgeToken.bestAsk);
    if (size === null) {
      log("Edge-lead edge skipped - budget below CLOB minimums", {
        market: event.title,
        edgeAsk: edgeToken.bestAsk,
        edgeOrderUsdc: config.edgeOrderUsdc,
        maxShareEdge: config.maxShareEdge,
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

  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    const ask = ctx.cheapBook?.bestAsk;
    if (ask === null || ask === undefined) return "keep";
    return cheapAskInBand(round2(ask), ctx.config) ? "keep" : "cancel-lock";
  }

  edgeOrderAction(ctx: RestingEdgeContext): EdgeOrderAction {
    return configEdgeOrderAction(ctx.edgeBook?.bestAsk, ctx.config);
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

  /**
   * Vendre l'edge (favori nu) quand :
   *  - la vente est activée (edgeSellExpensiveEnabled) ;
   *  - aucun cheap n'est fillé (cheapFilled === 0) ;
   *  - le marché a au moins edgeSellExpensiveAfterMin minutes ;
   *  - le best bid est en perte >= edgeSellExpensiveLossPct % sous le fill
   *    price, de façon continue pendant edgeSellExpensiveLossWindowMs.
   * La perte est mesurée en % du fill price : lossPct = (bid - fill)/fill*100.
   * Une perte < seuil (ou un bid manquant) reset le timer de perte continue.
   */
  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean {
    const { config, pairId } = ctx;
    if (!config.edgeSellExpensiveEnabled) {
      this.lossStart.delete(pairId);
      return false;
    }
    if (ctx.cheapFilled > 0) {
      this.lossStart.delete(pairId);
      return false;
    }
    const afterMs = config.edgeSellExpensiveAfterMin * 60_000;
    if (ctx.marketAgeMs < afterMs) {
      this.lossStart.delete(pairId);
      return false;
    }
    if (ctx.expensiveBid === null || ctx.expensiveFillPrice <= 0) {
      this.lossStart.delete(pairId);
      return false;
    }

    const lossPct =
      ((ctx.expensiveBid - ctx.expensiveFillPrice) / ctx.expensiveFillPrice) *
      100;
    // Pas en perte au-delà du seuil → reset du timer de perte continue.
    if (lossPct > -config.edgeSellExpensiveLossPct) {
      this.lossStart.delete(pairId);
      return false;
    }

    const now = ctx.nowMs ?? Date.now();
    const start = this.lossStart.get(pairId) ?? now;
    this.lossStart.set(pairId, start);
    return now - start >= config.edgeSellExpensiveLossWindowMs;
  }
}
