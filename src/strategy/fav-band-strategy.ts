import type { TradeOpportunity } from "../types.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import { appendOpportunity, pickEdgeToken } from "./edge-lead-strategy.js";
import { round2 } from "./predicates.js";
import {
  computeWhipsawScore,
  favBandLossStreak,
  priorWinnerFlipRate,
} from "./whipsaw.js";
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

type WindowBookStats = {
  slug: string;
  windowStart: number;
  lastFavIdx: number | null;
  flips: number;
  askMin: number;
  askMax: number;
  samples: number;
};

/** Nominal BTC/ETH updown window length used to convert "pause windows" to ms. */
const WHIPSAW_PAUSE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Fav-band — directional FOK buy of the favorite in a calibrated ask band
 * after min elapsed; hold to resolve. Optional inverse GTC + optional whipsaw
 * filter (pause after losses / max flips / max score).
 */
export class FavBandStrategy implements TradingStrategy {
  readonly id = "fav-band" as const;
  readonly label =
    "Fav-band: FOK buy favorite when ask in calibrated mid-band after min elapsed; hold to resolve (optional resting inverse GTC)";
  readonly leadsWithEdge = false;

  private bookStats: WindowBookStats | null = null;
  private recentWinners: number[] = [];
  private lastResolvedSeen = 0;
  /** Wall-clock pause end (avoids multi-market / band-gate pause bugs). */
  private pauseUntilMs = 0;
  private prevLossStreak = 0;

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];
    const nowMs = ctx.nowMs ?? Date.now();

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const fav = pickEdgeToken(books);
    if (!fav || fav.bestAsk === null) return opportunities;

    const pairId = `${event.slug}:${event.windowEnd}`;
    const favFilled = tracker.getFilledCheapSizeForPair(pairId);

    if (favFilled > 0) {
      if (tracker.getPostedOrdersForPair(pairId, "cheap").length === 0) {
        this.appendInverse(ctx, opportunities, fav, pairId, favFilled);
      }
      return opportunities;
    }

    // Whipsaw book/resolution sync runs even outside the ask band so pause
    // and flip stats stay coherent across polls and markets.
    this.syncResolvedWinners(tracker.getResolvedPositions());
    const stats = this.updateBookStats(event.slug, event.windowStart, fav);

    if (config.favBandWhipsawEnabled) {
      const lossStreak = favBandLossStreak(tracker.getResolvedPositions());
      this.maybeTriggerPause(config, lossStreak, nowMs);
    }

    const ask = fav.bestAsk;
    if (ask < config.favBandAskMin || ask > config.favBandAskMax) {
      return opportunities;
    }

    const elapsedSec = nowMs / 1000 - event.windowStart;
    if (elapsedSec < config.favBandMinElapsedSec) {
      return opportunities;
    }
    if (
      config.favBandMaxElapsedSec != null &&
      elapsedSec > config.favBandMaxElapsedSec
    ) {
      return opportunities;
    }

    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      return opportunities;
    }

    if (config.favBandWhipsawEnabled) {
      if (nowMs < this.pauseUntilMs) {
        return opportunities;
      }

      const lossStreak = favBandLossStreak(tracker.getResolvedPositions());
      const askRange =
        stats.samples > 0 ? stats.askMax - stats.askMin : null;
      const score = computeWhipsawScore({
        intraFlips: stats.flips,
        askRange,
        priorWinnerFlipRate: priorWinnerFlipRate(this.recentWinners),
        lossStreak,
      });

      if (
        config.favBandWhipsawMaxIntraFlips != null &&
        stats.flips >= config.favBandWhipsawMaxIntraFlips
      ) {
        return opportunities;
      }
      if (
        config.favBandWhipsawMaxScore != null &&
        score >= config.favBandWhipsawMaxScore
      ) {
        return opportunities;
      }
    }

    const size = computeSize(
      config.favBandOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    if (fav.bestAskSize != null && fav.bestAskSize < size * 0.8) {
      return opportunities;
    }

    const before = opportunities.length;
    appendOpportunity(
      tracker,
      opportunities,
      event,
      fav,
      "cheap",
      round2(ask),
      size,
      config.maxOpenPositionsPerSide,
    );
    for (let i = before; i < opportunities.length; i++) {
      opportunities[i] = { ...opportunities[i], orderType: "FOK" };
    }
    return opportunities;
  }

  private updateBookStats(
    slug: string,
    windowStart: number,
    fav: NonNullable<ReturnType<typeof pickEdgeToken>>,
  ): WindowBookStats {
    const favIdx = fav.outcomeIndex;
    const ask = fav.bestAsk as number;
    if (
      !this.bookStats ||
      this.bookStats.slug !== slug ||
      this.bookStats.windowStart !== windowStart
    ) {
      this.bookStats = {
        slug,
        windowStart,
        lastFavIdx: favIdx,
        flips: 0,
        askMin: ask,
        askMax: ask,
        samples: 1,
      };
      return this.bookStats;
    }
    const s = this.bookStats;
    if (s.lastFavIdx != null && s.lastFavIdx !== favIdx) {
      s.flips += 1;
    }
    s.lastFavIdx = favIdx;
    s.askMin = Math.min(s.askMin, ask);
    s.askMax = Math.max(s.askMax, ask);
    s.samples += 1;
    return s;
  }

  private syncResolvedWinners(
    resolved: ReturnType<StrategyContext["tracker"]["getResolvedPositions"]>,
  ): void {
    const fav = resolved
      .filter((p) => p.strategyId === "fav-band")
      .filter((p) => p.resolvedAt != null)
      .slice()
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0));
    for (const p of fav) {
      const ts = p.resolvedAt ?? 0;
      if (ts <= this.lastResolvedSeen) continue;
      this.lastResolvedSeen = ts;
      const winner =
        p.status === "lost"
          ? p.outcomeIndex === 0
            ? 1
            : 0
          : p.outcomeIndex;
      this.recentWinners.push(winner);
      if (this.recentWinners.length > 6) this.recentWinners.shift();
    }
  }

  private maybeTriggerPause(
    config: StrategyContext["config"],
    lossStreak: number,
    nowMs: number,
  ): void {
    const after = config.favBandWhipsawPauseAfterLosses;
    if (after == null) {
      this.prevLossStreak = lossStreak;
      return;
    }
    // Already in an active pause: do not re-arm on the same streak plateau.
    if (nowMs < this.pauseUntilMs) {
      this.prevLossStreak = lossStreak;
      return;
    }
    if (lossStreak >= after && lossStreak > this.prevLossStreak) {
      const windows = Math.max(1, config.favBandWhipsawPauseWindows);
      this.pauseUntilMs = nowMs + windows * WHIPSAW_PAUSE_WINDOW_MS;
    }
    this.prevLossStreak = lossStreak;
  }

  private appendInverse(
    ctx: StrategyContext,
    opportunities: TradeOpportunity[],
    fav: NonNullable<ReturnType<typeof pickEdgeToken>>,
    pairId: string,
    favFilled: number,
  ): void {
    const { config, tracker, event, books } = ctx;
    if (!config.favBandInverseEnabled) return;

    const inverse = books.find(
      (book) => book.tokenId !== fav.tokenId && book.bestAsk !== null,
    );
    if (!inverse || inverse.bestAsk === null) return;

    const budgetCapSize = computeSize(
      config.favBandInverseOrderUsdc,
      config.favBandInverseAskMax,
      config.maxSharesPerOrder,
    );
    if (budgetCapSize === null) return;
    const size = round2(
      Math.min(favFilled * config.favBandInverseShareRatio, budgetCapSize),
    );
    if (size < MIN_CLOB_SHARES) return;

    appendOpportunity(
      tracker,
      opportunities,
      event,
      inverse,
      "cheap",
      round2(config.favBandInverseAskMax),
      size,
      config.maxOpenPositionsPerSide,
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
    return { action: "skip", reason: "fav-band-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}