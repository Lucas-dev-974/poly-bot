import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearMarketTradesCache,
  getWalletTradesInRange,
  parseWalletTrade,
  toUnixSec,
  walletTradesUrl,
} from "../src/dashboard/market-trades.ts";
import { testConfig } from "./helpers.ts";

afterEach(() => {
  clearMarketTradesCache();
});

describe("wallet trades range fetch", () => {
  it("normalizes millisecond timestamps to seconds", () => {
    assert.equal(toUnixSec(1_800_000_000_000), 1_800_000_000);
    assert.equal(toUnixSec(1_800_000_000), 1_800_000_000);
    assert.equal(toUnixSec(0), 0);
  });

  it("parses a Data API trade and drops empty size", () => {
    const ok = parseWalletTrade({
      side: "BUY",
      price: "0.42",
      size: "12.5",
      timestamp: "1800000000",
      outcome: "Up",
      outcomeIndex: "0",
      conditionId: "0xabc",
      slug: "btc-updown-15m-1800000000",
      eventSlug: "btc-updown-15m-1800000000",
    });
    assert.deepEqual(ok, {
      timestamp: 1_800_000_000,
      price: 0.42,
      size: 12.5,
      side: "BUY",
      outcome: "Up",
      outcomeIndex: 0,
      conditionId: "0xabc",
      slug: "btc-updown-15m-1800000000",
      eventSlug: "btc-updown-15m-1800000000",
    });
    assert.equal(parseWalletTrade({ side: "BUY", price: 0.4, size: 0, timestamp: 1 }), null);
    assert.equal(parseWalletTrade({ side: "HOLD", price: 0.4, size: 1, timestamp: 1 }), null);
  });

  it("asks for maker+taker fills in the inclusive window", () => {
    const url = walletTradesUrl(
      "https://data-api.polymarket.com",
      "0xabc",
      100,
      200,
      500,
    );
    assert.equal(url.searchParams.get("user"), "0xabc");
    assert.equal(url.searchParams.get("start"), "100");
    assert.equal(url.searchParams.get("end"), "200");
    assert.equal(url.searchParams.get("takerOnly"), "false");
    assert.equal(url.searchParams.get("limit"), "500");
    assert.equal(url.searchParams.get("offset"), "500");
  });

  it("returns nothing without a funder", async () => {
    const trades = await getWalletTradesInRange(testConfig(), 100, 200);
    assert.deepEqual(trades, []);
  });

  it("pages user trades and caches the merged result", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      const href = String(input);
      urls.push(href);
      const offset = Number(new URL(href).searchParams.get("offset") ?? 0);
      const row = (n: number) => ({
        side: "BUY",
        price: 0.4,
        size: 1,
        timestamp: 1_800_000_000 + n,
        outcome: "Up",
        outcomeIndex: 0,
        conditionId: "0xabc",
        slug: "btc-updown-15m-1800000000",
        eventSlug: "btc-updown-15m-1800000000",
      });
      const body = offset === 0 ? Array.from({ length: 500 }, (_, i) => row(i)) : [row(500)];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      const config = testConfig({
        funderAddress: "0x1234567890123456789012345678901234567890",
      });
      const first = await getWalletTradesInRange(config, 1_800_000_000, 1_800_000_900);
      assert.equal(first.length, 501);
      assert.equal(calls, 2);
      assert.match(urls[0] ?? "", /takerOnly=false/);
      assert.match(urls[0] ?? "", /end=1800000901/);
      const second = await getWalletTradesInRange(config, 1_800_000_000, 1_800_000_900);
      assert.equal(second.length, 501);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
