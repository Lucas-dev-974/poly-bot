import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EdgeConfirmBuffer } from "../src/strategy/edge-confirm.js";
import { edgeLeadPocGraph } from "../src/strategy/graph/edge-lead-graph.js";
import { GraphStrategy } from "../src/strategy/graph/interpreter.js";
import {
  executeOp,
  type GraphRuntimeState,
} from "../src/strategy/graph/ops.js";
import { emptyGraphContext } from "../src/strategy/graph/types.js";
import { validateStrategyGraph } from "../src/strategy/graph/validate.js";
import type {
  GraphMethod,
  GraphNode,
  GraphOp,
  GraphParam,
  StrategyGraph,
} from "../src/strategy/graph/types.js";
import type { DefendContext } from "../src/strategy/trading-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

function lit(value: number | string | boolean | null): GraphParam {
  return { kind: "literal", value };
}
function ref(node: string): GraphParam {
  return { kind: "ref", node };
}
function n(
  id: string,
  op: GraphOp,
  params: Record<string, GraphParam> = {},
): GraphNode {
  return { id, op, params };
}
function d(from: string, to: string, port: string) {
  return { kind: "data" as const, from, to, port };
}
function leaf(
  id: string,
  op: GraphOp,
  params: Record<string, GraphParam> = {},
): GraphMethod {
  return { root: id, nodes: [n(id, op, params)], edges: [] };
}

function stubGraph(
  id: string,
  overrides: Partial<Pick<StrategyGraph, "shouldDefend" | "findOpportunities" | "cheapOrderAction">>,
): StrategyGraph {
  const now = Date.now();
  return {
    id,
    name: id,
    leadsWithEdge: true,
    findOpportunities: leaf("skip", "skip"),
    cheapOrderAction: leaf("keep", "keep"),
    shouldDefend: leaf("no-defend", "no-defend"),
    defendShares: leaf("zero", "const", { value: lit(0) }),
    hedgeAtPostTime: leaf("hedge-skip", "hedge-skip", {
      reason: lit("test"),
    }),
    shouldSellExpensiveEdge: leaf("no-sell", "no-sell-edge"),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function trendMethod(
  op: "trendUp" | "trendDown" | "trendNeutral",
  maxAgeMs: number,
): GraphMethod {
  return {
    root: "trend",
    nodes: [
      n("pid", "pairId"),
      n("now", "nowMs"),
      n("ask", "favoriteAsk"),
      n("sample", "sampleWindow", {
        pairId: ref("pid"),
        ask: ref("ask"),
        nowMs: ref("now"),
        maxAgeMs: lit(maxAgeMs),
      }),
      n("trend", op, {
        samples: ref("sample"),
        nowMs: ref("now"),
        maxAgeMs: lit(maxAgeMs),
        minSlope: lit(0.002),
      }),
    ],
    edges: [
      d("pid", "sample", "pairId"),
      d("ask", "sample", "ask"),
      d("now", "sample", "nowMs"),
      d("sample", "trend", "samples"),
      d("now", "trend", "nowMs"),
    ],
  };
}

function bothTrendsMethod(maxAgeMs: number): GraphMethod {
  return {
    root: "either",
    nodes: [
      n("pid", "pairId"),
      n("now", "nowMs"),
      n("ask", "favoriteAsk"),
      n("sample", "sampleWindow", {
        pairId: ref("pid"),
        ask: ref("ask"),
        nowMs: ref("now"),
        maxAgeMs: lit(maxAgeMs),
      }),
      n("up", "trendUp", {
        samples: ref("sample"),
        nowMs: ref("now"),
        maxAgeMs: lit(maxAgeMs),
        minSlope: lit(0.002),
      }),
      n("down", "trendDown", {
        samples: ref("sample"),
        nowMs: ref("now"),
        maxAgeMs: lit(maxAgeMs),
        minSlope: lit(0.002),
      }),
      n("either", "or", { a: ref("up"), b: ref("down") }),
    ],
    edges: [
      d("pid", "sample", "pairId"),
      d("ask", "sample", "ask"),
      d("now", "sample", "nowMs"),
      d("sample", "up", "samples"),
      d("now", "up", "nowMs"),
      d("sample", "down", "samples"),
      d("now", "down", "nowMs"),
      d("up", "either", "a"),
      d("down", "either", "b"),
    ],
  };
}

function emptyState(): GraphRuntimeState {
  return {
    buffer: new EdgeConfirmBuffer(),
    holdTrueFor: new Map(),
    pairWindows: new Map(),
    sampleWindows: new Map(),
  };
}

const config = testConfig({ strategyId: "edge-lead" });

function defend(
  pairId: string,
  ask: number | null,
  nowMs?: number,
): DefendContext {
  return {
    config,
    favoriteAsk: ask,
    filledCheap: 0,
    filledExpensive: 0,
    pairId,
    nowMs,
  };
}

function trio(suffix: string) {
  return {
    up: new GraphStrategy(
      stubGraph(`custom:t-up-${suffix}`, {
        shouldDefend: trendMethod("trendUp", 15_000),
      }),
    ),
    down: new GraphStrategy(
      stubGraph(`custom:t-dn-${suffix}`, {
        shouldDefend: trendMethod("trendDown", 15_000),
      }),
    ),
    neu: new GraphStrategy(
      stubGraph(`custom:t-neu-${suffix}`, {
        shouldDefend: trendMethod("trendNeutral", 15_000),
      }),
    ),
  };
}

function flags(
  s: ReturnType<typeof trio>,
  pairId: string,
  ask: number,
  nowMs: number,
) {
  return [
    s.up.shouldDefend(defend(pairId, ask, nowMs)),
    s.down.shouldDefend(defend(pairId, ask, nowMs)),
    s.neu.shouldDefend(defend(pairId, ask, nowMs)),
  ];
}

describe("strategy graph temporal ops", () => {
  it("POC edge-lead still has no temporal validation errors", () => {
    assert.deepEqual(validateStrategyGraph(edgeLeadPocGraph()), []);
  });

  it("rejects windowStartSec outside findOpportunities and weak temporal literals", () => {
    const graph = stubGraph("custom:bad-temporal", {
      cheapOrderAction: {
        root: "ws",
        nodes: [n("ws", "windowStartSec")],
        edges: [],
      },
      shouldDefend: {
        root: "trend",
        nodes: [
          n("trend", "trendUp", {
            samples: lit(1),
            minSlope: lit(0),
          }),
        ],
        edges: [],
      },
      findOpportunities: {
        root: "skip",
        nodes: [
          n("sample", "sampleWindow", { maxAgeMs: lit(1000) }),
          n("skip", "skip"),
        ],
        edges: [],
      },
    });
    const errors = validateStrategyGraph(graph);
    assert.ok(errors.some((e) => /cheapOrderAction: op 'windowStartSec'/.test(e)));
    assert.ok(errors.some((e) => /maxAgeMs must be/.test(e)));
    assert.ok(errors.some((e) => /minSlope must be > 0/.test(e)));
    assert.ok(errors.some((e) => /samples must ref a sampleWindow/.test(e)));
  });

  it("17: sampleWindow once per tick; trendUp respects minSlope on a 5s window", () => {
    const graph = stubGraph("custom:trend-up", {
      shouldDefend: trendMethod("trendUp", 5000),
    });
    const strategy = new GraphStrategy(graph);
    const pairId = "p:1";
    const t0 = 1_700_000_000_000;
    const asks = [0.5, 0.5, 0.51, 0.52, 0.54];
    const seen: boolean[] = [];
    for (let i = 0; i < asks.length; i++) {
      seen.push(strategy.shouldDefend(defend(pairId, asks[i], t0 + i * 5000)));
    }
    // 5s window. 0.51−0.50 is 0.010000000000000009 in IEEE, so slope > 0.002
    // from the third tick; 0.52→0.54 stays well above the threshold.
    assert.deepEqual(seen, [false, false, true, true, true]);

    const skipNull = new GraphStrategy(
      stubGraph("custom:skip-null", { shouldDefend: bothTrendsMethod(5000) }),
    );
    assert.equal(skipNull.shouldDefend(defend(pairId, null, t0)), false);
    assert.equal(skipNull.shouldDefend(defend(pairId, 0.5, t0 + 5000)), false);
    assert.equal(skipNull.shouldDefend(defend(pairId, 0.54, t0 + 10_000)), true);
  });

  it("18: trendUp/Down/Neutral are mutually exclusive; flat → neutral; <2 samples → all false", () => {
    const t0 = 1_700_000_000_000;

    const flat = trio("flat");
    assert.deepEqual(flags(flat, "p:18-flat", 0.5, t0), [false, false, false]);
    assert.deepEqual(flags(flat, "p:18-flat", 0.5, t0 + 5000), [
      false,
      false,
      true,
    ]);
    assert.deepEqual(flags(flat, "p:18-flat", 0.5, t0 + 10_000), [
      false,
      false,
      true,
    ]);

    const rise = trio("rise");
    assert.deepEqual(flags(rise, "p:18-rise", 0.5, t0), [false, false, false]);
    const rising = flags(rise, "p:18-rise", 0.52, t0 + 5000);
    assert.deepEqual(rising, [true, false, false]);
    assert.equal(rising.filter(Boolean).length, 1);

    const fall = trio("fall");
    assert.deepEqual(flags(fall, "p:18-fall", 0.52, t0), [false, false, false]);
    const falling = flags(fall, "p:18-fall", 0.5, t0 + 5000);
    assert.deepEqual(falling, [false, true, false]);
    assert.equal(falling.filter(Boolean).length, 1);
  });

  it("19: inPhase splits a 15m market; elapsed 301 → phase 1; 601 → phase 2; negative → false", () => {
    const graph = stubGraph("custom:in-phase", {
      shouldDefend: {
        root: "phase",
        nodes: [
          n("pid", "pairId"),
          n("ws", "pairWindowStart", { pairId: ref("pid") }),
          n("now", "nowMs"),
          n("phase", "inPhase", {
            windowStartSec: ref("ws"),
            nowMs: ref("now"),
            phaseDurationSec: lit(300),
            phaseMin: lit(0),
            phaseMax: lit(1),
          }),
        ],
        edges: [
          d("pid", "ws", "pairId"),
          d("ws", "phase", "windowStartSec"),
          d("now", "phase", "nowMs"),
        ],
      },
    });
    const strategy = new GraphStrategy(graph);
    const event = testEvent();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const t0 = event.windowStart * 1000;
    strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.5, 0.5),
      nowMs: t0,
    });

    assert.equal(
      strategy.shouldDefend(defend(pairId, 0.5, t0 + 301_000)),
      true,
    );
    assert.equal(
      strategy.shouldDefend(defend(pairId, 0.5, t0 + 601_000)),
      false,
    );
    assert.equal(strategy.shouldDefend(defend(pairId, 0.5, t0 - 1000)), false);

    const miss = new GraphStrategy(graph);
    assert.equal(
      miss.shouldDefend(defend("unknown:1", 0.5, t0 + 301_000)),
      false,
    );
  });

  it("20: injected snapshot clock timestamps samples; collapsed replay looks like a false trend", () => {
    const graph = stubGraph("custom:clock", {
      shouldDefend: trendMethod("trendUp", 10_000),
    });
    const spaced = new GraphStrategy(graph);
    const collapsed = new GraphStrategy(graph);
    const pairId = "p:20";
    const t0 = 1_700_000_000_000;

    assert.equal(spaced.shouldDefend(defend(pairId, 0.5, t0)), false);
    assert.equal(
      spaced.shouldDefend(defend(pairId, 0.501, t0 + 5000)),
      false,
    );

    assert.equal(collapsed.shouldDefend(defend(pairId, 0.5, t0)), false);
    assert.equal(
      collapsed.shouldDefend(defend(pairId, 0.501, t0 + 1)),
      true,
    );

    const state = emptyState();
    const ctx = emptyGraphContext();
    ctx.pairId = pairId;
    const ports = (ask: number, nowMs: number) => (port: string) => {
      if (port === "maxAgeMs") return 10_000;
      if (port === "pairId") return pairId;
      if (port === "ask") return ask;
      if (port === "nowMs") return nowMs;
      return undefined;
    };
    executeOp("sampleWindow", ports(0.5, t0), ctx, state, undefined, "sample");
    const packed = executeOp(
      "sampleWindow",
      ports(0.501, t0 + 5000),
      ctx,
      state,
      undefined,
      "sample",
    ) as { samples: Array<{ ts: number; ask: number }> };
    assert.deepEqual(
      packed.samples.map((s) => s.ts),
      [t0, t0 + 5000],
    );

    assert.throws(
      () =>
        executeOp(
          "sampleWindow",
          (port) => {
            if (port === "maxAgeMs") return 10_000;
            if (port === "pairId") return pairId;
            if (port === "ask") return 0.5;
            return undefined;
          },
          emptyGraphContext(),
          emptyState(),
          undefined,
          "sample",
        ),
      /temporal op requires nowMs/,
    );
  });
});

describe("graph strategy clock wiring", () => {
  it("shouldSellExpensiveEdge uses injected nowMs (not wall clock)", () => {
    const holdMs = 10_000;
    const sellMethod: GraphMethod = {
      root: "hold",
      nodes: [
        n("now", "nowMs"),
        n("hold", "holdTrueFor", {
          key: lit("loss-clock"),
          cond: lit(true),
          durationMs: lit(holdMs),
          nowMs: ref("now"),
        }),
      ],
      edges: [d("now", "hold", "nowMs")],
    };
    const graph = stubGraph("custom:clock-sell", {});
    graph.shouldSellExpensiveEdge = sellMethod;
    const strategy = new GraphStrategy(graph);
    const tracker = new TradeTracker();
    const t0 = 1_700_000_000_000;
    const base = {
      config: testConfig(),
      tracker,
      pairId: "p:1",
      expensiveBid: 0.7,
      expensiveFillPrice: 0.9,
      expensiveSize: 10,
      cheapFilled: 0,
      marketAgeMs: 0,
      nowMs: t0,
    };
    assert.equal(strategy.shouldSellExpensiveEdge(base), false);
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        ...base,
        marketAgeMs: holdMs,
        nowMs: t0 + holdMs,
      }),
      true,
    );
  });
});
