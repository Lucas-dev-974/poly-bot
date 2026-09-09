import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EdgeConfirmBuffer } from "../src/strategy/edge-confirm.js";
import {
  EdgeLeadStrategy,
  cheapAskInBand,
  computeEdgeLeadCheapSize,
  computeEdgeLeadEdgeSize,
} from "../src/strategy/edge-lead-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { UpDownEvent } from "../src/types.js";
import { computeSize } from "../src/utils/prices.js";
import { books, testConfig, testEvent } from "./helpers.js";

function edgeConfig(overrides: Record<string, unknown> = {}) {
  return testConfig({
    strategyId: "edge-lead",
    edgeBandMin: 0.85,
    edgeBandMax: 0.9,
    edgeConfirmSamples: 5,
    edgeMaxDownTick: 0.01,
    edgeCheapMargin: 0.01,
    edgeOrderUsdc: 25,
    edgeCheapOrderUsdc: 5,
    edgeCheapBandMin: 0.04,
    edgeCheapBandMax: 0.14,
    maxSharesPerOrder: 40,
    ...overrides,
  });
}

function filledExpensive(
  event: UpDownEvent,
  pairId: string,
  size = 29.41,
  price = 0.85,
) {
  return {
    id: "edge-fill",
    eventSlug: event.slug,
    eventTitle: event.title,
    tokenId: "t-up",
    outcome: "Up",
    outcomeIndex: 0,
    kind: "expensive" as const,
    limitPrice: price,
    fillPrice: price,
    size,
    cost: size * price,
    windowEnd: event.windowEnd,
    status: "open" as const,
    fillReason: "marketable" as const,
    pairId,
  };
}

function confirmRising(
  strategy: EdgeLeadStrategy,
  tracker: TradeTracker,
  event: UpDownEvent,
  config: ReturnType<typeof edgeConfig>,
  cheapAsk = 0.03,
) {
  let last: ReturnType<typeof strategy.findOpportunities> = [];
  for (const ask of [0.85, 0.85, 0.86, 0.86, 0.85]) {
    last = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(ask, cheapAsk),
    });
  }
  return last;
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
    buf.push(pairId, 0.85, "Up", config);
    buf.push(pairId, 0.82, "Up", config);
    assert.equal(buf.sampleCount(pairId), 0);
  });

  it("resets when the ask leaves the band", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    buf.push(pairId, 0.86, "Up", config);
    buf.push(pairId, 0.91, "Up", config);
    assert.equal(buf.sampleCount(pairId), 0);
  });

  it("resets and re-arms when the edge identity flips", () => {
    const buf = new EdgeConfirmBuffer();
    const pairId = "p1";
    buf.push(pairId, 0.86, "Up", config);
    buf.push(pairId, 0.87, "Down", config);
    assert.equal(buf.sampleCount(pairId), 1);
    assert.equal(buf.getEdgeOutcome(pairId), "Down");
  });
});

describe("cheapAskInBand", () => {
  const config = edgeConfig();

  it("accepts asks inside the band", () => {
    assert.equal(cheapAskInBand(0.04, config), true);
    assert.equal(cheapAskInBand(0.05, config), true);
    assert.equal(cheapAskInBand(0.14, config), true);
  });

  it("rejects asks outside the band", () => {
    assert.equal(cheapAskInBand(0.03, config), false);
    assert.equal(cheapAskInBand(0.16, config), false);
  });
});

describe("computeEdgeLeadEdgeSize / computeEdgeLeadCheapSize", () => {
  it("sizes the edge from edgeOrderUsdc independently of the cheap budget", () => {
    const config = edgeConfig();
    assert.equal(
      computeEdgeLeadEdgeSize(config, 0.85),
      computeSize(25, 0.85, 40),
    );
  });

  it("sizes the cheap from edgeCheapOrderUsdc independently of the edge size", () => {
    const config = edgeConfig();
    const cheap = computeEdgeLeadCheapSize(config, 0.05);
    const edge = computeEdgeLeadEdgeSize(config, 0.85);
    assert.equal(cheap, computeSize(5, 0.05, 40));
    assert.equal(cheap, 40);
    assert.notEqual(cheap, edge);
  });

  it("returns null when the edge budget cannot meet CLOB minimums", () => {
    const config = edgeConfig({ edgeOrderUsdc: 1 });
    assert.equal(computeEdgeLeadEdgeSize(config, 0.9), null);
  });

  it("returns null when the cheap budget cannot meet CLOB minimums", () => {
    const config = edgeConfig({ edgeCheapOrderUsdc: 0.5 });
    assert.equal(computeEdgeLeadCheapSize(config, 0.14), null);
  });

  it("does not require a large edge budget just because cheap band min is low", () => {
    const config = edgeConfig({ edgeOrderUsdc: 15, edgeCheapOrderUsdc: 5 });
    assert.ok(computeEdgeLeadEdgeSize(config, 0.9) !== null);
    assert.ok(computeEdgeLeadCheapSize(config, 0.04) !== null);
  });
});

describe("EdgeLeadStrategy.findOpportunities", () => {
  it("emits the edge after confirmation, no cheap until the edge fills", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();

    const opps = confirmRising(strategy, tracker, event, config, 0.14);
    const edge = opps.find((o) => o.kind === "expensive");
    assert.ok(edge);
    assert.equal(edge.price, 0.85);
    assert.equal(edge.size, computeSize(25, 0.85, 40));

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

    const whileResting = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    });
    assert.equal(whileResting.filter((o) => o.kind === "cheap").length, 0);
    assert.equal(whileResting.filter((o) => o.kind === "expensive").length, 0);

    tracker.addOpenPosition(filledExpensive(event, pairId, edge.size, edge.price));

    const afterFill = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    });
    const cheap = afterFill.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.05);
    assert.equal(cheap.size, computeSize(5, 0.05, 40));
    assert.notEqual(cheap.size, edge.size);
  });

  it("posts cheap after fill even when the edge ask has left the edge band", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    // Edge fillé à 0.85, favori monté à 0.91 (hors bande 0.85–0.90),
    // cheap à 0.09 : le cheap doit partir, pas de reconfirmation.
    tracker.addOpenPosition(filledExpensive(event, pairId));
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.91, 0.09),
    });
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.09);
    assert.equal(cheap.token.outcome, "Down");
  });

  it("posts cheap after fill on the first tick with no prior confirmation buffer (restart)", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    tracker.addOpenPosition(filledExpensive(event, pairId));
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    });
    assert.ok(opps.find((o) => o.kind === "cheap"));
  });

  it("targets the claimed edge's opposite token even if the live favorite flipped", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    // Edge fillé sur Up ; le marché a flippé : Down est maintenant le favori.
    // Le cheap doit rester Down (l'autre jambe), jamais Up.
    tracker.addOpenPosition(filledExpensive(event, pairId));
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.10, 0.88),
    });
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
    assert.equal(opps.filter((o) => o.kind === "expensive").length, 0);
  });

  it("posts cheap at round2(ask) when the unrounded ask is just below the band min", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    tracker.addOpenPosition(filledExpensive(event, pairId));

    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.036),
    });
    const cheap = opps.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.04);
  });

  it("does not emit cheap when ask is below the cheap band", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    tracker.addOpenPosition(filledExpensive(event, pairId));
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.03),
    });
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
  });

  it("does not emit cheap when ask is above the cheap band", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    tracker.addOpenPosition(filledExpensive(event, pairId));
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.16),
    });
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
  });

  it("re-emits cheap after cancel+unmark when the ask re-enters the band", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

    tracker.addOpenPosition(filledExpensive(event, pairId));
    tracker.recordPostedOrder(
      "cheap-k",
      event.slug,
      event.windowEnd,
      1,
      undefined,
      {
        eventSlug: event.slug,
        windowEnd: event.windowEnd,
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        kind: "cheap",
        limitPrice: 0.05,
        size: 20,
        pairId,
        eventTitle: event.title,
        bestAskAtFill: 0.05,
      },
    );
    tracker.mark("cheap-k");

    const whilePosted = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    });
    assert.equal(whilePosted.filter((o) => o.kind === "cheap").length, 0);

    tracker.removePostedOrder("cheap-k");
    tracker.unmark("cheap-k");

    const afterCancel = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.86, 0.09),
    });
    const cheap = afterCancel.find((o) => o.kind === "cheap");
    assert.ok(cheap);
    assert.equal(cheap.price, 0.09);
  });

  it("does not emit a second edge once one is posted", () => {
    const strategy = new EdgeLeadStrategy();
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;

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
        size: 25,
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
      books: books(0.86, 0.05),
    });
    assert.equal(opps.filter((o) => o.kind === "expensive").length, 0);
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
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

describe("EdgeLeadStrategy.cheapOrderAction", () => {
  it("keeps a cheap GTC while the live ask stays in the cheap band", () => {
    const strategy = new EdgeLeadStrategy();
    const config = edgeConfig();
    const [, down] = books(0.86, 0.05);
    assert.equal(
      strategy.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: down,
        favoriteAsk: 0.86,
      }),
      "keep",
    );
  });

  it("cancels when the live ask leaves the cheap band", () => {
    const strategy = new EdgeLeadStrategy();
    const config = edgeConfig();
    const [, high] = books(0.86, 0.16);
    assert.equal(
      strategy.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: high,
        favoriteAsk: 0.86,
      }),
      "cancel-lock",
    );
    const [, low] = books(0.86, 0.03);
    assert.equal(
      strategy.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: low,
        favoriteAsk: 0.86,
      }),
      "cancel-lock",
    );
  });

  it("keeps the order when the cheap book is missing (fail-closed)", () => {
    const strategy = new EdgeLeadStrategy();
    assert.equal(
      strategy.cheapOrderAction({
        config: edgeConfig(),
        limitPrice: 0.05,
        cheapBook: undefined,
        favoriteAsk: 0.86,
      }),
      "keep",
    );
  });
});
