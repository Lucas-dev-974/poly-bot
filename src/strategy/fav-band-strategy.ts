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

/**
 * Deterioration-exit chain for one filled pair (lower-peaks detector).
 * Anchored at the entry fill: `lastPeak` is the last significant peak, and
 * every time the price falls >= MinLowerHighDrop below the running max
 * (`curPeak`), that peak has failed — one event, `lowerPeaks`++. A failed
 * bounce that stays below `lastPeak` keeps the count (a lower peak forms and
 * can fail in turn); a full recovery to/above `lastPeak` resets the sequence.
 * Idempotent per sample: repeating the same ask never resets the chain, so
 * the runner's shouldDefend → defendShares double call is harmless.
 */
type ExitPairState = {
  heldTokenId: string | null;
  entryPrice: number | null;
  windowStartSec: number | null;
  /** Last significant peak (a level whose failure counted one event). */
  lastPeak: number | null;
  /** Running max since the last event (bounces below lastPeak raise it). */
  curPeak: number | null;
  lowerPeaks: number;
  lastEventTs: number | null;
  lastSeenTs: number;
  /** One-shot: set once the exit SELL has committed — no second exit. */
  exited: boolean;
  /** Arms the opposite-token FOK follow-up after the exit SELL. */
  switchPending: boolean;
};

/** Nominal BTC/ETH updown window length used to convert "pause windows" to ms. */
const WHIPSAW_PAUSE_WINDOW_MS = 15 * 60 * 1000;

/** Exit-chain states idle longer than this are purged (pairs never return). */
const EXIT_STATE_STALE_MS = 30 * 60 * 1000;

/**
 * Fav-band — directional FOK buy of the favorite in a calibrated ask band
 * after min elapsed; hold to resolve. Optional inverse GTC + optional whipsaw
 * filter (pause after losses / max flips / max score). Optional deterioration
 * exit: when the HELD favorite's price keeps printing lower and lower peaks
 * (successive levels each >= MinLowerHighDrop below the previous reference,
 * `Consecutive` times in a row within LookbackMs), SELL the whole position
 * (FOK at the bid, defend pipeline) instead of riding to resolution — and
 * optionally FOK-buy the OPPOSITE token right after (switch sides).
 */
export class FavBandStrategy implements TradingStrategy {
  readonly id = "fav-band" as const;
  readonly label =
    "Fav-band: FOK buy favorite when ask in calibrated mid-band after min elapsed; hold to resolve (optional resting inverse GTC, optional deterioration exit + inverse switch)";
  readonly leadsWithEdge = false;
  /** Deterioration exit reuses the defend pipeline (dip-revert TP precedent). */
  readonly usesDefendAsExit = true;

  private bookStats: WindowBookStats | null = null;
  private recentWinners: number[] = [];
  private lastResolvedSeen = 0;
  /** Wall-clock pause end (avoids multi-market / band-gate pause bugs). */
  private pauseUntilMs = 0;
  private prevLossStreak = 0;
  /** Per-pair deterioration-exit chain state. */
  private readonly exitStates = new Map<string, ExitPairState>();

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

    // Post-exit follow-up: after the exit SELL the cheap leg is CLOSED
    // (favFilled back to 0 and the entry gates would block), so the
    // opposite-token switch must run BEFORE any entry/filled branch.
    this.maybeEmitSwitchOpposite(ctx, opportunities, pairId, nowMs);

    if (favFilled > 0) {
      if (tracker.getPostedOrdersForPair(pairId, "cheap").length === 0) {
        this.appendInverse(ctx, opportunities, fav, pairId, favFilled);
      }
      return opportunities;
    }

    // Deterioration exit: the chain state lives per pair; purge closed windows
    // lazily like the dip-revert Map pattern (cheap + bounded).
    this.purgeExitStates(nowMs);

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

  /**
   * One observation against the held token's current ask (lower-peaks chain).
   * A full recovery to/above the last significant peak resets the sequence;
   * every peak that fails by >= minDrop counts one event. Idempotent for a
   * repeated identical sample (the runner calls shouldDefend twice per
   * decision — no double counting, no spurious reset).
   */
  private stepExitChainWith(
    state: ExitPairState,
    heldAsk: number,
    nowMs: number,
    minDrop: number,
    lookbackMs: number,
    consecutive: number,
  ): void {
    state.lastSeenTs = nowMs;
    if (state.lastPeak == null || state.curPeak == null) {
      state.lastPeak = heldAsk;
      state.curPeak = heldAsk;
      return;
    }
    // Decay: an INCOMPLETE sequence with no fresh event inside the lookback
    // is stale (the deterioration must stay recent). A completed sequence
    // stays armed so the exit keeps retrying until the sell fills.
    if (
      state.lowerPeaks > 0 &&
      state.lowerPeaks < consecutive &&
      state.lastEventTs != null &&
      nowMs - state.lastEventTs > lookbackMs
    ) {
      state.lowerPeaks = 0;
      state.lastEventTs = null;
    }
    if (heldAsk >= state.lastPeak) {
      // Full recovery: the price reclaimed the last significant peak — the
      // lower-peaks pattern is broken. Re-anchor and reset the count.
      state.lastPeak = heldAsk;
      state.curPeak = heldAsk;
      state.lowerPeaks = 0;
      state.lastEventTs = null;
      return;
    }
    if (heldAsk > state.curPeak) {
      state.curPeak = heldAsk;
    }
    if (state.curPeak - heldAsk >= minDrop) {
      // The peak at curPeak failed by >= minDrop: one deteriorating level.
      state.lowerPeaks += 1;
      state.lastPeak = state.curPeak;
      state.curPeak = heldAsk;
      state.lastEventTs = nowMs;
    }
    // Else: noise between the running peak and the step threshold.
  }

  /** Purge exit states of closed windows (pairs never come back). */
  private purgeExitStates(nowMs: number): void {
    for (const [key, st] of this.exitStates) {
      if (nowMs - st.lastSeenTs > EXIT_STATE_STALE_MS) {
        this.exitStates.delete(key);
      }
    }
  }

  /**
   * Post-exit follow-up: once, right after the exit SELL, FOK-buy the
   * OPPOSITE token at its CURRENT ask (marketable switch). Sizing on the
   * real opposite ask keeps the worst-price protection honest; the 0.8×
   * depth preflight mirrors the entry leg.
   */
  private maybeEmitSwitchOpposite(
    ctx: StrategyContext,
    opportunities: TradeOpportunity[],
    pairId: string,
    nowMs: number,
  ): void {
    const { config, tracker, event, books } = ctx;
    if (!config.favBandExitEnabled || !config.favBandExitSwitchEnabled) return;
    const state = this.exitStates.get(pairId);
    if (!state?.switchPending) return;
    // Only the token we actually sold qualifies: the held token's identity is
    // anchored at the fill, not re-derived from the current favorite.
    if (state.heldTokenId == null) return;

    const inverse = books.find(
      (book) => book.tokenId !== state.heldTokenId && book.bestAsk !== null,
    );
    if (!inverse || inverse.bestAsk === null) return;

    const ask = inverse.bestAsk;
    const size = computeSize(
      config.favBandExitSwitchOrderUsdc,
      ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return;
    if (inverse.bestAskSize != null && inverse.bestAskSize < size * 0.8) return;

    const before = opportunities.length;
    appendOpportunity(
      tracker,
      opportunities,
      event,
      inverse,
      "cheap",
      round2(ask),
      size,
      config.maxOpenPositionsPerSide,
    );
    for (let i = before; i < opportunities.length; i++) {
      opportunities[i] = { ...opportunities[i], orderType: "FOK" };
    }
    // One-shot: whether the FOK fills or is killed this tick, the trigger is
    // consumed (a kill retries via the tracker's retry counter, not re-emit).
    state.switchPending = false;
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

  /** Anchors the deterioration chain at the REAL fill (runner + live). */
  onBuyCommitted(opportunity: TradeOpportunity): void {
    if (!this.exitStates.has(opportunity.pairId)) {
      this.exitStates.set(opportunity.pairId, {
        heldTokenId: opportunity.token.tokenId,
        entryPrice: opportunity.price,
        windowStartSec: opportunity.event.windowStart,
        lastPeak: opportunity.price,
        curPeak: opportunity.price,
        lowerPeaks: 0,
        lastEventTs: null,
        lastSeenTs: Date.now(),
        exited: false,
        switchPending: false,
      });
    }
  }

  /**
   * Deterioration exit (config switch `favBandExitEnabled`): the HELD token's
   * price keeps printing lower and lower levels. Each printed level ≥
   * MinLowerHighDrop below the current reference steps the chain down and
   * bumps the count; `Consecutive` steps in a row within LookbackMs fire the
   * exit. The hooks run through defendUncoveredPairs (live) and defendCheapLegs
   * (backtest); the runner sells at the bid (worst-price FOK semantics).
   */
  shouldDefend(ctx: DefendContext): boolean {
    if (!ctx.config.favBandExitEnabled) return false;
    if (ctx.filledCheap <= 0) return false;
    const nowMs = ctx.nowMs ?? Date.now();
    const state = this.exitStates.get(ctx.pairId);
    if (!state || state.heldTokenId === null) return false;

    // Update the chain from the HELD token's own ask. In defend contexts the
    // caller supplies cheapAsk = the held token's book (defendUncoveredPairs /
    // defendCheapLegs both derive it from the cheap token = the filled leg).
    const heldAsk = ctx.cheapAsk ?? null;
    if (heldAsk != null) {
      this.stepExitChainWith(
        state,
        heldAsk,
        nowMs,
        ctx.config.favBandExitMinLowerHighDrop,
        ctx.config.favBandExitLookbackMs,
        ctx.config.favBandExitConsecutive,
      );
    }

    if (state.exited) return false;
    if (ctx.config.favBandExitLossOnly) {
      const entry = state.entryPrice;
      if (entry == null || heldAsk == null || heldAsk >= entry) return false;
    }
    if (ctx.config.favBandExitMinElapsedSec > 0) {
      const elapsedSec = nowMs / 1000 - (state.windowStartSec ?? 0);
      if (elapsedSec < ctx.config.favBandExitMinElapsedSec) return false;
    }
    if (state.lowerPeaks < ctx.config.favBandExitConsecutive) return false;
    // Event recency: the deteriorating sequence must still be inside the
    // lookback window at trigger time.
    if (
      state.lastEventTs == null ||
      nowMs - state.lastEventTs > ctx.config.favBandExitLookbackMs
    ) {
      return false;
    }
    return true;
  }

  defendShares(ctx: DefendContext): number {
    if (!this.shouldDefend(ctx)) return 0;
    return round2(ctx.filledCheap);
  }

  /** One-shot: no second exit, and arm the opposite-token follow-up. */
  onDefendCommitted(pairId: string): void {
    const state = this.exitStates.get(pairId);
    if (!state || state.exited) return;
    state.exited = true;
    state.switchPending = true;
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "fav-band-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}