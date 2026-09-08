import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findOpportunities, shouldReplaceRestingCheap } from "../src/strategy.js";
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
      fillPrice: 0.13,
      size: 10,
      cost: 1.3,
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

  it("sizes hedge by EXPENSIVE_ORDER_USDC, not cheap shares", () => {
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

  it("posts cheap at min(ask, cheapBuyMax) when pair lock is satisfied", () => {
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
    // cheap price = min(ask=0.17, cheapBuyMax=0.25) = 0.17
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

  it("skips cheap when pair cost exceeds pairLockMax", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    // cheap=0.20, hedge=0.80 → pairCost=1.00 > pairLockMax=0.98 → skip
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
    // With pairLockMax=0.98 and hedge=0.80, cheap must be ≤ 0.18.
    // ask=0.20 > 0.18 → cheap is clamped below band? No: cheapBuyMax=0.25,
    // but pairCost=1.00 > 0.98 → pairCostOk=false → no cheap posted.
    // However the ask 0.20 is above the pairLockMax-hedge=0.18, so
    // pairCostOk is false and no cheap is generated.
    const cheap = opps.find((o) => o.kind === "cheap");
    // The cheap at 0.20 + hedge 0.80 = 1.00 > 0.98 → skipped.
    // But min(ask=0.20, cheapBuyMax=0.25)=0.20, pairCost=1.00 > 0.98 → skip.
    assert.equal(cheap, undefined);
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