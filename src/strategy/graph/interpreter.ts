import type {
  CheapOrderAction,
  DefendContext,
  EdgeOrderAction,
  EdgeSellContext,
  HedgePostContext,
  HedgePostDecision,
  RestingCheapContext,
  RestingEdgeContext,
  StrategyContext,
  TradingStrategy,
} from "../trading-strategy.js";
import type { StrategyId } from "../ids.js";
import type { TradeOpportunity } from "../../types.js";
import { bus } from "../../dashboard/events.js";
import { log } from "../../logger.js";
import { EdgeConfirmBuffer } from "../edge-confirm.js";
import { executeOp, purgeExpiredSampleWindows, type GraphRuntimeState } from "./ops.js";
import { validateStrategyGraph } from "./validate.js";
import {
  emptyGraphContext,
  inferEdgeKind,
  type GraphContext,
  type GraphEdge,
  type GraphMethod,
  type GraphNode,
  type GraphNodeId,
  type StrategyGraph,
} from "./types.js";

class GraphReturn {
  constructor(readonly value: unknown) {}
}

function nodeMap(method: GraphMethod): Map<GraphNodeId, GraphNode> {
  return new Map(method.nodes.map((node) => [node.id, node]));
}

function outgoing(
  method: GraphMethod,
  from: GraphNodeId,
  kind: "data" | "control",
): GraphEdge[] {
  return method.edges.filter(
    (edge) => edge.from === from && inferEdgeKind(edge) === kind,
  );
}

function incomingData(
  method: GraphMethod,
  to: GraphNodeId,
  port: string,
): GraphEdge | undefined {
  return method.edges.find(
    (edge) =>
      edge.to === to && inferEdgeKind(edge) === "data" && edge.port === port,
  );
}

function controlTarget(
  method: GraphMethod,
  from: GraphNodeId,
  port: string,
): GraphNodeId | undefined {
  return outgoing(method, from, "control").find((edge) => edge.port === port)
    ?.to;
}

function hasThenElse(method: GraphMethod, id: GraphNodeId): boolean {
  const ports = new Set(
    outgoing(method, id, "control").map((edge) => edge.port),
  );
  return ports.has("then") && ports.has("else");
}

function interpretMethod(
  method: GraphMethod,
  ctx: GraphContext,
  state: GraphRuntimeState,
  mode: "findOpp" | "value",
): unknown {
  const nodes = nodeMap(method);
  const cache = new Map<GraphNodeId, unknown>();
  const evaluating = new Set<GraphNodeId>();
  const acc: TradeOpportunity[] = [];

  const evalNode = (id: GraphNodeId): unknown => {
    if (cache.has(id)) return cache.get(id);
    if (evaluating.has(id)) {
      throw new Error(`graph cycle at node '${id}'`);
    }
    const node = nodes.get(id);
    if (!node) throw new Error(`unknown graph node '${id}'`);
    evaluating.add(id);

    const getPort = (name: string): unknown => {
      const param = node.params[name];
      if (param) {
        if (param.kind === "literal") return param.value;
        if (param.kind === "config") {
          if (!ctx.config) throw new Error("graph config param without config");
          return (ctx.config as unknown as Record<string, unknown>)[param.key];
        }
        return evalNode(param.node);
      }
      const edge = incomingData(method, id, name);
      if (edge) return evalNode(edge.from);
      return undefined;
    };

    let value: unknown;
    if (node.op === "return") {
      evaluating.delete(id);
      throw new GraphReturn(getPort("value"));
    }
    if (node.op === "and") {
      value = Boolean(getPort("a")) && Boolean(getPort("b"));
    } else if (node.op === "or") {
      value = Boolean(getPort("a")) || Boolean(getPort("b"));
    } else if (node.op === "if") {
      const cond = Boolean(getPort("cond"));
      const target = controlTarget(method, id, cond ? "then" : "else");
      value = target ? evalNode(target) : undefined;
    } else if (node.op === "gate") {
      const cond = Boolean(getPort("cond"));
      const target = controlTarget(method, id, "then");
      value = cond && target ? evalNode(target) : undefined;
    } else if (node.op === "switch") {
      const key = String(getPort("value"));
      const target = controlTarget(method, id, key);
      value = target ? evalNode(target) : undefined;
    } else {
      value = executeOp(node.op, getPort, ctx, state, acc, node.id);
      if (typeof value === "boolean" && hasThenElse(method, id)) {
        const target = controlTarget(method, id, value ? "then" : "else");
        value = target ? evalNode(target) : value;
      }
    }

    evaluating.delete(id);
    cache.set(id, value);
    return value;
  };

  try {
    const result = evalNode(method.root);
    return mode === "findOpp" ? acc : result;
  } catch (error) {
    if (error instanceof GraphReturn) {
      if (mode === "findOpp") {
        return Array.isArray(error.value) ? error.value : acc;
      }
      return error.value;
    }
    throw error;
  }
}

function methodClock(injected?: number): number {
  return injected ?? Date.now();
}

/**
 * Runs a graph method and downgrades runtime errors to a safe fallback.
 * A malformed graph op (unknown node, runtime cycle, missing port) must not
 * abort the bot tick: the other market of the tick and resting management
 * still need to run. Validation catches structural errors at construction;
 * this is the runtime net (e.g. an op referencing state that is absent).
 *
 * Dashboard emission is transition-based (ok → failing emits once, like the
 * FOK kill path): a permanently broken graph must not flood the event bus
 * every tick. The log fires every call (diagnostics), the bus event only on
 * the streak start and recovery.
 */
const graphErrorStreaks = new Map<string, boolean>();

function interpretMethodSafe<T>(
  method: GraphMethod,
  ctx: GraphContext,
  state: GraphRuntimeState,
  mode: "findOpp" | "value",
  fallback: T,
  methodName: string,
  graphId: string,
): T {
  const streakKey = `${graphId}::${methodName}`;
  try {
    const result = interpretMethod(method, ctx, state, mode) as T;
    if (graphErrorStreaks.get(streakKey)) {
      graphErrorStreaks.delete(streakKey);
      log("Graph strategy recovered — runtime error streak ended", {
        graphId,
        method: methodName,
      });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const streakStart = !graphErrorStreaks.has(streakKey);
    graphErrorStreaks.set(streakKey, true);
    log("Graph strategy runtime error — safe fallback applied", {
      graphId,
      method: methodName,
      error: message,
      streak: true,
    });
    if (streakStart) {
      bus.emit({
        type: "error",
        message: `Graph ${graphId} ${methodName} failing: ${message} (safe fallback active)`,
      });
    }
    return fallback;
  }
}

export class GraphStrategy implements TradingStrategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly leadsWithEdge: boolean;
  private readonly state: GraphRuntimeState = {
    buffer: new EdgeConfirmBuffer(),
    holdTrueFor: new Map(),
    pairWindows: new Map(),
    sampleWindows: new Map(),
  };

  constructor(private readonly graph: StrategyGraph) {
    const errors = validateStrategyGraph(graph);
    if (errors.length > 0) {
      throw new Error(`invalid strategy graph: ${errors.join("; ")}`);
    }
    this.id = graph.id as StrategyId;
    this.label = graph.name;
    this.leadsWithEdge = graph.leadsWithEdge;
  }

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    const pairId = `${ctx.event.slug}:${ctx.event.windowEnd}`;
    const nowMs = methodClock(ctx.nowMs);
    purgeExpiredSampleWindows(this.state, nowMs);
    this.state.pairWindows.set(pairId, {
      windowStart: ctx.event.windowStart,
      windowEnd: ctx.event.windowEnd,
    });
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.tracker = ctx.tracker;
    gctx.event = ctx.event;
    gctx.books = ctx.books;
    gctx.pairId = pairId;
    gctx.nowMs = nowMs;
    return interpretMethodSafe(
      this.graph.findOpportunities,
      gctx,
      this.state,
      "findOpp",
      [] as TradeOpportunity[],
      "findOpportunities",
      this.id,
    );
  }

  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction {
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.cheapBook = ctx.cheapBook ?? null;
    gctx.favoriteAsk = ctx.favoriteAsk;
    gctx.limitPrice = ctx.limitPrice;
    gctx.pairId = ctx.pairId;
    gctx.nowMs = methodClock(ctx.nowMs);
    return interpretMethodSafe(
      this.graph.cheapOrderAction,
      gctx,
      this.state,
      "value",
      "keep" as CheapOrderAction,
      "cheapOrderAction",
      this.id,
    );
  }

  edgeOrderAction(ctx: RestingEdgeContext): EdgeOrderAction {
    if (!this.leadsWithEdge) return "keep";
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.pairId = ctx.pairId;
    gctx.favoriteAsk = ctx.edgeBook?.bestAsk ?? null;
    gctx.nowMs = methodClock(ctx.nowMs);
    return interpretMethodSafe(
      this.graph.edgeOrderAction,
      gctx,
      this.state,
      "value",
      "keep" as EdgeOrderAction,
      "edgeOrderAction",
      this.id,
    );
  }

  shouldDefend(ctx: DefendContext): boolean {
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.favoriteAsk = ctx.favoriteAsk;
    gctx.filledCheap = ctx.filledCheap;
    gctx.filledExpensive = ctx.filledExpensive;
    gctx.pairId = ctx.pairId;
    gctx.nowMs = methodClock(ctx.nowMs);
    return Boolean(
      interpretMethodSafe(
        this.graph.shouldDefend,
        gctx,
        this.state,
        "value",
        false as unknown,
        "shouldDefend",
        this.id,
      ),
    );
  }

  defendShares(ctx: DefendContext): number {
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.favoriteAsk = ctx.favoriteAsk;
    gctx.filledCheap = ctx.filledCheap;
    gctx.filledExpensive = ctx.filledExpensive;
    gctx.pairId = ctx.pairId;
    gctx.nowMs = methodClock(ctx.nowMs);
    const value = interpretMethodSafe(
      this.graph.defendShares,
      gctx,
      this.state,
      "value",
      0 as unknown,
      "defendShares",
      this.id,
    );
    return typeof value === "number" ? value : 0;
  }

  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision {
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.tracker = ctx.tracker;
    gctx.pairId = ctx.pairId;
    gctx.freshAsk = ctx.freshAsk;
    gctx.nowMs = methodClock(ctx.nowMs);
    return interpretMethodSafe(
      this.graph.hedgeAtPostTime,
      gctx,
      this.state,
      "value",
      { action: "skip", reason: "graph-error-fallback" } as HedgePostDecision,
      "hedgeAtPostTime",
      this.id,
    );
  }

  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean {
    const gctx = emptyGraphContext();
    gctx.config = ctx.config;
    gctx.tracker = ctx.tracker;
    gctx.pairId = ctx.pairId;
    gctx.expensiveBid = ctx.expensiveBid;
    gctx.expensiveFillPrice = ctx.expensiveFillPrice;
    gctx.expensiveSize = ctx.expensiveSize;
    gctx.cheapFilled = ctx.cheapFilled;
    gctx.marketAgeMs = ctx.marketAgeMs;
    gctx.nowMs = methodClock(ctx.nowMs);
    return Boolean(
      interpretMethodSafe(
        this.graph.shouldSellExpensiveEdge,
        gctx,
        this.state,
        "value",
        false as unknown,
        "shouldSellExpensiveEdge",
        this.id,
      ),
    );
  }
}
