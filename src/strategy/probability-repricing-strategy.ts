import type { BotConfig } from "../config.js";
import type { TradeOpportunity, TokenBook } from "../types.js";
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
 * Probability-repricing (v1) — intramarket path trade on short crypto Up/Down.
 *
 * Hypothesis (paper §3): primary mode C (microstructure / book dislocation vs
 * short history) + strict exits. Optional mode A (reversion after overshoot)
 * via `repricingModeAEnabled`. No pure momentum B.
 *
 * No Binance/spot feed in this bot yet → dislocation is computed vs a short
 * rolling ask history on the CLOB (cheapness + z-score drop). Documented
 * placeholder until an external feed is wired (`repricingFeedMaxAgeMs` is
 * accepted but unused while feed age is unavailable).
 *
 * Execution: single FOK BUY of the dislocated token at ask; exits via the
 * defend pipeline (`usesDefendAsExit`) on executable bid (never mid).
 *
 * State machine (§5): IDLE → ARMED → ENTERING → OPEN → EXITING → FLAT (+ HALTED).
 */
export type RepricingPhase =
  | "IDLE"
  | "ARMED"
  | "ENTERING"
  | "OPEN"
  | "EXITING"
  | "FLAT"
  | "HALTED";

export type RepricingExitReason =
  | "tp_abs"
  | "tp_rel"
  | "stop_abs"
  | "time_stop"
  | "tau_force"
  | "spread_exit"
  | "forced_settlement"
  | null;

interface AskSample {
  ts: number;
  ask: number;
}

interface PairState {
  phase: RepricingPhase;
  windowEndSec: number;
  /** Rolling ask history per tokenId (prior ticks only — current ask is pushed after scoring). */
  history: Map<string, AskSample[]>;
  /** Token we intend to / have bought. */
  heldTokenId: string | null;
  entryPrice: number | null;
  entryTs: number | null;
  armedTokenId: string | null;
  /** First arm time for current token; not refreshed while signal stays valid (TTL). */
  armedTs: number | null;
  /** Last findOpportunities clock (sim/live) — used as entryTs on commit. */
  lastTickNowMs: number | null;
  /**
   * After signal_ttl expiry, block re-arm until the signal has been absent
   * for at least one tick (otherwise TTL clears and re-arms in the same tick).
   */
  signalGateClear: boolean;
  exitReason: RepricingExitReason;
  forcedSettlement: boolean;
  lastSignalScore: number;
  lastEdgeEst: number;
}

const STALE_MS = 2 * 900 * 1000;

function tauSec(windowEndSec: number, nowMs: number): number {
  return windowEndSec - nowMs / 1000;
}

function spreadOf(book: TokenBook): number | null {
  if (book.bestAsk == null || book.bestBid == null) return null;
  return book.bestAsk - book.bestBid;
}

function pushHistory(
  state: PairState,
  tokenId: string,
  ask: number,
  nowMs: number,
  windowMs: number,
): void {
  let series = state.history.get(tokenId);
  if (!series) {
    series = [];
    state.history.set(tokenId, series);
  }
  const last = series[series.length - 1];
  if (!last || last.ts !== nowMs) {
    series.push({ ts: nowMs, ask });
  } else {
    last.ask = ask;
  }
  const cutoff = nowMs - windowMs;
  while (series.length > 0 && series[0].ts < cutoff) {
    series.shift();
  }
}

/** Mode C: positive score = ask cheap vs recent mean (z-score). Prior samples only. */
function dislocationZ(series: AskSample[], ask: number): number {
  if (series.length < 3) return 0;
  const values = series.map((s) => s.ask);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const sigma = Math.sqrt(variance);
  if (sigma < 1e-6) {
    // Flat book: fall back to absolute cheapness vs mean.
    return mean - ask > 0.01 ? (mean - ask) / 0.01 : 0;
  }
  return (mean - ask) / sigma;
}

/** Mode A: recent local low then bounce (reversion after overshoot). */
function modeAReady(series: AskSample[], ask: number, minDrop: number): boolean {
  if (series.length < 3) return false;
  const low = Math.min(...series.map((s) => s.ask));
  const first = series[0].ask;
  return first - ask >= minDrop && ask > low && ask - low >= 0.001;
}

/**
 * edge_est (§6.4 / §9.3): E[bid_exit] − ask_entry − fees − slip buffers.
 * With path target E[bid_exit] ≈ ask_entry + targetAbs → targetAbs − fees − slips.
 * Do NOT subtract current spread: TP is measured from entry ask to exit bid
 * (`bid >= entry + targetAbs`), so spread is already outside that edge.
 */
function edgeEst(config: BotConfig): number {
  return (
    config.repricingTargetAbs -
    config.repricingFeesRoundtrip -
    config.repricingSlipEntryBuffer -
    config.repricingSlipExitBuffer
  );
}

function clearArmed(state: PairState): void {
  state.armedTokenId = null;
  state.armedTs = null;
}

export class ProbabilityRepricingStrategy implements TradingStrategy {
  readonly id = "probability-repricing" as const;
  readonly label =
    "Probability-repricing: FOK buy dislocated token (CLOB ask vs short history / optional reversion); strict bid exits (TP/stop/time/tau/spread); no hedge";
  readonly leadsWithEdge = false;
  /** Path exits reuse the defend pipeline (dip-revert / open-entry precedent). */
  readonly usesDefendAsExit = true;

  private readonly states = new Map<string, PairState>();

  /** Debug / dashboard: phase + last scores for a pair. */
  getPairSnapshot(pairId: string): {
    phase: RepricingPhase;
    exitReason: RepricingExitReason;
    forcedSettlement: boolean;
    lastSignalScore: number;
    lastEdgeEst: number;
    entryPrice: number | null;
  } | null {
    const s = this.states.get(pairId);
    if (!s) return null;
    return {
      phase: s.phase,
      exitReason: s.exitReason,
      forcedSettlement: s.forcedSettlement,
      lastSignalScore: s.lastSignalScore,
      lastEdgeEst: s.lastEdgeEst,
      entryPrice: s.entryPrice,
    };
  }

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const { config, tracker, event, books } = ctx;
    const opportunities: TradeOpportunity[] = [];

    if (books.filter((b) => b.bestAsk !== null).length < 2) {
      return opportunities;
    }

    const nowMs = ctx.nowMs ?? Date.now();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tau = tauSec(event.windowEnd, nowMs);

    this.purgeStaleStates(nowMs);
    const state = this.stateFor(pairId, event.windowEnd);
    state.lastTickNowMs = nowMs;

    // Forced settlement failure marker: inventory still open as tau → 0.
    // Also re-marks if a partial exit left us FLAT while inventory remains.
    const filled = tracker.getFilledCheapSizeForPair(pairId);
    if (filled > 0 && tau <= 0) {
      state.forcedSettlement = true;
      state.exitReason = "forced_settlement";
      state.phase = "FLAT";
    }

    if (state.phase === "HALTED") {
      return opportunities;
    }

    // Already in a position (or leg claimed) → no new entry; exits via shouldDefend.
    if (filled > 0) {
      // Resurrect OPEN after a partial defend that marked FLAT too early (§8.4).
      // Do NOT resurrect after forced_settlement (tau<=0) — that FLAT is terminal.
      if (
        !state.forcedSettlement &&
        (state.phase === "ENTERING" ||
          state.phase === "ARMED" ||
          state.phase === "IDLE" ||
          state.phase === "FLAT")
      ) {
        state.phase = "OPEN";
      }
      this.sampleHistory(state, books, nowMs, config.repricingHistoryWindowMs);
      return opportunities;
    }

    // Flat after a completed exit: lock re-entry for this window.
    if (state.phase === "FLAT" || state.phase === "EXITING") {
      if (state.phase === "EXITING") state.phase = "FLAT";
      this.sampleHistory(state, books, nowMs, config.repricingHistoryWindowMs);
      return opportunities;
    }

    if (tracker.countLegsByKind(pairId, "cheap") > 0) {
      this.sampleHistory(state, books, nowMs, config.repricingHistoryWindowMs);
      return opportunities;
    }

    // Late window / tau filters — no new entries (§7.1 / §6.2).
    if (tau < config.repricingTauMinSec || tau < config.repricingLateWindowSec) {
      if (state.phase === "ARMED" || state.phase === "ENTERING") {
        state.phase = "IDLE";
        clearArmed(state);
      }
      this.sampleHistory(state, books, nowMs, config.repricingHistoryWindowMs);
      return opportunities;
    }

    // Signal TTL: ARMED/ENTERING expired → IDLE (armedTs is NOT refreshed while
    // the same token stays armed/entering — otherwise TTL never fires when
    // waiting on depth/size or retrying a failed FOK).
    if (
      (state.phase === "ARMED" || state.phase === "ENTERING") &&
      state.armedTs != null &&
      nowMs - state.armedTs > config.repricingSignalTtlMs
    ) {
      state.phase = "IDLE";
      clearArmed(state);
      // Require signal absence before re-arming (avoid same-tick re-arm).
      state.signalGateClear = false;
    }

    // Score against PRIOR history only, then sample current asks.
    const priorHistory = state.history;
    const candidates = books.filter((b) => b.bestAsk !== null);
    let best: {
      book: TokenBook;
      score: number;
      edge: number;
      ask: number;
    } | null = null;

    const edge = edgeEst(config);

    for (const book of candidates) {
      const ask = book.bestAsk as number;
      const spr = spreadOf(book);
      if (spr == null || spr > config.repricingSpreadMax) continue;
      if (ask > config.repricingPEntryMax) continue;

      const series = priorHistory.get(book.tokenId) ?? [];
      const z = dislocationZ(series, ask);
      if (z < config.repricingDislocationMin) continue;

      if (config.repricingModeAEnabled) {
        // Optional reversion: require bounce off a recent drop.
        if (!modeAReady(series, ask, Math.max(0.01, config.repricingDislocationMin * 0.01))) {
          continue;
        }
      }

      if (edge < config.repricingEdgeMin) continue;

      if (!best || z > best.score || (z === best.score && ask < best.ask)) {
        best = { book, score: z, edge, ask };
      }
    }

    this.sampleHistory(state, books, nowMs, config.repricingHistoryWindowMs);

    if (!best) {
      // Failed FOK / lost signal must not leave ENTERING stuck.
      if (state.phase === "ARMED" || state.phase === "ENTERING") {
        state.phase = "IDLE";
        clearArmed(state);
      }
      // Signal absent → allow a fresh ARMED after a prior TTL expiry.
      state.signalGateClear = true;
      return opportunities;
    }

    state.lastSignalScore = best.score;
    state.lastEdgeEst = best.edge;

    // TTL cooldown: wait until signal has been absent before re-arming.
    if (!state.signalGateClear && state.phase !== "ARMED" && state.phase !== "ENTERING") {
      return opportunities;
    }

    const sameArmedToken = state.armedTokenId === best.book.tokenId;
    const stayArmed =
      (state.phase === "ARMED" || state.phase === "ENTERING") && sameArmedToken;
    if (!stayArmed || state.armedTs == null) {
      state.armedTs = nowMs;
    }
    state.phase = "ARMED";
    state.armedTokenId = best.book.tokenId;
    state.signalGateClear = true;

    const size = computeSize(
      config.repricingOrderUsdc,
      best.ask,
      config.maxSharesPerOrder,
    );
    if (size === null || size < MIN_CLOB_SHARES) return opportunities;

    // Depth hard filter (§7.1): FOK needs full size at L1.
    if (best.book.bestAskSize != null && best.book.bestAskSize < size) {
      return opportunities;
    }

    // Notional cap per market.
    const notional = size * best.ask;
    if (notional > config.repricingNotionalMaxPerMarket) {
      return opportunities;
    }

    const tradeKey = tracker.makeKey(
      event.slug,
      best.book.outcome,
      "cheap",
      round2(best.ask),
    );
    if (tracker.has(tradeKey)) return opportunities;

    state.phase = "ENTERING";
    state.heldTokenId = best.book.tokenId;

    opportunities.push({
      kind: "cheap",
      event,
      token: best.book,
      price: round2(best.ask),
      size,
      tickSize: tickSizeFromMarket(event.market),
      negRisk: event.market.negRisk,
      tradeKey,
      pairId,
      orderType: "FOK",
    });
    return opportunities;
  }

  onBuyCommitted(opportunity: TradeOpportunity): void {
    const state = this.states.get(opportunity.pairId);
    // Prefer last strategy tick clock (sim/live) over wall clock so holdMax /
    // time_stop stay coherent in backtests. Do NOT use armedTs — after TTL fix
    // it can be seconds before the actual fill.
    const nowMs = state?.lastTickNowMs ?? Date.now();
    if (state) {
      state.phase = "OPEN";
      state.entryPrice = opportunity.price;
      state.entryTs = nowMs;
      state.heldTokenId = opportunity.token.tokenId;
      state.exitReason = null;
      state.forcedSettlement = false;
    } else {
      this.states.set(opportunity.pairId, {
        phase: "OPEN",
        windowEndSec: opportunity.event.windowEnd,
        history: new Map(),
        heldTokenId: opportunity.token.tokenId,
        entryPrice: opportunity.price,
        entryTs: nowMs,
        armedTokenId: null,
        armedTs: null,
        lastTickNowMs: nowMs,
        signalGateClear: true,
        exitReason: null,
        forcedSettlement: false,
        lastSignalScore: 0,
        lastEdgeEst: 0,
      });
    }
  }

  /**
   * Exit rules (§8) on executable bid. `cheapBid` preferred; when missing,
   * `cheapAsk - 0.01` is a conservative proxy (sell fills at bid ≤ ask−tick).
   */
  shouldDefend(ctx: DefendContext): boolean {
    if (ctx.filledCheap <= 0) return false;
    const nowMs = ctx.nowMs ?? Date.now();
    const state = this.states.get(ctx.pairId);
    if (!state || state.entryPrice == null || state.entryTs == null) return false;
    if (state.phase === "FLAT" || state.phase === "HALTED") return false;

    const entry = state.entryPrice;
    const bid =
      ctx.cheapBid ??
      (ctx.cheapAsk != null ? ctx.cheapAsk - 0.01 : null);
    if (bid == null) return false;

    const tau = tauSec(state.windowEndSec, nowMs);
    const holdSec = (nowMs - state.entryTs) / 1000;
    const spr =
      ctx.cheapAsk != null && ctx.cheapBid != null
        ? ctx.cheapAsk - ctx.cheapBid
        : ctx.cheapAsk != null
          ? ctx.cheapAsk - bid
          : null;

    // Take-profit absolute / relative (§8.1).
    if (bid >= entry + ctx.config.repricingTargetAbs) {
      state.exitReason = "tp_abs";
      state.phase = "EXITING";
      return true;
    }
    if (
      ctx.config.repricingTargetRel > 0 &&
      bid >= entry * (1 + ctx.config.repricingTargetRel)
    ) {
      state.exitReason = "tp_rel";
      state.phase = "EXITING";
      return true;
    }

    // Stop (§8.3).
    if (bid <= entry - ctx.config.repricingStopAbs) {
      state.exitReason = "stop_abs";
      state.phase = "EXITING";
      return true;
    }

    // Spread blowout on exit.
    if (spr != null && spr > ctx.config.repricingSpreadMaxExit) {
      state.exitReason = "spread_exit";
      state.phase = "EXITING";
      return true;
    }

    // Time-stop / tau force (§8.2). Late window → aggress exit via tau_force.
    if (holdSec >= ctx.config.repricingHoldMaxSec) {
      state.exitReason = "time_stop";
      state.phase = "EXITING";
      return true;
    }
    if (tau <= ctx.config.repricingTauForceExitSec) {
      state.exitReason = "tau_force";
      state.phase = "EXITING";
      return true;
    }

    return false;
  }

  defendShares(ctx: DefendContext): number {
    if (!this.shouldDefend(ctx)) return 0;
    return round2(ctx.filledCheap);
  }

  /**
   * After a defend SELL. Spec §8.4: residual inventory stays OPEN.
   * We mark FLAT optimistically; findOpportunities resurrects OPEN if
   * filledCheap is still > 0 (partial live fill).
   */
  onDefendCommitted(pairId: string): void {
    const state = this.states.get(pairId);
    if (!state) return;
    state.phase = "FLAT";
  }

  halt(pairId?: string): void {
    if (pairId) {
      const s = this.states.get(pairId);
      if (s) s.phase = "HALTED";
      return;
    }
    for (const s of this.states.values()) {
      s.phase = "HALTED";
    }
  }

  /** Pure helper exported for unit tests. */
  static computeEdgeEst(config: BotConfig): number {
    return edgeEst(config);
  }

  static computeDislocationZ(asks: number[], ask: number): number {
    const series = asks.map((a, i) => ({ ts: i, ask: a }));
    return dislocationZ(series, ask);
  }

  private sampleHistory(
    state: PairState,
    books: TokenBook[],
    nowMs: number,
    windowMs: number,
  ): void {
    for (const book of books) {
      if (book.bestAsk != null) {
        pushHistory(state, book.tokenId, book.bestAsk, nowMs, windowMs);
      }
    }
  }

  private stateFor(pairId: string, windowEndSec: number): PairState {
    let state = this.states.get(pairId);
    if (!state) {
      state = {
        phase: "IDLE",
        windowEndSec,
        history: new Map(),
        heldTokenId: null,
        entryPrice: null,
        entryTs: null,
        armedTokenId: null,
        armedTs: null,
        lastTickNowMs: null,
        signalGateClear: true,
        exitReason: null,
        forcedSettlement: false,
        lastSignalScore: 0,
        lastEdgeEst: 0,
      };
      this.states.set(pairId, state);
    }
    return state;
  }

  private purgeStaleStates(nowMs: number): void {
    for (const [key, st] of this.states) {
      if (st.windowEndSec * 1000 + STALE_MS < nowMs) {
        this.states.delete(key);
      }
    }
  }

  cheapOrderAction(_ctx: RestingCheapContext): CheapOrderAction {
    return "keep";
  }

  edgeOrderAction(_ctx: RestingEdgeContext): EdgeOrderAction {
    return "keep";
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "probability-repricing-no-hedge" };
  }

  shouldSellExpensiveEdge(): boolean {
    return false;
  }
}
