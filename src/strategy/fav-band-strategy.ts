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
import {
  CrossImbalanceHistory,
  crossImbalanceSigned,
} from "../utils/book-imbalance.js";

type WindowBookStats = {
  slug: string;
  windowStart: number;
  lastFavIdx: number | null;
  flips: number;
  askMin: number;
  askMax: number;
  samples: number;
};

/** Polymarket L1 tick in cents — floor for a confirming bounce. */
const PRICE_TICK_CENTS = 1;

function priceToCents(price: number): number {
  return Math.round(price * 100);
}

/**
 * Bounce needed to freeze a plus-bas. Not a rigid 50% retrace:
 *  - after a real swing (>= minSwing), bounce is clamp(ratio × drop, 1 tick, minSwing)
 *    so a 10¢ dump confirms around 3¢ (ratio 0.25) not 5¢, and a 20¢ dump never
 *    waits more than minSwing (default 5¢);
 *  - a later extension of >= minSwing below the last plus-bas confirms on 1 tick
 *    (stairs / waterfall / failed bounce).
 */
function requiredBounceCents(
  dropC: number,
  minSwingC: number,
  ratio: number,
  lowestLowC: number | null,
  curLowC: number,
): number {
  if (lowestLowC != null && lowestLowC - curLowC >= minSwingC) {
    return PRICE_TICK_CENTS;
  }
  const cap = Math.max(PRICE_TICK_CENTS, minSwingC);
  const proportional = Math.round(ratio * dropC);
  return Math.min(cap, Math.max(PRICE_TICK_CENTS, proportional));
}

/**
 * Deterioration-exit chain: confirmed lower-lows (plus-bas), not failed peaks.
 * A plus-bas is the running trough of the current down-leg, frozen once price
 * bounces enough (see requiredBounceCents). Strictly lower confirmed lows
 * increment the sequence; reclaiming the structure high resets it. Breaking
 * the last plus-bas without a full retrace starts a new down-leg from the
 * bounce high (failed bounce / continuation). Idempotent per sample so the
 * runner's shouldDefend → defendShares double call is harmless.
 */
type ExitPairState = {
  heldTokenId: string | null;
  entryPrice: number | null;
  windowStartSec: number | null;
  phase: "down" | "up";
  /** Structure high (BOS level): entry, or a pre-low extension. */
  lastHighC: number;
  /** Origin of the current down-leg (structure high or last bounce peak). */
  legHighC: number;
  /** Lowest confirmed plus-bas in the current sequence. */
  lowestLowC: number | null;
  /** Most recently confirmed plus-bas (break of this resumes a down-leg). */
  lastSwingLowC: number | null;
  /** Running min (down) or max (up) of the current leg. */
  curExtremeC: number;
  lowerLows: number;
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

/** Whipsaw pause status for external consumption (dashboard). */
export type FavBandWhipsawStatus = {
  enabled: boolean;
  active: boolean;
  remainingMs: number;
  pauseUntilMs: number;
  lossStreak: number;
  pauseAfterLosses: number | null;
  pauseWindows: number;
};

/**
 * Fav-band — directional FOK buy of the favorite in a calibrated ask band
 * after min elapsed; hold to resolve. Optional inverse GTC + optional whipsaw
 * filter (pause after losses / max flips / max score). Optional deterioration
 * exit: when the HELD favorite prints a sequence of confirmed plus-bas
 * (lower lows, each a swing of >= MinSwing frozen by a flexible bounce)
 * `Consecutive` times within LookbackMs, SELL the whole position (FOK at
 * the bid, defend pipeline) instead of riding to resolution — and optionally
 * FOK-buy the OPPOSITE token right after (switch sides).
 */
export class FavBandStrategy implements TradingStrategy {
  readonly id = "fav-band" as const;
  readonly label =
    "Fav-band: FOK buy favorite when ask in calibrated mid-band after min elapsed; hold to resolve (optional resting inverse GTC, optional lower-low deterioration exit + inverse switch)";
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
  /** Per-pair rolling cross-imbalance samples (for the persistence gate). */
  private readonly imbalanceHistory = new CrossImbalanceHistory();
  /** Purge the imbalance history at most this often. */
  private lastImbalancePruneMs = 0;

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

    // Cross-imbalance sample: recorded every tick BEFORE the gates so the
    // persistence gate sees the true rolling state, not only in-band ticks.
    if (config.favBandImbalanceCrossMin != null) {
      const up = books.find((b) => b.outcomeIndex === 0);
      const down = books.find((b) => b.outcomeIndex === 1);
      this.imbalanceHistory.push(
        pairId,
        nowMs,
        crossImbalanceSigned(up, down, fav.outcomeIndex),
        Math.max(8, (config.favBandImbalanceTicks ?? 2) + 2),
      );
      if (nowMs - this.lastImbalancePruneMs > 60_000) {
        this.imbalanceHistory.forgetStale(nowMs, EXIT_STATE_STALE_MS);
        this.lastImbalancePruneMs = nowMs;
      }
    }

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

    // Cross-imbalance persistence gate (default off): skip when the merged
    // 3-level book pressure signed toward the bought favorite has been
    // below CrossMin for Ticks consecutive samples. Null samples fail the
    // condition (gate not armed on size-less books).
    if (
      config.favBandImbalanceCrossMin != null &&
      !this.imbalanceHistory.consecutiveAtOrAbove(
        pairId,
        config.favBandImbalanceCrossMin,
        config.favBandImbalanceTicks ?? 2,
      )
    ) {
      return opportunities;
    }

    // Fav-band spread filter tied to the imbalance gate (default off).
    if (
      config.favBandImbalanceMaxSpread != null &&
      fav.bestAsk != null &&
      fav.bestBid != null &&
      fav.bestAsk - fav.bestBid > config.favBandImbalanceMaxSpread
    ) {
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
   * One observation against the held token's current ask (plus-bas chain).
   * A bounce that reclaims the structure high resets the sequence; every
   * confirmed trough strictly below the last plus-bas counts one event.
   * Idempotent for a repeated identical sample (the runner calls
   * shouldDefend twice per decision — no double counting, no spurious reset).
   */
  private stepExitChainWith(
    state: ExitPairState,
    heldAsk: number,
    nowMs: number,
    minSwing: number,
    lookbackMs: number,
    consecutive: number,
    retraceRatio: number,
  ): void {
    state.lastSeenTs = nowMs;
    const askC = priceToCents(heldAsk);
    const minSwingC = Math.max(PRICE_TICK_CENTS, priceToCents(minSwing));
    // Decay: an INCOMPLETE sequence with no fresh plus-bas inside the lookback
    // is stale. A completed sequence stays armed so the exit keeps retrying
    // until the sell fills.
    if (
      state.lowerLows > 0 &&
      state.lowerLows < consecutive &&
      state.lastEventTs != null &&
      nowMs - state.lastEventTs > lookbackMs
    ) {
      state.lowerLows = 0;
      state.lastEventTs = null;
    }

    if (state.phase === "down") {
      if (askC >= state.lastHighC) {
        state.lastHighC = askC;
        state.legHighC = askC;
        state.curExtremeC = askC;
        if (state.lowestLowC != null) {
          state.lowestLowC = null;
          state.lastSwingLowC = null;
          state.lowerLows = 0;
          state.lastEventTs = null;
        }
        return;
      }
      state.curExtremeC = Math.min(state.curExtremeC, askC);
      const dropC = state.legHighC - state.curExtremeC;
      const bounceC = askC - state.curExtremeC;
      if (dropC < minSwingC) return;
      const needed = requiredBounceCents(
        dropC,
        minSwingC,
        retraceRatio,
        state.lowestLowC,
        state.curExtremeC,
      );
      if (bounceC >= needed) {
        this.confirmLow(state, state.curExtremeC, nowMs);
        state.phase = "up";
        state.curExtremeC = askC;
      }
      return;
    }

    // phase === "up": tracking the bounce off the last plus-bas.
    if (askC >= state.lastHighC) {
      state.phase = "down";
      state.lastHighC = askC;
      state.legHighC = askC;
      state.curExtremeC = askC;
      state.lowestLowC = null;
      state.lastSwingLowC = null;
      state.lowerLows = 0;
      state.lastEventTs = null;
      return;
    }
    state.curExtremeC = Math.max(state.curExtremeC, askC);
    if (state.lastSwingLowC != null && askC < state.lastSwingLowC) {
      // Failed bounce / continuation: the last plus-bas broke. New down-leg
      // starts from the bounce peak — no need for a 50% retrace first.
      state.phase = "down";
      state.legHighC = state.curExtremeC;
      state.curExtremeC = askC;
    }
  }

  private confirmLow(
    state: ExitPairState,
    lowC: number,
    nowMs: number,
  ): void {
    if (state.lowestLowC == null || lowC < state.lowestLowC) {
      state.lowerLows += 1;
      state.lastEventTs = nowMs;
      state.lowestLowC = lowC;
    }
    state.lastSwingLowC = lowC;
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

  /** Anchors the plus-bas chain at the REAL fill (runner + live). */
  onBuyCommitted(opportunity: TradeOpportunity): void {
    if (!this.exitStates.has(opportunity.pairId)) {
      const entryC = priceToCents(opportunity.price);
      this.exitStates.set(opportunity.pairId, {
        heldTokenId: opportunity.token.tokenId,
        entryPrice: opportunity.price,
        windowStartSec: opportunity.event.windowStart,
        phase: "down",
        lastHighC: entryC,
        legHighC: entryC,
        lowestLowC: null,
        lastSwingLowC: null,
        curExtremeC: entryC,
        lowerLows: 0,
        lastEventTs: null,
        lastSeenTs: Date.now(),
        exited: false,
        switchPending: false,
      });
    }
  }

  /**
   * Deterioration exit (config switch `favBandExitEnabled`): the HELD token
   * prints a sequence of confirmed plus-bas (lower lows). Each trough of
   * >= MinSwing, frozen by a flexible bounce, that is strictly below the
   * previous plus-bas increments the count; `Consecutive` plus-bas inside
   * LookbackMs fire the exit. Hooks run through defendUncoveredPairs (live)
   * and defendCheapLegs (backtest); the runner sells at the bid.
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
        ctx.config.favBandExitRetraceRatio,
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
    if (state.lowerLows < ctx.config.favBandExitConsecutive) return false;
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

  /** Get current whipsaw pause status for the dashboard. */
  getWhipsawStatus(config: StrategyContext["config"], nowMs: number, lossStreak: number): FavBandWhipsawStatus {
    const enabled = config.favBandWhipsawEnabled === true;
    const active = enabled && nowMs < this.pauseUntilMs;
    const remainingMs = active ? Math.max(0, this.pauseUntilMs - nowMs) : 0;
    return {
      enabled,
      active,
      remainingMs,
      pauseUntilMs: this.pauseUntilMs,
      lossStreak,
      pauseAfterLosses: config.favBandWhipsawPauseAfterLosses ?? null,
      pauseWindows: config.favBandWhipsawPauseWindows ?? 8,
    };
  }

  /** Manually reset the whipsaw pause cooldown (for manual override via dashboard). */
  resetWhipsawPause(lossStreak: number = 0): void {
    this.pauseUntilMs = 0;
    // Set prevLossStreak to current lossStreak so that maybeTriggerPause won't
    // re-arm immediately on the next tick (condition: lossStreak > prevLossStreak).
    this.prevLossStreak = lossStreak;
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