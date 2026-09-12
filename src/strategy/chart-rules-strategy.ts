import type { BotConfig } from "../config.js";
import type { TokenBook, TradeOpportunity } from "../types.js";
import type { TradeTracker } from "../trade-tracker.js";
import { parseWindowStart } from "../utils/market.js";
import { computeSize, MIN_CLOB_SHARES } from "../utils/prices.js";
import {
  DEFAULT_LOOKBACK_MS,
  hasPriceBand,
  inPriceBand,
  normalizeChartRule,
  orderChartRules,
  uniqueDependsOn,
  type NormalizedChartRule,
} from "./chart-rule.js";
import { EdgeConfirmBuffer } from "./edge-confirm.js";
import {
  appendOpportunity,
  computeEdgeLeadCheapSize,
  computeEdgeLeadEdgeSize,
  edgeClaimedOutcome,
} from "./edge-lead-strategy.js";
import type { StrategyGraph } from "./graph/types.js";
import { validateStrategyGraph } from "./graph/validate.js";
import type { StrategyId } from "./ids.js";
import { pickReverseToken, round2 } from "./predicates.js";
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

type Sample = { ts: number; px: number };

function clock(injected?: number): number {
  return injected ?? Date.now();
}

function splitLegs(books: TokenBook[]): {
  cheap: TokenBook | null;
  favorite: TokenBook | null;
} {
  const cheap = pickReverseToken(books);
  if (!cheap) return { cheap: null, favorite: null };
  const favorite =
    books.find(
      (book) => book.tokenId !== cheap.tokenId && book.bestAsk !== null,
    ) ?? null;
  return { cheap, favorite };
}

function inZone(elapsedSec: number, rule: NormalizedChartRule): boolean {
  return elapsedSec >= rule.startSec && elapsedSec <= rule.endSec;
}

function slopePerSecond(samples: Sample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.ts - first.ts) / 1000;
  if (dt <= 0) return null;
  return (last.px - first.px) / dt;
}

function trendMatches(
  samples: Sample[],
  nowMs: number,
  rule: NormalizedChartRule,
): boolean {
  const windowed = samples.filter((s) => nowMs - s.ts <= rule.lookbackMs);
  const slope = slopePerSecond(windowed);
  if (slope == null) return false;
  if (rule.direction === "up") return slope > rule.minSlope;
  return slope < -rule.minSlope;
}

function overlayConfirmConfig(
  rule: NormalizedChartRule,
  config: BotConfig,
): BotConfig {
  return {
    ...config,
    edgeBandMin: rule.bandMin ?? 0,
    edgeBandMax: rule.bandMax ?? 1,
    edgeConfirmSamples: rule.confirmTicks ?? config.edgeConfirmSamples,
    edgeMaxDownTick: rule.maxDownTick ?? config.edgeMaxDownTick,
  };
}

/**
 * Interprète `chartRules` sur le contrat TradingStrategy.
 *
 * buy  = poster la jambe (cheap → kind cheap, favorite → expensive) au round2(ask).
 * sell = uniquement si une position de ce token est ouverte (fill).
 *        cheap fillé → defend ; favorite fillé → shouldSellExpensiveEdge.
 *        Un GTC cheap resting n'est pas une position : cancel-lock seulement hors bande d'un buy.
 * `once` : commit (fired) après POST accepté. Un POST raté se retente.
 * `dependsOn` : l'enfant attend le **fill** du parent buy, pas seulement le POST.
 * afterFill favorite : cheap = l'autre outcome claimé, pas le moins cher live.
 */
export class ChartRulesStrategy implements TradingStrategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly leadsWithEdge: boolean;
  private readonly rules: NormalizedChartRule[];
  private readonly samples = new Map<string, Sample[]>();
  private readonly fired = new Set<string>();
  private readonly pairWindows = new Map<string, number>();
  private readonly confirm = new EdgeConfirmBuffer();
  private readonly lossStart = new Map<string, number>();
  /** Déclenchements (fill parent) pour dependsOn. */
  private readonly satisfied = new Set<string>();
  /** Buys dont le POST a été accepté, en attente de fill. */
  private readonly posted = new Set<string>();
  private readonly pendingSellFav = new Map<string, string>();
  private readonly pendingSellCheap = new Map<string, string>();

  constructor(graph: StrategyGraph) {
    const errors = validateStrategyGraph(graph);
    if (errors.length > 0) {
      throw new Error(`invalid strategy graph: ${errors.join("; ")}`);
    }
    this.id = graph.id as StrategyId;
    this.label = graph.name;
    this.leadsWithEdge = graph.leadsWithEdge;
    this.rules = orderChartRules((graph.chartRules ?? []).map(normalizeChartRule));
  }

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const nowMs = clock(ctx.nowMs);
    const pairId = `${ctx.event.slug}:${ctx.event.windowEnd}`;
    this.pairWindows.set(pairId, ctx.event.windowStart);
    this.promoteFills(pairId, ctx.tracker);
    const elapsed = nowMs / 1000 - ctx.event.windowStart;
    const { cheap, favorite } = splitLegs(ctx.books);
    this.pushSample(pairId, "cheap", cheap?.bestAsk ?? null, nowMs);
    this.pushSample(pairId, "favorite", favorite?.bestAsk ?? null, nowMs);

    const opportunities: TradeOpportunity[] = [];
    for (const rule of this.rules) {
      if (rule.action !== "buy") continue;
      if (rule.once && this.fired.has(this.fireKey(pairId, rule.id))) continue;
      if (!inZone(elapsed, rule)) {
        this.confirm.reset(this.fireKey(pairId, rule.id));
        continue;
      }
      if (rule.minElapsedSec != null && elapsed < rule.minElapsedSec) continue;
      if (!this.parentsReady(pairId, rule)) continue;
      if (!this.afterFillReady(rule, ctx.tracker, pairId)) continue;
      const token = this.pickBuyToken(
        rule,
        ctx.books,
        cheap,
        favorite,
        ctx.tracker,
        pairId,
      );
      if (!token || token.bestAsk === null) continue;
      if (
        !this.signalReady(
          pairId,
          rule,
          nowMs,
          token.bestAsk,
          token.outcome,
          ctx.config,
        )
      ) {
        continue;
      }
      const price = round2(token.bestAsk);
      const size = this.buySize(ctx.config, rule, rule.token, price);
      if (size == null) continue;
      const kind = rule.token === "cheap" ? "cheap" : "expensive";
      const before = opportunities.length;
      appendOpportunity(
        ctx.tracker,
        opportunities,
        ctx.event,
        token,
        kind,
        price,
        size,
        ctx.config.maxOpenPositionsPerSide,
      );
      if (opportunities.length > before) {
        opportunities[opportunities.length - 1]!.chartRuleId = rule.id;
      }
    }
    return opportunities;
  }

  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    const nowMs = clock(ctx.nowMs);
    this.promoteFills(ctx.pairId, ctx.tracker);
    const ask = ctx.cheapBook?.bestAsk ?? null;
    this.pushSample(ctx.pairId, "cheap", ask, nowMs);
    this.pushSample(ctx.pairId, "favorite", ctx.favoriteAsk, nowMs);
    if (ask === null) return "keep";
    const bandRule = this.cheapOutOfBandRule(ctx.pairId, nowMs);
    if (!bandRule) return "keep";
    return inPriceBand(round2(ask), bandRule) ? "keep" : "cancel-lock";
  }

  edgeOrderAction(ctx: RestingEdgeContext): EdgeOrderAction {
    const nowMs = clock(ctx.nowMs);
    this.promoteFills(ctx.pairId, ctx.tracker);
    const ask = ctx.edgeBook?.bestAsk ?? null;
    this.pushSample(ctx.pairId, "favorite", ask, nowMs);
    if (ask === null) return "keep";
    const bandRule = this.favoriteOutOfBandRule(ctx.pairId, nowMs);
    if (!bandRule) return "keep";
    return inPriceBand(ask, bandRule) ? "keep" : "cancel-lock";
  }

  shouldDefend(ctx: DefendContext): boolean {
    const nowMs = clock(ctx.nowMs);
    this.promoteFills(ctx.pairId, ctx.tracker);
    this.pushSample(ctx.pairId, "favorite", ctx.favoriteAsk, nowMs);
    if (ctx.filledCheap < MIN_CLOB_SHARES) return false;
    return this.firstSellCheap(ctx.pairId, nowMs, ctx.cheapAsk ?? null, ctx.config) != null;
  }

  defendShares(ctx: DefendContext): number {
    const nowMs = clock(ctx.nowMs);
    this.promoteFills(ctx.pairId, ctx.tracker);
    this.pushSample(ctx.pairId, "favorite", ctx.favoriteAsk, nowMs);
    if (ctx.filledCheap < MIN_CLOB_SHARES) return 0;
    const rule = this.firstSellCheap(ctx.pairId, nowMs, ctx.cheapAsk ?? null, ctx.config);
    if (!rule) return 0;
    const shares = round2(ctx.filledCheap);
    if (shares < MIN_CLOB_SHARES) return 0;
    this.pendingSellCheap.set(ctx.pairId, rule.id);
    return shares;
  }

  hedgeAtPostTime(_ctx: HedgePostContext): HedgePostDecision {
    return { action: "skip", reason: "chart-rules-managed" };
  }

  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean {
    const nowMs = clock(ctx.nowMs);
    this.promoteFills(ctx.pairId, ctx.tracker);
    this.pushSample(ctx.pairId, "favorite", ctx.expensiveBid, nowMs, "bid");
    if (ctx.expensiveSize <= 0) return false;
    const elapsed = ctx.marketAgeMs / 1000;
    if (ctx.cheapFilled > 0) {
      this.clearLoss(ctx.pairId);
      return false;
    }
    for (const rule of this.rules) {
      if (rule.action !== "sell" || rule.token !== "favorite") continue;
      if (rule.sellAll === false) continue; // partial sells not implemented
      if (rule.once && this.fired.has(this.fireKey(ctx.pairId, rule.id))) continue;
      if (!inZone(elapsed, rule)) continue;
      if (rule.minElapsedSec != null && elapsed < rule.minElapsedSec) continue;
      if (!this.parentsReady(ctx.pairId, rule)) continue;
      if (rule.lossPct != null) {
        if (this.lossReady(ctx, rule, nowMs)) {
          this.pendingSellFav.set(ctx.pairId, rule.id);
          return true;
        }
        continue;
      }
      if (
        !this.signalReady(
          ctx.pairId,
          rule,
          nowMs,
          ctx.expensiveBid,
          "favorite",
          ctx.config,
        )
      ) {
        continue;
      }
      this.pendingSellFav.set(ctx.pairId, rule.id);
      return true;
    }
    return false;
  }

  private lossReady(
    ctx: EdgeSellContext,
    rule: NormalizedChartRule,
    nowMs: number,
  ): boolean {
    const key = this.fireKey(ctx.pairId, rule.id);
    if (ctx.expensiveBid === null || ctx.expensiveFillPrice <= 0) {
      this.lossStart.delete(key);
      return false;
    }
    const lossPct =
      ((ctx.expensiveBid - ctx.expensiveFillPrice) / ctx.expensiveFillPrice) *
      100;
    if (lossPct > -rule.lossPct!) {
      this.lossStart.delete(key);
      return false;
    }
    const start = this.lossStart.get(key) ?? nowMs;
    this.lossStart.set(key, start);
    const windowMs = rule.lossWindowMs ?? 10_000;
    return nowMs - start >= windowMs;
  }

  private buySize(
    config: BotConfig,
    rule: NormalizedChartRule,
    token: "cheap" | "favorite",
    price: number,
  ): number | null {
    if (rule.sizeUsdc != null) {
      return computeSize(rule.sizeUsdc, price, config.maxSharesPerOrder);
    }
    return token === "cheap"
      ? computeEdgeLeadCheapSize(config, price)
      : computeEdgeLeadEdgeSize(config, price);
  }

  private pickBuyToken(
    rule: NormalizedChartRule,
    books: TokenBook[],
    cheap: TokenBook | null,
    favorite: TokenBook | null,
    tracker: TradeTracker,
    pairId: string,
  ): TokenBook | null {
    if (rule.token === "favorite") return favorite;
    if (rule.afterFill === "favorite") {
      const claimed = edgeClaimedOutcome(tracker, pairId);
      if (!claimed) return null;
      return books.find((book) => book.outcome !== claimed) ?? null;
    }
    return cheap;
  }

  private afterFillReady(
    rule: NormalizedChartRule,
    tracker: TradeTracker,
    pairId: string,
  ): boolean {
    if (rule.afterFill === "favorite") {
      return tracker.getFilledExpensiveSizeForPair(pairId) > 0;
    }
    if (rule.afterFill === "cheap") {
      return tracker.getFilledCheapSizeForPair(pairId) > 0;
    }
    return true;
  }

  private firstSellCheap(
    pairId: string,
    nowMs: number,
    ask: number | null,
    config: BotConfig,
  ): NormalizedChartRule | null {
    const elapsed = this.elapsedSec(pairId, nowMs);
    for (const rule of this.rules) {
      if (rule.action !== "sell" || rule.token !== "cheap") continue;
      if (rule.sellAll === false) continue; // partial sells not implemented
      if (rule.once && this.fired.has(this.fireKey(pairId, rule.id))) continue;
      if (!inZone(elapsed, rule)) continue;
      if (rule.minElapsedSec != null && elapsed < rule.minElapsedSec) continue;
      if (!this.parentsReady(pairId, rule)) continue;
      if (!this.signalReady(pairId, rule, nowMs, ask, "cheap", config)) continue;
      return rule;
    }
    return null;
  }

  onBuyCommitted(opportunity: TradeOpportunity): void {
    const id = opportunity.chartRuleId;
    if (!id) return;
    const rule = this.rules.find((item) => item.id === id);
    if (!rule) return;
    this.posted.add(this.fireKey(opportunity.pairId, rule.id));
    this.markFired(opportunity.pairId, rule);
  }

  onSellExpensiveCommitted(pairId: string): void {
    this.commitPending(pairId, this.pendingSellFav);
  }

  onDefendCommitted(pairId: string): void {
    this.commitPending(pairId, this.pendingSellCheap);
  }

  private commitPending(pairId: string, pending: Map<string, string>): void {
    const id = pending.get(pairId);
    pending.delete(pairId);
    if (!id) return;
    const rule = this.rules.find((item) => item.id === id);
    if (rule) this.markSatisfied(pairId, rule);
  }

  /**
   * Rebuild posted / fired / satisfied for buy rules from the tracker.
   * Survives process restart / hot-swap: fills and resting posts are durable,
   * in-memory Sets are not. Heuristic is per-token-kind (favorite→expensive,
   * cheap→cheap): if several once-buys share a kind, a single fill marks all
   * of them — fail-closed against double entry in live.
   */
  private hydrateBuyStateFromTracker(
    pairId: string,
    tracker: TradeTracker,
  ): void {
    for (const rule of this.rules) {
      if (rule.action !== "buy") continue;
      const kind = rule.token === "favorite" ? "expensive" : "cheap";
      const key = this.fireKey(pairId, rule.id);
      const filled =
        kind === "expensive"
          ? tracker.getFilledExpensiveSizeForPair(pairId) > 0
          : tracker.getFilledCheapSizeForPair(pairId) > 0;
      const resting =
        tracker.getPostedOrdersForPair(pairId, kind).length > 0;
      if (!filled && !resting) continue;
      this.posted.add(key);
      if (rule.once) this.fired.add(key);
      if (filled) this.satisfied.add(key);
    }
  }

  private promoteFills(pairId: string, tracker: TradeTracker | undefined): void {
    // hydrateBuyStateFromTracker already marks posted / fired / satisfied
    // from durable fills + resting posts (covers restart and same-process fills).
    if (!tracker) return;
    this.hydrateBuyStateFromTracker(pairId, tracker);
  }

  private favoriteOutOfBandRule(
    pairId: string,
    nowMs: number,
  ): NormalizedChartRule | null {
    const elapsed = this.elapsedSec(pairId, nowMs);
    for (const rule of this.rules) {
      if (rule.action !== "buy" || rule.token !== "favorite") continue;
      if (!hasPriceBand(rule)) continue;
      if (!inZone(elapsed, rule)) continue;
      if (!this.parentsReady(pairId, rule)) continue;
      return rule;
    }
    return null;
  }

  private cheapOutOfBandRule(
    pairId: string,
    nowMs: number,
  ): NormalizedChartRule | null {
    const elapsed = this.elapsedSec(pairId, nowMs);
    for (const rule of this.rules) {
      if (rule.action !== "buy" || rule.token !== "cheap") continue;
      if (rule.outOfBand !== "cancel-lock") continue;
      if (!inZone(elapsed, rule)) continue;
      if (!this.parentsReady(pairId, rule)) continue;
      return rule;
    }
    return null;
  }

  private elapsedSec(pairId: string, nowMs: number): number {
    const cached = this.pairWindows.get(pairId);
    if (cached != null) return nowMs / 1000 - cached;
    const sep = pairId.lastIndexOf(":");
    const fromSlug = sep >= 0 ? parseWindowStart(pairId.slice(0, sep)) : null;
    if (fromSlug == null) return Number.POSITIVE_INFINITY;
    this.pairWindows.set(pairId, fromSlug);
    return nowMs / 1000 - fromSlug;
  }

  private signalReady(
    pairId: string,
    rule: NormalizedChartRule,
    nowMs: number,
    ask: number | null,
    outcome: string | null,
    config: BotConfig,
  ): boolean {
    const confirmN = rule.confirmTicks ?? 0;
    if (confirmN > 0) {
      if (ask == null || !outcome) return false;
      return this.confirm.push(
        this.fireKey(pairId, rule.id),
        ask,
        outcome,
        overlayConfirmConfig(rule, config),
      );
    }
    if (hasPriceBand(rule)) {
      if (ask == null) return false;
      // Cheap: same rounding as native cheapAskInBand / cancel-lock.
      const px = rule.token === "cheap" ? round2(ask) : ask;
      return inPriceBand(px, rule);
    }
    // Favorite sells trend on bids; buys and cheap sells trend on asks (defend path has ask only).
    const side =
      rule.action === "sell" && rule.token === "favorite" ? "bid" : "ask";
    const samples = this.samples.get(this.sampleKey(pairId, rule.token, side)) ?? [];
    return trendMatches(samples, nowMs, rule);
  }

  private pushSample(
    pairId: string,
    token: "cheap" | "favorite",
    px: number | null,
    nowMs: number,
    side: "ask" | "bid" = "ask",
  ): void {
    if (px == null || Number.isNaN(px) || !pairId) return;
    const key = this.sampleKey(pairId, token, side);
    const next = [...(this.samples.get(key) ?? []), { ts: nowMs, px }];
    const maxAge = this.rules.reduce(
      (m, r) => Math.max(m, r.lookbackMs),
      DEFAULT_LOOKBACK_MS,
    );
    this.samples.set(
      key,
      next.filter((s) => nowMs - s.ts <= maxAge * 2),
    );
  }

  private parentsReady(pairId: string, rule: NormalizedChartRule): boolean {
    return uniqueDependsOn(rule).every((id) =>
      this.satisfied.has(this.fireKey(pairId, id)),
    );
  }

  private markSatisfied(pairId: string, rule: NormalizedChartRule): void {
    this.satisfied.add(this.fireKey(pairId, rule.id));
    this.markFired(pairId, rule);
  }

  private markFired(pairId: string, rule: NormalizedChartRule): void {
    if (rule.once) this.fired.add(this.fireKey(pairId, rule.id));
  }

  private clearLoss(pairId: string): void {
    const prefix = `${pairId}::`;
    for (const key of [...this.lossStart.keys()]) {
      if (key.startsWith(prefix)) this.lossStart.delete(key);
    }
  }

  private sampleKey(
    pairId: string,
    token: "cheap" | "favorite",
    side: "ask" | "bid" = "ask",
  ): string {
    return `${pairId}::${token}::${side}`;
  }

  private fireKey(pairId: string, ruleId: string): string {
    return `${pairId}::${ruleId}`;
  }
}
