import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findOpportunities,
  shouldCancelRestingCheapForLock,
  shouldReplaceRestingCheap,
} from "../src/strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { computeSize } from "../src/utils/prices.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("findOpportunities", () => {
  it("posts GTC hedge at min(bestAsk, expensiveBuyMax)", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({ expensiveOrderType: "GTC", expensiveOrderUsdc: 10 });
    // Inject a filled cheap leg so the hedge is allowed (S1.4 anti favori-nu).
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition({
      id: "test-cheap-fill",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.13,
      fillPrice: 0.1,
      size: 10,
      cost: 1.0,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    const opps = findOpportunities(config, tracker, event, books(0.87, 0.08));
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(hedge);
    assert.equal(hedge.price, 0.87);
  });

  it("caps the 1:1 hedge by EXPENSIVE_ORDER_USDC when the budget is below the filled cheap", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      expensiveOrderType: "GTC",
      cheapOrderUsdc: 10,
      expensiveOrderUsdc: 5,
      maxSharesPerOrder: 90,
    });
    const pairId = `${event.slug}:${event.windowEnd}`;
    // Fill the cheap leg so the hedge is allowed.
    tracker.addOpenPosition({
      id: "test-cheap-fill",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.08,
      fillPrice: 0.08,
      size: 10,
      cost: 0.8,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    const opps = findOpportunities(config, tracker, event, books(0.85, 0.08, 200));
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(hedge);
    assert.equal(hedge.size, computeSize(5, 0.85, 90));
  });

  it("posts cheap at the live ask when it already satisfies the pair lock", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    // cheap=0.17, hedge=0.80 → pairCost=0.97 ≤ 0.98 → ok
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        expensiveOrderType: "GTC",
        expensiveOrderUsdc: 20,
        pairLockMax: 0.98,
      }),
      tracker,
      event,
      books(0.8, 0.17),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    // ask 0.17 + hedge 0.80 = 0.97 ≤ 0.98 → take the ask (no need to sit lower)
    assert.equal(cheap.price, 0.17);
  });

  it("takes the cheap ask when it is below cheapBuyMax", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        expensiveOrderType: "GTC",
        expensiveOrderUsdc: 20,
        pairLockMax: 0.98,
      }),
      tracker,
      event,
      books(0.8, 0.13),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.13);
  });

  it("posts a maker cheap at pairLockMax − hedge when the ask is above the lock", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    // ask=0.20 + hedge=0.80 = 1.00 > 0.98, but the maker bid sits at 0.18
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        pairLockMax: 0.98,
      }),
      tracker,
      event,
      books(0.8, 0.2),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.18);
  });

  it("posts cheap when pair cost is within pairLockMax", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    // cheap=0.17, hedge=0.80 → pairCost=0.97 ≤ 0.98 → ok
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        pairLockMax: 0.98,
      }),
      tracker,
      event,
      books(0.8, 0.17),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.17);
  });

  it("skips cheap when the ask is below CHEAP_BUY_MIN", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = findOpportunities(
      testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
      }),
      tracker,
      event,
      books(0.8, 0.05),
    );
    assert.equal(
      opps.filter((o) => o.kind === "cheap").length,
      0,
    );
  });

  it("clears a cheap-only claim when the reverse flips and nothing is committed", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.claimWindowOutcomes(pairId, "Up", "");
    findOpportunities(testConfig(), tracker, event, books(0.87, 0.08));
    const claim = tracker.getWindowClaim(pairId);
    assert.equal(claim?.cheapOutcome, "Down");
  });

  it("does not post hedge without a filled cheap leg (anti favori-nu, C2)", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      expensiveOrderType: "GTC",
      expensiveOrderUsdc: 10,
    });
    // No filled cheap — hedge should not be generated.
    const opps = findOpportunities(config, tracker, event, books(0.87, 0.08));
    const hedge = opps.find((o) => o.kind === "expensive");
    // Strategy generates the hedge opportunity, but bot.ts S1.4 blocks it.
    // The strategy itself still generates it based on committedCheapSize.
    // The anti-favori-nu guard is in bot.ts (getFilledCheapSizeForPair).
    // So this test verifies the strategy behavior; the bot guard is tested
    // separately in order-lifecycle tests.
    // With GTC, committedCheapSize includes resting orders. No resting order
    // here, so cheapCommittedForHedge = 0 → no hedge generated.
    assert.equal(hedge, undefined);
  });

  it("does not hedge a filled cheap when fill + favorite exceeds pairLockMax", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      cheapBuyMin: 0.07,
      cheapBuyMax: 0.24,
      expensiveBuyMin: 0.76,
      expensiveBuyMax: 0.85,
      expensiveOrderType: "GTC",
      expensiveOrderUsdc: 10,
      pairLockMax: 0.98,
    });
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition({
      id: "test-cheap-fill",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.2,
      fillPrice: 0.2,
      size: 5,
      cost: 1,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "resting",
      pairId,
    });
    // 0.20 + 0.81 = 1.01 > 0.98 → hold cheap directional, do not lock a loss.
    const opps = findOpportunities(config, tracker, event, books(0.21, 0.81, 80));
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.equal(hedge, undefined);
  });

  function filledCheap(event: ReturnType<typeof testEvent>, size: number, fillPrice: number) {
    return {
      id: `cheap-${fillPrice}`,
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap" as const,
      limitPrice: fillPrice,
      fillPrice,
      size,
      cost: Math.round(fillPrice * size * 100) / 100,
      windowEnd: event.windowEnd,
      status: "open" as const,
      fillReason: "resting" as const,
      pairId: `${event.slug}:${event.windowEnd}`,
    };
  }

  it("does not generate a GTC hedge when the favorite asks above expensiveBuyMax", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      expensiveBuyMin: 0.85,
      expensiveBuyMax: 0.9,
      expensiveOrderType: "GTC",
      expensiveOrderUsdc: 20,
    });
    tracker.addOpenPosition(filledCheap(event, 10, 0.08));
    // Favorite at 0.93 > max 0.90: a GTC at 0.90 would rest below the ask
    // and fill later as a naked favorite once defense sells the cheap.
    const opps = findOpportunities(config, tracker, event, books(0.93, 0.08));
    assert.equal(opps.find((o) => o.kind === "expensive"), undefined);
  });

  it("does not generate a hedge when the favorite asks below expensiveBuyMin", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      expensiveBuyMin: 0.85,
      expensiveBuyMax: 0.95,
      expensiveOrderType: "GTC",
      expensiveOrderUsdc: 20,
    });
    tracker.addOpenPosition(filledCheap(event, 10, 0.08));
    const opps = findOpportunities(config, tracker, event, books(0.8, 0.08));
    assert.equal(opps.find((o) => o.kind === "expensive"), undefined);
  });

  it("does not post a new cheap while the favorite is outside the band and nothing is committed", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      cheapBuyMax: 0.25,
      expensiveBuyMin: 0.85,
      expensiveBuyMax: 0.9,
      pairLockMax: 0.98,
    });
    // Favorite 0.97 > max → no cheap: a 0.01 maker bid is not a cover.
    assert.equal(findOpportunities(config, tracker, event, books(0.97, 0.05)).length, 0);
    // Favorite 0.7 < min → no cheap either (no favorite to hedge against).
    assert.equal(findOpportunities(config, tracker, event, books(0.7, 0.3)).length, 0);
  });

  it("does not hedge more than the uncovered cheap after a partial hedge", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = testConfig({
      expensiveOrderType: "GTC",
      expensiveOrderUsdc: 100,
      maxSharesPerOrder: 50,
      maxOpenPositionsPerSide: 2,
    });
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition(filledCheap(event, 12, 0.08));
    tracker.addOpenPosition({
      id: "hedge-1",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "expensive",
      limitPrice: 0.87,
      fillPrice: 0.87,
      size: 6,
      cost: 5.22,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    const opps = findOpportunities(config, tracker, event, books(0.87, 0.08));
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(hedge);
    assert.equal(hedge.size, 6);
  });

  it("returns nothing on a one-sided book (failed fetch must not claim the window)", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const [up] = books(0.87, 0.08);
    const opps = findOpportunities(testConfig(), tracker, event, [up]);
    assert.equal(opps.length, 0);
    assert.equal(tracker.getWindowClaim(`${event.slug}:${event.windowEnd}`), undefined);
  });
});

describe("shouldReplaceRestingCheap", () => {
  it("takes when the ask drops below the resting limit", () => {
    assert.equal(shouldReplaceRestingCheap(0.15, 0.13, 0.12, 0.07), true);
  });

  it("replaces a ghost bid missing from the public book", () => {
    assert.equal(shouldReplaceRestingCheap(0.15, 0.15, 0.12, 0.07), true);
  });

  it("leaves a live bid sitting on the book", () => {
    assert.equal(shouldReplaceRestingCheap(0.15, 0.16, 0.15, 0.07), false);
  });

  it("does not lift a dying ask below CHEAP_BUY_MIN", () => {
    assert.equal(shouldReplaceRestingCheap(0.15, 0.05, 0.04, 0.07), false);
  });
});

describe("shouldCancelRestingCheapForLock", () => {
  const config = testConfig({
    expensiveBuyMin: 0.76,
    expensiveBuyMax: 0.85,
    pairLockMax: 0.98,
  });

  it("cancels when the favorite leaves the hedge band", () => {
    assert.equal(shouldCancelRestingCheapForLock(0.13, 0.9, config), true);
    assert.equal(shouldCancelRestingCheapForLock(0.13, 0.7, config), true);
  });

  it("cancels when the resting bid is above the new lock cap", () => {
    // hedge 0.85 → max cheap 0.13; a 0.18 bid would break the lock
    assert.equal(shouldCancelRestingCheapForLock(0.18, 0.85, config), true);
  });

  it("keeps a bid that still locks", () => {
    assert.equal(shouldCancelRestingCheapForLock(0.13, 0.85, config), false);
    assert.equal(shouldCancelRestingCheapForLock(0.18, 0.8, config), false);
  });

  it("does not cancel on a one-sided book", () => {
    assert.equal(shouldCancelRestingCheapForLock(0.13, null, config), false);
  });
});