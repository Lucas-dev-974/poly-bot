import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findOpportunities } from "../src/strategy.js";
import { ArbStrategy } from "../src/strategy/arb-strategy.js";
import { BarbellSizing } from "../src/strategy/barbell-sizing.js";
import { BarbellStrategy } from "../src/strategy/barbell-strategy.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import type { HedgePostContext } from "../src/strategy/trading-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

function addFill(
  tracker: TradeTracker,
  event: ReturnType<typeof testEvent>,
  kind: "cheap" | "expensive",
  size: number,
  fillPrice: number,
  tokenId = kind === "cheap" ? "t-down" : "t-up",
  outcome = kind === "cheap" ? "Down" : "Up",
): void {
  const pairId = `${event.slug}:${event.windowEnd}`;
  const position: SimulatedPosition = {
    id: `test-${kind}-${size}-${fillPrice}`,
    eventSlug: event.slug,
    eventTitle: event.title,
    tokenId,
    outcome,
    outcomeIndex: kind === "cheap" ? 1 : 0,
    kind,
    limitPrice: fillPrice,
    fillPrice,
    size,
    cost: fillPrice * size,
    windowEnd: event.windowEnd,
    status: "open",
    fillReason: "marketable",
    pairId,
  };
  tracker.addOpenPosition(position);
}

function hedgeCtx(
  tracker: TradeTracker,
  event: ReturnType<typeof testEvent>,
  freshAsk: number | null,
  overrides: Partial<ReturnType<typeof testConfig>> = {},
): HedgePostContext {
  const config = testConfig({ expensiveOrderUsdc: 15, ...overrides });
  const pairId = `${event.slug}:${event.windowEnd}`;
  return { config, tracker, pairId, freshAsk };
}

describe("parseStrategyId", () => {
  it("accepts case-insensitive known ids", () => {
    assert.equal(parseStrategyId("ARB"), "arb");
    assert.equal(parseStrategyId(" barbell "), "barbell");
  });

  it("throws on unknown ids", () => {
    assert.throws(() => parseStrategyId("nope"), /Invalid strategyId/);
  });
});

describe("createStrategy", () => {
  it("returns the same cheap/hedge opportunities as the arb barrel", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({ expensiveOrderUsdc: 15 });
    addFill(tracker, event, "cheap", 10, 0.08);
    const ctx = { config, tracker, event, books: books(0.87, 0.08) };
    const barrel = findOpportunities(config, tracker, event, ctx.books);
    const viaRegistry = createStrategy("arb").findOpportunities(ctx);
    assert.deepEqual(
      viaRegistry.map((o) => ({ kind: o.kind, price: o.price, size: o.size })),
      barrel.map((o) => ({ kind: o.kind, price: o.price, size: o.size })),
    );
  });
});

describe("ArbStrategy interface", () => {
  const arb = new ArbStrategy();

  it("cheapOrderAction: cancel-lock wins over take-ask", () => {
    const config = testConfig();
    const cheapBook = books(0.87, 0.08)[1];
    assert.equal(
      arb.cheapOrderAction({
        config,
        limitPrice: 0.18,
        cheapBook,
        favoriteAsk: 0.85,
      }),
      "cancel-lock",
    );
  });

  it("cheapOrderAction: take-ask when the live ask is at or below the limit", () => {
    const config = testConfig();
    assert.equal(
      arb.cheapOrderAction({
        config,
        limitPrice: 0.1,
        cheapBook: {
          tokenId: "t-down",
          outcome: "Down",
          outcomeIndex: 1,
          bestBid: 0.08,
          bestAsk: 0.09,
          bestAskSize: 50,
        },
        favoriteAsk: 0.87,
      }),
      "take-ask",
    );
  });

  it("hedgeAtPostTime follows null / above-max / below-min / lock / post", () => {
    const event = testEvent();
    const tracker = new TradeTracker();
    addFill(tracker, event, "cheap", 10, 0.13);

    assert.equal(arb.hedgeAtPostTime(hedgeCtx(tracker, event, null)).action, "skip");
    assert.equal(
      (arb.hedgeAtPostTime(hedgeCtx(tracker, event, null)) as { reason: string }).reason,
      "favorite-book-missing",
    );

    const defend = arb.hedgeAtPostTime(hedgeCtx(tracker, event, 0.97));
    assert.deepEqual(defend, { action: "defend", reason: "favorite-ask-above-max" });

    addFill(tracker, event, "expensive", 10, 0.87);
    const covered = arb.hedgeAtPostTime(hedgeCtx(tracker, event, 0.97));
    assert.deepEqual(covered, { action: "skip", reason: "already-covered" });

    const tracker2 = new TradeTracker();
    addFill(tracker2, event, "cheap", 10, 0.13);
    assert.deepEqual(arb.hedgeAtPostTime(hedgeCtx(tracker2, event, 0.7)), {
      action: "skip",
      reason: "outside-band",
    });

    const tracker3 = new TradeTracker();
    addFill(tracker3, event, "cheap", 10, 0.2);
    assert.deepEqual(arb.hedgeAtPostTime(hedgeCtx(tracker3, event, 0.85)), {
      action: "skip",
      reason: "pair-lock-unreachable",
    });

    const tracker4 = new TradeTracker();
    addFill(tracker4, event, "cheap", 10, 0.1);
    assert.deepEqual(arb.hedgeAtPostTime(hedgeCtx(tracker4, event, 0.87)), {
      action: "post",
      price: 0.87,
    });

    const tracker5 = new TradeTracker();
    addFill(tracker5, event, "cheap", 3, 0.13);
    assert.deepEqual(arb.hedgeAtPostTime(hedgeCtx(tracker5, event, 0.97)), {
      action: "skip",
      reason: "defend-below-clob-min",
    });
  });

  it("defendShares is 1:1 uncovered cheap", () => {
    assert.equal(
      arb.defendShares({
        config: testConfig(),
        favoriteAsk: 0.97,
        filledCheap: 10,
        filledExpensive: 3,
      }),
      7,
    );
  });
});

describe("BarbellStrategy", () => {
  const barbell = new BarbellStrategy();

  it("does not cancel a cheap just because the pair lock is broken", () => {
    const config = testConfig({ strategyId: "barbell", barbellHedgeRatio: 0.5 });
    const restingCheap = {
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      bestBid: 0.17,
      bestAsk: 0.19,
      bestAskSize: 50,
    };
    assert.equal(
      barbell.cheapOrderAction({
        config,
        limitPrice: 0.18,
        cheapBook: restingCheap,
        favoriteAsk: 0.85,
      }),
      "keep",
    );
    assert.equal(
      barbell.cheapOrderAction({
        config,
        limitPrice: 0.13,
        cheapBook: restingCheap,
        favoriteAsk: 0.7,
      }),
      "cancel-lock",
    );
  });

  it("sizes the hedge to cheap × ratio, on the uncovered remainder", () => {
    const event = testEvent();
    const config = testConfig({
      strategyId: "barbell",
      barbellHedgeRatio: 0.5,
      expensiveOrderUsdc: 20,
      maxSharesPerOrder: 90,
    });

    const tracker = new TradeTracker();
    addFill(tracker, event, "cheap", 10, 0.08);
    const opps = barbell.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.85, 0.08, 200),
    });
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(hedge);
    assert.equal(hedge.size, 5);

    const trackerPartial = new TradeTracker();
    addFill(trackerPartial, event, "cheap", 20, 0.08);
    addFill(trackerPartial, event, "expensive", 5, 0.85);
    const cheapToken = books(0.85, 0.08, 200)[1]!;
    const expensiveToken = books(0.85, 0.08, 200)[0]!;
    const sized = new BarbellSizing().compute({
      config,
      pairId: `${event.slug}:${event.windowEnd}`,
      tracker: trackerPartial,
      cheapToken,
      expensiveToken,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });
    assert.equal(sized.hedgeSize, 5);
    assert.equal(sized.pairLockOk, true);
  });

  it("does not post a hedge remainder below the CLOB minimum", () => {
    const event = testEvent();
    const config = testConfig({
      strategyId: "barbell",
      barbellHedgeRatio: 0.5,
      expensiveOrderUsdc: 20,
    });
    const tracker = new TradeTracker();
    addFill(tracker, event, "cheap", 10, 0.08);
    addFill(tracker, event, "expensive", 3, 0.85);
    const opps = barbell.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.85, 0.08, 200),
    });
    assert.equal(
      opps.find((o) => o.kind === "expensive"),
      undefined,
    );
  });

  it("hedgeAtPostTime still posts when fill+hedge exceeds pairLockMax", () => {
    const event = testEvent();
    const tracker = new TradeTracker();
    addFill(tracker, event, "cheap", 10, 0.2);
    const decision = barbell.hedgeAtPostTime(
      hedgeCtx(tracker, event, 0.85, {
        strategyId: "barbell",
        barbellHedgeRatio: 0.5,
        pairLockMax: 0.98,
      }),
    );
    assert.deepEqual(decision, { action: "post", price: 0.85 });
  });

  it("defendShares sells only the missing hedge slice, not leftover cheap", () => {
    assert.equal(
      barbell.defendShares({
        config: testConfig({ barbellHedgeRatio: 0.5 }),
        favoriteAsk: 0.97,
        filledCheap: 10,
        filledExpensive: 3,
      }),
      2,
    );
  });

  it("hedgeAtPostTime skips defend when the missing slice is below the CLOB minimum", () => {
    const event = testEvent();
    const tracker = new TradeTracker();
    addFill(tracker, event, "cheap", 10, 0.08);
    addFill(tracker, event, "expensive", 3, 0.85);
    assert.deepEqual(
      barbell.hedgeAtPostTime(
        hedgeCtx(tracker, event, 0.97, {
          strategyId: "barbell",
          barbellHedgeRatio: 0.5,
        }),
      ),
      { action: "skip", reason: "defend-below-clob-min" },
    );
  });
});
