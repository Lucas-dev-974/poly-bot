import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { FavBandStrategy } from "../src/strategy/fav-band-strategy.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("fav-band strategy", () => {
  it("parses and registers fav-band", () => {
    assert.equal(parseStrategyId("fav-band"), "fav-band");
    assert.equal(createStrategy("fav-band").id, "fav-band");
  });

  it("emits FOK buy on favorite when ask in band after min elapsed", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      enableExpensiveHedge: false,
      arbAskLockOnly: true, // sticky flag must not block emission
      favBandOrderUsdc: 15,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 200,
      maxSharesPerOrder: 40,
    });
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 250) * 1000;
    const tracker = new TradeTracker();
    // Up ask 0.75 = favorite, Down 0.26
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].token.outcome, "Up");
    assert.equal(opps[0].price, 0.75);
  });

  it("skips when elapsed too early", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandMinElapsedSec: 200,
      favBandOrderUsdc: 15,
    });
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 50) * 1000;
    const opps = strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.75, 0.26, 100),
      nowMs,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when favorite ask outside band", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 0,
      favBandOrderUsdc: 15,
    });
    const event = testEvent();
    const nowMs = (event.windowStart + 300) * 1000;
    // favorite at 0.92 — outside band
    const opps = strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.92, 0.1, 100),
      nowMs,
    });
    assert.equal(opps.length, 0);
  });

  it("does not stack a second entry after a filled leg", () => {
    const strategy = new FavBandStrategy();
    const config = testConfig({
      strategyId: "fav-band",
      favBandMinElapsedSec: 0,
      favBandOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const position: SimulatedPosition = {
      id: "filled",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.75,
      fillPrice: 0.75,
      size: 20,
      cost: 15,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    };
    tracker.addOpenPosition(position);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.75, 0.26, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("coerces sticky arbAskLockOnly / hedge off in validateConfigCoherence", () => {
    const config = testConfig({
      strategyId: "fav-band",
      arbAskLockOnly: true,
      enableExpensiveHedge: true,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
    });
    validateConfigCoherence(config);
    assert.equal(config.arbAskLockOnly, false);
    assert.equal(config.enableExpensiveHedge, false);
  });
});
