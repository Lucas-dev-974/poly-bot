import type { BotConfig } from "../../config.js";
import type { TradeTracker } from "../../trade-tracker.js";
import type { TokenBook, UpDownEvent } from "../../types.js";

export type GraphNodeId = string;

export type GraphOp =
  | "books"
  | "cheapBook"
  | "claimedOutcome"
  | "favoriteAsk"
  | "limitPrice"
  | "filledCheap"
  | "filledExpensive"
  | "pairId"
  | "nowMs"
  | "freshAsk"
  | "askOf"
  | "bidOf"
  | "askSizeOf"
  | "pickReverseToken"
  | "pickFavoriteToken"
  | "pickEdgeToken"
  | "pickTokenByOutcome"
  | "pickOtherTokenByOutcome"
  | "inBand"
  | "inCheapBand"
  | "confirmTicks"
  | "favoriteAskInBuyRange"
  | "round2"
  | "computeSize"
  | "computeEdgeLeadEdgeSize"
  | "computeEdgeLeadCheapSize"
  | "if"
  | "switch"
  | "gate"
  | "return"
  | "const"
  | "and"
  | "or"
  | "not"
  | "eq"
  | "lt"
  | "gt"
  | "lte"
  | "gte"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "holdTrueFor"
  | "isNull"
  | "postEdge"
  | "postCheap"
  | "skip"
  | "keep"
  | "cancel-lock"
  | "take-ask"
  | "defend"
  | "no-defend"
  | "hedge-skip"
  | "hedge-post"
  | "hedge-defend"
  | "sell-edge"
  | "no-sell-edge"
  | "expensiveBid"
  | "expensiveFillPrice"
  | "expensiveSize"
  | "cheapFilled"
  | "marketAgeMs"
  | "hasEdgeFill"
  | "hasCheapFill"
  | "edgePosted"
  | "cheapPosted"
  | "countOpenPerSide"
  | "countLegsByKind"
  | "hasTradeKey"
  | "makeTradeKey"
  | "windowStartSec"
  | "windowEndSec"
  | "minutesLeft"
  | "secondsElapsed"
  | "inPhase"
  | "windowRange"
  | "sampleWindow"
  | "trendUp"
  | "trendDown"
  | "trendNeutral"
  | "pairWindowStart"
  | "pairWindowEnd";

export type GraphParam =
  | { kind: "config"; key: string }
  | { kind: "literal"; value: number | string | boolean | null }
  | { kind: "ref"; node: GraphNodeId };

export interface GraphNode {
  id: GraphNodeId;
  op: GraphOp;
  params: Record<string, GraphParam>;
}

export interface GraphEdge {
  from: GraphNodeId;
  to: GraphNodeId;
  kind?: "data" | "control";
  port: string;
}

export interface GraphMethod {
  nodes: GraphNode[];
  edges: GraphEdge[];
  root: GraphNodeId;
}

/** Règle chart : si dans [startSec, endSec] le token part dans `direction`, alors `action`. */
export interface ChartRule {
  id: string;
  /** Secondes depuis windowStart du marché (0–900 typ.). */
  startSec: number;
  endSec: number;
  token: "cheap" | "favorite";
  direction: "up" | "down";
  action: "buy" | "sell";
  /** Fenêtre de pente. Défaut 5000. */
  lookbackMs?: number;
  /** Seuil de pente en prix/s. Défaut 0.002. */
  minSlope?: number;
  /** Ne déclencher qu'une fois par paire. Défaut true. */
  once?: boolean;
  /** Budget USDC pour un buy. Sinon config cheap/edge. */
  sizeUsdc?: number;
  /** `false` désactive la règle (ventes partielles non supportées). Défaut true. */
  sellAll?: boolean;
  /** Ask min inclus. */
  bandMin?: number;
  /** Ask max inclus. */
  bandMax?: number;
  /** N ticks consécutifs in-band + série croissante (edge-lead). */
  confirmTicks?: number;
  /** Drop tick-à-tick max avant reset du confirm. */
  maxDownTick?: number;
  /** Le buy n'est émis qu'après fill de l'autre jambe. */
  afterFill?: "none" | "cheap" | "favorite";
  /** Cheap resting hors bande. */
  outOfBand?: "keep" | "cancel-lock";
  /** Vente favori : âge min du marché. */
  minElapsedSec?: number;
  /** Vente favori : perte % sous le fill (ex. 10 = -10 %). */
  lossPct?: number;
  /** Vente favori : durée min de la perte continue. */
  lossWindowMs?: number;
  /** Ids des zones parentes : cette règle n'est prête qu'après leur déclenchement. */
  dependsOn?: string[];
}

export interface StrategyGraph {
  id: string;
  name: string;
  description?: string;
  leadsWithEdge: boolean;
  findOpportunities: GraphMethod;
  cheapOrderAction: GraphMethod;
  shouldDefend: GraphMethod;
  defendShares: GraphMethod;
  hedgeAtPostTime: GraphMethod;
  shouldSellExpensiveEdge: GraphMethod;
  chartRules?: ChartRule[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type GraphMethodName = keyof Pick<
  StrategyGraph,
  | "findOpportunities"
  | "cheapOrderAction"
  | "shouldDefend"
  | "defendShares"
  | "hedgeAtPostTime"
  | "shouldSellExpensiveEdge"
>;

export interface GraphContext {
  config: BotConfig | null;
  books: TokenBook[] | null;
  event: UpDownEvent | null;
  tracker: TradeTracker | null;
  pairId: string | null;
  cheapBook: TokenBook | null;
  favoriteAsk: number | null;
  limitPrice: number | null;
  filledCheap: number | null;
  filledExpensive: number | null;
  freshAsk: number | null;
  expensiveBid: number | null;
  expensiveFillPrice: number | null;
  expensiveSize: number | null;
  cheapFilled: number | null;
  marketAgeMs: number | null;
  nowMs: number | null;
}

export interface PairWindow {
  windowStart: number;
  windowEnd: number;
}

export function inferEdgeKind(edge: GraphEdge): "data" | "control" {
  if (edge.kind) return edge.kind;
  return edge.port === "then" || edge.port === "else" ? "control" : "data";
}

export function emptyGraphContext(): GraphContext {
  return {
    config: null,
    books: null,
    event: null,
    tracker: null,
    pairId: null,
    cheapBook: null,
    favoriteAsk: null,
    limitPrice: null,
    filledCheap: null,
    filledExpensive: null,
    freshAsk: null,
    expensiveBid: null,
    expensiveFillPrice: null,
    expensiveSize: null,
    cheapFilled: null,
    marketAgeMs: null,
    nowMs: null,
  };
}
