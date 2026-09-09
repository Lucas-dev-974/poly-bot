import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GammaMarket } from "../src/types.js";
import { gammaMarketStats, l1Spread, rankedLevels, withSeriesVolume24hr } from "../src/utils/market.js";

describe("rankedLevels", () => {
  it("returns L1–L3 asks low to high and bids high to low", () => {
    const asks = [
      { price: "0.14", size: "10" },
      { price: "0.12", size: "5" },
      { price: "0.13", size: "8" },
      { price: "0.15", size: "20" },
    ];
    const bids = [
      { price: "0.09", size: "4" },
      { price: "0.11", size: "7" },
      { price: "0.10", size: "6" },
    ];
    const askLevels = rankedLevels(asks, "ask", 3);
    const bidLevels = rankedLevels(bids, "bid", 3);
    assert.deepEqual(askLevels, [
      { price: 0.12, size: 5 },
      { price: 0.13, size: 8 },
      { price: 0.14, size: 10 },
    ]);
    assert.deepEqual(bidLevels, [
      { price: 0.11, size: 7 },
      { price: 0.1, size: 6 },
      { price: 0.09, size: 4 },
    ]);
  });

  it("pads missing depth with null", () => {
    const levels = rankedLevels([{ price: "0.5", size: "1" }], "ask", 3);
    assert.equal(levels[0]?.price, 0.5);
    assert.equal(levels[1], null);
    assert.equal(levels[2], null);
  });

  it("merges the same price after ranking and sums sizes", () => {
    const levels = rankedLevels(
      [
        { price: "0.20", size: "1" },
        { price: "0.10", size: "2" },
        { price: "0.10", size: "9" },
      ],
      "ask",
      3,
    );
    assert.equal(levels[0]?.price, 0.1);
    assert.equal(levels[0]?.size, 11);
    assert.equal(levels[1]?.price, 0.2);
    assert.equal(levels[2], null);
  });
});

describe("gammaMarketStats", () => {
  const base: GammaMarket = {
    conditionId: "0x1",
    slug: "btc-updown-15m-1",
    clobTokenIds: "[]",
    outcomes: "[]",
    negRisk: false,
    orderPriceMinTickSize: 0.01,
    active: true,
    closed: false,
  };

  it("prefers numeric *Num fields and parses string fallbacks", () => {
    const stats = gammaMarketStats({
      ...base,
      volume: "100",
      volumeNum: 250.5,
      volume24hr: "12.5",
      liquidity: "80",
      liquidityNum: 90,
      lastTradePrice: "0.87",
      spread: 0.02,
    });
    assert.deepEqual(stats, {
      volume: 250.5,
      volume24hr: 12.5,
      liquidity: 90,
      lastTradePrice: 0.87,
      spread: 0.02,
    });
  });

  it("returns null when Gamma omits a metric", () => {
    const stats = gammaMarketStats(base);
    assert.equal(stats.volume, null);
    assert.equal(stats.volume24hr, null);
    assert.equal(stats.liquidity, null);
    assert.equal(stats.lastTradePrice, null);
    assert.equal(stats.spread, null);
  });

  it("fills volume24hr from the recurring series when the market omits it", () => {
    const market = withSeriesVolume24hr(base, [{ volume24hr: 141101.93 }]);
    assert.equal(gammaMarketStats(market).volume24hr, 141101.93);
  });
});

describe("l1Spread", () => {
  it("returns ask minus bid", () => {
    assert.equal(l1Spread(0.25, 0.5), 0.25);
  });

  it("returns null when a side is missing", () => {
    assert.equal(l1Spread(null, 0.82), null);
    assert.equal(l1Spread(0.8, undefined), null);
  });
});
