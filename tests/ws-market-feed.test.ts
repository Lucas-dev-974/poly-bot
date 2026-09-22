import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketDataProvider } from "../src/market-data.js";
import type { UpDownEvent } from "../src/types.js";

function makeEvent(clobTokenIds: string): UpDownEvent {
  return {
    title: "BTC Up/Down 15m",
    slug: "btc-updown-15m-1700000000",
    market: {
      conditionId: "0xcond",
      slug: "btc-updown-15m-1700000000",
      clobTokenIds,
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      active: true,
      closed: false,
    },
    windowStart: 1_700_000_000,
    windowEnd: 1_700_000_000 + 900,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConstructorParameters<typeof MarketDataProvider>[0] {
  return {
    wsEnabled: true,
    wsMarketHost: "wss://test/ws/market",
    wsUserHost: "wss://test/ws/user",
    wsBookMaxAgeMs: 3_000,
    clobApiKey: "k",
    clobSecret: "s",
    clobPassphrase: "p",
    ...overrides,
  } as ConstructorParameters<typeof MarketDataProvider>[0];
}

describe("MarketDataProvider", () => {
  it("serves books from the WS cache when live (no REST call)", async () => {
    const provider = new MarketDataProvider(makeConfig());
    provider.start(["tokA", "tokB"]);
    const feed = provider["feed"];
    const scanner = provider["scanner"];
    // Si le test passe par le REST, on le sait immédiatement.
    scanner.getTokenBook = async () => {
      throw new Error("REST called while WS live");
    };
    feed?.setConnected(true);
    feed?.handleMessage({
      event_type: "book",
      asset_id: "tokA",
      bids: [{ price: "0.42", size: "9" }],
      asks: [{ price: "0.5", size: "6" }],
    });
    feed?.handleMessage({
      event_type: "book",
      asset_id: "tokB",
      bids: [{ price: "0.3", size: "2" }],
      asks: [{ price: "0.4", size: "3" }],
    });
    const books = await provider.getTokenBooks(makeEvent('["tokA","tokB"]'));
    assert.equal(books.length, 2);
    assert.equal(books[0]?.bestBid, 0.42);
    assert.equal(books[1]?.bestAsk, 0.4);
    await provider.stop();
  });

  it("falls back to REST when the WS is not live", async () => {
    const provider = new MarketDataProvider(makeConfig({ wsEnabled: false }));
    const scanner = provider["scanner"];
    const captured: string[] = [];
    scanner.getTokenBook = async (tokenId: string) => {
      captured.push(tokenId);
      return {
        tokenId,
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: 0.1,
        bestAsk: 0.2,
        bestAskSize: 1,
        bestBidSize: 2,
      };
    };
    const books = await provider.getTokenBooks(makeEvent('["tokX"]'));
    assert.deepEqual(captured, ["tokX"]);
    assert.equal(books.length, 1);
    assert.equal(books[0]?.bestAsk, 0.2);
  });

  it("syncAssets accepts the active set without reconnect when unchanged", async () => {
    const provider = new MarketDataProvider(makeConfig());
    provider.start(["tokA"]);
    const socket = provider["socket"];
    assert.ok(socket);
    let closed = 0;
    socket.close = () => {
      closed++;
    };
    provider.syncAssets([makeEvent('["tokA"]')]);
    // Set inchangé → aucune reconnexion programmée.
    assert.equal(closed, 0);
    await provider.stop();
  });
});