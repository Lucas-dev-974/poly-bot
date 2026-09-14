import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { bus } from "../src/dashboard/events.js";
import { runBacktest } from "../src/backtest/runner.js";
import type { Repositories } from "../src/db/index.js";
import type { BookSnapshotRow } from "../src/db/repositories.js";
import { testConfig } from "./helpers.js";

const START = 1_800_000_000;
const END = START + 900;
const SLUG = `btc-updown-15m-${START}`;

function row(
  ts: number,
  outcomeIndex: number,
  ask: number,
  bid = ask - 0.01,
  askSize = 50,
): BookSnapshotRow {
  return {
    ts,
    eventSlug: SLUG,
    tokenId: outcomeIndex === 0 ? "t-up" : "t-down",
    outcome: outcomeIndex === 0 ? "Up" : "Down",
    outcomeIndex,
    bestBid: bid,
    bestAsk: ask,
    bestAskSize: askSize,
  };
}

function ticks(count: number, downAsk: (i: number) => number): BookSnapshotRow[] {
  const rows: BookSnapshotRow[] = [];
  for (let i = 0; i < count; i++) {
    const ts = START * 1000 + i * 1000;
    rows.push(row(ts, 0, 0.9), row(ts, 1, downAsk(i)));
  }
  return rows;
}

describe("backtest engine", () => {
  const seen: string[] = [];
  const unsub = bus.subscribe((event) => {
    seen.push(event.type);
  });
  after(() => unsub());

  it("fills cheap then hedges after the fill, without emitting simulatedBalance", async () => {
    const rows = ticks(5, () => 0.09);
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => rows,
      },
      backtestTrades: { insert: () => undefined },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "test-run",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.12,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        expensiveOrderType: "FOK",
        expensiveOrderUsdc: 6,
        simulatedCapital: 50,
        maxExposureUsdc: 45,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 5,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 5 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 0 }),
    });

    assert.ok(result.fillCount >= 2, `expected cheap+hedge fills, got ${result.fillCount}`);
    assert.equal(seen.includes("simulatedBalance"), false);
    assert.equal(result.unresolvedWindows, 0);
  });

  it("settles a window before the next window trades at the same timestamp", async () => {
    const slugA = SLUG;
    const slugB = `btc-updown-15m-${END}`;
    const rowsA = ticks(3, () => 0.09);
    const rowsB: BookSnapshotRow[] = [];
    for (let i = 0; i < 3; i++) {
      const ts = END * 1000 + i * 1000;
      rowsB.push(
        row(ts, 0, 0.9),
        { ...row(ts, 1, 0.09), eventSlug: slugB, tokenId: "t-down-b" },
      );
      rowsB[rowsB.length - 2] = { ...rowsB[rowsB.length - 2], eventSlug: slugB, tokenId: "t-up-b" };
    }
    const repos = {
      bookSnapshots: {
        bySlugAndRange: (slug: string) => (slug === slugA ? rowsA : rowsB),
      },
      backtestTrades: { insert: () => undefined },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const windowMeta = (
      eventSlug: string,
      windowStart: number,
      windowEnd: number,
      up: string,
      down: string,
    ) => ({
      eventSlug,
      eventTitle: "BTC",
      windowStart,
      windowEnd,
      complete: true,
      tickCount: 3,
      expectedTicks: 900,
      maxGapMs: 1000,
      coveragePct: 3 / 900,
      gapCount: 0,
      upTokenId: up,
      downTokenId: down,
      conditionId: "0xcond",
    });

    const result = await runBacktest({
      runId: "test-settle",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.12,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        expensiveOrderType: "FOK",
        enableExpensiveHedge: false,
        cheapOrderUsdc: 5,
        simulatedCapital: 2.5,
        maxExposureUsdc: 45,
      }),
      windows: [
        windowMeta(slugA, START, END, "t-up", "t-down"),
        windowMeta(slugB, END, END + 900, "t-up-b", "t-down-b"),
      ],
      repos,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async (slug) =>
        slug === slugA ? { winnerOutcomeIndex: 1 } : { winnerOutcomeIndex: 1 },
    });

    const filledA = result.windows.find((w) => w.eventSlug === slugA)?.tradeCount ?? 0;
    const filledB = result.windows.find((w) => w.eventSlug === slugB)?.tradeCount ?? 0;
    assert.ok(filledA >= 1, `window A should fill, got ${filledA}`);
    assert.ok(filledB >= 1, `window B should fill after A settles, got ${filledB}`);
    assert.equal(result.unresolvedWindows, 0);
  });

  it("does not double-count resting notional when a GTC later fills", async () => {
    const rows: BookSnapshotRow[] = [];
    rows.push(row(START * 1000, 0, 0.9), row(START * 1000, 1, 0.11));
    rows.push(row(START * 1000 + 1000, 0, 0.9), row(START * 1000 + 1000, 1, 0.09));
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => rows,
      },
      backtestTrades: { insert: () => undefined },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "test-resting-exposure",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.1,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        enableExpensiveHedge: false,
        cheapOrderUsdc: 5,
        simulatedCapital: 50,
        maxExposureUsdc: 2.5,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 2,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 2 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 1 }),
    });

    assert.ok(result.fillCount >= 1, `resting GTC should fill, got ${result.fillCount}`);
  });

  it("keeps a GTC remainder on the book across thin ticks until fully filled", async () => {
    const trades: Array<{ filled: number; kind: string; side: string; size: number }> = [];
    const rows: BookSnapshotRow[] = [
      row(START * 1000, 0, 0.9),
      row(START * 1000, 1, 0.11),
      row(START * 1000 + 1000, 0, 0.9),
      row(START * 1000 + 1000, 1, 0.09, 0.08, 5),
      row(START * 1000 + 2000, 0, 0.9),
      row(START * 1000 + 2000, 1, 0.09, 0.08, 8),
      row(START * 1000 + 3000, 0, 0.9),
      row(START * 1000 + 3000, 1, 0.09, 0.08, 50),
    ];
    const result = await runBacktest({
      runId: "test-gtc-remainder",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.1,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        enableExpensiveHedge: false,
        cheapOrderUsdc: 5,
        maxSharesPerOrder: 20,
        simulatedCapital: 50,
        maxExposureUsdc: 45,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 4,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 4 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos: {
        bookSnapshots: { bySlugAndRange: () => rows },
        backtestTrades: {
          insert: (row: { filled: number; kind: string; side: string; size: number }) => {
            trades.push(row);
          },
        },
        backtestPositions: { upsert: () => undefined },
        marketResolutions: { get: () => undefined, upsert: () => undefined },
      } as unknown as Repositories,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 1 }),
    });
    const cheapFills = trades.filter((t) => t.filled === 1 && t.kind === "cheap" && t.side === "BUY");
    const totalSize = Math.round(cheapFills.reduce((sum, t) => sum + t.size, 0) * 100) / 100;
    assert.ok(cheapFills.length >= 2, `expected several partial fills, got ${cheapFills.length}`);
    assert.equal(totalSize, 20);
    assert.equal(result.unresolvedWindows, 0);
  });

  it("posts the unfilled slice of a marketable GTC and fills it later", async () => {
    const trades: Array<{ filled: number; kind: string; side: string; size: number }> = [];
    const rows: BookSnapshotRow[] = [
      row(START * 1000, 0, 0.9),
      row(START * 1000, 1, 0.09, 0.08, 6),
      row(START * 1000 + 1000, 0, 0.9),
      row(START * 1000 + 1000, 1, 0.09, 0.08, 50),
    ];
    await runBacktest({
      runId: "test-marketable-remainder",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.12,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        enableExpensiveHedge: false,
        cheapOrderUsdc: 5,
        maxSharesPerOrder: 20,
        simulatedCapital: 50,
        maxExposureUsdc: 45,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 2,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 2 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos: {
        bookSnapshots: { bySlugAndRange: () => rows },
        backtestTrades: {
          insert: (row: { filled: number; kind: string; side: string; size: number }) => {
            trades.push(row);
          },
        },
        backtestPositions: { upsert: () => undefined },
        marketResolutions: { get: () => undefined, upsert: () => undefined },
      } as unknown as Repositories,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 1 }),
    });

    const cheapFills = trades.filter((t) => t.filled === 1 && t.kind === "cheap" && t.side === "BUY");
    const totalSize = Math.round(cheapFills.reduce((sum, t) => sum + t.size, 0) * 100) / 100;
    assert.ok(cheapFills.length >= 2, `expected marketable slice + remainder, got ${cheapFills.length}`);
    assert.equal(totalSize, 20);
  });

  it("cancels a GTC remainder without unwinding already filled shares", async () => {
    const trades: Array<{ filled: number; kind: string; side: string; size: number }> = [];
    const rows: BookSnapshotRow[] = [
      row(START * 1000, 0, 0.9),
      row(START * 1000, 1, 0.11),
      row(START * 1000 + 1000, 0, 0.9),
      row(START * 1000 + 1000, 1, 0.09, 0.08, 5),
      row(START * 1000 + 2000, 0, 0.99),
      row(START * 1000 + 2000, 1, 0.11),
    ];
    await runBacktest({
      runId: "test-cancel-remainder",
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.1,
        expensiveBuyMin: 0.85,
        expensiveBuyMax: 0.95,
        pairLockMax: 0.99,
        enableExpensiveHedge: true,
        expensiveOrderType: "FOK",
        cheapOrderUsdc: 5,
        maxSharesPerOrder: 20,
        simulatedCapital: 50,
        maxExposureUsdc: 45,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 3,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 3 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos: {
        bookSnapshots: { bySlugAndRange: () => rows },
        backtestTrades: {
          insert: (row: { filled: number; kind: string; side: string; size: number }) => {
            trades.push(row);
          },
        },
        backtestPositions: { upsert: () => undefined },
        marketResolutions: { get: () => undefined, upsert: () => undefined },
      } as unknown as Repositories,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 1 }),
    });

    const cheapFills = trades.filter((t) => t.filled === 1 && t.kind === "cheap" && t.side === "BUY");
    const totalSize = Math.round(cheapFills.reduce((sum, t) => sum + t.size, 0) * 100) / 100;
    assert.equal(totalSize, 5);
  });

  it("reverse posts the hedge grid without a filled cheap leg", async () => {
    // Down ask stays above the cheap band → cheap GTC rest, never fill.
    // Up ask 0.95 sits on the hedge grid → expensive must still POST.
    const rows = ticks(5, () => 0.5);
    const persisted: Array<{ filled: number; kind: string; reason: string | null }> = [];
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => rows,
      },
      backtestTrades: {
        insert: (row: { filled: number; kind: string; reason: string | null }) => {
          persisted.push(row);
        },
      },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "test-reverse-independent-hedge",
      config: testConfig({
        strategyId: "reverse",
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.1,
        expensiveBuyMin: 0.9,
        expensiveBuyMax: 0.95,
        enableExpensiveHedge: true,
        requireCheapFillBeforeExpensive: false,
        reverseCheapOrderUsdc: 10,
        expensiveOrderUsdc: 50,
        expensiveOrderType: "GTC",
        maxSharesPerOrder: 90,
        maxOpenPositionsPerSide: 6,
        maxExposureUsdc: 340,
        simulatedCapital: 1000,
        simRequireCoveredPair: false,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 5,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 5 / 900,
          gapCount: 0,
          upTokenId: "t-up",
          downTokenId: "t-down",
          conditionId: "0xcond",
        },
      ],
      repos,
      hooks: {
        shouldCancel: () => false,
        onProgress: () => undefined,
      },
      resolveWinner: async () => ({ winnerOutcomeIndex: 0 }),
    });

    const cheapFills = persisted.filter((t) => t.kind === "cheap" && t.filled === 1);
    const expensivePosted = persisted.filter((t) => t.kind === "expensive");
    assert.equal(cheapFills.length, 0, "cheap must stay unfilled so C2 would have blocked hedge");
    assert.ok(
      expensivePosted.length > 0,
      `expected reverse hedge posts without cheap fill, got ${expensivePosted.length}`,
    );
    assert.ok(result.rejectCount < 50, `reject storm? ${result.rejectCount}`);
  });
});
