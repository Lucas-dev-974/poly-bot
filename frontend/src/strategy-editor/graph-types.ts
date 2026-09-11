import { edgeLeadChartRules as edgeLeadChartRulesShared } from "../../../src/strategy/chart-rule-presets";
export type GraphNodeId = string;

export type GraphOp = string;

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

export interface ChartRule {
  id: string;
  startSec: number;
  endSec: number;
  token: "cheap" | "favorite";
  direction: "up" | "down";
  action: "buy" | "sell";
  lookbackMs?: number;
  minSlope?: number;
  once?: boolean;
  sizeUsdc?: number;
  sellAll?: boolean;
  bandMin?: number;
  bandMax?: number;
  confirmTicks?: number;
  maxDownTick?: number;
  afterFill?: "none" | "cheap" | "favorite";
  outOfBand?: "keep" | "cancel-lock";
  minElapsedSec?: number;
  lossPct?: number;
  lossWindowMs?: number;
  dependsOn?: string[];
}

export interface StrategyGraph {
  id: string;
  name: string;
  description?: string;
  leadsWithEdge: boolean;
  findOpportunities: GraphMethod;
  cheapOrderAction: GraphMethod;
  edgeOrderAction: GraphMethod;
  shouldDefend: GraphMethod;
  defendShares: GraphMethod;
  hedgeAtPostTime: GraphMethod;
  shouldSellExpensiveEdge: GraphMethod;
  chartRules?: ChartRule[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_CHART_DURATION_SEC = 900;
export const CHART_SNAP_SEC = 60;
export const CHART_SNAP_PRICE = 0.01;
export const DEFAULT_LOOKBACK_MS = 5000;
export const DEFAULT_MIN_SLOPE = 0.002;

export function snapChartSec(sec: number, durationSec: number): number {
  const snapped = Math.round(sec / CHART_SNAP_SEC) * CHART_SNAP_SEC;
  return Math.min(Math.max(snapped, 0), durationSec);
}

export function snapChartRange(
  start: number,
  end: number,
  durationSec: number,
): { startSec: number; endSec: number } {
  let startSec = snapChartSec(Math.min(start, end), durationSec);
  let endSec = snapChartSec(Math.max(start, end), durationSec);
  if (endSec <= startSec) {
    endSec = Math.min(startSec + CHART_SNAP_SEC, durationSec);
    if (endSec <= startSec) {
      startSec = Math.max(0, endSec - CHART_SNAP_SEC);
    }
  }
  return { startSec, endSec };
}

export function snapChartPrice(price: number): number {
  const snapped = Math.round(price / CHART_SNAP_PRICE) * CHART_SNAP_PRICE;
  return Math.min(Math.max(Number(snapped.toFixed(2)), 0), 1);
}

export function snapChartBand(
  a: number,
  b: number,
): { bandMin: number; bandMax: number } {
  let bandMin = snapChartPrice(Math.min(a, b));
  let bandMax = snapChartPrice(Math.max(a, b));
  if (bandMax <= bandMin) {
    bandMax = Math.min(Number((bandMin + CHART_SNAP_PRICE).toFixed(2)), 1);
    if (bandMax <= bandMin) {
      bandMin = Math.max(0, Number((bandMax - CHART_SNAP_PRICE).toFixed(2)));
    }
  }
  return { bandMin, bandMax };
}

/** Favori si le milieu de bande est ≥ 0,50, sinon cheap. */
export function guessRuleFromBand(bandMin: number, bandMax: number): Partial<ChartRule> {
  const mid = (bandMin + bandMax) / 2;
  if (mid >= 0.5) {
    return { token: "favorite", direction: "up", action: "buy" };
  }
  return { token: "cheap", direction: "up", action: "buy" };
}

/** Déplace une zone sans changer sa largeur / hauteur, clampée dans le plot. */
export function translateChartRule(
  origin: ChartRule,
  dSec: number,
  dPrice: number,
  durationSec: number,
): ChartRule {
  const duration = Math.max(durationSec, 1);
  const width = Math.max(origin.endSec - origin.startSec, 1);
  let startSec = origin.startSec + dSec;
  if (startSec < 0) startSec = 0;
  if (startSec + width > duration) startSec = Math.max(0, duration - width);
  const endSec = Math.min(startSec + width, duration);
  const next: ChartRule = { ...origin, startSec, endSec };
  if (origin.bandMin == null && origin.bandMax == null) return next;

  const min0 = origin.bandMin ?? 0;
  const max0 = origin.bandMax ?? 1;
  const height = Math.max(max0 - min0, CHART_SNAP_PRICE);
  let bandMin = min0 + dPrice;
  if (bandMin < 0) bandMin = 0;
  if (bandMin + height > 1) bandMin = Math.max(0, 1 - height);
  const bandMax = Math.min(bandMin + height, 1);
  return { ...next, bandMin, bandMax };
}

export function snapMovedRule(rule: ChartRule, durationSec: number): ChartRule {
  const width = Math.max(rule.endSec - rule.startSec, 1);
  let startSec = snapChartSec(rule.startSec, durationSec);
  if (startSec + width > durationSec) {
    startSec = snapChartSec(Math.max(0, durationSec - width), durationSec);
  }
  const endSec = Math.min(startSec + width, durationSec);
  if (rule.bandMin == null && rule.bandMax == null) {
    return { ...rule, startSec, endSec };
  }
  const height = Math.max((rule.bandMax ?? 1) - (rule.bandMin ?? 0), CHART_SNAP_PRICE);
  let bandMin = snapChartPrice(rule.bandMin ?? 0);
  if (bandMin + height > 1) {
    bandMin = snapChartPrice(Math.max(0, 1 - height));
  }
  const bandMax = Math.min(Number((bandMin + height).toFixed(2)), 1);
  return { ...rule, startSec, endSec, bandMin, bandMax };
}

export function newChartRule(partial?: Partial<ChartRule>): ChartRule {
  const rule: ChartRule = {
    id: `zone-${Math.random().toString(36).slice(2, 9)}`,
    startSec: 0,
    endSec: 300,
    token: "cheap",
    direction: "down",
    action: "buy",
    once: true,
    ...partial,
  };
  if (
    rule.action === "sell" &&
    rule.afterFill !== "cheap" &&
    rule.afterFill !== "favorite" &&
    rule.afterFill !== "none"
  ) {
    rule.afterFill = rule.token;
  }
  return rule;
}

export function hasPriceBand(rule: ChartRule): boolean {
  return rule.bandMin != null || rule.bandMax != null;
}

/** Trois règles qui reproduisent le moteur edge-lead natif. */
export function edgeLeadChartRules(durationSec = 900): ChartRule[] {
  return edgeLeadChartRulesShared(durationSec) as ChartRule[];
}

export function chartRuleLegend(rule: ChartRule): string {
  const token = rule.token === "cheap" ? "cheap" : "favori";
  const dir = rule.direction === "up" ? "↑" : "↓";
  const action = rule.action === "buy" ? "acheter" : "vendre";
  if (hasPriceBand(rule)) {
    const min = rule.bandMin ?? 0;
    const max = rule.bandMax ?? 1;
    return `${token} ${action} ${min}–${max}`;
  }
  return `${token} ${dir} ${action}`;
}

export function chartRuleIndexLabel(rules: ChartRule[], id: string): string {
  const i = rules.findIndex((r) => r.id === id);
  return i >= 0 ? `#${i + 1}` : "#?";
}

export {
  chartRuleLinks,
  chartRulesHaveCycle,
  linkChartRules,
  orderChartRules,
  stripDependsOn,
  uniqueDependsOn,
  unlinkChartRules,
} from "../../../src/strategy/chart-rule-deps";
