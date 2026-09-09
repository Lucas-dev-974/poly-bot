import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EdgeConfirmBuffer } from "../src/strategy/edge-confirm.js";
import {
  EdgeLeadStrategy,
  computeEdgeCheapSize,
} from "../src/strategy/edge-lead-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

function edgeConfig(overrides: Record<string, unknown> = {}) {
  return testConfig({
    strategyId: "edge-lead",
    edgeBandMin: 0.85,
    edgeBandMax: 0.9,
    edgeConfirmSamples: 5,
    edgeMaxDownTick: 0.01,
    edgeCheapMargin: 0.01,
    edgeOrderUsdc: 15,
    edgeCheapOrderUsdc: 5,
    ...overrides,
  });
}

describe("EdgeConfirmBuffer", () => {
  const config = edgeConfig();

  it("confirms a rising series (0.85,0.85,0.86,0.86,0.85) after 5 ticks", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    const asks = [0.85, 0.85, 0.86, 0.86, 0.85];
    let ready = false;
    for (const ask of asks) {
      ready = buf.push(pairId, ask, "Up", config);
    }
    assert.equal(ready, true);
  });

  it("does not confirm a flat series (0.85 × 5) — mean === first", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    let ready = false;
    for (let i = 0; i < 5; i++) {
      ready = buf.push(pairId, 0.85, "Up", config);
    }
    assert.equal(ready, false);
  });

  it("does not confirm when last < first", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    let ready = false;
    for (const ask of [0.88, 0.88, 0.87, 0.87, 0.86]) {
      ready = buf.push(pairId, ask, "Up", config);
    }
    assert.equal(ready, false);
  });

  it("resets on a tick-to-tick drop above edgeMaxDownTick", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    buf.push(pairId, 0.86, "Up", config);
    buf.push(pairId, 0.85, "Up", config); // drop 0.01 = OK
    buf.push(pairId, 0.82, "Up", config); // drop 0.03 > 0.01 → reset
    assert.equal(buf.sampleCount(pairId), 0);
  });

  it("resets when the ask leaves the band", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    buf.push(pairId, 0.86, "Up", config);
    buf.push(pairId, 0.91, "Up", config); // > max 0.90 → reset
    assert.equal(buf.sampleCount(pairId), 0);
  });

  it("resets and re-arms when the edge identity flips", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    buf.push(pairId, 0.86, "Up", config);
    buf.push(pairId, 0.87, "Down", config); // identity changed → reset + re-arm
    // Re-armed on the new token: the new sample is counted.
    assert.equal(buf.sampleCount(pairId), 1);
    assert.equal(buf.getEdgeOutcome(pairId), "Down");
  });
});

describe("computeEdgeCheapSize", () => {
  it("sizes 1:1 so the cheap passes CLOB minimums (5 shares, $1 notional)", () => {
    const config = edgeConfig();
    // edge 0.85 → cheap 0.14 → need ceil(1/0.14)=8 shares, edge cost 0.85*8=6.8 ≤ 15
    const size = computeEdgeCheapSize(config, 0.85);
    assert.ok(size !== null);
    assert.ok(size >= 5);
    assert.ok(size * (1 - 0.85 - 0.01) >= 1);
  });

  it("returns null when the edge budget cannot cover the CLOB minimum", () => {
    const config = edgeConfig({ edgeOrderUsdc: 1 });
    // edge 0.9 → cheap 0.09 → need ceil(1/0.09)=12 shares → edge cost 0.9*12=10.8 > 1
    assert.equal(computeEdgeCheapSize(config, 0.9), null);
  });

  it("caps size by edgeCheapOrderUsdc when cheap budget is the binding constraint", () => {
    // edge 0.85 → cheap 0.14 → CLOB wants 8 shares, edge budget allows 17,
    // but cheap cap 1 USDC → floor(1/0.14)=7 shares (≥5 → valid).
    const config = edgeConfig({ edgeCheapOrderUsdc: 1 });
    const size = computeEdgeCheapSize(config, 0.85);
    assert.equal(size, 7);
  });

  it("returns null when edgeCheapOrderUsdc is too low for CLOB minimum", () => {
    // edge 0.85 → cheap 0.14 → CLOB needs 5 shares → cheap cost 5*0.14=0.70.
    // cheap cap 0.50 → floor(0.50/0.14)=3 < 5 → null.
    const config = edgeConfig({ edgeCheapOrderUsdc: 0.5 });
    assert.equal(computeEdgeCheapSize(config, 0.85), null);
  });
});

describe("EdgeLeadStrategy.findOpportunities", () => {
  it("emits the edge (expensive) after confirmation, then cheap-only resume", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();

    // 5 ticks rising in band → edge emitted.
    let opps: ReturnType<typeof strategy.findOpportunities> = [];
    for (const ask of [0.85, 0.85, 0.86, 0.86, 0.85]) {
      opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.14),
      });
    }
    const edge = opps.find((o) => o.kind === "expensive");
    assert.ok(edge);
    assert.equal(edge.price, 0.85);

    // Simulate the edge POST (record posted order) → next tick emits cheap only.
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.recordPostedOrder(
      edge.tradeKey,
      event.slug,
      event.windowEnd,
      edge.price * edge.size,
      undefined,
      {
        eventSlug: event.slug,
        windowEnd: event.windowEnd,
        tokenId: edge.token.tokenId,
        outcome: edge.token.outcome,
        outcomeIndex: edge.token.outcomeIndex,
        kind: "expensive",
        limitPrice: edge.price,
        size: edge.size,
        pairId,
        eventTitle: event.title,
        bestAskAtFill: edge.token.bestAsk,
      },
    );
    tracker.mark(edge.tradeKey);

    const opps2 = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.14),
    });
    const cheap = opps2.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 1 - 0.85 - 0.01); // 0.14
    assert.equal(cheap.size, edge.size); // 1:1
  });

  it("does not emit a second edge once one is posted", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    // Pre-post an edge.
    tracker.recordPostedOrder(
      "k1",
      event.slug,
      event.windowEnd,
      7,
      undefined,
      {
        eventSlug: event.slug,
        windowEnd: event.windowEnd,
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        kind: "expensive",
        limitPrice: 0.85,
        size: 8,
        pairId,
        eventTitle: event.title,
        bestAskAtFill: 0.85,
      },
    );
    tracker.mark("k1");

    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.14),
    });
    assert.equal(opps.filter((o) => o.kind === "expensive").length, 0);
  });

  it("does not emit anything on a one-sided book", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const [up] = books(0.86, 0.14);
    const opps = strategy.findOpportunities({
      config: edgeConfig(),
      tracker,
      event,
      books: [up],
    });
    assert.equal(opps.length, 0);
  });

  it("does not emit the edge when the ask is outside the band", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: edgeConfig(),
      tracker,
      event,
      books: books(0.95, 0.05),
    });
    assert.equal(opps.length, 0);
  });
});
