import type { Repositories } from "../db/index.js";
import { ChartRulesStrategy } from "./chart-rules-strategy.js";
import { GraphStrategy } from "./graph/interpreter.js";
import { ensureEdgeOrderAction } from "./graph/ensure-edge-order.js";
import { ArbStrategy } from "./arb-strategy.js";
import { BarbellStrategy } from "./barbell-strategy.js";
import { EdgeLeadStrategy } from "./edge-lead-strategy.js";
import type { NativeStrategyId, StrategyId } from "./ids.js";
import type { TradingStrategy } from "./trading-strategy.js";

const STRATEGIES: Record<NativeStrategyId, () => TradingStrategy> = {
  arb: () => new ArbStrategy(),
  barbell: () => new BarbellStrategy(),
  "edge-lead": () => new EdgeLeadStrategy(),
};

export type StrategyRepos = Pick<Repositories, "strategyGraphs">;

export function leadsWithEdgeFor(
  id: StrategyId,
  repos?: StrategyRepos,
): boolean | undefined {
  if (id === "edge-lead") return true;
  if (id === "arb" || id === "barbell") return false;
  if (!id.startsWith("custom:")) return undefined;
  return repos?.strategyGraphs?.get(id)?.leadsWithEdge;
}

export function createStrategy(
  id: StrategyId,
  repos?: StrategyRepos,
): TradingStrategy {
  if (id.startsWith("custom:")) {
    if (!repos) {
      throw new Error(`custom strategy ${id} requires persistence`);
    }
    const graph = repos.strategyGraphs?.get(id);
    if (!graph) {
      throw new Error(`Unknown custom strategy: ${id}`);
    }
    const normalized = ensureEdgeOrderAction(graph);
    if ((normalized.chartRules?.length ?? 0) > 0) {
      return new ChartRulesStrategy(normalized);
    }
    return new GraphStrategy(normalized);
  }
  const factory = STRATEGIES[id as NativeStrategyId];
  if (!factory) {
    throw new Error(`Unknown strategy: ${id}`);
  }
  return factory();
}
