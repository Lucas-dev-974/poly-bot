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

  it("getFilledExpensiveSizeForPair counts only open expensive legs", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition({
      id: "cheap",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.19,
      fillPrice: 0.19,
      size: 5.27,
      cost: 1,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "resting",
      pairId,
    });
    tracker.addOpenPosition({
      id: "exp",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "expensive",
      limitPrice: 0.8,
      fillPrice: 0.8,
      size: 5.27,
      cost: 4.22,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    assert.equal(tracker.getFilledCheapSizeForPair(pairId), 5.27);
    assert.equal(tracker.getFilledExpensiveSizeForPair(pairId), 5.27);
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

  it("sits the cheap bid at pairLockMax − hedge instead of rejecting the ask", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      cheapBuyMin: 0.07,
      cheapBuyMax: 0.25,
      pairLockMax: 0.98,
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
        bestBid: 0.15,
        bestAsk: 0.16,
        bestAskSize: 100,
      },
      expensiveToken: {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.84,
        bestAsk: 0.85,
        bestAskSize: 100,
      },
      hedgePrice: 0.85, // ask+ask = 1.01, maker bid = 0.98 − 0.85 = 0.13
      thisTickCheapSize: 0,
    });

    assert.equal(result.pairLockOk, true);
    assert.equal(result.cheapPrice, 0.13);
    assert.equal(result.pairCost, 0.98);
    assert.ok(result.cheapSize !== null);
  });

  it("rejects when the lock is unreachable inside the cheap band", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      cheapBuyMin: 0.16,
      cheapBuyMax: 0.25,
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
      expensiveToken: {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.79,
        bestAsk: 0.80,
        bestAskSize: 100,
      },
      hedgePrice: 0.80, // max cheap for lock = 0.15 < cheapBuyMin 0.16
      thisTickCheapSize: 0,
    });

    assert.equal(result.pairLockOk, false);
    assert.equal(result.cheapSize, null);
    assert.equal(result.reason, "pair-lock-unreachable");
  });

  it("does not size a hedge when the filled cheap plus favorite exceeds the lock", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition({
      id: "p1",
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.2,
      fillPrice: 0.2,
      size: 5,
      cost: 1,
      windowEnd: 1234567890,
      status: "open",
      fillReason: "resting",
      pairId,
    });

    const result = new ArbSizing().compute({
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.24,
        expensiveBuyMin: 0.76,
        expensiveBuyMax: 0.85,
        pairLockMax: 0.99,
        expensiveOrderUsdc: 10,
      }),
      pairId,
      tracker,
      cheapToken: {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.19,
        bestAsk: 0.21,
        bestAskSize: 80,
      },
      expensiveToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.82,
        bestAsk: 0.83,
        bestAskSize: 80,
      },
      hedgePrice: 0.83,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, null);
    assert.equal(result.reason, "pair-lock-unreachable");
    assert.equal(result.pairCost, 1.03);
  });

  it("steps the cheap bid down when $1 cannot buy 5 shares at the lock price", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const result = new ArbSizing().compute({
      config: testConfig({
        cheapBuyMin: 0.07,
        cheapBuyMax: 0.25,
        cheapOrderUsdc: 1,
        pairLockMax: 0.98,
        maxSharesPerOrder: 50,
      }),
      pairId: "test-event:1234567890",
      tracker,
      cheapToken: {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.21,
        bestAsk: 0.22,
        bestAskSize: 100,
      },
      expensiveToken: {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.75,
        bestAsk: 0.76,
        bestAskSize: 100,
      },
      // lock cap = 0.22, but $1 / 0.22 = 4.54 < 5 shares → step down to 0.20
      hedgePrice: 0.76,
      thisTickCheapSize: 0,
    });

    assert.equal(result.pairLockOk, true);
    assert.equal(result.cheapPrice, 0.2);
    assert.ok(result.cheapSize !== null);
    assert.ok(result.cheapSize! >= 5);
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

  function cheapLeg(pairId: string, size: number, id = "p1") {
    return {
      id,
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap" as const,
      limitPrice: 0.13,
      fillPrice: 0.13,
      size,
      cost: Math.round(0.13 * size * 100) / 100,
      windowEnd: 1234567890,
      status: "open" as const,
      fillReason: "marketable" as const,
      pairId,
    };
  }

  function expensiveLeg(pairId: string, size: number, id = "h1") {
    return {
      id,
      eventSlug: "test-event",
      eventTitle: "Test",
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "expensive" as const,
      limitPrice: 0.85,
      fillPrice: 0.85,
      size,
      cost: Math.round(0.85 * size * 100) / 100,
      windowEnd: 1234567890,
      status: "open" as const,
      fillReason: "marketable" as const,
      pairId,
    };
  }

  const cheapBook = {
    tokenId: "t-down",
    outcome: "Down",
    outcomeIndex: 1,
    bestBid: 0.12,
    bestAsk: 0.13,
    bestAskSize: 100,
  };

  it("caps the 1:1 hedge by EXPENSIVE_ORDER_USDC when the budget is below the filled cheap", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    const config = testConfig({
      expensiveOrderUsdc: 5, // 5 USDC / 0.85 = 5.88 shares → capped at 5.88
      expensiveBuyMax: 0.85,
      pairLockMax: 0.98,
      maxSharesPerOrder: 50,
    });
    tracker.addOpenPosition(cheapLeg(pairId, 10));

    const result = new ArbSizing().compute({
      config,
      pairId,
      tracker,
      cheapToken: cheapBook,
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, 5.88);
    assert.equal(result.reason, "arb-pair-budget-capped");
  });

  it("yields NO hedge when the budget buys fewer than 5 shares (CLOB minimum)", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    // 3 USDC / 0.85 = 3.52 shares < 5 → computeSize returns null → no hedge.
    const config = testConfig({
      expensiveOrderUsdc: 3,
      expensiveBuyMax: 0.85,
      pairLockMax: 0.98,
      maxSharesPerOrder: 50,
    });
    tracker.addOpenPosition(cheapLeg(pairId, 10));

    const result = new ArbSizing().compute({
      config,
      pairId,
      tracker,
      cheapToken: cheapBook,
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, 0);
    assert.equal(result.reason, "arb-pair-budget-insufficient");
  });

  it("sizes the hedge against the UNCOVERED cheap only (no over-hedge after a partial hedge)", async () => {
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
    tracker.addOpenPosition(cheapLeg(pairId, 12));
    tracker.addOpenPosition(expensiveLeg(pairId, 6));

    const result = new ArbSizing().compute({
      config,
      pairId,
      tracker,
      cheapToken: cheapBook,
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, 6);
    assert.equal(result.reason, "arb-pair");
  });

  it("does not size a hedge when the pair is already covered 1:1", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition(cheapLeg(pairId, 10));
    tracker.addOpenPosition(expensiveLeg(pairId, 10));

    const result = new ArbSizing().compute({
      config: testConfig({ expensiveOrderUsdc: 100, maxSharesPerOrder: 50 }),
      pairId,
      tracker,
      cheapToken: cheapBook,
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, 0);
    assert.equal(result.reason, "arb-pair-covered");
  });

  it("holds a partial pair whose uncovered remainder is below the CLOB minimum", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition(cheapLeg(pairId, 10));
    tracker.addOpenPosition(expensiveLeg(pairId, 7));

    const result = new ArbSizing().compute({
      config: testConfig({ expensiveOrderUsdc: 100, maxSharesPerOrder: 50 }),
      pairId,
      tracker,
      cheapToken: cheapBook,
      expensiveToken: null,
      hedgePrice: 0.85,
      thisTickCheapSize: 0,
    });

    assert.equal(result.hedgeSize, 0);
    assert.equal(result.reason, "arb-pair-remainder-below-clob-min");
  });

  it("accepts an exact lock without float noise (0.07 + 0.91 = 0.98)", async () => {
    const { ArbSizing } = await import("../src/strategy/arb-sizing.js");
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const { testConfig } = await import("./helpers.js");

    const tracker = new TradeTracker();
    const pairId = "test-event:1234567890";
    tracker.addOpenPosition({ ...cheapLeg(pairId, 14), limitPrice: 0.07, fillPrice: 0.07, cost: 0.98 });

    const result = new ArbSizing().compute({
      config: testConfig({
        cheapBuyMin: 0.05,
        cheapBuyMax: 0.25,
        expensiveBuyMin: 0.8,
        expensiveBuyMax: 0.95,
        expensiveOrderUsdc: 100,
        pairLockMax: 0.98,
        maxSharesPerOrder: 50,
      }),
      pairId,
      tracker,
      cheapToken: { ...cheapBook, bestBid: 0.06, bestAsk: 0.07 },
      expensiveToken: {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.9,
        bestAsk: 0.91,
        bestAskSize: 100,
      },
      hedgePrice: 0.91,
      thisTickCheapSize: 0,
    });

    assert.equal(result.pairCost, 0.98);
    assert.equal(result.hedgeSize, 14);
  });
});

describe("TradeTracker.closePairCheapAsSold", () => {
  const pairId = "test-event:1234567890";
  const leg = (size: number) => ({
    id: "cheap-1",
    eventSlug: "test-event",
    eventTitle: "Test",
    tokenId: "t-down",
    outcome: "Down",
    outcomeIndex: 1,
    kind: "cheap" as const,
    limitPrice: 0.13,
    fillPrice: 0.13,
    size,
    cost: Math.round(0.13 * size * 100) / 100,
    windowEnd: 1234567890,
    status: "open" as const,
    fillReason: "marketable" as const,
    pairId,
  });

  it("closes the whole leg as sold and books proceeds − cost", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const position = leg(10);
    tracker.addOpenPosition(position);
    tracker.attachLeg(position);

    const closed = tracker.closePairCheapAsSold(pairId, 0.1, 10);

    assert.equal(closed, 1);
    assert.equal(tracker.getFilledCheapSizeForPair(pairId), 0);
    assert.equal(tracker.getOpenExposure(), 0);
    const sold = tracker.getResolvedPositions()[0];
    assert.equal(sold.status, "sold");
    // proceeds 1.00 − cost 1.30 = −0.30
    assert.equal(sold.pnl, -0.3);
    // pair fully resolved as directional (no expensive leg)
    assert.equal(tracker.getPair(pairId)?.status, "resolved");
    assert.equal(tracker.getPair(pairId)?.directional, true);
  });

  it("splits a partial sale: remainder stays open with shrunk size/cost", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const position = leg(10);
    tracker.addOpenPosition(position);
    tracker.attachLeg(position);

    const closed = tracker.closePairCheapAsSold(pairId, 0.1, 4);

    assert.equal(closed, 1);
    assert.equal(tracker.getFilledCheapSizeForPair(pairId), 6);
    const remaining = tracker.getOpenPositions().find((p) => p.id === "cheap-1");
    assert.ok(remaining);
    assert.equal(remaining.size, 6);
    assert.equal(remaining.cost, 0.78);
    assert.equal(remaining.status, "open");
    // pair still has an open leg → not finalized
    assert.notEqual(tracker.getPair(pairId)?.status, "resolved");
  });

  it("never sells more than the filled cheap", async () => {
    const { TradeTracker } = await import("../src/trade-tracker.js");
    const tracker = new TradeTracker();
    const position = leg(10);
    tracker.addOpenPosition(position);
    tracker.attachLeg(position);

    tracker.closePairCheapAsSold(pairId, 0.1, 25);

    assert.equal(tracker.getFilledCheapSizeForPair(pairId), 0);
    assert.equal(tracker.getResolvedPositions().length, 1);
  });
});