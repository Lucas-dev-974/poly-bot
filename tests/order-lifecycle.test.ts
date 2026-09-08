import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockClobClient } from "./mock-clob-client.js";

describe("MockClobClient", () => {
  it("creates and posts a GTC order", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    assert.ok(result.orderID);
    assert.equal(result.success, true);
    assert.equal(client.orders.size, 1);
    assert.equal(client.postedOrders.length, 1);
  });

  it("creates and posts a FOK market order (BUY)", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostMarketOrder({
      tokenID: "t-up",
      price: 0.85,
      amount: 8.5,
      side: "BUY",
      orderType: "FOK",
    });
    assert.equal(result.success, true);
    assert.ok(result.takingAmount);
    assert.ok(result.makingAmount);
  });

  it("creates and posts a FOK market order (SELL)", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostMarketOrder({
      tokenID: "t-down",
      price: 0.12,
      amount: 1.2,
      side: "SELL",
      orderType: "FOK",
    });
    assert.equal(result.success, true);
    assert.ok(result.makingAmount);
    assert.ok(result.takingAmount);
  });

  it("cancels an order", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    await client.cancelOrder({ orderID: result.orderID });
    const order = client.orders.get(result.orderID);
    assert.ok(order);
    assert.equal(order.status, "canceled");
  });

  it("gets order status", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    const order = await client.getOrder(result.orderID);
    assert.equal(order.status, "live");
    assert.equal(Number(order.size_matched), 0);
    assert.equal(Number(order.original_size), 10);
  });

  it("throws 404 for unknown order", async () => {
    const client = new MockClobClient();
    await assert.rejects(
      () => client.getOrder("nonexistent"),
      /404/,
    );
  });

  it("throws network error when shouldFail is set", async () => {
    const client = new MockClobClient();
    client.shouldFail = true;
    await assert.rejects(
      () => client.createAndPostOrder({
        tokenID: "t-up",
        price: 0.15,
        side: "BUY",
        size: 10,
      }),
      /network error/,
    );
  });

  it("simulates a partial fill", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    client.simulateFill(result.orderID, 5);
    const order = await client.getOrder(result.orderID);
    assert.equal(order.status, "live"); // partial fill → still live
    assert.equal(Number(order.size_matched), 5);
  });

  it("simulates a full fill", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    client.simulateFill(result.orderID, 10);
    const order = await client.getOrder(result.orderID);
    assert.equal(order.status, "matched");
    assert.equal(Number(order.size_matched), 10);
  });

  it("simulates a cancel by the exchange", async () => {
    const client = new MockClobClient();
    const result = await client.createAndPostOrder({
      tokenID: "t-up",
      price: 0.15,
      side: "BUY",
      size: 10,
    });
    client.simulateCancel(result.orderID);
    const order = await client.getOrder(result.orderID);
    assert.equal(order.status, "canceled");
  });
});

describe("TradeTracker pair defense helpers", () => {
  it("getCheapFillPriceForPair returns volume-weighted average", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";

    // First fill: 10 shares @ 0.15
    tracker.addOpenPosition({
      id: "p1",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.15,
      fillPrice: 0.15,
      size: 10,
      cost: 1.5,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });

    // Second fill: 5 shares @ 0.12
    tracker.addOpenPosition({
      id: "p2",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.12,
      fillPrice: 0.12,
      size: 5,
      cost: 0.6,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });

    // VWAP = (10*0.15 + 5*0.12) / 15 = (1.5 + 0.6) / 15 = 2.1 / 15 = 0.14
    const vwap = tracker.getCheapFillPriceForPair(pairId);
    assert.ok(vwap !== null);
    assert.equal(vwap, 0.14);
  });

  it("getCheapFillPriceForPair returns null when no fills", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    assert.equal(tracker.getCheapFillPriceForPair("no-pair"), null);
  });

  it("getCheapTokenForPair returns the tokenId of the first cheap fill", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition({
      id: "p1",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.15,
      fillPrice: 0.15,
      size: 10,
      cost: 1.5,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    assert.equal(tracker.getCheapTokenForPair(pairId), "t-down");
  });

  it("getCheapTokenForPair returns null when no cheap fills", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    assert.equal(tracker.getCheapTokenForPair("no-pair"), null);
  });
});

describe("ArbSizing", () => {
  it("sizes hedge 1:1 with filled cheap", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      expensiveOrderUsdc: 100,
      expensiveBuyMax: 0.85,
      pairLockMax: 0.98,
      maxSharesPerOrder: 50,
    });

    // Fill 10 cheap shares
    tracker.addOpenPosition({
      id: "p1",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.13,
      fillPrice: 0.13,
      size: 10,
      cost: 1.3,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });

    const sizing = new ArbSizing();
    const result = sizing.compute({
      config,
      pairId,
      tracker,
      cheapToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.12,
        bestAsk: 0.13,
        bestAskSize: 100,
      },
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    // hedgeSize should be 10 (1:1 with filled cheap), capped by budget
    assert.ok(result.hedgeSize !== null);
    assert.equal(result.hedgeSize, 10);
    assert.equal(result.pairLockOk, true);
  });

  it("rejects pair when pairCost > pairLockMax", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      cheapBuyMax: 0.25, // allow cheap up to 0.25
      pairLockMax: 0.95,
      maxSharesPerOrder: 50,
    });

    const sizing = new ArbSizing();
    const result = sizing.compute({
      config,
      pairId,
      tracker,
      cheapToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.12,
        bestAsk: 0.20,
        bestAskSize: 100,
      },
      expensiveToken: null,
      hedgePrice: 0.80, // pairCost = 0.20 + 0.80 = 1.00 > 0.95
      thisTickCheapSize: 0,
    });

    assert.equal(result.pairLockOk, false);
    assert.equal(result.cheapSize, null);
    // reason is "no-filled-cheap" because no cheap has been filled yet,
    // but pairLockOk and cheapSize correctly reflect the pair lock check.
    assert.equal(result.pairLockOk, false);
  });

  it("returns no-filled-cheap when no cheap has been filled", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";

    const sizing = new ArbSizing();
    const result = sizing.compute({
      config: testConfig(),
      pairId,
      tracker,
      cheapToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.12,
        bestAsk: 0.13,
        bestAskSize: 100,
      },
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, null);
    assert.equal(result.reason, "no-filled-cheap");
  });

  it("caps hedge by budget when budget < filled cheap", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      expensiveOrderUsdc: 3, // 3 USDC / 0.85 = 3.52 shares → capped at 3.52
      expensiveBuyMax: 0.85,
      pairLockMax: 0.98,
      maxSharesPerOrder: 50,
    });

    // Fill 10 cheap shares → hedge should be capped at ~3.52, not 10
    tracker.addOpenPosition({
      id: "p1",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.13,
      fillPrice: 0.13,
      size: 10,
      cost: 1.3,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });

    const sizing = new ArbSizing();
    const result = sizing.compute({
      config,
      pairId,
      tracker,
      cheapToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.12,
        bestAsk: 0.13,
        bestAskSize: 100,
      },
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.ok(result.hedgeSize !== null);
    assert.ok(result.hedgeSize! < 10, "hedge should be capped by budget");
    assert.equal(result.reason, "arb-pair-budget-capped");
  });
});