import type { BotConfig } from "../../config.js";
import type { TokenBook, TradeOpportunity } from "../../types.js";
import { computeSize } from "../../utils/prices.js";
import { EdgeConfirmBuffer } from "../edge-confirm.js";
import {
  appendOpportunity,
  cheapAskInBand,
  computeEdgeLeadCheapSize,
  computeEdgeLeadEdgeSize,
  edgeClaimedOutcome,
  pickEdgeToken,
} from "../edge-lead-strategy.js";
import {
  favoriteAskInBuyRange,
  pickFavoriteToken,
  pickReverseToken,
  pickTokenByOutcome,
  round2,
} from "../predicates.js";
import type { GraphContext, GraphOp } from "./types.js";

type PortGetter = (name: string) => unknown;

export type SamplePoint = { ts: number; ask: number };
type SampleState = { samples: SamplePoint[] };

export type GraphRuntimeState = {
  buffer: EdgeConfirmBuffer;
  holdTrueFor: Map<string, number>;
  pairWindows: Map<string, { windowStart: number; windowEnd: number }>;
  sampleWindows: Map<string, SamplePoint[]>;
};

type EmitAcc = TradeOpportunity[];

const TEMPORAL: ReadonlySet<GraphOp> = new Set([
  "windowStartSec",
  "windowEndSec",
  "minutesLeft",
  "secondsElapsed",
  "inPhase",
  "windowRange",
  "sampleWindow",
  "trendUp",
  "trendDown",
  "trendNeutral",
  "pairWindowStart",
  "pairWindowEnd",
]);

export function isTemporalOp(op: GraphOp): boolean {
  return TEMPORAL.has(op);
}

function sampleWindowKey(nodeId: string, pairId: string): string {
  return `${nodeId}::${pairId}`;
}

export function purgeExpiredSampleWindows(
  state: GraphRuntimeState,
  nowMs: number,
): void {
  for (const [pairId, win] of state.pairWindows) {
    if (win.windowEnd * 1000 >= nowMs) continue;
    state.pairWindows.delete(pairId);
    for (const key of [...state.sampleWindows.keys()]) {
      if (key.endsWith(`::${pairId}`)) state.sampleWindows.delete(key);
    }
  }
}

function requireConfig(ctx: GraphContext): BotConfig {
  if (!ctx.config) throw new Error("graph op requires config");
  return ctx.config;
}

function requireNumber(value: unknown, port: string): number {
  if (value === null || value === undefined) {
    throw new Error(`graph port '${port}' is null`);
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`graph port '${port}' is not a number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}

function resolveNowMs(getPort: PortGetter, ctx: GraphContext): number {
  const fromPort = optionalNumber(getPort("nowMs"));
  if (fromPort != null) return fromPort;
  if (typeof ctx.nowMs === "number" && !Number.isNaN(ctx.nowMs)) return ctx.nowMs;
  throw new Error("temporal op requires nowMs (backtest clock wiring missing)");
}

function pairIdOf(getPort: PortGetter, ctx: GraphContext): string {
  return String(getPort("pairId") ?? ctx.pairId ?? "");
}

function resolveWindowStart(
  getPort: PortGetter,
  ctx: GraphContext,
  state: GraphRuntimeState,
): number | null {
  const fromPort = optionalNumber(getPort("windowStartSec"));
  if (fromPort != null) return fromPort;
  if (ctx.event) return ctx.event.windowStart;
  return state.pairWindows.get(pairIdOf(getPort, ctx))?.windowStart ?? null;
}

function resolveWindowEnd(
  getPort: PortGetter,
  ctx: GraphContext,
  state: GraphRuntimeState,
): number | null {
  const fromPort = optionalNumber(getPort("windowEndSec"));
  if (fromPort != null) return fromPort;
  if (ctx.event) return ctx.event.windowEnd;
  return state.pairWindows.get(pairIdOf(getPort, ctx))?.windowEnd ?? null;
}

function asSampleState(value: unknown): SampleState | null {
  if (!value || typeof value !== "object") return null;
  const samples = (value as SampleState).samples;
  if (!Array.isArray(samples)) return null;
  return { samples };
}

function samplesInAge(
  samples: SamplePoint[],
  nowMs: number,
  maxAgeMs: number | null,
): SamplePoint[] {
  if (maxAgeMs == null) return samples;
  return samples.filter((sample) => nowMs - sample.ts <= maxAgeMs);
}

function slopePerSecond(samples: SamplePoint[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dtSec = (last.ts - first.ts) / 1000;
  if (dtSec <= 0) return null;
  return (last.ask - first.ask) / dtSec;
}

function asToken(value: unknown): TokenBook | null {
  if (value == null) return null;
  return value as TokenBook;
}

function pickOtherTokenByOutcome(
  books: TokenBook[],
  outcome: string,
): TokenBook | null {
  return books.find((book) => book.outcome !== outcome) ?? null;
}

export function executeOp(
  op: GraphOp,
  getPort: PortGetter,
  ctx: GraphContext,
  state: GraphRuntimeState,
  acc: EmitAcc | undefined,
  nodeId?: string,
): unknown {
  switch (op) {
    case "books":
      return ctx.books;
    case "cheapBook":
      return ctx.cheapBook;
    case "claimedOutcome": {
      if (!ctx.tracker || !ctx.pairId) return null;
      return edgeClaimedOutcome(ctx.tracker, ctx.pairId);
    }
    case "favoriteAsk":
      return ctx.favoriteAsk;
    case "limitPrice":
      return ctx.limitPrice;
    case "filledCheap":
      return ctx.filledCheap;
    case "filledExpensive":
      return ctx.filledExpensive;
    case "pairId":
      return ctx.pairId;
    case "nowMs":
      return ctx.nowMs;
    case "freshAsk":
      return ctx.freshAsk;
    case "askOf":
      return asToken(getPort("token"))?.bestAsk ?? null;
    case "bidOf":
      return asToken(getPort("token"))?.bestBid ?? null;
    case "askSizeOf":
      return asToken(getPort("token"))?.bestAskSize ?? null;
    case "pickReverseToken":
      return pickReverseToken((ctx.books ?? getPort("books")) as TokenBook[]);
    case "pickFavoriteToken": {
      const books = (getPort("books") ?? ctx.books) as TokenBook[];
      const reverse = asToken(getPort("reverseToken"));
      if (!reverse) return null;
      const config = requireConfig(ctx);
      return pickFavoriteToken(
        books,
        reverse,
        config.expensiveBuyMin,
        config.maxSharesPerOrder,
      );
    }
    case "pickEdgeToken": {
      const books = (getPort("books") ?? ctx.books) as TokenBook[] | null;
      if (!books) return null;
      return pickEdgeToken(books);
    }
    case "pickTokenByOutcome": {
      const books = (getPort("books") ?? ctx.books) as TokenBook[];
      const outcome = String(getPort("outcome"));
      return pickTokenByOutcome(books, outcome);
    }
    case "pickOtherTokenByOutcome": {
      const books = (getPort("books") ?? ctx.books) as TokenBook[] | null;
      const outcome = getPort("outcome");
      if (!books || outcome == null) return null;
      return pickOtherTokenByOutcome(books, String(outcome));
    }
    case "inBand": {
      const ask = requireNumber(getPort("ask"), "ask");
      const min = requireNumber(getPort("bandMin"), "bandMin");
      const max = requireNumber(getPort("bandMax"), "bandMax");
      return ask >= min && ask <= max;
    }
    case "inCheapBand": {
      const ask = requireNumber(getPort("ask"), "ask");
      const minPort = getPort("bandMin");
      const maxPort = getPort("bandMax");
      if (minPort != null && maxPort != null) {
        return ask >= requireNumber(minPort, "bandMin") &&
          ask <= requireNumber(maxPort, "bandMax");
      }
      return cheapAskInBand(ask, requireConfig(ctx));
    }
    case "confirmTicks":
      return runConfirmTicks(ctx, state, getPort);
    case "favoriteAskInBuyRange":
      return favoriteAskInBuyRange(asToken(getPort("token")), requireConfig(ctx));
    case "round2":
      return round2(requireNumber(getPort("value"), "value"));
    case "computeSize": {
      const config = requireConfig(ctx);
      const price = requireNumber(getPort("price"), "price");
      return computeSize(config.customOrderUsdc, price, config.maxSharesPerOrder);
    }
    case "computeEdgeLeadEdgeSize":
      return computeEdgeLeadEdgeSize(
        requireConfig(ctx),
        requireNumber(getPort("price"), "price"),
      );
    case "computeEdgeLeadCheapSize":
      return computeEdgeLeadCheapSize(
        requireConfig(ctx),
        requireNumber(getPort("price"), "price"),
      );
    case "const":
      return getPort("value");
    case "not":
      return !getPort("a");
    case "isNull":
      return getPort("value") == null;
    case "eq":
      return getPort("a") === getPort("b");
    case "lt":
      return requireNumber(getPort("a"), "a") < requireNumber(getPort("b"), "b");
    case "gt":
      return requireNumber(getPort("a"), "a") > requireNumber(getPort("b"), "b");
    case "lte":
      return requireNumber(getPort("a"), "a") <= requireNumber(getPort("b"), "b");
    case "gte":
      return requireNumber(getPort("a"), "a") >= requireNumber(getPort("b"), "b");
    case "add":
      return requireNumber(getPort("a"), "a") + requireNumber(getPort("b"), "b");
    case "sub":
      return requireNumber(getPort("a"), "a") - requireNumber(getPort("b"), "b");
    case "mul":
      return requireNumber(getPort("a"), "a") * requireNumber(getPort("b"), "b");
    case "div": {
      const b = requireNumber(getPort("b"), "b");
      if (b === 0) throw new Error("graph div by zero");
      return requireNumber(getPort("a"), "a") / b;
    }
    case "holdTrueFor":
      return runHoldTrueFor(ctx, state, getPort);
    case "postEdge":
    case "postCheap":
      return runPost(op === "postEdge" ? "expensive" : "cheap", getPort, ctx, acc);
    case "skip":
      return [];
    case "keep":
      return "keep";
    case "cancel-lock":
      return "cancel-lock";
    case "take-ask":
      return "take-ask";
    case "defend":
      return true;
    case "no-defend":
      return false;
    case "hedge-skip":
      return { action: "skip", reason: String(getPort("reason") ?? "graph-skip") };
    case "hedge-post":
      return { action: "post", price: requireNumber(getPort("price"), "price") };
    case "hedge-defend":
      return { action: "defend", reason: String(getPort("reason") ?? "graph-defend") };
    case "sell-edge":
      return true;
    case "no-sell-edge":
      return false;
    case "expensiveBid":
      return ctx.expensiveBid;
    case "expensiveFillPrice":
      return ctx.expensiveFillPrice;
    case "expensiveSize":
      return ctx.expensiveSize;
    case "cheapFilled":
      return ctx.cheapFilled;
    case "marketAgeMs":
      return ctx.marketAgeMs;
    case "hasEdgeFill":
      return (ctx.tracker?.getFilledExpensiveSizeForPair(ctx.pairId ?? "") ?? 0) > 0;
    case "hasCheapFill":
      return (ctx.tracker?.getFilledCheapSizeForPair(ctx.pairId ?? "") ?? 0) > 0;
    case "edgePosted":
      return (ctx.tracker?.getPostedOrdersForPair(ctx.pairId ?? "", "expensive").length ?? 0) > 0;
    case "cheapPosted":
      return (ctx.tracker?.getPostedOrdersForPair(ctx.pairId ?? "", "cheap").length ?? 0) > 0;
    case "countOpenPerSide": {
      if (!ctx.tracker || !ctx.event) return 0;
      const token = asToken(getPort("token"));
      if (!token) return 0;
      return (
        ctx.tracker.countOpenPositionsForSide(ctx.event.slug, token.outcome) +
        ctx.tracker.countPendingOrdersForSide(ctx.event.slug, token.outcome)
      );
    }
    case "countLegsByKind": {
      if (!ctx.tracker || !ctx.pairId) return 0;
      return ctx.tracker.countLegsByKind(
        ctx.pairId,
        getPort("kind") === "cheap" ? "cheap" : "expensive",
      );
    }
    case "hasTradeKey":
      return ctx.tracker?.has(String(getPort("key"))) ?? false;
    case "windowStartSec":
      return ctx.event?.windowStart ?? null;
    case "windowEndSec":
      return ctx.event?.windowEnd ?? null;
    case "pairWindowStart":
      return state.pairWindows.get(pairIdOf(getPort, ctx))?.windowStart ?? null;
    case "pairWindowEnd":
      return state.pairWindows.get(pairIdOf(getPort, ctx))?.windowEnd ?? null;
    case "minutesLeft": {
      const end = resolveWindowEnd(getPort, ctx, state);
      if (end == null) return null;
      return (end - resolveNowMs(getPort, ctx) / 1000) / 60;
    }
    case "secondsElapsed": {
      const start = resolveWindowStart(getPort, ctx, state);
      if (start == null) return null;
      return resolveNowMs(getPort, ctx) / 1000 - start;
    }
    case "inPhase": {
      const start = resolveWindowStart(getPort, ctx, state);
      if (start == null) return false;
      const elapsed = resolveNowMs(getPort, ctx) / 1000 - start;
      if (elapsed < 0) return false;
      const duration = requireNumber(getPort("phaseDurationSec"), "phaseDurationSec");
      if (duration <= 0) return false;
      const idx = Math.floor(elapsed / duration);
      const min = requireNumber(getPort("phaseMin"), "phaseMin");
      const max = requireNumber(getPort("phaseMax"), "phaseMax");
      return idx >= min && idx <= max;
    }
    case "windowRange": {
      const start = resolveWindowStart(getPort, ctx, state);
      if (start == null) return false;
      const elapsed = resolveNowMs(getPort, ctx) / 1000 - start;
      if (elapsed < 0) return false;
      const startSec = requireNumber(getPort("startSec"), "startSec");
      const endSec = requireNumber(getPort("endSec"), "endSec");
      return elapsed >= startSec && elapsed <= endSec;
    }
    case "sampleWindow": {
      const pairId = pairIdOf(getPort, ctx);
      const nowMs = resolveNowMs(getPort, ctx);
      const maxAgeMs = requireNumber(getPort("maxAgeMs"), "maxAgeMs");
      if (!nodeId) throw new Error("sampleWindow requires a node id");
      const key = sampleWindowKey(nodeId, pairId);
      let samples = state.sampleWindows.get(key) ?? [];
      const ask = getPort("ask");
      if (typeof ask === "number" && !Number.isNaN(ask) && pairId) {
        samples = [...samples, { ts: nowMs, ask }];
      }
      samples = samplesInAge(samples, nowMs, maxAgeMs);
      state.sampleWindows.set(key, samples);
      return { samples } satisfies SampleState;
    }
    case "trendUp":
    case "trendDown":
    case "trendNeutral": {
      const packed = asSampleState(getPort("samples"));
      if (!packed) return false;
      const nowMs = resolveNowMs(getPort, ctx);
      const maxAgeMs = optionalNumber(getPort("maxAgeMs"));
      const minSlope = requireNumber(getPort("minSlope"), "minSlope");
      const samples = samplesInAge(packed.samples, nowMs, maxAgeMs);
      const slope = slopePerSecond(samples);
      if (slope == null) return false;
      if (op === "trendUp") return slope > minSlope;
      if (op === "trendDown") return slope < -minSlope;
      return Math.abs(slope) <= minSlope;
    }
    case "makeTradeKey": {
      if (!ctx.tracker || !ctx.event) return "";
      const token = asToken(getPort("token"));
      if (!token) return "";
      return ctx.tracker.makeKey(
        ctx.event.slug,
        token.outcome,
        getPort("kind") === "cheap" ? "cheap" : "expensive",
        requireNumber(getPort("price"), "price"),
      );
    }
    case "if":
    case "switch":
    case "gate":
    case "return":
    case "and":
    case "or":
      throw new Error(`op '${op}' must be evaluated by the interpreter`);
    default:
      throw new Error(`unknown graph op: ${op}`);
  }
}

function runConfirmTicks(
  ctx: GraphContext,
  state: GraphRuntimeState,
  getPort: PortGetter,
): boolean {
  const config = requireConfig(ctx);
  const pairId = ctx.pairId;
  if (!pairId) return false;
  const books = ctx.books;
  if (!books || books.filter((book) => book.bestAsk !== null).length < 2) {
    state.buffer.reset(pairId);
    return false;
  }
  const edgeToken = pickEdgeToken(books);
  if (!edgeToken || edgeToken.bestAsk === null) {
    state.buffer.reset(pairId);
    return false;
  }
  const inBand =
    edgeToken.bestAsk >= config.edgeBandMin &&
    edgeToken.bestAsk <= config.edgeBandMax;
  if (!inBand) {
    state.buffer.reset(pairId);
    return false;
  }
  const askPort = getPort("ask");
  const ask =
    askPort === null || askPort === undefined
      ? edgeToken.bestAsk
      : requireNumber(askPort, "ask");
  return state.buffer.push(pairId, ask, edgeToken.outcome, config);
}

function runHoldTrueFor(
  ctx: GraphContext,
  state: GraphRuntimeState,
  getPort: PortGetter,
): boolean {
  const cond = Boolean(getPort("cond"));
  const pairId = String(getPort("pairId") ?? ctx.pairId ?? "");
  const nowMs = requireNumber(getPort("nowMs") ?? ctx.nowMs, "nowMs");
  const durationMs = requireNumber(getPort("durationMs"), "durationMs");
  const key = pairId;
  if (!cond) {
    state.holdTrueFor.delete(key);
    return false;
  }
  const start = state.holdTrueFor.get(key) ?? nowMs;
  state.holdTrueFor.set(key, start);
  return nowMs - start >= durationMs;
}

function runPost(
  kind: "cheap" | "expensive",
  getPort: PortGetter,
  ctx: GraphContext,
  acc: EmitAcc | undefined,
): unknown {
  if (!acc || !ctx.tracker || !ctx.event || !ctx.config) return null;
  const when = getPort("when");
  if (when === false) return null;
  const token = asToken(getPort("token"));
  if (!token) return null;
  const price = requireNumber(getPort("price"), "price");
  const size = requireNumber(getPort("size"), "size");
  appendOpportunity(
    ctx.tracker,
    acc,
    ctx.event,
    token,
    kind,
    price,
    size,
    ctx.config.maxOpenPositionsPerSide,
  );
  return acc[acc.length - 1] ?? null;
}
