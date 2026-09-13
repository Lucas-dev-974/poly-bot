import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { BacktestPositionRow } from "../db/repositories.js";
import { createStrategy } from "../strategy/registry.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import { TradeTracker } from "../trade-tracker.js";
import type {
  SimulatedPosition,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "../types.js";
import {
  shouldCancelOrphanIndependentHedges,
  shouldPostIndependentHedge,
} from "../strategy/hedge-post.js";
import { isWithinMinutesBeforeClose } from "../utils/market.js";
import { MIN_CLOB_SHARES } from "../utils/prices.js";
import { buyFillAgainstBook, estimatedBuyCost, sellFillAgainstBook } from "./broker.js";
import { minutesLeft } from "./clock.js";
import { BacktestLedger, round2 } from "./ledger.js";
import { resolveWindowWinner } from "./resolve.js";
import {
  BacktestRestingBook,
  consumeAskLiquidity,
  remainingAskMap,
  takeAskLiquidity,
} from "./resting.js";
import type {
  BacktestResult,
  BacktestTradeRecord,
  BacktestWindowMeta,
  BacktestWindowResult,
} from "./types.js";
import { booksFromRows } from "./windows.js";

const YIELD_EVERY = 50;

export interface RunnerHooks {
  shouldCancel: () => boolean;
  onProgress: (current: number, total: number, eventSlug: string | null) => void;
}

export async function runBacktest(params: {
  runId: string;
  config: BotConfig;
  windows: BacktestWindowMeta[];
  repos?: Repositories;
  hooks: RunnerHooks;
  skippedIncomplete?: number;
  resolveWinner?: (
    slug: string,
    upTokenId: string | null,
    windowEnd: number,
  ) => Promise<{ winnerOutcomeIndex: number } | null>;
}): Promise<BacktestResult> {
  const { runId, config, repos, hooks } = params;
  const selected = [...params.windows].sort((a, b) => a.windowStart - b.windowStart);
  const strategy = createStrategy(config.strategyId, repos);
  const tracker = new TradeTracker();
  const ledger = new BacktestLedger(config.simulatedCapital);
  const resting = new BacktestRestingBook();
  const trades: BacktestTradeRecord[] = [];
  const capitalStart = ledger.getBalance();
  const skippedIncomplete = params.skippedIncomplete ?? 0;

  const events = new Map<string, UpDownEvent>();
  const tickIndex: Array<{ ts: number; slug: string }> = [];
  const booksBySlugTs = new Map<string, Map<number, TokenBook[]>>();

  for (const window of selected) {
    events.set(window.eventSlug, toEvent(window));
    const rows = repos?.bookSnapshots.bySlugAndRange(
      window.eventSlug,
      window.windowStart * 1000,
      window.windowEnd * 1000,
    ) ?? [];
    const byTs = booksFromRows(rows);
    booksBySlugTs.set(window.eventSlug, byTs);
    for (const ts of byTs.keys()) {
      tickIndex.push({ ts, slug: window.eventSlug });
    }
  }
  tickIndex.sort((a, b) => a.ts - b.ts || a.slug.localeCompare(b.slug));

  const finished = new Set<string>();
  let lastProgressSlug: string | null = null;
  let steps = 0;
  let i = 0;

  const settleEnded = async (endMs: number, inclusive: boolean): Promise<void> => {
    for (const window of selected) {
      if (finished.has(window.eventSlug)) continue;
      const closeAt = window.windowEnd * 1000;
      const due = inclusive ? closeAt <= endMs : closeAt < endMs;
      if (!due) continue;
      await closeWindow({
        runId,
        config,
        window,
        event: events.get(window.eventSlug)!,
        tracker,
        ledger,
        resting,
        repos,
        resolveWinner: params.resolveWinner,
      });
      finished.add(window.eventSlug);
      hooks.onProgress(finished.size, selected.length, window.eventSlug);
    }
  };

  const tickCtx = (slug: string, ts: number): void => {
    const event = events.get(slug);
    const books = booksBySlugTs.get(slug)?.get(ts);
    if (!event || !books || finished.has(slug)) return;
    lastProgressSlug = slug;
    processTick({
      runId,
      config,
      strategy,
      tracker,
      ledger,
      resting,
      event,
      books,
      nowMs: ts,
      trades,
      repos,
    });
  };

  while (i < tickIndex.length) {
    if (hooks.shouldCancel()) break;
    const ts = tickIndex[i].ts;

    // Fenêtres déjà terminées avant ce tick (trou ou fenêtre suivante).
    await settleEnded(ts, false);

    const batch: string[] = [];
    while (i < tickIndex.length && tickIndex[i].ts === ts) {
      if (hooks.shouldCancel()) break;
      if (++steps % YIELD_EVERY === 0) {
        await yieldTick();
        hooks.onProgress(finished.size, selected.length, lastProgressSlug);
      }
      batch.push(tickIndex[i].slug);
      i++;
    }
    if (hooks.shouldCancel()) break;

    const ending = new Set(
      selected
        .filter((w) => !finished.has(w.eventSlug) && w.windowEnd * 1000 <= ts)
        .map((w) => w.eventSlug),
    );

    for (const slug of batch) {
      if (ending.has(slug)) tickCtx(slug, ts);
    }
    await settleEnded(ts, true);
    for (const slug of batch) {
      tickCtx(slug, ts);
    }
  }

  for (const window of selected) {
    if (hooks.shouldCancel()) break;
    if (!finished.has(window.eventSlug)) {
      await closeWindow({
        runId,
        config,
        window,
        event: events.get(window.eventSlug)!,
        tracker,
        ledger,
        resting,
        repos,
        resolveWinner: params.resolveWinner,
      });
      finished.add(window.eventSlug);
    }
  }

  const windowResults: BacktestWindowResult[] = selected.map((window) => {
    const legs = [
      ...tracker.getOpenPositions(),
      ...tracker.getResolvedPositions(),
    ].filter((p) => p.eventSlug === window.eventSlug);
    const unresolved = legs.some((p) => p.status === "open");
    const pnl = unresolved
      ? null
      : round2(legs.reduce((sum, p) => sum + (p.pnl ?? 0), 0));
    return {
      eventSlug: window.eventSlug,
      pnl,
      tradeCount: trades.filter((t) => t.eventSlug === window.eventSlug && t.filled).length,
      unresolved,
    };
  });

  const unresolvedWindows = windowResults.filter((w) => w.unresolved).length;
  const realized = tracker.getRealizedPnl();

  return {
    runId,
    strategyId: config.strategyId,
    capitalStart,
    capitalEnd: ledger.getBalance(),
    pnl: round2(realized),
    windowsTested: selected.length,
    windowsSkippedIncomplete: skippedIncomplete,
    unresolvedWindows,
    fillCount: trades.filter((t) => t.filled).length,
    rejectCount: trades.filter((t) => !t.filled).length,
    coveredPairs: tracker.getCoveredCount(),
    uncoveredPairs: tracker.getUncoveredCount(),
    windows: windowResults,
  };
}

function toEvent(window: BacktestWindowMeta): UpDownEvent {
  const up = window.upTokenId ?? "up";
  const down = window.downTokenId ?? "down";
  return {
    title: window.eventTitle,
    slug: window.eventSlug,
    market: {
      conditionId: window.conditionId ?? "",
      slug: window.eventSlug,
      clobTokenIds: JSON.stringify([up, down]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      active: false,
      closed: true,
    },
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
  };
}

function processTick(ctx: {
  runId: string;
  config: BotConfig;
  strategy: TradingStrategy;
  tracker: TradeTracker;
  ledger: BacktestLedger;
  resting: BacktestRestingBook;
  event: UpDownEvent;
  books: TokenBook[];
  nowMs: number;
  trades: BacktestTradeRecord[];
  repos?: Repositories;
}): void {
  const tick = { ...ctx, filledThisTick: new Set<string>() };
  matchResting(tick);

  if (
    isWithinMinutesBeforeClose(
      minutesLeft(ctx.event.windowEnd, ctx.nowMs),
      ctx.config.minutesBeforeCloseMin,
      ctx.config.minutesBeforeCloseMax,
    )
  ) {
    manageRestingPolicy(tick);
    const opportunities = ctx.strategy.findOpportunities({
      config: ctx.config,
      tracker: ctx.tracker,
      event: ctx.event,
      books: ctx.books,
      nowMs: ctx.nowMs,
    });
    opportunities.sort((a, b) =>
      ctx.strategy.leadsWithEdge
        ? a.kind === b.kind
          ? 0
          : a.kind === "expensive"
            ? -1
            : 1
        : a.kind === b.kind
          ? 0
          : a.kind === "cheap"
            ? -1
            : 1,
    );
    for (const opp of opportunities) {
      executeOpp(tick, opp);
    }
  } else {
    manageRestingPolicy(tick);
  }
}

function matchResting(ctx: {
  strategy: TradingStrategy;
  tracker: TradeTracker;
  ledger: BacktestLedger;
  resting: BacktestRestingBook;
  event: UpDownEvent;
  books: TokenBook[];
  nowMs: number;
  trades: BacktestTradeRecord[];
  config: BotConfig;
  runId: string;
  repos?: Repositories;
  filledThisTick: Set<string>;
}): void {
  const remainingAsk = remainingAskMap(ctx.books);
  for (const { order, fill } of ctx.resting.matchBuys(ctx.event, ctx.books)) {
    if (!fill.filled || fill.fillPrice === undefined || fill.size === undefined) continue;
    // Ask crossed this tick. Remember the key even if capital/exposure skips
    // the fill, otherwise take-ask would cancel the GTC we still want to work.
    ctx.filledThisTick.add(order.key);
    const fillSize = takeAskLiquidity(remainingAsk, order.context.tokenId, fill.size);
    if (fillSize <= 0) continue;
    const cost = estimatedBuyCost(order.opportunity, fill.fillPrice, fillSize);
    const remaining = round2(order.context.size - fillSize);
    const remainingCost = remaining > 1e-9 ? round2(order.context.limitPrice * remaining) : 0;
    const otherReserved = ctx.resting.reservedNotional(order.key);
    if (!ctx.ledger.canAfford(cost + otherReserved + remainingCost)) continue;
    if (
      ctx.tracker.getOpenExposure() + otherReserved + cost + remainingCost >
      ctx.config.maxExposureUsdc
    ) {
      continue;
    }
    ctx.ledger.debit(cost);
    openFill(ctx, order.opportunity, fill.fillPrice, fillSize, "resting", "GTC");
    consumeAskLiquidity(remainingAsk, order.context.tokenId, fillSize);
    const leftover = ctx.resting.reduce(order.key, fillSize);
    if (leftover) {
      ctx.tracker.updatePostedRemainder(order.key, leftover.context.size, leftover.cost);
    } else {
      ctx.tracker.removePostedOrder(order.key);
    }
    ctx.trades.push(
      tradeFromOpp(order.opportunity, ctx.nowMs, true, null, "resting", fill.fillPrice, fillSize, "GTC"),
    );
    persistTrade(ctx, order.opportunity, ctx.nowMs, true, null, "resting", fill.fillPrice, fillSize, "GTC");
  }
}

function manageRestingPolicy(ctx: {
  config: BotConfig;
  strategy: TradingStrategy;
  tracker: TradeTracker;
  ledger: BacktestLedger;
  resting: BacktestRestingBook;
  event: UpDownEvent;
  books: TokenBook[];
  nowMs: number;
  trades: BacktestTradeRecord[];
  runId: string;
  repos?: Repositories;
  filledThisTick: Set<string>;
}): void {
  const pairId = `${ctx.event.slug}:${ctx.event.windowEnd}`;
  if (ctx.strategy.leadsWithEdge) {
    const edgeOrders = ctx.resting.listForPair(pairId, "expensive");
    for (const order of edgeOrders) {
      const book =
        ctx.books.find((b) => b.tokenId === order.context.tokenId) ??
        ctx.books.find((b) => b.outcome === order.context.outcome);
      const action = ctx.strategy.edgeOrderAction({
        config: ctx.config,
        edgeBook: book,
        pairId,
        nowMs: ctx.nowMs,
        tracker: ctx.tracker,
      });
      if (action === "cancel-lock") {
        cancelResting(ctx, order.key, "edge-off-band");
      }
    }
  }

  for (const order of ctx.resting.listForPair(pairId, "cheap")) {
    const book =
      ctx.books.find((b) => b.tokenId === order.context.tokenId) ??
      ctx.books.find((b) => b.outcome === order.context.outcome);
    const favoriteBook =
      ctx.books.find((b) => b.outcome !== order.context.outcome) ?? undefined;
    const action = ctx.strategy.cheapOrderAction({
      config: ctx.config,
      limitPrice: order.context.limitPrice,
      cheapBook: book,
      favoriteAsk: favoriteBook?.bestAsk ?? null,
      pairId,
      nowMs: ctx.nowMs,
      tracker: ctx.tracker,
    });
    if (action === "keep") continue;
    // Ask crossed this tick and we already took the TOB slice: keep the
    // remainder as a maker bid. take-ask would cancel it and countLegsByKind
    // would block a re-post — the rest of the GTC would vanish.
    if (action === "take-ask" && ctx.filledThisTick.has(order.key)) continue;
    // Mirror live replaceMarketableCheap: cancel+unmark, then this tick's
    // findOpportunities / executeOpp can take the ask. Filling here AND
    // unmarking would double-buy the same cheap.
    cancelResting(ctx, order.key, action);
    cancelOrphanHedgesAfterCheapGone(ctx, pairId);
  }

  defendCheapLegs(ctx, pairId);
  sellExpensiveEdge(ctx, pairId);
}

function sellExpensiveEdge(
  ctx: {
    config: BotConfig;
    strategy: TradingStrategy;
    tracker: TradeTracker;
    ledger: BacktestLedger;
    resting: BacktestRestingBook;
    books: TokenBook[];
    event: UpDownEvent;
    nowMs: number;
    trades: BacktestTradeRecord[];
    runId: string;
    repos?: Repositories;
  },
  pairId: string,
): void {
  if (!ctx.strategy.leadsWithEdge) return;
  const expensiveTokenId = ctx.tracker.getExpensiveTokenForPair(pairId);
  if (!expensiveTokenId) return;
  const expensiveFillPrice = ctx.tracker.getExpensiveFillPriceForPair(pairId);
  if (expensiveFillPrice === null) return;
  const expensiveSize = ctx.tracker.getFilledExpensiveSizeForPair(pairId);
  if (expensiveSize <= 0) return;
  const cheapFilled = ctx.tracker.getFilledCheapSizeForPair(pairId);
  const expensiveBook = ctx.books.find((b) => b.tokenId === expensiveTokenId);
  const expensiveBid = expensiveBook?.bestBid ?? null;
  const marketAgeMs = Math.max(0, (ctx.nowMs - ctx.event.windowStart * 1000));

  if (
    !ctx.strategy.shouldSellExpensiveEdge({
      config: ctx.config,
      tracker: ctx.tracker,
      pairId,
      expensiveBid,
      expensiveFillPrice,
      expensiveSize,
      cheapFilled,
      marketAgeMs,
      nowMs: ctx.nowMs,
    })
  ) {
    return;
  }
  if (expensiveBid === null || expensiveBid <= 0) return;

  const fill = sellFillAgainstBook(0, expensiveSize, expensiveBook);
  if (fill.filled && fill.fillPrice !== undefined && fill.size !== undefined) {
    ctx.ledger.credit(round2(fill.fillPrice * fill.size));
    ctx.tracker.closePairExpensiveAsSold(pairId, fill.fillPrice, fill.size, ctx.nowMs);
    ctx.strategy.onSellExpensiveCommitted?.(pairId);
    const outcome = expensiveBook?.outcome ?? "Up";
    ctx.trades.push({
      ts: ctx.nowMs,
      eventSlug: ctx.event.slug,
      kind: "expensive",
      outcome,
      side: "SELL",
      limitPrice: fill.fillPrice,
      fillPrice: fill.fillPrice,
      size: fill.size,
      filled: true,
      reason: "edge-sell",
      fillReason: "marketable",
      orderType: "FOK",
      pairId,
      pnl: null,
    });
    ctx.repos?.backtestTrades.insert({
      runId: ctx.runId,
      ts: ctx.nowMs,
      eventSlug: ctx.event.slug,
      kind: "expensive",
      outcome,
      side: "SELL",
      limitPrice: fill.fillPrice,
      fillPrice: fill.fillPrice,
      size: fill.size,
      filled: 1,
      reason: "edge-sell",
      fillReason: "marketable",
      orderType: "FOK",
      pairId,
      pnl: null,
    });
    // A resting edge GTC would keep filling after the sell.
    for (const order of ctx.resting.listForPair(pairId, "expensive")) {
      cancelResting(ctx, order.key, "edge-sell");
    }
  }
}

function defendCheapLegs(
  ctx: {
    config: BotConfig;
    strategy: TradingStrategy;
    tracker: TradeTracker;
    ledger: BacktestLedger;
    resting: BacktestRestingBook;
    books: TokenBook[];
    event: UpDownEvent;
    nowMs: number;
    trades: BacktestTradeRecord[];
    runId: string;
    repos?: Repositories;
  },
  pairId: string,
  opts?: { force?: boolean },
): void {
  // Let the strategy decide: native edge-lead returns false from shouldDefend,
  // but a custom chart-rules strategy with leadsWithEdge may define a
  // "sell cheap" zone that must fire. Short-circuiting here would silently
  // suppress all cheap sells for any edge-lead-like custom strategy.
  const cheapTokenId = ctx.tracker.getCheapTokenForPair(pairId);
  const cheapBook = cheapTokenId
    ? ctx.books.find((b) => b.tokenId === cheapTokenId)
    : undefined;
  const favorite = ctx.books.find((b) => (cheapTokenId ? b.tokenId !== cheapTokenId : b !== cheapBook));
  const favoriteAsk = favorite?.bestAsk ?? null;
  const filledCheap = ctx.tracker.getFilledCheapSizeForPair(pairId);
  const filledExpensive = ctx.tracker.getFilledExpensiveSizeForPair(pairId);
  const defendCtx = {
    config: ctx.config,
    favoriteAsk,
    filledCheap,
    filledExpensive,
    pairId,
    nowMs: ctx.nowMs,
    cheapAsk: cheapBook?.bestAsk ?? null,
    tracker: ctx.tracker,
  };
  if (!opts?.force && !ctx.strategy.shouldDefend(defendCtx)) return;
  const shares = ctx.strategy.defendShares(defendCtx);
  if (shares < MIN_CLOB_SHARES) return;
  const fill = sellFillAgainstBook(0, shares, cheapBook);
  if (fill.filled && fill.fillPrice !== undefined && fill.size !== undefined) {
    ctx.ledger.credit(round2(fill.fillPrice * fill.size));
    ctx.tracker.closePairCheapAsSold(pairId, fill.fillPrice, fill.size, ctx.nowMs);
    ctx.strategy.onDefendCommitted?.(pairId);
    const outcome = cheapBook?.outcome ?? "Down";
    ctx.trades.push({
      ts: ctx.nowMs,
      eventSlug: ctx.event.slug,
      kind: "cheap",
      outcome,
      side: "SELL",
      limitPrice: fill.fillPrice,
      fillPrice: fill.fillPrice,
      size: fill.size,
      filled: true,
      reason: "defend",
      fillReason: "marketable",
      orderType: "FOK",
      pairId,
      pnl: null,
    });
    ctx.repos?.backtestTrades.insert({
      runId: ctx.runId,
      ts: ctx.nowMs,
      eventSlug: ctx.event.slug,
      kind: "cheap",
      outcome,
      side: "SELL",
      limitPrice: fill.fillPrice,
      fillPrice: fill.fillPrice,
      size: fill.size,
      filled: 1,
      reason: "defend",
      fillReason: "marketable",
      orderType: "FOK",
      pairId,
      pnl: null,
    });
    // Remainder cheap GTC would keep filling after the sell; a resting hedge
    // would become a naked favorite. Live cancels those GTCs after defendPair.
    for (const kind of ["cheap", "expensive"] as const) {
      for (const order of ctx.resting.listForPair(pairId, kind)) {
        cancelResting(ctx, order.key, "defend");
      }
    }
  }
}

function executeOpp(
  ctx: {
    config: BotConfig;
    strategy: TradingStrategy;
    tracker: TradeTracker;
    ledger: BacktestLedger;
    resting: BacktestRestingBook;
    event: UpDownEvent;
    books: TokenBook[];
    nowMs: number;
    trades: BacktestTradeRecord[];
    runId: string;
    repos?: Repositories;
  },
  opportunity: TradeOpportunity,
): void {
  if (ctx.config.minMinutesBeforeCloseToBuy !== null) {
    if (minutesLeft(opportunity.event.windowEnd, ctx.nowMs) < ctx.config.minMinutesBeforeCloseToBuy) {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "too-close-to-close", null));
      return;
    }
  }

  const bypassCheapFillGate =
    ctx.strategy.leadsWithEdge ||
    (ctx.strategy.independentHedgeGrid === true &&
      ctx.config.requireCheapFillBeforeExpensive === false);
  if (
    opportunity.kind === "expensive" &&
    ctx.tracker.getFilledCheapSizeForPair(opportunity.pairId) === 0 &&
    !bypassCheapFillGate
  ) {
    ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "no-committed-cheap", null));
    return;
  }

  const useFOK =
    opportunity.orderType === "FOK" ||
    (opportunity.kind === "expensive" &&
      ctx.config.expensiveOrderType === "FOK" &&
      !ctx.strategy.leadsWithEdge);

  // Ask-lock dual-FOK preflight: only take cheap if the expensive ask can
  // fill the same size on this tick's book. Otherwise skip (no one-legged).
  if (
    opportunity.kind === "cheap" &&
    opportunity.orderType === "FOK" &&
    ctx.config.arbAskLockOnly
  ) {
    const other = ctx.books.find((b) => b.tokenId !== opportunity.token.tokenId);
    if (!other || other.bestAsk == null) {
      ctx.trades.push(
        tradeFromOpp(opportunity, ctx.nowMs, false, "ask-lock-no-hedge-book", null, undefined, undefined, "FOK"),
      );
      return;
    }
    const hedgeProbe = buyFillAgainstBook(
      other.bestAsk,
      opportunity.size,
      other,
      "marketable",
      true,
    );
    if (!hedgeProbe.filled || (hedgeProbe.size ?? 0) + 1e-9 < opportunity.size) {
      ctx.trades.push(
        tradeFromOpp(opportunity, ctx.nowMs, false, "ask-lock-hedge-unfillable", null, undefined, undefined, "FOK"),
      );
      return;
    }
    const cheapProbe = buyFillAgainstBook(
      opportunity.price,
      opportunity.size,
      ctx.books.find((b) => b.tokenId === opportunity.token.tokenId),
      "marketable",
      true,
    );
    if (!cheapProbe.filled || (cheapProbe.size ?? 0) + 1e-9 < opportunity.size) {
      ctx.trades.push(
        tradeFromOpp(opportunity, ctx.nowMs, false, "ask-lock-cheap-unfillable", null, undefined, undefined, "FOK"),
      );
      return;
    }
  }

  let limit = opportunity.price;
  if (
    opportunity.kind === "expensive" &&
    !ctx.strategy.leadsWithEdge &&
    ctx.strategy.independentHedgeGrid === true
  ) {
    const freshAsk =
      ctx.books.find((b) => b.tokenId === opportunity.token.tokenId)?.bestAsk ??
      opportunity.token.bestAsk;
    const band = shouldPostIndependentHedge(
      freshAsk,
      opportunity.price,
      ctx.config.expensiveBuyMin,
      ctx.config.expensiveBuyMax,
    );
    if (!band.ok) {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, band.reason, null));
      return;
    }
  } else if (
    opportunity.kind === "expensive" &&
    !ctx.strategy.leadsWithEdge &&
    !ctx.strategy.independentHedgeGrid
  ) {
    const freshAsk =
      ctx.books.find((b) => b.tokenId === opportunity.token.tokenId)?.bestAsk ??
      opportunity.token.bestAsk;
    const decision = ctx.strategy.hedgeAtPostTime({
      config: ctx.config,
      tracker: ctx.tracker,
      pairId: opportunity.pairId,
      freshAsk,
      nowMs: ctx.nowMs,
    });
    if (decision.action === "defend") {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, decision.reason, null));
      defendCheapLegs(ctx, opportunity.pairId, { force: true });
      // Policy A tradeKey stays marked (enqueue). No unmark-on-fail: that
      // re-queued every book tick inside the same window. Band defend still
      // covers ask > expensiveBuyMax later.
      return;
    }
    if (decision.action === "skip") {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, decision.reason, null));
      // Dust / covered / unreachable-with-hedge-off: keep marked (no retry spam).
      return;
    }
    limit = decision.price;
    opportunity = { ...opportunity, price: decision.price };
  }

  const book = ctx.books.find((b) => b.tokenId === opportunity.token.tokenId);
  const marketable = buyFillAgainstBook(limit, opportunity.size, book, "marketable", useFOK);
  const fillPrice = marketable.fillPrice ?? limit;
  const size = marketable.size ?? opportunity.size;
  const fillCost = estimatedBuyCost(opportunity, fillPrice, size);
  const otherReserved = ctx.resting.reservedNotional();

  if (useFOK) {
    if (ctx.tracker.getOpenExposure() + otherReserved + fillCost > ctx.config.maxExposureUsdc) {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "exposure-cap", null, undefined, undefined, "FOK"));
      return;
    }
    if (!ctx.ledger.canAfford(fillCost + otherReserved)) {
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "insufficient-capital", null, undefined, undefined, "FOK"));
      return;
    }
    if (!marketable.filled) {
      ctx.tracker.incrementRetry(opportunity.tradeKey);
      if (ctx.tracker.getRetryCount(opportunity.tradeKey) >= ctx.config.simMaxRetryAttempts) {
        ctx.tracker.mark(opportunity.tradeKey);
      }
      ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "no-fill", null, undefined, undefined, "FOK"));
      return;
    }
    ctx.ledger.debit(fillCost);
    openFill(ctx, opportunity, fillPrice, size, "marketable", "FOK");
    ctx.strategy.onBuyCommitted?.(opportunity);
    ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, true, null, "marketable", fillPrice, size, "FOK"));
    persistTrade(ctx, opportunity, ctx.nowMs, true, null, "marketable", fillPrice, size, "FOK");
    return;
  }

  const gtcFillSize = marketable.filled ? size : 0;
  const gtcRemainder = round2(opportunity.size - gtcFillSize);
  const remainderCost = gtcRemainder > 1e-9 ? round2(limit * gtcRemainder) : 0;
  const cashOut = marketable.filled ? fillCost : 0;
  if (ctx.tracker.getOpenExposure() + otherReserved + cashOut + remainderCost > ctx.config.maxExposureUsdc) {
    ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "exposure-cap", null, undefined, undefined, "GTC"));
    return;
  }
  if (!ctx.ledger.canAfford(cashOut + otherReserved + remainderCost)) {
    ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, false, "insufficient-capital", null, undefined, undefined, "GTC"));
    return;
  }

  if (marketable.filled) {
    ctx.ledger.debit(fillCost);
    openFill(ctx, opportunity, fillPrice, size, "marketable", "GTC");
    ctx.tracker.mark(opportunity.tradeKey);
    ctx.strategy.onBuyCommitted?.(opportunity);
    ctx.trades.push(tradeFromOpp(opportunity, ctx.nowMs, true, null, "marketable", fillPrice, size, "GTC"));
    persistTrade(ctx, opportunity, ctx.nowMs, true, null, "marketable", fillPrice, size, "GTC");
    if (gtcRemainder > 1e-9) {
      postResting(ctx, { ...opportunity, size: gtcRemainder }, remainderCost);
    }
    return;
  }

  postResting(ctx, opportunity, remainderCost);
  ctx.strategy.onBuyCommitted?.(opportunity);
  persistTrade(ctx, opportunity, ctx.nowMs, false, "resting", null, null, opportunity.size, "GTC");
}

function postResting(
  ctx: {
    config: BotConfig;
    tracker: TradeTracker;
    resting: BacktestRestingBook;
  },
  opportunity: TradeOpportunity,
  cost: number,
): void {
  ctx.resting.post(opportunity, cost, ctx.config.strategyId);
  ctx.tracker.recordPostedOrder(
    opportunity.tradeKey,
    opportunity.event.slug,
    opportunity.event.windowEnd,
    cost,
    undefined,
    {
      eventSlug: opportunity.event.slug,
      windowEnd: opportunity.event.windowEnd,
      tokenId: opportunity.token.tokenId,
      outcome: opportunity.token.outcome,
      outcomeIndex: opportunity.token.outcomeIndex,
      kind: opportunity.kind,
      limitPrice: opportunity.price,
      size: opportunity.size,
      pairId: opportunity.pairId,
      eventTitle: opportunity.event.title,
      bestAskAtFill: opportunity.token.bestAsk,
      strategyId: ctx.config.strategyId,
    },
  );
  ctx.tracker.mark(opportunity.tradeKey);
}

function openFill(
  ctx: {
    tracker: TradeTracker;
    config: BotConfig;
    nowMs: number;
    runId: string;
    repos?: Repositories;
  },
  opportunity: TradeOpportunity,
  fillPrice: number,
  size: number,
  fillReason: "marketable" | "resting",
  orderType: "GTC" | "FOK",
): void {
  const position: SimulatedPosition = {
    id: `${opportunity.tradeKey}:${ctx.nowMs}`,
    eventSlug: opportunity.event.slug,
    eventTitle: opportunity.event.title,
    tokenId: opportunity.token.tokenId,
    outcome: opportunity.token.outcome,
    outcomeIndex: opportunity.token.outcomeIndex,
    kind: opportunity.kind,
    limitPrice: opportunity.price,
    fillPrice,
    size,
    cost: round2(fillPrice * size),
    windowEnd: opportunity.event.windowEnd,
    status: "open",
    fillReason,
    pairId: opportunity.pairId,
    bestAskAtFill: opportunity.token.bestAsk,
    orderType,
    strategyId: ctx.config.strategyId,
  };
  ctx.tracker.mark(opportunity.tradeKey);
  ctx.tracker.addOpenPosition(position);
  ctx.tracker.attachLeg(position);
}


function cancelOrphanHedgesAfterCheapGone(
  ctx: {
    config: BotConfig;
    strategy: TradingStrategy;
    tracker: TradeTracker;
    resting: BacktestRestingBook;
  },
  pairId: string,
): void {
  if (ctx.strategy.leadsWithEdge) return;
  const filledCheap = ctx.tracker.getFilledCheapSizeForPair(pairId);
  if (filledCheap > 0) return;
  if (ctx.strategy.independentHedgeGrid) {
    const restingCheap = ctx.tracker.getPostedOrdersForPair(pairId, "cheap").length;
    if (
      !shouldCancelOrphanIndependentHedges({
        filledCheap,
        restingCheapCount: restingCheap,
        requireCheapFillBeforeExpensive: ctx.config.requireCheapFillBeforeExpensive,
      })
    ) {
      return;
    }
  }
  for (const hedge of [...ctx.resting.listForPair(pairId, "expensive")]) {
    cancelResting(ctx, hedge.key, "orphan-hedge");
  }
}

function cancelResting(
  ctx: {
    tracker: TradeTracker;
    resting: BacktestRestingBook;
  },
  key: string,
  _reason: string,
): void {
  ctx.resting.remove(key);
  ctx.tracker.removePostedOrder(key);
  ctx.tracker.unmark(key);
}

function tradeFromOpp(
  opportunity: TradeOpportunity,
  ts: number,
  filled: boolean,
  reason: string | null,
  fillReason: "marketable" | "resting" | null,
  fillPrice?: number,
  size?: number,
  orderType: "GTC" | "FOK" = "GTC",
): BacktestTradeRecord {
  return {
    ts,
    eventSlug: opportunity.event.slug,
    kind: opportunity.kind,
    outcome: opportunity.token.outcome,
    side: "BUY",
    limitPrice: opportunity.price,
    fillPrice: fillPrice ?? null,
    size: size ?? opportunity.size,
    filled,
    reason,
    fillReason,
    orderType,
    pairId: opportunity.pairId,
    pnl: null,
  };
}

function persistTrade(
  ctx: { runId: string; repos?: Repositories },
  opportunity: TradeOpportunity,
  ts: number,
  filled: boolean,
  reason: string | null,
  fillReason: "marketable" | "resting" | null,
  fillPrice: number | null,
  size: number,
  orderType: string,
): void {
  ctx.repos?.backtestTrades.insert({
    runId: ctx.runId,
    ts,
    eventSlug: opportunity.event.slug,
    kind: opportunity.kind,
    outcome: opportunity.token.outcome,
    side: "BUY",
    limitPrice: opportunity.price,
    fillPrice,
    size,
    filled: filled ? 1 : 0,
    reason,
    fillReason,
    orderType,
    pairId: opportunity.pairId,
    pnl: null,
  });
}

async function closeWindow(params: {
  runId: string;
  config: BotConfig;
  window: BacktestWindowMeta;
  event: UpDownEvent;
  tracker: TradeTracker;
  ledger: BacktestLedger;
  resting: BacktestRestingBook;
  repos?: Repositories;
  resolveWinner?: (
    slug: string,
    upTokenId: string | null,
    windowEnd: number,
  ) => Promise<{ winnerOutcomeIndex: number } | null>;
}): Promise<void> {
  for (const order of params.resting.listForSlug(params.window.eventSlug)) {
    params.resting.remove(order.key);
    params.tracker.removePostedOrder(order.key);
    params.tracker.unmark(order.key);
  }

  const winner = params.resolveWinner
    ? await params.resolveWinner(
        params.window.eventSlug,
        params.window.upTokenId,
        params.window.windowEnd,
      )
    : await resolveWindowWinner(
        params.config,
        params.repos,
        params.window.eventSlug,
        params.window.upTokenId,
        params.window.windowEnd,
      );

  const open = params.tracker
    .getOpenPositions()
    .filter((p) => p.eventSlug === params.window.eventSlug);

  if (winner) {
    const resolvedAt = params.window.windowEnd * 1000;
    for (const position of open) {
      const won = position.outcomeIndex === winner.winnerOutcomeIndex;
      const credit = won ? position.size : 0;
      params.ledger.credit(credit);
      position.status = won ? "won" : "lost";
      position.resolvedAt = resolvedAt;
      position.pnl = round2(credit - position.cost);
      params.tracker.resolvePosition(position);
    }
    const pair = params.tracker.getPair(`${params.window.eventSlug}:${params.window.windowEnd}`);
    if (pair && pair.status !== "resolved") {
      const allResolved =
        pair.cheapLegs.every((leg) => leg.status !== "open") &&
        pair.expensiveLegs.every((leg) => leg.status !== "open");
      if (allResolved) params.tracker.finalizePair(pair);
    }
  }

  flushPositions(params.runId, params.window.eventSlug, params.tracker, params.repos);
}

function flushPositions(
  runId: string,
  eventSlug: string,
  tracker: TradeTracker,
  repos?: Repositories,
): void {
  const legs = [
    ...tracker.getOpenPositions(),
    ...tracker.getResolvedPositions(),
  ].filter((p) => p.eventSlug === eventSlug);
  for (const position of legs) {
    if (position.status === "sold") {
      // Une position vendue génère deux marqueurs sur le graphique :
      //  1. L'achat (BUY) au prix et timestamp d'origine.
      //  2. La vente (SELL) au sellPrice et au timestamp de résolution.
      // Sans cette séparation, l'upsert (INSERT OR REPLACE) écraserait la
      // ligne BUY avec la ligne SELL, et seul le marqueur de vente
      // apparaîtrait — l'achat serait invisible.
      const buyTs = buyTimestampFromId(position.id);
      const buyRow: BacktestPositionRow = {
        id: `${runId}:${position.id}`,
        runId,
        ts: buyTs,
        eventSlug: position.eventSlug,
        eventTitle: position.eventTitle,
        tokenId: position.tokenId,
        outcome: position.outcome,
        outcomeIndex: position.outcomeIndex,
        kind: position.kind,
        side: "BUY",
        limitPrice: position.limitPrice,
        fillPrice: position.fillPrice,
        size: position.size,
        cost: position.cost,
        windowEnd: position.windowEnd,
        status: position.status,
        resolvedAt: position.resolvedAt ?? null,
        pnl: position.pnl ?? null,
        fillReason: position.fillReason,
        pairId: position.pairId,
        bestAskAtFill: position.bestAskAtFill ?? null,
        orderType: position.orderType ?? null,
        strategyId: position.strategyId ?? null,
        sellPrice: position.sellPrice ?? null,
      };
      repos?.backtestPositions.upsert(buyRow);

      const sellRow: BacktestPositionRow = {
        id: `${runId}:${position.id}:sold-${position.resolvedAt ?? 0}`,
        runId,
        ts: position.resolvedAt ?? buyTs,
        eventSlug: position.eventSlug,
        eventTitle: position.eventTitle,
        tokenId: position.tokenId,
        outcome: position.outcome,
        outcomeIndex: position.outcomeIndex,
        kind: position.kind,
        side: "SELL",
        limitPrice: position.limitPrice,
        fillPrice: position.sellPrice ?? position.fillPrice,
        size: position.size,
        cost: position.cost,
        windowEnd: position.windowEnd,
        status: position.status,
        resolvedAt: position.resolvedAt ?? null,
        pnl: position.pnl ?? null,
        fillReason: position.fillReason,
        pairId: position.pairId,
        bestAskAtFill: position.bestAskAtFill ?? null,
        orderType: position.orderType ?? null,
        strategyId: position.strategyId ?? null,
        sellPrice: position.sellPrice ?? null,
      };
      repos?.backtestPositions.upsert(sellRow);
      continue;
    }

    const row: BacktestPositionRow = {
      id: `${runId}:${position.id}`,
      runId,
      ts: fillTsFromPosition(position),
      eventSlug: position.eventSlug,
      eventTitle: position.eventTitle,
      tokenId: position.tokenId,
      outcome: position.outcome,
      outcomeIndex: position.outcomeIndex,
      kind: position.kind,
      side: "BUY",
      limitPrice: position.limitPrice,
      fillPrice: position.fillPrice,
      size: position.size,
      cost: position.cost,
      windowEnd: position.windowEnd,
      status: position.status,
      resolvedAt: position.resolvedAt ?? null,
      pnl: position.pnl ?? null,
      fillReason: position.fillReason,
      pairId: position.pairId,
      bestAskAtFill: position.bestAskAtFill ?? null,
      orderType: position.orderType ?? null,
      strategyId: position.strategyId ?? null,
      sellPrice: position.sellPrice ?? null,
    };
    repos?.backtestPositions.upsert(row);
  }
}

/** Extrait le timestamp d'achat (epoch ms) depuis l'id d'une position. */
function buyTimestampFromId(positionId: string): number {
  const suffix = positionId.split(":").pop();
  const parsed = Number(suffix);
  if (Number.isFinite(parsed) && parsed > 1_000_000_000_000) return parsed;
  return 0;
}

function fillTsFromPosition(position: SimulatedPosition): number {
  const suffix = position.id.split(":").pop();
  const parsed = Number(suffix);
  if (Number.isFinite(parsed) && parsed > 1_000_000_000_000) return parsed;
  return position.resolvedAt ?? 0;
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
