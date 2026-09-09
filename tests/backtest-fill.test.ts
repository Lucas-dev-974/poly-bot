import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buyFillAgainstBook, sellFillAgainstBook } from "../src/backtest/broker.js";
import {
  BacktestRestingBook,
  consumeAskLiquidity,
  remainingAskMap,
  takeAskLiquidity,
} from "../src/backtest/resting.js";
import type { TokenBook } from "../src/types.js";
import { bestSize } from "../src/utils/market.js";
import { testEvent } from "./helpers.js";

function book(ask: number | null, size: number | null = 100): TokenBook {
  return {
    tokenId: "t-down",
    outcome: "Down",
    outcomeIndex: 1,
    bestBid: ask !== null ? ask - 0.01 : null,
    bestAsk: ask,
    bestAskSize: size,
    bestBidSize: size,
  };
}

describe("backtest next-tick fill", () => {
  it("does not fill a GTC when ask is above the limit", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.41), "resting");
    assert.equal(fill.filled, false);
    assert.equal(fill.reason, "no-fill");
  });

  it("fills on a later tick when ask crosses the limit", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.39), "resting");
    assert.equal(fill.filled, true);
    assert.equal(fill.fillPrice, 0.39);
    assert.equal(fill.reason, "resting");
  });

  it("FOK / marketable rejects when not crossing", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.41), "marketable");
    assert.equal(fill.filled, false);
  });

  it("caps size to bestAskSize", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.39, 3), "resting");
    assert.equal(fill.filled, true);
    assert.equal(fill.size, 3);
  });

  it("rejects a missing ask", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(null), "resting");
    assert.equal(fill.reason, "no-ask");
  });

  it("FOK rejects a partial top-of-book instead of filling a slice", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.39, 3), "marketable", true);
    assert.equal(fill.filled, false);
    assert.equal(fill.reason, "insufficient-depth");
  });

  it("GTC still accepts a partial top-of-book", () => {
    const fill = buyFillAgainstBook(0.4, 10, book(0.39, 3), "marketable", false);
    assert.equal(fill.filled, true);
    assert.equal(fill.size, 3);
  });

  it("is independent of Date.now", () => {
    const now = Date.now;
    Date.now = () => 0;
    try {
      const fill = buyFillAgainstBook(0.4, 10, book(0.39), "resting");
      assert.equal(fill.filled, true);
    } finally {
      Date.now = now;
    }
  });
});

describe("backtest GTC remainder book", () => {
  it("shrinks a partial fill and removes a complete fill", () => {
    const event = testEvent();
    const resting = new BacktestRestingBook();
    const opportunity = {
      kind: "cheap" as const,
      event,
      token: book(0.11),
      price: 0.1,
      size: 20,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "k",
      pairId: `${event.slug}:${event.windowEnd}`,
    };
    resting.post(opportunity, 2, "arb");
    const leftover = resting.reduce("k", 5);
    assert.equal(leftover?.context.size, 15);
    assert.equal(leftover?.cost, 1.5);
    assert.equal(resting.reservedNotional(), 1.5);
    assert.equal(resting.reduce("k", 15), undefined);
    assert.equal(resting.reservedNotional(), 0);
  });

  it("does not consume top-of-book until a later hit is accepted", () => {
    const event = testEvent();
    const resting = new BacktestRestingBook();
    const thin = book(0.09, 8);
    for (const key of ["a", "b"] as const) {
      resting.post(
        {
          kind: "cheap",
          event,
          token: thin,
          price: 0.1,
          size: 10,
          tickSize: "0.01",
          negRisk: false,
          tradeKey: key,
          pairId: `${event.slug}:${event.windowEnd}`,
        },
        1,
        "arb",
      );
    }
    const hits = resting.matchBuys(event, [thin]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.fill.size, 8);
    assert.equal(hits[1]?.fill.size, 8);
    assert.equal(thin.bestAskSize, 8);

    const remaining = remainingAskMap([thin]);
    const first = takeAskLiquidity(remaining, "t-down", hits[0]!.fill.size!);
    assert.equal(first, 8);
    const secondWhileSkipped = takeAskLiquidity(remaining, "t-down", hits[1]!.fill.size!);
    assert.equal(secondWhileSkipped, 8);
    consumeAskLiquidity(remaining, "t-down", first);
    assert.equal(takeAskLiquidity(remaining, "t-down", hits[1]!.fill.size!), 0);
  });
});

describe("backtest defense sell", () => {
  it("FOK-kills when bid depth is thinner than the sell size", () => {
    const fill = sellFillAgainstBook(0, 20, {
      ...book(0.13, 50),
      bestBid: 0.12,
      bestBidSize: 3,
    });
    assert.equal(fill.filled, false);
    assert.equal(fill.reason, "insufficient-depth");
  });

  it("fills the full size when bid depth is enough", () => {
    const fill = sellFillAgainstBook(0, 20, {
      ...book(0.13, 50),
      bestBid: 0.12,
      bestBidSize: 20,
    });
    assert.equal(fill.filled, true);
    assert.equal(fill.size, 20);
    assert.equal(fill.fillPrice, 0.12);
  });

  it("treats a missing bestBidSize as unlimited (legacy snapshots)", () => {
    const fill = sellFillAgainstBook(0, 20, {
      ...book(0.13, 50),
      bestBid: 0.12,
      bestBidSize: null,
    });
    assert.equal(fill.filled, true);
    assert.equal(fill.size, 20);
  });

  it("partial-fills when requireFullSize is false", () => {
    const fill = sellFillAgainstBook(
      0,
      20,
      { ...book(0.13, 50), bestBid: 0.12, bestBidSize: 3 },
      false,
    );
    assert.equal(fill.filled, true);
    assert.equal(fill.size, 3);
  });
});

describe("bestSize bid vs ask", () => {
  it("reads size at the highest bid, not the lowest", () => {
    const bids = [
      { price: "0.10", size: "99" },
      { price: "0.12", size: "4" },
    ];
    assert.equal(bestSize(bids, "bid"), 4);
    assert.equal(bestSize(bids, "ask"), 99);
  });
});
