import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { BacktestPositionRow } from "../db/repositories.js";
import { createStrategy } from "../strategy/registry.js";
import { TradeTracker } from "../trade-tracker.js";
import type { SimulatedPosition, TokenBook, UpDownEvent } from "../types.js";
import { BacktestLedger, round2 } from "./ledger.js";
import { BacktestRestingBook } from "./resting.js";
import { resolveWindowWinner } from "./resolve.js";
import { processTick } from "./tick-executor.js";
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
      sink: {
        pushTrade: (record) => trades.push(record),
        persistTrade: (row) => repos?.backtestTrades.insert(row),
        onPositionOpened: () => {},
      },
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
  const wins = tracker.getCumulativeWins();
  const losses = tracker.getCumulativeLosses();

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
    wins,
    losses,
    winRate: wins + losses > 0 ? round2(wins / (wins + losses)) : null,
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