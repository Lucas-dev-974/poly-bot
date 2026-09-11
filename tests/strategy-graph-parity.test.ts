import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edgeLeadPocGraph } from "../src/strategy/graph/edge-lead-graph.js";
import { GraphStrategy } from "../src/strategy/graph/interpreter.js";
import { ensureEdgeOrderAction } from "../src/strategy/graph/ensure-edge-order.js";
import { validateStrategyGraph } from "../src/strategy/graph/validate.js";
import { EdgeLeadStrategy } from "../src/strategy/edge-lead-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { TradeOpportunity, UpDownEvent } from "../src/types.js";
import { computeSize } from "../src/utils/prices.js";
import { books, testConfig, testEvent } from "./helpers.js";

function edgeConfig(overrides: Record<string, unknown> = {}) {
  return testConfig({
    strategyId: "edge-lead",
    edgeBandMin: 0.85,
    edgeBandMax: 0.9,
    edgeConfirmSamples: 5,
    edgeMaxDownTick: 0.01,
    edgeOrderUsdc: 25,
    maxShareEdge: 40,
    edgeCheapOrderUsdc: 5,
    edgeCheapBandMin: 0.04,
    edgeCheapBandMax: 0.14,
    maxSharesPerOrder: 40,
    edgeSellExpensiveEnabled: true,
    edgeSellExpensiveAfterMin: 8,
    edgeSellExpensiveLossPct: 10,
    edgeSellExpensiveLossWindowMs: 10_000,
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

function assertSameOpps(native: TradeOpportunity[], graph: TradeOpportunity[]) {
  assert.equal(native.length, graph.length);
  for (let i = 0; i < native.length; i++) {
    const a = native[i];
    const b = graph[i];
    assert.equal(a.kind, b.kind);
    assert.equal(a.price, b.price);
    assert.equal(a.size, b.size);
    assert.equal(a.token.tokenId, b.token.tokenId);
    assert.equal(a.token.outcome, b.token.outcome);
    assert.equal(a.pairId, b.pairId);
  }
}

function confirmRising(
  native: EdgeLeadStrategy,
  graph: GraphStrategy,
  tracker: TradeTracker,
  event: UpDownEvent,
  config: ReturnType<typeof edgeConfig>,
  cheapAsk = 0.03,
) {
  let lastN: TradeOpportunity[] = [];
  let lastG: TradeOpportunity[] = [];
  for (const ask of [0.85, 0.85, 0.86, 0.86, 0.85]) {
    const ctx = { config, tracker, event, books: books(ask, cheapAsk) };
    lastN = native.findOpportunities(ctx);
    lastG = graph.findOpportunities(ctx);
    assertSameOpps(lastN, lastG);
  }
  return { native: lastN, graph: lastG };
}

describe("strategy graph validation", () => {
  it("accepts the edge-lead POC graph", () => {
    assert.deepEqual(validateStrategyGraph(edgeLeadPocGraph()), []);
  });
});

describe("GraphStrategy parity with EdgeLeadStrategy", () => {
  it("emits the edge after confirmation, no cheap until the edge fills", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();

    const { native: nOpps, graph: gOpps } = confirmRising(
      native,
      graph,
      tracker,
      event,
      config,
      0.14,
    );
    const edge = nOpps.find((o) => o.kind === "expensive");
    assert.ok(edge);
    assert.equal(edge.price, 0.85);
    assert.equal(edge.size, computeSize(25, 0.85, 40));
    assertSameOpps(nOpps, gOpps);

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

    const restingCtx = {
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    };
    assertSameOpps(
      native.findOpportunities(restingCtx),
      graph.findOpportunities(restingCtx),
    );

    tracker.addOpenPosition(filledExpensive(event, pairId, edge.size, edge.price));
    const afterFill = {
      config,
      tracker,
      event,
      books: books(0.86, 0.05),
    };
    const nFill = native.findOpportunities(afterFill);
    const gFill = graph.findOpportunities(afterFill);
    assertSameOpps(nFill, gFill);
    assert.equal(nFill[0]?.kind, "cheap");
    assert.equal(nFill[0]?.price, 0.05);
  });

  it("returns [] and resets the buffer when only one side has an ask", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const ctx = {
      config,
      tracker,
      event,
      books: [books(0.86, 0.05)[0]!],
    };
    assertSameOpps(native.findOpportunities(ctx), graph.findOpportunities(ctx));
  });

  it("resets confirmation when the edge leaves the band then requires N ticks again", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const tick = (ask: number) => {
      const ctx = { config, tracker, event, books: books(ask, 0.05) };
      assertSameOpps(native.findOpportunities(ctx), graph.findOpportunities(ctx));
    };
    tick(0.85);
    tick(0.86);
    tick(0.91);
    tick(0.85);
    tick(0.85);
    tick(0.86);
    tick(0.86);
    const last = { config, tracker, event, books: books(0.85, 0.05) };
    const nOpps = native.findOpportunities(last);
    const gOpps = graph.findOpportunities(last);
    assertSameOpps(nOpps, gOpps);
    assert.ok(nOpps.find((o) => o.kind === "expensive"));
  });

  it("applies round2 before the cheap band test", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition(filledExpensive(event, pairId));
    const ctx = {
      config,
      tracker,
      event,
      books: books(0.86, 0.14166),
    };
    const nOpps = native.findOpportunities(ctx);
    const gOpps = graph.findOpportunities(ctx);
    assertSameOpps(nOpps, gOpps);
    assert.equal(nOpps[0]?.kind, "cheap");
    assert.equal(nOpps[0]?.price, 0.14);
  });

  it("does not emit cheap when the rounded ask is outside the band", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition(filledExpensive(event, pairId));
    const ctx = {
      config,
      tracker,
      event,
      books: books(0.86, 0.16),
    };
    const nOpps = native.findOpportunities(ctx);
    assertSameOpps(nOpps, graph.findOpportunities(ctx));
    assert.equal(nOpps.length, 0);
  });

  it("does not emit a second edge when maxOpenPositionsPerSide is reached", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig({ maxOpenPositionsPerSide: 1 });
    tracker.addOpenPosition({
      ...filledExpensive(event, "other-window:1"),
      eventSlug: event.slug,
      outcome: "Up",
    });
    const { native: nOpps, graph: gOpps } = confirmRising(
      native,
      graph,
      tracker,
      event,
      config,
    );
    assertSameOpps(nOpps, gOpps);
    assert.equal(nOpps.length, 0);
  });

  it("does not re-emit once the tradeKey is marked", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const { native: posted } = confirmRising(
      native,
      graph,
      tracker,
      event,
      config,
    );
    const edge = posted.find((o) => o.kind === "expensive");
    assert.ok(edge);
    tracker.mark(edge.tradeKey);
    const ctx = { config, tracker, event, books: books(0.85, 0.05) };
    const nOpps = native.findOpportunities(ctx);
    assertSameOpps(nOpps, graph.findOpportunities(ctx));
    assert.equal(nOpps.length, 0);
  });

  it("targets the claimed opposite token even if the live favorite flipped", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const tracker = new TradeTracker();
    const event = testEvent();
    const config = edgeConfig();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition(filledExpensive(event, pairId));
    const ctx = {
      config,
      tracker,
      event,
      books: books(0.10, 0.88),
    };
    const nOpps = native.findOpportunities(ctx);
    assertSameOpps(nOpps, graph.findOpportunities(ctx));
    assert.equal(nOpps.length, 0);
  });

  it("re-emits cheap after cancel+unmark when the ask re-enters the band", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
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
    const postedCtx = { config, tracker, event, books: books(0.86, 0.05) };
    assertSameOpps(
      native.findOpportunities(postedCtx),
      graph.findOpportunities(postedCtx),
    );
    tracker.removePostedOrder("cheap-k");
    tracker.unmark("cheap-k");
    const afterCtx = { config, tracker, event, books: books(0.86, 0.09) };
    const nOpps = native.findOpportunities(afterCtx);
    const gOpps = graph.findOpportunities(afterCtx);
    assertSameOpps(nOpps, gOpps);
    assert.equal(nOpps[0]?.kind, "cheap");
    assert.equal(nOpps[0]?.price, 0.09);
  });

  it("matches cheapOrderAction keep / cancel-lock / missing book", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const config = edgeConfig();
    const [, down] = books(0.86, 0.05);
    const [, high] = books(0.86, 0.16);
    assert.equal(
      native.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: down,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
      graph.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: down,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
    );
    assert.equal(
      native.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: high,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
      graph.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: high,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
    );
    assert.equal(
      native.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: undefined,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
      graph.cheapOrderAction({
        config,
        limitPrice: 0.05,
        cheapBook: undefined,
        favoriteAsk: 0.86,
        pairId: "p",
      }),
    );
  });

  it("matches defend / hedge defaults", () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const defend = {
      config: edgeConfig(),
      favoriteAsk: 0.97,
      filledCheap: 10,
      filledExpensive: 0,
      pairId: "p",
    };
    assert.equal(native.shouldDefend(defend), graph.shouldDefend(defend));
    assert.equal(native.defendShares(defend), graph.defendShares(defend));
    const tracker = new TradeTracker();
    const hedge = {
      config: edgeConfig(),
      tracker,
      pairId: "p",
      freshAsk: 0.87,
    };
    assert.deepEqual(native.hedgeAtPostTime(hedge), graph.hedgeAtPostTime(hedge));
  });

  it("matches shouldSellExpensiveEdge guards and loss window", async () => {
    const native = new EdgeLeadStrategy();
    const graph = new GraphStrategy(edgeLeadPocGraph());
    const pairId = "btc-updown-15m-123:1800000000";
    const base = {
      config: edgeConfig(),
      tracker: new TradeTracker(),
      pairId,
      expensiveBid: 0.75,
      expensiveFillPrice: 0.85,
      expensiveSize: 29.41,
      cheapFilled: 0,
      marketAgeMs: 9 * 60_000,
    };
    assert.equal(
      native.shouldSellExpensiveEdge({ ...base, marketAgeMs: 5 * 60_000 }),
      graph.shouldSellExpensiveEdge({ ...base, marketAgeMs: 5 * 60_000 }),
    );
    assert.equal(
      native.shouldSellExpensiveEdge({ ...base, cheapFilled: 20 }),
      graph.shouldSellExpensiveEdge({ ...base, cheapFilled: 20 }),
    );
    assert.equal(
      native.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.85 }),
      graph.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.85 }),
    );
    assert.equal(
      native.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.8075 }),
      graph.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.8075 }),
    );
    assert.equal(
      native.shouldSellExpensiveEdge(base),
      graph.shouldSellExpensiveEdge(base),
    );

    native.shouldSellExpensiveEdge(base);
    graph.shouldSellExpensiveEdge(base);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const shortWindow = {
      ...base,
      config: edgeConfig({ edgeSellExpensiveLossWindowMs: 1 }),
    };
    assert.equal(
      native.shouldSellExpensiveEdge(shortWindow),
      true,
    );
    assert.equal(
      graph.shouldSellExpensiveEdge(shortWindow),
      true,
    );

    native.shouldSellExpensiveEdge(base);
    graph.shouldSellExpensiveEdge(base);
    native.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.85 });
    graph.shouldSellExpensiveEdge({ ...base, expensiveBid: 0.85 });
    assert.equal(
      native.shouldSellExpensiveEdge(shortWindow),
      false,
    );
    assert.equal(
      graph.shouldSellExpensiveEdge(shortWindow),
      false,
    );

    assert.equal(
      native.shouldSellExpensiveEdge({
        ...base,
        config: edgeConfig({ edgeSellExpensiveEnabled: false }),
      }),
      graph.shouldSellExpensiveEdge({
        ...base,
        config: edgeConfig({ edgeSellExpensiveEnabled: false }),
      }),
    );
    assert.equal(
      native.shouldSellExpensiveEdge({ ...base, expensiveBid: null }),
      graph.shouldSellExpensiveEdge({ ...base, expensiveBid: null }),
    );
  });
});

describe("graph edgeOrderAction", () => {
  it("edgeOrderAction matches native config bands", () => {
    const graph = edgeLeadPocGraph();
    assert.deepEqual(validateStrategyGraph(graph), []);
    const strategy = new GraphStrategy(graph);
    const config = testConfig({ edgeBandMin: 0.85, edgeBandMax: 0.9 });
    const pairId = "p:1";
    const inBand = {
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.84,
      bestAsk: 0.87,
      bestAskSize: 10,
    };
    const outBand = { ...inBand, bestAsk: 0.92 };
    assert.equal(
      strategy.edgeOrderAction({ config, edgeBook: inBand, pairId }),
      "keep",
    );
    assert.equal(
      strategy.edgeOrderAction({ config, edgeBook: outBand, pairId }),
      "cancel-lock",
    );
    assert.equal(
      strategy.edgeOrderAction({ config, edgeBook: undefined, pairId }),
      "keep",
    );
  });

  it("custom edgeOrderAction is not overridden by config bands", () => {
    const graph = edgeLeadPocGraph();
    // Always keep — even outside config bands.
    graph.edgeOrderAction = {
      root: "keep",
      nodes: [{ id: "keep", op: "const", params: { value: { kind: "literal", value: "keep" } } }],
      edges: [],
    };
    const strategy = new GraphStrategy(graph);
    const config = testConfig({ edgeBandMin: 0.85, edgeBandMax: 0.9 });
    const edgeBook = {
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.5,
      bestAsk: 0.5,
      bestAskSize: 10,
    };
    assert.equal(
      strategy.edgeOrderAction({ config, edgeBook, pairId: "p:1" }),
      "keep",
    );
  });

  it("ensureEdgeOrderAction fills missing method", () => {
    const graph = edgeLeadPocGraph() as StrategyGraph & { edgeOrderAction?: unknown };
    delete graph.edgeOrderAction;
    const fixed = ensureEdgeOrderAction(graph as StrategyGraph);
    assert.ok(fixed.edgeOrderAction);
    assert.deepEqual(validateStrategyGraph(fixed), []);
  });
});
