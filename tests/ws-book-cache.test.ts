import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketFeed } from "../src/ws/market-feed.js";
import type { TokenBook } from "../src/types.js";

function msg(eventType: string, extra: Record<string, unknown>): unknown {
  return { event_type: eventType, ...extra };
}

describe("MarketFeed", () => {
  it("applies a book snapshot and extracts the top-3 ladder", () => {
    const feed = new MarketFeed(3_000);
    feed.setConnected(true);
    feed.handleMessage(
      msg("book", {
        asset_id: "tokA",
        bids: [
          { price: "0.10", size: "5" },
          { price: "0.09", size: "8" },
          { price: "0.08", size: "2" },
          { price: "0.07", size: "9" },
        ],
        asks: [
          { price: "0.12", size: "4" },
          { price: "0.13", size: "6" },
          { price: "0.14", size: "1" },
        ],
      }),
    );
    const book = feed.getBook("tokA");
    assert.ok(book);
    assert.equal(book.bestBid, 0.1);
    assert.equal(book.bestBidSize, 5);
    assert.equal(book.bid2, 0.09);
    assert.equal(book.bid3, 0.08);
    assert.equal(book.bestAsk, 0.12);
    assert.equal(book.ask2, 0.13);
    assert.equal(book.ask3, 0.14);
  });

  it("applies price_change deltas including removals (size 0)", () => {
    const feed = new MarketFeed(3_000);
    feed.setConnected(true);
    feed.handleMessage(
      msg("book", {
        asset_id: "tokA",
        bids: [{ price: "0.10", size: "5" }],
        asks: [{ price: "0.12", size: "4" }],
      }),
    );
    feed.handleMessage(
      msg("price_change", {
        asset_id: "tokA",
        changes: [
          { price: "0.11", side: "BUY", size: "3" },
          { price: "0.12", side: "SELL", size: "0" },
        ],
      }),
    );
    const book = feed.getBook("tokA");
    assert.ok(book);
    assert.equal(book.bestBid, 0.11);
    assert.equal(book.bestBidSize, 3);
    assert.equal(book.bestAsk, null);
  });

  it("price_change without a prior snapshot is ignored", () => {
    const feed = new MarketFeed(3_000);
    feed.setConnected(true);
    feed.handleMessage(
      msg("price_change", { asset_id: "tokX", changes: [{ price: "0.10", side: "BUY", size: "3" }] }),
    );
    assert.equal(feed.getBook("tokX"), null);
  });

  it("isLive() reflects socket state and recency", () => {
    const feed = new MarketFeed(3_000);
    assert.equal(feed.isLive(), false); // not connected
    feed.setConnected(true);
    assert.equal(feed.isLive(), true); // just got activity
    feed.setConnected(false);
    assert.equal(feed.isLive(), false);
  });

  it("setAssets purges books outside the active set", () => {
    const feed = new MarketFeed(3_000);
    feed.setConnected(true);
    feed.handleMessage(msg("book", { asset_id: "a", bids: [], asks: [] }));
    feed.handleMessage(msg("book", { asset_id: "b", bids: [], asks: [] }));
    feed.setAssets(["a"]);
    assert.ok(feed.getBook("a"));
    assert.equal(feed.getBook("b"), null);
  });

  it("heal() restores the top-3 from a REST snapshot", () => {
    const feed = new MarketFeed(3_000);
    feed.setConnected(true);
    const restBook: TokenBook = {
      tokenId: "tokA",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.3,
      bestBidSize: 7,
      bestAsk: 0.35,
      bestAskSize: 4,
      bid2: 0.29,
      bid2Size: 2,
      bid3: null,
      bid3Size: null,
      ask2: 0.4,
      ask2Size: 1,
      ask3: null,
      ask3Size: null,
    };
    feed.heal("tokA", restBook);
    const book = feed.getBook("tokA");
    assert.ok(book);
    assert.equal(book.bestBid, 0.3);
    assert.equal(book.bid2, 0.29);
  });
});