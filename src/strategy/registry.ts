import type { Repositories } from "../db/index.js";
import { ChartRulesStrategy } from "./chart-rules-strategy.js";
import { GraphStrategy } from "./graph/interpreter.js";
import { ensureEdgeOrderAction } from "./graph/ensure-edge-order.js";
import { ArbStrategy } from "./arb-strategy.js";
import { BarbellStrategy } from "./barbell-strategy.js";
import { EdgeLeadStrategy } from "./edge-lead-strategy.js";
import { ReverseStrategy } from "./reverse-strategy.js";
import { FavBandStrategy } from "./fav-band-strategy.js";
import { DipRevertStrategy } from "./dip-revert-strategy.js";
import { EarlyLowStrategy } from "./early-low-strategy.js";
import { AntiflipRevertStrategy } from "./antiflip-revert-strategy.js";
import { FlipConfirmStrategy } from "./flip-confirm-strategy.js";
import { EarlyConvictionStrategy } from "./early-conviction-strategy.js";
import { OpenEntryStrategy } from "./open-entry-strategy.js";
import { ProbabilityRepricingStrategy } from "./probability-repricing-strategy.js";
import type { NativeStrategyId, StrategyId } from "./ids.js";
import type { TradingStrategy } from "./trading-strategy.js";

const STRATEGIES: Record<NativeStrategyId, () => TradingStrategy> = {
  arb: () => new ArbStrategy(),
  barbell: () => new BarbellStrategy(),
  "edge-lead": () => new EdgeLeadStrategy(),
  reverse: () => new ReverseStrategy(),
  "fav-band": () => new FavBandStrategy(),
  "dip-revert": () => new DipRevertStrategy(),
  "antiflip-revert": () => new AntiflipRevertStrategy(),
  "flip-confirm": () => new FlipConfirmStrategy(),
  "early-conviction": () => new EarlyConvictionStrategy(),
  "early-low": () => new EarlyLowStrategy(),
  "open-entry": () => new OpenEntryStrategy(),
  "probability-repricing": () => new ProbabilityRepricingStrategy(),
};

type StrategyRepos = Pick<Repositories, "strategyGraphs">;

export function leadsWithEdgeFor(
  id: StrategyId,
  repos?: StrategyRepos,
): boolean | undefined {
  if (id === "edge-lead") return true;
  if (
    id === "arb" ||
    id === "barbell" ||
    id === "reverse" ||
    id === "fav-band" ||
    id === "dip-revert" ||
    id === "antiflip-revert" ||
    id === "flip-confirm" ||
    id === "early-conviction" ||
    id === "early-low" ||
    id === "open-entry" ||
    id === "probability-repricing"
  )
    return false;
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
