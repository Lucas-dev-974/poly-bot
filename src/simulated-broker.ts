import type { BotConfig } from "./config.js";
import type { SimulatedLedger } from "./simulated-ledger.js";
import type { SimulatedPosition, TradeOpportunity } from "./types.js";
import { SeededRng } from "./utils/random.js";

export interface FillResult {
  filled: boolean;
  position?: SimulatedPosition;
  reason:
    | "marketable"
    | "probabilistic"
    | "no-fill"
    | "insufficient-capital"
    | "exposure-cap"
    | "no-ask"
    | "not-a-favorite"
    | "insufficient-depth";
}

export class SimulatedBroker {
  private rng: SeededRng;

  constructor(
    private readonly config: BotConfig,
    private readonly ledger: SimulatedLedger,
  ) {
    this.rng = new SeededRng(
      config.simRandomSeed ? `${config.simRandomSeed}:broker` : undefined,
    );
  }

  reseed(seed?: string): void {
    this.rng = new SeededRng(seed ? `${seed}:broker` : undefined);
  }

  attemptFill(
    opportunity: TradeOpportunity,
    currentOpenExposure: number,
  ): FillResult {
    const bestAsk = opportunity.token.bestAsk;
    let size = opportunity.size;
    const limitPrice = opportunity.price;

    if (bestAsk === null) {
      return { filled: false, reason: "no-ask" };
    }

    // Guard: an "expensive" hedge must be a real favorite. If the best ask is
    // well below the expensive buy range, the market is pricing this token as
    // a likely loser — filling it as a "hedge" creates a directional bet, not
    // an arb. aligned with the strategy's expensiveBuyMin.
    // Edge-lead : le seuil est la bande edge (edgeBandMin), pas expensiveBuyMin.
    const favoriteMin =
      this.config.strategyId === "edge-lead"
        ? this.config.edgeBandMin
        : this.config.expensiveBuyMin;
    if (opportunity.kind === "expensive" && bestAsk < favoriteMin) {
      return { filled: false, reason: "not-a-favorite" };
    }

    // Depth guard: only fill up to the size available at the best ask. If the
    // book has less liquidity than requested, fill partially (or reject if
    // there is no depth at all). This prevents the sim from filling a size
    // that could never be filled on the real CLOB.
    const bestAskSize = opportunity.token.bestAskSize;
    if (bestAskSize !== null) {
      if (bestAskSize <= 0) {
        return { filled: false, reason: "insufficient-depth" };
      }
      if (size > bestAskSize) {
        size = bestAskSize;
      }
    }

    const isMarketable = limitPrice >= bestAsk;
    const estimatedFillPrice = isMarketable ? bestAsk : limitPrice;
    const estimatedCost = round2(estimatedFillPrice * size);

    if (
      currentOpenExposure + estimatedCost >
      this.config.maxExposureUsdc
    ) {
      return { filled: false, reason: "exposure-cap" };
    }

    if (!this.ledger.canAfford(estimatedCost)) {
      return { filled: false, reason: "insufficient-capital" };
    }

    let fillPrice: number;
    let reason: "marketable" | "probabilistic";

    if (isMarketable) {
      fillPrice = bestAsk;
      reason = "marketable";
    } else {
      const p = this.nonMarketableProbability(opportunity);
      if (!this.rng.chance(p)) {
        return { filled: false, reason: "no-fill" };
      }
      fillPrice = limitPrice;
      reason = "probabilistic";
    }

    const cost = round2(fillPrice * size);
    this.ledger.debit(cost);

    const position: SimulatedPosition = {
      id: `${opportunity.tradeKey}:${Date.now()}`,
      eventSlug: opportunity.event.slug,
      eventTitle: opportunity.event.title,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      outcomeIndex: opportunity.token.outcomeIndex,
      kind: opportunity.kind,
      limitPrice,
      fillPrice,
      size,
      cost,
      windowEnd: opportunity.event.windowEnd,
      status: "open",
      fillReason: reason,
      pairId: opportunity.pairId,
      bestAskAtFill: bestAsk,
      orderType: "SIM",
      strategyId: this.config.strategyId,
    };

    return { filled: true, position, reason };
  }

  private nonMarketableProbability(opportunity: TradeOpportunity): number {
    const bestAsk = opportunity.token.bestAsk ?? 0;
    const limitPrice = opportunity.price;
    const base = this.config.simFillProbabilityNonMarketable;

    const proximity = bestAsk > 0 ? 1 - (bestAsk - limitPrice) / bestAsk : 0;
    const minutesLeft = Math.max(0, (opportunity.event.windowEnd - Date.now() / 1000) / 60);
    const timeFactor = Math.min(1, minutesLeft / 15);

    return clamp01(base * clamp01(proximity) * clamp01(timeFactor));
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}