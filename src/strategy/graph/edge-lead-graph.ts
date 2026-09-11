import type {
  GraphEdge,
  GraphMethod,
  GraphNode,
  GraphOp,
  GraphParam,
  StrategyGraph,
} from "./types.js";

function lit(value: number | string | boolean | null): GraphParam {
  return { kind: "literal", value };
}
function cfg(key: string): GraphParam {
  return { kind: "config", key };
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
function d(from: string, to: string, port: string): GraphEdge {
  return { from, to, kind: "data", port };
}
function c(from: string, to: string, port: string): GraphEdge {
  return { from, to, kind: "control", port };
}

function findOpportunities(): GraphMethod {
  return {
    root: "phase-1",
    nodes: [
      n("books", "books"),
      n("edge-token", "pickEdgeToken", { books: ref("books") }),
      n("edge-ask", "askOf", { token: ref("edge-token") }),
      n("claimed-outcome", "claimedOutcome"),
      n("cheap-book", "pickOtherTokenByOutcome", {
        books: ref("books"),
        outcome: ref("claimed-outcome"),
      }),
      n("cheap-ask", "askOf", { token: ref("cheap-book") }),
      n("phase-1", "if", { cond: ref("edge-posted-not-filled") }),
      n("edge-posted-not-filled", "and", {
        a: ref("edge-posted"),
        b: ref("edge-not-filled"),
      }),
      n("edge-posted", "edgePosted"),
      n("edge-not-filled", "not", { a: ref("edge-filled") }),
      n("edge-filled", "hasEdgeFill"),
      n("phase-1-return", "return", { value: lit(null) }),
      n("phase-2", "if", { cond: ref("edge-filled") }),
      n("cheap-posted-or-filled", "or", {
        a: ref("cheap-posted"),
        b: ref("cheap-filled"),
      }),
      n("cheap-posted", "cheapPosted"),
      n("cheap-filled", "hasCheapFill"),
      n("claimed-null", "isNull", { value: ref("claimed-outcome") }),
      n("claimed-non-null", "not", { a: ref("claimed-null") }),
      n("cheap-book-null", "isNull", { value: ref("cheap-book") }),
      n("cheap-book-non-null", "not", { a: ref("cheap-book-null") }),
      n("cheap-ask-null", "isNull", { value: ref("cheap-ask") }),
      n("cheap-ask-non-null", "not", { a: ref("cheap-ask-null") }),
      n("cheap-guards", "and", {
        a: ref("claimed-non-null"),
        b: ref("cheap-book-non-null"),
      }),
      n("cheap-guards-2", "and", {
        a: ref("cheap-guards"),
        b: ref("cheap-ask-non-null"),
      }),
      n("cheap-ask-rounded", "round2", { value: ref("cheap-ask") }),
      n("cheap-in-band", "inCheapBand", {
        ask: ref("cheap-ask-rounded"),
        bandMin: cfg("edgeCheapBandMin"),
        bandMax: cfg("edgeCheapBandMax"),
      }),
      n("cheap-size", "computeEdgeLeadCheapSize", {
        price: ref("cheap-ask-rounded"),
      }),
      n("cheap-size-null", "isNull", { value: ref("cheap-size") }),
      n("cheap-size-non-null", "not", { a: ref("cheap-size-null") }),
      n("cheap-posted-or-filled-not", "not", {
        a: ref("cheap-posted-or-filled"),
      }),
      n("cheap-ready", "and", {
        a: ref("cheap-posted-or-filled-not"),
        b: ref("cheap-guards-2"),
      }),
      n("cheap-ready-2", "and", {
        a: ref("cheap-ready"),
        b: ref("cheap-in-band"),
      }),
      n("cheap-ready-3", "and", {
        a: ref("cheap-ready-2"),
        b: ref("cheap-size-non-null"),
      }),
      n("post-cheap", "postCheap"),
      n("phase-3", "if", { cond: ref("edge-ready") }),
      n("edge-confirm", "confirmTicks", {
        ask: ref("edge-ask"),
        samples: cfg("edgeConfirmSamples"),
        bandMin: cfg("edgeBandMin"),
        bandMax: cfg("edgeBandMax"),
        maxDownTick: cfg("edgeMaxDownTick"),
      }),
      n("edge-size", "computeEdgeLeadEdgeSize", { price: ref("edge-ask") }),
      n("edge-size-null", "isNull", { value: ref("edge-size") }),
      n("edge-size-non-null", "not", { a: ref("edge-size-null") }),
      n("edge-ready", "and", {
        a: ref("edge-confirm"),
        b: ref("edge-size-non-null"),
      }),
      n("post-edge", "postEdge"),
      n("phase-3-else", "return", { value: lit(null) }),
    ],
    edges: [
      d("books", "edge-token", "books"),
      d("edge-token", "edge-ask", "token"),
      d("books", "cheap-book", "books"),
      d("claimed-outcome", "cheap-book", "outcome"),
      d("cheap-book", "cheap-ask", "token"),
      d("cheap-ask", "cheap-ask-rounded", "value"),
      d("edge-posted", "edge-posted-not-filled", "a"),
      d("edge-not-filled", "edge-posted-not-filled", "b"),
      d("edge-filled", "edge-not-filled", "a"),
      d("edge-posted-not-filled", "phase-1", "cond"),
      c("phase-1", "phase-1-return", "then"),
      c("phase-1", "phase-2", "else"),
      d("edge-filled", "phase-2", "cond"),
      d("cheap-posted", "cheap-posted-or-filled", "a"),
      d("cheap-filled", "cheap-posted-or-filled", "b"),
      d("cheap-posted-or-filled", "cheap-posted-or-filled-not", "a"),
      d("claimed-outcome", "claimed-null", "value"),
      d("claimed-null", "claimed-non-null", "a"),
      d("cheap-book", "cheap-book-null", "value"),
      d("cheap-book-null", "cheap-book-non-null", "a"),
      d("cheap-ask", "cheap-ask-null", "value"),
      d("cheap-ask-null", "cheap-ask-non-null", "a"),
      d("claimed-non-null", "cheap-guards", "a"),
      d("cheap-book-non-null", "cheap-guards", "b"),
      d("cheap-guards", "cheap-guards-2", "a"),
      d("cheap-ask-non-null", "cheap-guards-2", "b"),
      d("cheap-posted-or-filled-not", "cheap-ready", "a"),
      d("cheap-guards-2", "cheap-ready", "b"),
      d("cheap-ready", "cheap-ready-2", "a"),
      d("cheap-in-band", "cheap-ready-2", "b"),
      d("cheap-ready-2", "cheap-ready-3", "a"),
      d("cheap-size-non-null", "cheap-ready-3", "b"),
      c("phase-2", "post-cheap", "then"),
      c("phase-2", "phase-3", "else"),
      d("cheap-ready-3", "post-cheap", "when"),
      d("cheap-book", "post-cheap", "token"),
      d("cheap-ask-rounded", "post-cheap", "price"),
      d("cheap-size", "post-cheap", "size"),
      d("edge-ask", "edge-confirm", "ask"),
      d("edge-ask", "edge-size", "price"),
      d("edge-size", "edge-size-null", "value"),
      d("edge-size-null", "edge-size-non-null", "a"),
      d("edge-confirm", "edge-ready", "a"),
      d("edge-size-non-null", "edge-ready", "b"),
      d("edge-ready", "phase-3", "cond"),
      c("phase-3", "post-edge", "then"),
      c("phase-3", "phase-3-else", "else"),
      d("edge-ready", "post-edge", "when"),
      d("edge-token", "post-edge", "token"),
      d("edge-ask", "post-edge", "price"),
      d("edge-size", "post-edge", "size"),
    ],
  };
}

function cheapOrderAction(): GraphMethod {
  return {
    root: "cheap-action",
    nodes: [
      n("cheap-book", "cheapBook"),
      n("cheap-ask", "askOf", { token: ref("cheap-book") }),
      n("ask-null", "isNull", { value: ref("cheap-ask") }),
      n("cheap-action", "if", { cond: ref("ask-null") }),
      n("ask-rounded", "round2", { value: ref("cheap-ask") }),
      n("cheap-in-band", "inCheapBand", {
        ask: ref("ask-rounded"),
        bandMin: cfg("edgeCheapBandMin"),
        bandMax: cfg("edgeCheapBandMax"),
      }),
      n("keep", "const", { value: lit("keep") }),
      n("cancel-lock", "const", { value: lit("cancel-lock") }),
    ],
    edges: [
      d("cheap-book", "cheap-ask", "token"),
      d("cheap-ask", "ask-null", "value"),
      d("cheap-ask", "ask-rounded", "value"),
      d("ask-null", "cheap-action", "cond"),
      c("cheap-action", "keep", "then"),
      c("cheap-action", "cheap-in-band", "else"),
      d("ask-rounded", "cheap-in-band", "ask"),
      c("cheap-in-band", "keep", "then"),
      c("cheap-in-band", "cancel-lock", "else"),
    ],
  };
}

function constMethod(root: string, op: GraphOp, value: GraphParam): GraphMethod {
  return { root, nodes: [n(root, op, { value })], edges: [] };
}

function sellEdge(): GraphMethod {
  return {
    root: "hold-loss",
    nodes: [
      n("pair-id", "pairId"),
      n("now", "nowMs"),
      n("enabled", "const", { value: cfg("edgeSellExpensiveEnabled") }),
      n("cheap-filled", "cheapFilled"),
      n("cheap-gt0", "gt", { a: ref("cheap-filled"), b: lit(0) }),
      n("cheap-zero", "not", { a: ref("cheap-gt0") }),
      n("age", "marketAgeMs"),
      n("after-min", "const", { value: cfg("edgeSellExpensiveAfterMin") }),
      n("after-ms", "mul", { a: ref("after-min"), b: lit(60_000) }),
      n("age-ok", "gte", { a: ref("age"), b: ref("after-ms") }),
      n("bid", "expensiveBid"),
      n("fill", "expensiveFillPrice"),
      n("bid-null", "isNull", { value: ref("bid") }),
      n("bid-ok", "not", { a: ref("bid-null") }),
      n("fill-ok", "gt", { a: ref("fill"), b: lit(0) }),
      n("diff", "sub", { a: ref("bid"), b: ref("fill") }),
      n("ratio", "div", { a: ref("diff"), b: ref("fill") }),
      n("loss-pct", "mul", { a: ref("ratio"), b: lit(100) }),
      n("thresh", "const", { value: cfg("edgeSellExpensiveLossPct") }),
      n("neg-thresh", "sub", { a: lit(0), b: ref("thresh") }),
      n("in-loss", "lte", { a: ref("loss-pct"), b: ref("neg-thresh") }),
      n("window-ms", "const", { value: cfg("edgeSellExpensiveLossWindowMs") }),
      n("g1", "and", { a: ref("enabled"), b: ref("cheap-zero") }),
      n("g2", "and", { a: ref("g1"), b: ref("age-ok") }),
      n("g3", "and", { a: ref("g2"), b: ref("bid-ok") }),
      n("g4", "and", { a: ref("g3"), b: ref("fill-ok") }),
      n("g5", "and", { a: ref("g4"), b: ref("in-loss") }),
      n("hold-loss", "holdTrueFor", {
        cond: ref("g5"),
        durationMs: ref("window-ms"),
        pairId: ref("pair-id"),
        nowMs: ref("now"),
      }),
    ],
    edges: [
      d("cheap-filled", "cheap-gt0", "a"),
      d("cheap-gt0", "cheap-zero", "a"),
      d("after-min", "after-ms", "a"),
      d("age", "age-ok", "a"),
      d("after-ms", "age-ok", "b"),
      d("bid", "bid-null", "value"),
      d("bid-null", "bid-ok", "a"),
      d("fill", "fill-ok", "a"),
      d("bid", "diff", "a"),
      d("fill", "diff", "b"),
      d("diff", "ratio", "a"),
      d("fill", "ratio", "b"),
      d("ratio", "loss-pct", "a"),
      d("thresh", "neg-thresh", "b"),
      d("loss-pct", "in-loss", "a"),
      d("neg-thresh", "in-loss", "b"),
      d("enabled", "g1", "a"),
      d("cheap-zero", "g1", "b"),
      d("g1", "g2", "a"),
      d("age-ok", "g2", "b"),
      d("g2", "g3", "a"),
      d("bid-ok", "g3", "b"),
      d("g3", "g4", "a"),
      d("fill-ok", "g4", "b"),
      d("g4", "g5", "a"),
      d("in-loss", "g5", "b"),
      d("g5", "hold-loss", "cond"),
      d("window-ms", "hold-loss", "durationMs"),
      d("pair-id", "hold-loss", "pairId"),
      d("now", "hold-loss", "nowMs"),
    ],
  };
}

export function edgeLeadPocGraph(): StrategyGraph {
  const now = Date.now();
  return {
    id: "custom:edge-lead-poc",
    name: "Edge-lead (POC)",
    leadsWithEdge: true,
    findOpportunities: findOpportunities(),
    cheapOrderAction: cheapOrderAction(),
    shouldDefend: constMethod("no-defend", "const", lit(false)),
    defendShares: constMethod("zero", "const", lit(0)),
    hedgeAtPostTime: {
      root: "hedge-skip",
      nodes: [
        n("hedge-skip", "hedge-skip", {
          reason: lit("edge-lead-managed-in-bot"),
        }),
      ],
      edges: [],
    },
    shouldSellExpensiveEdge: sellEdge(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
