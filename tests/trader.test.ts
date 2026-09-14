import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Trader } from "../src/trader.js";
import type { TradeOpportunity } from "../src/types.js";
import { MockClobClient } from "./mock-clob-client.js";
import { testConfig, testEvent } from "./helpers.js";

/**
 * Trader wraps a real ClobClient; for tests we inject the mock through the
 * private `client` field.
 */
function liveTrader(client: MockClobClient): Trader {
  const trader = new Trader(testConfig({ expensiveBuyMax: 0.9 }));
  (trader as unknown as { client: MockClobClient }).client = client;
  return trader;
}

function sellOpportunity(
  size: number,
  bestBid = 0.12,
  depth?: { bestBidSize?: number; bid2?: number; bid2Size?: number; bid3?: number; bid3Size?: number },
): TradeOpportunity {
  return {
    kind: "cheap",
    event: testEvent(),
    token: {
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      bestBid,
      bestAsk: bestBid + 0.01,
      bestAskSize: 100,
      bestBidSize: depth?.bestBidSize ?? null,
      bid2: depth?.bid2 ?? null,
      bid2Size: depth?.bid2Size ?? null,
      bid3: depth?.bid3 ?? null,
      bid3Size: depth?.bid3Size ?? null,
    },
    price: bestBid,
    size,
    tickSize: "0.01",
    negRisk: false,
    tradeKey: "defend:test",
    pairId: "test:1",
  };
}

function hedgeOpportunity(size: number, bestAsk: number): TradeOpportunity {
  return {
    kind: "expensive",
    event: testEvent(),
    token: {
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: bestAsk - 0.01,
      bestAsk,
      bestAskSize: 100,
    },
    price: Math.min(bestAsk, 0.9),
    size,
    tickSize: "0.01",
    negRisk: false,
    tradeKey: "hedge:test",
    pairId: "test:1",
  };
}

describe("Trader.placeSell", () => {
  it("sends SHARES as the market-order amount (not USDC) and confirms via balance drop", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    const trader = liveTrader(client);

    const result = await trader.placeSell(sellOpportunity(10, 0.12));

    assert.equal(client.marketOrders.length, 1);
    assert.equal(client.marketOrders[0].side, "SELL");
    assert.equal(client.marketOrders[0].amount, 10, "amount must be shares, not 0.12 × 10 USDC");
    assert.equal(result.filled, true);
    assert.equal(result.filledSize, 10);
    assert.equal(result.reason, "filled-fok-sell");
    assert.equal(client.balances.get("t-down"), 0);
  });

  it("books the sale when the CLOB says killed but the wallet balance dropped (production ghost)", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    client.sellReportsKilledButFills = true;
    const trader = liveTrader(client);

    const result = await trader.placeSell(sellOpportunity(10, 0.12));

    assert.equal(result.filled, true);
    assert.equal(result.filledSize, 10);
    assert.equal(result.reason, "filled-fok-sell-balance");
  });

  it("trusts the CLOB-confirmed makingAmount over a partially stale balance cache", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    client.sellDropsPartially = true; // cache only shows a 1/10 drop
    const trader = liveTrader(client);

    const result = await trader.placeSell(sellOpportunity(10, 0.12));

    assert.equal(result.filled, true, "CLOB-confirmed fill must be booked fully");
    assert.equal(result.filledSize, 10, "stale cache must not under-report the sold size");
    assert.equal(result.reason, "filled-fok-sell");
  });

  it("re-checks the balance after the taker delay when the first read still shows the pre-sell balance (delayed settlement)", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    client.sellSettlesOnSecondRead = true;
    const trader = liveTrader(client);

    const result = await trader.placeSell(sellOpportunity(10, 0.12));

    assert.equal(result.filled, true, "delayed settlement must be caught by the re-check");
    assert.equal(result.filledSize, 10);
    assert.equal(result.reason, "filled-fok-sell-balance");
    assert.equal(client.balances.get("t-down"), 0);
  });

  it("returns sell-unconfirmed when the balance is unknown and the CLOB reports a kill", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    client.sellReportsKilledButFills = true;
    client.balanceShouldFail = true;
    const trader = liveTrader(client);

    const result = await trader.placeSell(sellOpportunity(10, 0.12));

    assert.equal(result.filled, false);
    assert.equal(result.reason, "sell-unconfirmed");
  });

  it("never prices a SELL below 0.01 on an empty bid", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    const trader = liveTrader(client);
    const opp = sellOpportunity(10, 0.12);
    opp.token.bestBid = null;

    await trader.placeSell(opp);

    assert.equal(client.marketOrders[0].price, 0.01);
  });

  it("walks down bid levels when top-of-book depth is insufficient instead of pricing at bestBid", async () => {
    const client = new MockClobClient();
    // 8 at best bid, 6 at the next level: selling 10 requires the 2nd level.
    client.balances.set("t-down", 10);
    const trader = liveTrader(client);

    const result = await trader.placeSell(
      sellOpportunity(10, 0.12, { bestBidSize: 8, bid2: 0.11, bid2Size: 6 }),
    );

    assert.equal(client.marketOrders[0].price, 0.11, "worst-price limit must step down one tick");
    assert.equal(result.filled, true);
    assert.equal(result.filledSize, 10);
  });

  it("bounded to 3 ticks of slippage: an order deeper than 3 bid levels is priced at bid-3 ticks", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 100);
    const trader = liveTrader(client);

    await trader.placeSell(
      sellOpportunity(100, 0.20, {
        bestBidSize: 5,
        bid2: 0.19,
        bid2Size: 5,
        bid3: 0.18,
        bid3Size: 5,
      }),
    );

    assert.equal(client.marketOrders[0].price, 0.17);
  });

  it("keeps pricing at bestBid when the top level alone covers the order", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 10);
    const trader = liveTrader(client);

    await trader.placeSell(
      sellOpportunity(10, 0.12, { bestBidSize: 20, bid2: 0.11, bid2Size: 6 }),
    );

    assert.equal(client.marketOrders[0].price, 0.12);
  });
});

describe("Trader.placeBuyFOK", () => {
  it("clamps the FOK price to expensiveBuyMax and spends price × size USDC", async () => {
    const client = new MockClobClient();
    const trader = liveTrader(client);

    // ask 0.95 > max 0.90 → FOK priced at 0.90 (non-marketable in prod → killed)
    const result = await trader.placeBuyFOK(hedgeOpportunity(10, 0.95));

    assert.equal(client.marketOrders[0].price, 0.9);
    assert.equal(client.marketOrders[0].amount, 9);
    assert.equal(result.orderType, "FOK");
  });

  it("reports filledSize from takingAmount and a per-share fillPrice", async () => {
    const client = new MockClobClient();
    const trader = liveTrader(client);

    const result = await trader.placeBuyFOK(hedgeOpportunity(10, 0.87));

    assert.equal(result.filled, true);
    assert.equal(result.filledSize, 10);
    assert.equal(result.fillPrice, 0.87);
    assert.equal(result.reason, "filled-fok");
  });

  it("maps the CLOB 'couldn't be fully filled' error to killed-fok instead of throwing", async () => {
    const client = new MockClobClient();
    client.createAndPostMarketOrder = async () => {
      throw new Error("order couldn't be fully filled, FOK orders are fully filled/killed");
    };
    const trader = liveTrader(client);

    const result = await trader.placeBuyFOK(hedgeOpportunity(10, 0.87));

    assert.equal(result.filled, false);
    assert.equal(result.filledSize, 0);
    assert.equal(result.reason, "killed-fok");
  });

  it("re-throws genuine network errors", async () => {
    const client = new MockClobClient();
    client.shouldFail = true;
    const trader = liveTrader(client);

    await assert.rejects(() => trader.placeBuyFOK(hedgeOpportunity(10, 0.87)), /network error/);
  });
});

describe("Trader.getConditionalTokenBalance", () => {
  it("converts 6-decimal raw balances to shares", async () => {
    const client = new MockClobClient();
    client.balances.set("t-down", 7.69);
    const trader = liveTrader(client);
    assert.equal(await trader.getConditionalTokenBalance("t-down"), 7.69);
  });

  it("passes through balances already expressed in shares", async () => {
    const client = new MockClobClient();
    client.rawBalanceScale = 1;
    client.balances.set("t-down", 12);
    const trader = liveTrader(client);
    assert.equal(await trader.getConditionalTokenBalance("t-down"), 12);
  });

  it("returns null (fail-closed) when the CLOB balance call fails", async () => {
    const client = new MockClobClient();
    client.balanceShouldFail = true;
    const trader = liveTrader(client);
    assert.equal(await trader.getConditionalTokenBalance("t-down"), null);
  });

  it("returns null when no CLOB client is initialized", async () => {
    const trader = new Trader(testConfig());
    assert.equal(await trader.getConditionalTokenBalance("t-down"), null);
  });
});

describe("Trader.getOrderStatus", () => {
  it("does not report a LIVE fully-matched order as filled (ghost maker match)", async () => {
    const client = new MockClobClient();
    const trader = liveTrader(client);
    const posted = await client.createAndPostOrder({ tokenID: "t-down", price: 0.13, side: "BUY", size: 10 });
    client.simulateFill(posted.orderID, 5); // partial → still live

    const status = await trader.getOrderStatus(posted.orderID);

    assert.equal(status.filled, false);
    assert.equal(status.sizeMatched, 5);
    assert.equal(status.status, "live");
  });

  it("reports matched + size as filled", async () => {
    const client = new MockClobClient();
    const trader = liveTrader(client);
    const posted = await client.createAndPostOrder({ tokenID: "t-down", price: 0.13, side: "BUY", size: 10 });
    client.simulateFill(posted.orderID, 10);

    const status = await trader.getOrderStatus(posted.orderID);

    assert.equal(status.filled, true);
    assert.equal(status.sizeMatched, 10);
  });
});
