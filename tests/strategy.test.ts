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
    const opps = findOpportunities(config, tracker, event, books(0.85, 0.08, 200));
    const hedge = opps.find((o) => o.kind === "expensive");
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(hedge);
    assert.ok(cheap);
    assert.equal(hedge.size, computeSize(5, 0.85, 90));
    assert.notEqual(hedge.size, cheap.size);
  });

  it("skips cheap when PAIR_TARGET_COST minus hedge is below CHEAP_BUY_MIN", () => {
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
      books(0.9, 0.2),
    );
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
  });

  it("posts cheap at 0.15 when expensive is 0.80", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        expensiveOrderType: "GTC",
        expensiveOrderUsdc: 20,
      }),
      tracker,
      event,
      books(0.8, 0.2),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(cheap);
    assert.ok(hedge);
    assert.equal(cheap.price, 0.15);
    assert.equal(hedge.price, 0.8);
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 1);
  });

  it("takes the cheap ask when it is below PAIR_TARGET_COST minus hedge", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        expensiveOrderType: "GTC",
        expensiveOrderUsdc: 20,
      }),
      tracker,
      event,
      books(0.8, 0.13),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.13);
  });

  it("posts cheap at PAIR_TARGET_COST minus hedge ask", () => {
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = findOpportunities(
      testConfig({
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.9,
        expensiveOrderType: "GTC",
        expensiveOrderUsdc: 20,
      }),
      tracker,
      event,
      books(0.81, 0.2),
    );
    const cheap = opps.find((o) => o.kind === "cheap");
    const hedge = opps.find((o) => o.kind === "expensive");
    assert.ok(cheap);
    assert.ok(hedge);
    assert.equal(cheap.price, 0.14);
    assert.equal(hedge.price, 0.81);
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
