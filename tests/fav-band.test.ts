import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { FavBandStrategy } from "../src/strategy/fav-band-strategy.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("fav-band strategy", () => {
  it("parses and registers fav-band", () => {
    assert.equal(parseStrategyId("fav-band"), "fav-band");
    assert.equal(createStrategy("fav-band").id, "fav-band");
  });

  it("emits FOK buy on favorite when ask in band after min elapsed", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      enableExpensiveHedge: false,
      arbAskLockOnly: true, // sticky flag must not block emission
      favBandOrderUsdc: 15,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      maxSharesPerOrder: 40,
    });
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 250) * 1000;
    const tracker = new TradeTracker();
    // Up ask 0.75 = favorite, Down 0.26
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].token.outcome, "Up");
    assert.equal(opps[0].price, 0.75);
  });

  it("skips when elapsed too early", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandMinElapsedSec: 200,
      favBandOrderUsdc: 15,
    });
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 50) * 1000;
    const opps = strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when favorite ask outside band", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 0,
      favBandOrderUsdc: 15,
    });
    const event = testEvent();
    const nowMs = (event.windowStart + 300) * 1000;
    // favorite at 0.92 — outside band
    const opps = strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.92, 0.1, 100),
      nowMs,
    });
    assert.equal(opps.length, 0);
  });

  it("does not stack a second entry after a filled leg (inverse off)", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandMinElapsedSec: 0,
      favBandOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const position: SimulatedPosition = {
      id: "filled",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.75,
      fillPrice: 0.75,
      size: 20,
      cost: 15,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    };
    tracker.addOpenPosition(position);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("coerces sticky arbAskLockOnly / hedge off in validateConfigCoherence", () => {
    const config = testConfig({
      strategyId: "fav-band",
      arbAskLockOnly: true,
      enableExpensiveHedge: true,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
    });
    validateConfigCoherence(config);
    assert.equal(config.arbAskLockOnly, false);
    assert.equal(config.enableExpensiveHedge, false);
  });
});

describe("fav-band hedge-inverse (resting GTC, incremental)", () => {
  const inverseConfig = testConfig({
    strategyId: "fav-band",
    favBandMinElapsedSec: 0,
    favBandOrderUsdc: 15,
    maxSharesPerOrder: 40,
    maxOpenPositionsPerSide: 2,
    maxExposureUsdc: 60,
    favBandInverseEnabled: true,
    favBandInverseAskMax: 0.2,
    favBandInverseShareRatio: 2,
    favBandInverseOrderUsdc: 15,
  });

  function fillFavorite(event: ReturnType<typeof testEvent>): TradeTracker {
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const position: SimulatedPosition = {
      id: "fav-filled",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.75,
      fillPrice: 0.75,
      size: 20,
      cost: 15,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    };
    tracker.addOpenPosition(position);
    return tracker;
  }

  it("posts a resting GTC at the limit on the opposite token sized 2x the favorite", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const event = testEvent();
    const tracker = fillFavorite(event);
    // Favorite 0.72 (in band), Down ask 0.28 — the GTC rests BELOW the ask,
    // no marketable take (incremental maker fills only).
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.72, 0.28, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].orderType, undefined); // default GTC
    assert.equal(opps[0].token.outcome, "Down");
    assert.equal(opps[0].price, 0.2); // limit = favBandInverseAskMax
    // 2 × 20 filled favorite shares = 40 (inside budget/maxShares caps).
    assert.equal(opps[0].size, 40);
  });

  it("does not emit the inverse leg when the feature is disabled", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      ...inverseConfig,
      favBandInverseEnabled: false,
    });
    const event = testEvent();
    const tracker = fillFavorite(event);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.72, 0.2, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("caps the inverse size to the inverse budget (budget < ratio × favorite)", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      ...inverseConfig,
      favBandInverseOrderUsdc: 4,
    });
    const event = testEvent();
    const tracker = fillFavorite(event);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.72, 0.2, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 1);
    // 4 USDC / 0.20 limit = 20 shares (cap), not 2 × 20.
    assert.equal(opps[0].size, 20);
  });

  it("sizes the inverse leg even when the favorite ask left the entry band", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const event = testEvent();
    const tracker = fillFavorite(event);
    // Favorite 0.88 (out of band) — the filled leg is what matters now.
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.88, 0.35, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].token.outcome, "Down");
    assert.equal(opps[0].price, 0.2);
    assert.equal(opps[0].size, 40);
  });

  it("skips the inverse leg when the favorite is not filled", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const event = testEvent();
    const tracker = new TradeTracker();
    // Favorite 0.88 (out of band) → no entry, no inverse (not filled yet).
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.88, 0.2, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("does not stack the inverse GTC beyond maxOpenPositionsPerSide", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const event = testEvent();
    const tracker = fillFavorite(event);
    const pairId = `${event.slug}:${event.windowEnd}`;
    // 2 legs already open on the Down side → side guard blocks a third.
    for (const id of ["inv-a", "inv-b"]) {
      tracker.addOpenPosition({
        id,
        eventSlug: event.slug,
        eventTitle: event.title,
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        kind: "cheap",
        limitPrice: 0.2,
        fillPrice: 0.2,
        size: 5,
        cost: 1,
        windowEnd: event.windowEnd,
        status: "open",
        fillReason: "marketable",
        pairId,
      });
    }
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.72, 0.2, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("does not re-stack the inverse GTC while a posted one is still working", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const event = testEvent();
    const tracker = fillFavorite(event);
    const pairId = `${event.slug}:${event.windowEnd}`;
    // Posted working inverse GTC on the Down token (40 sh @ 0.20 resting).
    tracker.recordPostedOrder(
      "key-inv",
      event.slug,
      event.windowEnd,
      8,
      "order-1",
      {
        eventSlug: event.slug,
        windowEnd: event.windowEnd,
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        kind: "cheap",
        limitPrice: 0.2,
        size: 40,
        pairId,
        eventTitle: event.title,
        bestAskAtFill: 0.28,
        strategyId: "fav-band",
      },
    );
    // Whatever the Down ask (resting below, crossing, favorite out-of-band):
    // the posted order owns the inverse leg — no second emission.
    for (const downAsk of [0.3, 0.19]) {
      for (const upAsk of [0.72, 0.92]) {
        const opps = strategy.findOpportunities({
          config,
          tracker,
          event,
          books: books(upAsk, downAsk, 100),
          nowMs: (event.windowStart + 300) * 1000,
        });
        assert.equal(
          opps.length,
          0,
          `stacked GTC re-emitted (up=${upAsk}, down=${downAsk})`,
        );
      }
    }
  });

  it("keeps the resting inverse GTC (cheapOrderAction: keep, never cancelled)", () => {
    const strategy = new FavBandStrategy();
    const config = inverseConfig;
    const action = strategy.cheapOrderAction({
      config,
      limitPrice: 0.2,
      cheapBook: books(0.72, 0.35)[1],
      favoriteAsk: 0.65,
      pairId: "pair",
    });
    assert.equal(action, "keep");
  });

  it("validates the inverse config coherence", () => {
    // OK case.
    const ok = testConfig({
      strategyId: "fav-band",
      favBandInverseEnabled: true,
      favBandInverseAskMax: 0.2,
      favBandInverseShareRatio: 2,
      favBandInverseOrderUsdc: 5,
      maxOpenPositionsPerSide: 2,
    });
    assert.doesNotThrow(() => validateConfigCoherence(ok));

    // Ask max out of range.
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            ...ok,
            favBandInverseAskMax: 0.6,
          }),
        ),
      /favBandInverseAskMax/,
    );
    // Budget below CLOB minimum.
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            ...ok,
            favBandInverseOrderUsdc: 0.5,
          }),
        ),
      /fav-band inverse/,
    );
    // Side count too low.
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            ...ok,
            maxOpenPositionsPerSide: 1,
          }),
        ),
      /maxOpenPositionsPerSide/,
    );
  });
});

describe("fav-band hedge-inverse end-to-end (backtest runner)", () => {
  const START = 1_800_000_000;
  const END = START + 900;
  const SLUG = `btc-updown-15m-${START}`;

  function row(
    ts: number,
    outcomeIndex: number,
    ask: number,
    bid = ask - 0.01,
    askSize = 50,
  ): import("../src/db/repositories.js").BookSnapshotRow {
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

  // Tick 1-5: down ask 0.30 (no inverse fill possible at limit 0.20).
  // Tick 6+: down ask 0.19 → the resting inverse GTC crosses and fills.
  function ticks(): import("../src/db/repositories.js").BookSnapshotRow[] {
    const rows: import("../src/db/repositories.js").BookSnapshotRow[] = [];
    for (let i = 0; i < 8; i++) {
      const ts = (START + 200 + i) * 1000;
      rows.push(row(ts, 0, 0.72), row(ts, 1, i < 5 ? 0.3 : 0.19));
    }
    return rows;
  }

  it("fills the inverse GTC incrementally after the favorite fill", async () => {
    const { runBacktest } = await import("../src/backtest/runner.js");
    const tradeRows: Array<{
      filled: number;
      kind: string;
      side: string;
      reason: string | null;
      size: number;
    }> = [];
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => ticks(),
      },
      backtestTrades: {
        insert: (row: {
          filled: number;
          kind: string;
          side: string;
          reason: string | null;
          size: number;
        }) => {
          tradeRows.push(row);
        },
      },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "inv-run",
      config: testConfig({
        strategyId: "fav-band",
        favBandAskMin: 0.7,
        favBandAskMax: 0.85,
        favBandMinElapsedSec: 200,
        favBandOrderUsdc: 15,
        maxSharesPerOrder: 40,
        maxOpenPositionsPerSide: 2,
        maxExposureUsdc: 60,
        simulatedCapital: 100,
        minMinutesBeforeCloseToBuy: null,
        favBandInverseEnabled: true,
        favBandInverseAskMax: 0.2,
        favBandInverseShareRatio: 2,
        favBandInverseOrderUsdc: 15,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 8,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 8 / 900,
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

    const buyFills = tradeRows.filter((t) => t.filled === 1 && t.side === "BUY");
    const favFill = buyFills.find((t) => t.size > 20); // 15/0.72 ≈ 20.83
    const inverseFill = buyFills.find(
      (t) => t.fillPrice === 0.2 && t.size <= 40 && t.fillReason === "resting",
    );
    assert.ok(favFill, `expected the favorite entry fill, got ${JSON.stringify(tradeRows)}`);
    assert.ok(
      inverseFill,
      `expected the resting inverse GTC fill @ 0.20, got ${JSON.stringify(tradeRows)}`,
    );
    assert.equal(result.unresolvedWindows, 0);
  });
});

describe("fav-band whipsaw filter", () => {
  it("skips entry when max intra flips exceeded", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      enableExpensiveHedge: false,
      favBandOrderUsdc: 15,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 0,
      maxSharesPerOrder: 40,
      favBandWhipsawEnabled: true,
      favBandWhipsawPauseAfterLosses: null,
      favBandWhipsawMaxScore: null,
      favBandWhipsawMaxIntraFlips: 2,
    });
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 250) * 1000;
    const tracker = new TradeTracker();
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.26, 0.75, 100),
      nowMs: nowMs + 1000,
    });
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs: nowMs + 2000,
    });
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs: nowMs + 3000,
    });
    assert.equal(opps.length, 0);
  });

  it("allows entry when whipsaw disabled despite flips", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      enableExpensiveHedge: false,
      favBandOrderUsdc: 15,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 0,
      maxSharesPerOrder: 40,
      favBandWhipsawEnabled: false,
      favBandWhipsawMaxIntraFlips: 1,
    });
    const event = testEvent(1_800_000_100);
    const nowMs = (event.windowStart + 250) * 1000;
    const tracker = new TradeTracker();
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.26, 0.75, 100),
      nowMs: nowMs + 1000,
    });
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs: nowMs + 2000,
    });
    assert.ok(opps.length >= 1);
  });
});

describe("fav-band deterioration exit", () => {
  function filledTracker(
    event: ReturnType<typeof testEvent>,
    entryPrice = 0.65,
  ): TradeTracker {
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition({
      id: "fav-filled",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: entryPrice,
      fillPrice: entryPrice,
      size: 20,
      cost: entryPrice * 20,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    return tracker;
  }

  const exitConfig = testConfig({
    strategyId: "fav-band",
    favBandAskMin: 0.7,
    favBandAskMax: 0.85,
    favBandMinElapsedSec: 0,
    favBandOrderUsdc: 15,
    maxSharesPerOrder: 40,
    favBandExitEnabled: true,
    favBandExitMinLowerHighDrop: 0.02,
    favBandExitRetraceRatio: 0.25,
    favBandExitConsecutive: 2,
    favBandExitLookbackMs: 120_000,
    favBandExitMinElapsedSec: 0,
    favBandExitLossOnly: true,
    favBandExitSwitchEnabled: false,
  });

  function defendCtx(
    tracker: TradeTracker,
    cheapAsk: number | null,
    favoriteAsk: number | null,
    event: ReturnType<typeof testEvent>,
  ) {
    return {
      config: exitConfig,
      favoriteAsk,
      filledCheap: 20,
      filledExpensive: 0,
      pairId: `${event.slug}:${event.windowEnd}`,
      cheapAsk,
      tracker,
      nowMs: (event.windowStart + 400) * 1000,
    };
  }

  function feedAsks(
    strategy: FavBandStrategy,
    tracker: TradeTracker,
    event: ReturnType<typeof testEvent>,
    asks: number[],
  ): void {
    for (const ask of asks) {
      strategy.shouldDefend(defendCtx(tracker, ask, 0.9 - ask, event));
    }
  }

  function armedStrategy(event: ReturnType<typeof testEvent>, entry = 0.65) {
    const strategy = new FavBandStrategy();
    const tracker = filledTracker(event, entry);
    strategy.onBuyCommitted({
      ...({} as TradeOpportunity),
      pairId: `${event.slug}:${event.windowEnd}`,
      token: { tokenId: "t-up" } as TradeOpportunity["token"],
      event,
      price: entry,
    });
    return { strategy, tracker };
  }

  it("fires after two confirmed lower lows (0.65 → 0.55 bounce 0.60 → 0.48 bounce 0.50)", () => {
    const event = testEvent(1_800_000_000);
    const { strategy, tracker } = armedStrategy(event);
    // 0.55 trough + 0.60 bounce (50% of the 10¢ drop) freezes plus-bas #1.
    // Break of 0.55 then bounce off 0.48 freezes plus-bas #2.
    feedAsks(strategy, tracker, event, [0.55, 0.6, 0.48, 0.5]);
    const ctx = defendCtx(tracker, 0.5, 0.41, event);
    assert.equal(strategy.shouldDefend(ctx), true);
    assert.equal(strategy.defendShares(ctx), 20);
  });

  it("does not fire on a single confirmed plus-bas", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.55, 0.6]);
    const ctx = defendCtx(tracker, 0.59, 0.32, event);
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("does not fire on a one-impulse dump (one plus-bas, no sequence)", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.5, 0.52]);
    const ctx = defendCtx(tracker, 0.52, 0.39, event);
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("resets the chain after reclaiming the structure high", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.55, 0.6]);
    feedAsks(strategy, tracker, event, [0.66]);
    const ctx = defendCtx(tracker, 0.64, 0.27, event);
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("does not fire when favBandExitEnabled is false", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.55, 0.6, 0.48, 0.5]);
    const ctx = {
      ...defendCtx(tracker, 0.5, 0.41, event),
      config: { ...exitConfig, favBandExitEnabled: false },
    };
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("does not fire while the held ask stays above the entry price (loss-only)", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.78, 0.7, 0.73, 0.67, 0.68]);
    const ctx = defendCtx(tracker, 0.68, 0.23, event);
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("does not fire when the sequence is stale (outside lookback)", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.55, 0.6]);
    const ctx = {
      ...defendCtx(tracker, 0.59, 0.32, event),
      nowMs: (event.windowStart + 700) * 1000,
    };
    assert.equal(strategy.shouldDefend(ctx), false);
  });

  it("is idempotent: repeated identical calls do not double count", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.55, 0.55, 0.6, 0.6, 0.48, 0.48, 0.5, 0.5]);
    const ctx = defendCtx(tracker, 0.5, 0.41, event);
    assert.equal(strategy.shouldDefend(ctx), true);
    assert.equal(strategy.defendShares(ctx), 20);
  });

  it("confirms a later lower-low on a 1-tick bounce (waterfall / stairs)", () => {
    const event = testEvent();
    const { strategy, tracker } = armedStrategy(event);
    feedAsks(strategy, tracker, event, [0.58, 0.61, 0.52, 0.53]);
    const ctx = defendCtx(tracker, 0.53, 0.38, event);
    assert.equal(strategy.shouldDefend(ctx), true);
  });

  it("validates the exit config coherence", () => {
    assert.doesNotThrow(() =>
      validateConfigCoherence(
        testConfig({
          strategyId: "fav-band",
          favBandExitEnabled: true,
          favBandExitSwitchEnabled: true,
          favBandExitSwitchOrderUsdc: 15,
          maxOpenPositionsPerSide: 2,
        }),
      ),
    );
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            strategyId: "fav-band",
            favBandExitEnabled: true,
            favBandExitConsecutive: 1,
          }),
        ),
      /favBandExitConsecutive/,
    );
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            strategyId: "fav-band",
            favBandExitEnabled: true,
            favBandExitRetraceRatio: 1.5,
          }),
        ),
      /favBandExitRetraceRatio/,
    );
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({
            strategyId: "fav-band",
            favBandExitEnabled: true,
            favBandExitSwitchEnabled: true,
            maxOpenPositionsPerSide: 1,
          }),
        ),
      /maxOpenPositionsPerSide/,
    );
  });
});

describe("fav-band deterioration exit end-to-end (backtest runner)", () => {
  const START = 1_800_000_000;
  const END = START + 900;
  const SLUG = `btc-updown-15m-${START}`;

  function row(
    ts: number,
    outcomeIndex: number,
    ask: number,
    bid = ask - 0.01,
    askSize = 50,
  ): import("../src/db/repositories.js").BookSnapshotRow {
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

  // Entry band [0.60, 0.85] on Up; then two confirmed plus-bas:
  // 0.64 → 0.58 bounce 0.61 → 0.52 bounce 0.54.
  function ticks(): import("../src/db/repositories.js").BookSnapshotRow[] {
    const rows: import("../src/db/repositories.js").BookSnapshotRow[] = [];
    const upAsks = [0.64, 0.64, 0.64, 0.64, 0.58, 0.61, 0.52, 0.54];
    const downAsks = [0.36, 0.36, 0.36, 0.36, 0.42, 0.39, 0.48, 0.46];
    for (let i = 0; i < 8; i++) {
      const ts = (START + 200 + i) * 1000;
      rows.push(row(ts, 0, upAsks[i]), row(ts, 1, downAsks[i]));
    }
    return rows;
  }

  it("sells the position on a sequence of lower lows instead of riding to resolution", async () => {
    const { runBacktest } = await import("../src/backtest/runner.js");
    const tradeRows: Array<{
      filled: number;
      kind: string;
      side: string;
      reason: string | null;
      size: number;
      fillPrice: number | null;
    }> = [];
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => ticks(),
      },
      backtestTrades: {
        insert: (row2: {
          filled: number;
          kind: string;
          side: string;
          reason: string | null;
          size: number;
          fillPrice: number | null;
        }) => {
          tradeRows.push(row2);
        },
      },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "exit-run",
      config: testConfig({
        strategyId: "fav-band",
        favBandAskMin: 0.6,
        favBandAskMax: 0.85,
        favBandMinElapsedSec: 200,
        favBandOrderUsdc: 15,
        maxSharesPerOrder: 40,
        maxExposureUsdc: 60,
        simulatedCapital: 100,
        minMinutesBeforeCloseToBuy: null,
        minutesBeforeCloseMin: 0,
        minutesBeforeCloseMax: 15,
        favBandExitEnabled: true,
        favBandExitMinLowerHighDrop: 0.02,
        favBandExitRetraceRatio: 0.25,
        favBandExitConsecutive: 2,
        favBandExitLookbackMs: 120_000,
        favBandExitMinElapsedSec: 0,
        favBandExitLossOnly: true,
        favBandExitSwitchEnabled: false,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 8,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 8 / 900,
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

    const buys = tradeRows.filter((t) => t.filled === 1 && t.side === "BUY");
    const sells = tradeRows.filter((t) => t.filled === 1 && t.side === "SELL");
    assert.ok(buys.length >= 1, `expected an entry fill, got ${JSON.stringify(tradeRows)}`);
    assert.ok(sells.length >= 1, `expected a defend SELL, got ${JSON.stringify(tradeRows)}`);
    assert.equal(sells[0].reason, "defend");
    assert.equal(result.unresolvedWindows, 0);
  });
});

describe("fav-band exit + switch end-to-end (backtest runner)", () => {
  const START = 1_800_000_000;
  const END = START + 900;
  const SLUG = `btc-updown-15m-${START}`;

  function row(
    ts: number,
    outcomeIndex: number,
    ask: number,
    bid = ask - 0.01,
    askSize = 50,
  ): import("../src/db/repositories.js").BookSnapshotRow {
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

  // Entry Up at 0.64 (band [0.60,0.85]); two plus-bas 0.64→0.58 bounce 0.61
  // →0.52 bounce 0.54 (exit fires ~tick 8); Down ask RISES as the favorite
  // flips down — the switch buys the rising Down token at its current ask.
  function ticks(): import("../src/db/repositories.js").BookSnapshotRow[] {
    const rows: import("../src/db/repositories.js").BookSnapshotRow[] = [];
    const upAsks = [0.64, 0.64, 0.64, 0.64, 0.58, 0.61, 0.52, 0.54, 0.54];
    const downAsks = [0.36, 0.36, 0.36, 0.36, 0.42, 0.39, 0.48, 0.46, 0.52];
    for (let i = 0; i < 9; i++) {
      const ts = (START + 200 + i) * 1000;
      rows.push(row(ts, 0, upAsks[i]), row(ts, 1, downAsks[i]));
    }
    return rows;
  }

  it("FOK-buys the opposite token right after the exit sell", async () => {
    const { runBacktest } = await import("../src/backtest/runner.js");
    const tradeRows: Array<{
      filled: number;
      kind: string;
      side: string;
      reason: string | null;
      size: number;
      fillPrice: number | null;
      outcome: string;
    }> = [];
    const repos = {
      bookSnapshots: {
        bySlugAndRange: () => ticks(),
      },
      backtestTrades: {
        insert: (row2: {
          filled: number;
          kind: string;
          side: string;
          reason: string | null;
          size: number;
          fillPrice: number | null;
          outcome: string;
        }) => {
          tradeRows.push(row2);
        },
      },
      backtestPositions: { upsert: () => undefined },
      marketResolutions: { get: () => undefined, upsert: () => undefined },
    } as unknown as Repositories;

    const result = await runBacktest({
      runId: "switch-run",
      config: testConfig({
        strategyId: "fav-band",
        favBandAskMin: 0.6,
        favBandAskMax: 0.85,
        favBandMinElapsedSec: 200,
        favBandOrderUsdc: 15,
        maxSharesPerOrder: 40,
        maxOpenPositionsPerSide: 2,
        maxExposureUsdc: 60,
        simulatedCapital: 100,
        minMinutesBeforeCloseToBuy: null,
        minutesBeforeCloseMin: 0,
        minutesBeforeCloseMax: 15,
        favBandExitEnabled: true,
        favBandExitMinLowerHighDrop: 0.02,
        favBandExitRetraceRatio: 0.25,
        favBandExitConsecutive: 2,
        favBandExitLookbackMs: 120_000,
        favBandExitMinElapsedSec: 0,
        favBandExitLossOnly: true,
        favBandExitSwitchEnabled: true,
        favBandExitSwitchOrderUsdc: 15,
      }),
      windows: [
        {
          eventSlug: SLUG,
          eventTitle: "BTC",
          windowStart: START,
          windowEnd: END,
          complete: true,
          tickCount: 9,
          expectedTicks: 900,
          maxGapMs: 1000,
          coveragePct: 9 / 900,
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

    const buys = tradeRows.filter((t) => t.filled === 1 && t.side === "BUY");
    const sells = tradeRows.filter((t) => t.filled === 1 && t.side === "SELL");
    assert.ok(sells.length >= 1, `expected the exit SELL, got ${JSON.stringify(tradeRows)}`);
    // The switch buy is on the DOWN token (the opposite of the sold Up leg).
    const switchBuy = buys.filter((t) => t.outcome === "Down");
    assert.ok(
      switchBuy.length >= 1,
      `expected the opposite-token switch BUY, got ${JSON.stringify(tradeRows)}`,
    );
    assert.equal(result.unresolvedWindows, 0);
  });
});
