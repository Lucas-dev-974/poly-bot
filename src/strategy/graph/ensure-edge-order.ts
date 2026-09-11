import type { StrategyGraph } from "./types.js";
import { defaultEdgeOrderActionMethod } from "./edge-lead-graph.js";

/** Soft-migrate graphs saved before edgeOrderAction existed. */
export function ensureEdgeOrderAction(graph: StrategyGraph): StrategyGraph {
  const method = (graph as StrategyGraph).edgeOrderAction;
  if (method && Array.isArray(method.nodes) && Array.isArray(method.edges)) {
    return graph;
  }
  return {
    ...graph,
    edgeOrderAction: defaultEdgeOrderActionMethod(),
  };
}
