import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserFeed } from "../src/ws/user-feed.js";
import type { WsOrderStatus } from "../src/ws/user-feed.js";

function collect(): { statuses: WsOrderStatus[]; feed: UserFeed } {
  const statuses: WsOrderStatus[] = [];
  const feed = new UserFeed({
    wsUserHost: "wss://test/ws/user",
    apiKey: "k",
    apiSecret: "s",
    apiPassphrase: "p",
    onOrderStatus: (status) => statuses.push(status),
  });
  return { statuses, feed };
}

describe("UserFeed", () => {
  it("normalizes an order message into a WsOrderStatus", () => {
    const { statuses, feed } = collect();
    feed.handleMessage({
      event_type: "order",
      order_id: "0xabc",
      asset_id: "tokA",
      status: "matched",
      size_matched: "12.5",
    });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.orderId, "0xabc");
    assert.equal(statuses[0]?.filled, true);
    assert.equal(statuses[0]?.sizeMatched, 12.5);
    assert.equal(statuses[0]?.cancelled, false);
  });

  it("detects cancelled orders", () => {
    const { statuses, feed } = collect();
    feed.handleMessage({
      event_type: "order",
      order_id: "0xdef",
      status: "canceled",
      size_matched: "0",
    });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.cancelled, true);
    assert.equal(statuses[0]?.filled, false);
  });

  it("ignores non-order/trade events and missing order_id", () => {
    const { statuses, feed } = collect();
    feed.handleMessage({ event_type: "tick_size_change" });
    feed.handleMessage({ event_type: "order" });
    feed.handleMessage({ event_type: "trade", order_id: "0x123", status: "matched", size_matched: "5" });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.orderId, "0x123");
  });

  it("treats non-numeric size_matched as 0 (not filled)", () => {
    const { statuses, feed } = collect();
    feed.handleMessage({
      event_type: "order",
      order_id: "0x123",
      status: "matched",
      size_matched: "abc",
    });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.filled, false);
    assert.equal(statuses[0]?.sizeMatched, 0);
  });

  it("start() without creds does not connect", () => {
    const statuses: WsOrderStatus[] = [];
    const feed = new UserFeed({
      wsUserHost: "wss://test/ws/user",
      onOrderStatus: (status) => statuses.push(status),
    });
    feed.start();
    assert.equal(feed.isConnected(), false);
  });
});