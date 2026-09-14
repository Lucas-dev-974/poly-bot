import { validateChartRules } from "../chart-rule.js";
import { isTemporalOp } from "./ops.js";
import {
  inferEdgeKind,
  type GraphMethod,
  type GraphMethodName,
  type GraphNode,
  type GraphOp,
  type StrategyGraph,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;

const FORBIDDEN: Partial<Record<GraphMethodName, ReadonlySet<GraphOp>>> = {
  cheapOrderAction: new Set([
    "postEdge",
    "postCheap",
    "books",
    "confirmTicks",
    "windowStartSec",
    "windowEndSec",
  ]),
  edgeOrderAction: new Set([
    "postEdge",
    "postCheap",
    "books",
    "confirmTicks",
    "take-ask",
    "cheapBook",
    "windowStartSec",
    "windowEndSec",
  ]),
  shouldDefend: new Set([
    "postEdge",
    "postCheap",
    "windowStartSec",
    "windowEndSec",
  ]),
  defendShares: new Set([
    "postEdge",
    "postCheap",
    "windowStartSec",
    "windowEndSec",
  ]),
  hedgeAtPostTime: new Set([
    "postEdge",
    "postCheap",
    "confirmTicks",
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
  ]),
  shouldSellExpensiveEdge: new Set([
    "postEdge",
    "postCheap",
    "confirmTicks",
    "windowStartSec",
    "windowEndSec",
  ]),
};

function literalNumber(node: GraphNode, port: string): number | undefined {
  const param = node.params[port];
  if (param?.kind === "literal" && typeof param.value === "number") {
    return param.value;
  }
  return undefined;
}

function portSource(
  method: GraphMethod,
  node: GraphNode,
  port: string,
  byId: Map<string, GraphNode>,
): GraphNode | undefined {
  const param = node.params[port];
  if (param?.kind === "ref") return byId.get(param.node);
  const edge = method.edges.find(
    (item) =>
      item.to === node.id &&
      inferEdgeKind(item) === "data" &&
      item.port === port,
  );
  return edge ? byId.get(edge.from) : undefined;
}

function validateTemporalNode(
  name: GraphMethodName,
  method: GraphMethod,
  node: GraphNode,
  byId: Map<string, GraphNode>,
  pollIntervalMs: number,
  errors: string[],
): void {
  if (node.op === "inPhase") {
    const duration = literalNumber(node, "phaseDurationSec");
    const min = literalNumber(node, "phaseMin");
    const max = literalNumber(node, "phaseMax");
    if (duration !== undefined && duration <= 0) {
      errors.push(`${name}: inPhase '${node.id}' phaseDurationSec must be > 0`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      errors.push(`${name}: inPhase '${node.id}' phaseMin must be ≤ phaseMax`);
    }
    if (min !== undefined && min < 0) {
      errors.push(`${name}: inPhase '${node.id}' phaseMin must be ≥ 0`);
    }
    if (max !== undefined && max < 0) {
      errors.push(`${name}: inPhase '${node.id}' phaseMax must be ≥ 0`);
    }
  }
  if (node.op === "windowRange") {
    const start = literalNumber(node, "startSec");
    const end = literalNumber(node, "endSec");
    if (start !== undefined && end !== undefined && start >= end) {
      errors.push(`${name}: windowRange '${node.id}' startSec must be < endSec`);
    }
  }
  if (node.op === "sampleWindow") {
    const maxAgeMs = literalNumber(node, "maxAgeMs");
    const minAge = 2 * pollIntervalMs;
    if (maxAgeMs !== undefined && maxAgeMs < minAge) {
      errors.push(
        `${name}: sampleWindow '${node.id}' maxAgeMs must be ≥ 2× pollIntervalMs (${minAge})`,
      );
    }
  }
  if (node.op === "trendUp" || node.op === "trendDown" || node.op === "trendNeutral") {
    const minSlope = literalNumber(node, "minSlope");
    if (minSlope !== undefined && minSlope <= 0) {
      errors.push(`${name}: ${node.op} '${node.id}' minSlope must be > 0`);
    }
    const source = portSource(method, node, "samples", byId);
    if (!source) {
      errors.push(`${name}: ${node.op} '${node.id}' samples must ref a sampleWindow`);
    } else if (source.op !== "sampleWindow") {
      errors.push(
        `${name}: ${node.op} '${node.id}' samples must ref a sampleWindow (got '${source.op}')`,
      );
    }
  }
}

function validateMethod(
  name: GraphMethodName,
  method: GraphMethod,
  pollIntervalMs: number,
  errors: string[],
): void {
  const ids = new Set<string>();
  for (const node of method.nodes) {
    if (ids.has(node.id)) errors.push(`${name}: duplicate node '${node.id}'`);
    ids.add(node.id);
    const forbidden = FORBIDDEN[name];
    if (forbidden?.has(node.op)) {
      errors.push(`${name}: op '${node.op}' is not allowed`);
    }
  }
  if (!ids.has(method.root)) {
    errors.push(`${name}: root '${method.root}' is missing`);
  }

  const inDeg = new Map<string, number>();
  for (const id of ids) inDeg.set(id, 0);
  for (const edge of method.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      errors.push(
        `${name}: edge ${edge.from}→${edge.to} references unknown node`,
      );
      continue;
    }
    if (inferEdgeKind(edge) === "data") {
      inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1);
    }
  }

  const byId = new Map(method.nodes.map((node) => [node.id, node]));
  let confirmTicks = 0;
  for (const node of method.nodes) {
    if (node.op === "confirmTicks") confirmTicks += 1;
    const controlOut = method.edges.filter(
      (edge) => edge.from === node.id && inferEdgeKind(edge) === "control",
    );
    const ports = controlOut.map((edge) => edge.port);
    if (node.op === "if") {
      if (!ports.includes("then") || !ports.includes("else")) {
        errors.push(`${name}: if '${node.id}' needs then and else`);
      }
    }
    if (node.op === "return" && controlOut.length > 0) {
      errors.push(`${name}: return '${node.id}' must be a leaf`);
    }
    if (node.op === "postEdge" || node.op === "postCheap") {
      const needed = ["when", "token", "price", "size"];
      for (const port of needed) {
        const hasParam = Boolean(node.params[port]);
        const hasEdge = method.edges.some(
          (edge) =>
            edge.to === node.id &&
            inferEdgeKind(edge) === "data" &&
            edge.port === port,
        );
        if (!hasParam && !hasEdge) {
          errors.push(`${name}: ${node.op} '${node.id}' missing port '${port}'`);
        }
      }
    }
    if (node.op === "confirmTicks") {
      for (const key of [
        "bandMin",
        "bandMax",
        "samples",
        "maxDownTick",
      ] as const) {
        const param = node.params[key];
        if (param && param.kind !== "config") {
          errors.push(
            `${name}: confirmTicks '${node.id}' port '${key}' must be config`,
          );
        }
      }
    }
    if (isTemporalOp(node.op)) {
      validateTemporalNode(name, method, node, byId, pollIntervalMs, errors);
    }
  }
  if (confirmTicks > 1) {
    errors.push(`${name}: at most one confirmTicks node`);
  }

  const queue = [...ids].filter((id) => (inDeg.get(id) ?? 0) === 0);
  let seen = 0;
  const dataOut = new Map<string, string[]>();
  for (const id of ids) dataOut.set(id, []);
  for (const edge of method.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    if (inferEdgeKind(edge) === "data") {
      dataOut.get(edge.from)!.push(edge.to);
    }
  }
  const remaining = new Map(inDeg);
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const to of dataOut.get(id) ?? []) {
      remaining.set(to, (remaining.get(to) ?? 1) - 1);
      if (remaining.get(to) === 0) queue.push(to);
    }
  }
  if (seen < ids.size) {
    errors.push(`${name}: data-edge cycle`);
  }
}

export function validateStrategyGraph(
  graph: StrategyGraph,
  opts?: { pollIntervalMs?: number },
): string[] {
  const errors: string[] = [];
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!graph || typeof graph !== "object") {
    return ["graph must be an object"];
  }
  if (
    typeof graph.id !== "string" ||
    !graph.id.startsWith("custom:") ||
    graph.id.length <= "custom:".length
  ) {
    errors.push("id must start with custom:");
  }
  if (typeof graph.leadsWithEdge !== "boolean") {
    errors.push("leadsWithEdge is required");
  }
  const methods: GraphMethodName[] = [
    "findOpportunities",
    "cheapOrderAction",
    "edgeOrderAction",
    "shouldDefend",
    "defendShares",
    "hedgeAtPostTime",
    "shouldSellExpensiveEdge",
  ];
  for (const name of methods) {
    const method = graph[name];
    if (!method || !Array.isArray(method.nodes) || !Array.isArray(method.edges)) {
      errors.push(`${name} is required`);
      continue;
    }
    validateMethod(name, method, pollIntervalMs, errors);
  }
  errors.push(...validateChartRules(graph.chartRules, pollIntervalMs));
  return errors;
}
