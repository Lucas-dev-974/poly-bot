import type { ChartRule } from "./graph/types.js";
import {
  chartRulesHaveCycle,
  orderChartRules,
  uniqueDependsOn,
} from "./chart-rule-deps.js";

export {
  chartRulesHaveCycle,
  orderChartRules,
  uniqueDependsOn,
} from "./chart-rule-deps.js";

export const DEFAULT_LOOKBACK_MS = 5000;
export const DEFAULT_MIN_SLOPE = 0.002;

export type NormalizedChartRule = ChartRule & {
  lookbackMs: number;
  minSlope: number;
  once: boolean;
};

export function normalizeChartRule(rule: ChartRule): NormalizedChartRule {
  return {
    ...rule,
    lookbackMs:
      typeof rule.lookbackMs === "number" && rule.lookbackMs > 0
        ? rule.lookbackMs
        : DEFAULT_LOOKBACK_MS,
    minSlope:
      typeof rule.minSlope === "number" && rule.minSlope > 0
        ? rule.minSlope
        : DEFAULT_MIN_SLOPE,
    once: rule.once !== false,
    afterFill:
      rule.afterFill === "cheap" || rule.afterFill === "favorite"
        ? rule.afterFill
        : rule.action === "sell"
          ? rule.token
          : "none",
    // Engine always full-liquidation today; false disables the sell rule.
    sellAll: rule.action === "sell" ? rule.sellAll !== false : rule.sellAll,
    dependsOn: uniqueDependsOn(rule),
  };
}

export function inPriceBand(ask: number, rule: ChartRule): boolean {
  const min = rule.bandMin ?? Number.NEGATIVE_INFINITY;
  const max = rule.bandMax ?? Number.POSITIVE_INFINITY;
  return ask >= min && ask <= max;
}

export function hasPriceBand(rule: ChartRule): boolean {
  return rule.bandMin != null || rule.bandMax != null;
}

/** Trois règles qui reproduisent le moteur edge-lead natif. */
export function edgeLeadChartRules(durationSec = 900): ChartRule[] {
  const end = Math.max(durationSec, 1);
  return [
    {
      id: "el-buy-fav",
      startSec: 0,
      endSec: end,
      token: "favorite",
      direction: "up",
      action: "buy",
      bandMin: 0.85,
      bandMax: 0.9,
      confirmTicks: 5,
      maxDownTick: 0.01,
      once: true,
    },
    {
      id: "el-buy-cheap",
      startSec: 0,
      endSec: end,
      token: "cheap",
      direction: "up",
      action: "buy",
      bandMin: 0.04,
      bandMax: 0.14,
      afterFill: "favorite",
      outOfBand: "cancel-lock",
      dependsOn: ["el-buy-fav"],
      once: false,
    },
    {
      id: "el-sell-fav",
      startSec: 8 * 60,
      endSec: end,
      token: "favorite",
      direction: "down",
      action: "sell",
      minElapsedSec: 8 * 60,
      lossPct: 10,
      lossWindowMs: 10_000,
      afterFill: "favorite",
      dependsOn: ["el-buy-fav"],
      once: true,
    },
  ];
}

export function validateChartRules(
  rules: ChartRule[] | undefined,
  pollIntervalMs: number,
): string[] {
  if (!rules || rules.length === 0) return [];
  const errors: string[] = [];
  const ids = new Set<string>();
  const minLookback = 2 * pollIntervalMs;
  for (const rule of rules) {
    if (!rule.id) errors.push("chartRule missing id");
    else if (ids.has(rule.id)) errors.push(`chartRule duplicate id '${rule.id}'`);
    else ids.add(rule.id);
    if (!(rule.startSec < rule.endSec)) {
      errors.push(`chartRule '${rule.id}': startSec must be < endSec`);
    }
    if (rule.startSec < 0 || rule.endSec < 0) {
      errors.push(`chartRule '${rule.id}': bounds must be ≥ 0`);
    }
    if (rule.token !== "cheap" && rule.token !== "favorite") {
      errors.push(`chartRule '${rule.id}': token must be cheap|favorite`);
    }
    if (rule.direction !== "up" && rule.direction !== "down") {
      errors.push(`chartRule '${rule.id}': direction must be up|down`);
    }
    if (rule.action !== "buy" && rule.action !== "sell") {
      errors.push(`chartRule '${rule.id}': action must be buy|sell`);
    }
    if (rule.lookbackMs !== undefined && rule.lookbackMs < minLookback) {
      errors.push(
        `chartRule '${rule.id}': lookbackMs must be ≥ 2× pollIntervalMs (${minLookback})`,
      );
    }
    if (rule.minSlope !== undefined && rule.minSlope <= 0) {
      errors.push(`chartRule '${rule.id}': minSlope must be > 0`);
    }
    if (rule.sizeUsdc !== undefined && !(rule.sizeUsdc > 0)) {
      errors.push(`chartRule '${rule.id}': sizeUsdc must be > 0`);
    }
    if (rule.sellAll !== undefined && rule.action !== "sell") {
      errors.push(`chartRule '${rule.id}': sellAll only applies to sell zones`);
    }
    if (rule.bandMin != null && rule.bandMax != null && !(rule.bandMin < rule.bandMax)) {
      errors.push(`chartRule '${rule.id}': bandMin must be < bandMax`);
    }
    if (rule.confirmTicks !== undefined && !(rule.confirmTicks >= 2)) {
      errors.push(`chartRule '${rule.id}': confirmTicks must be ≥ 2`);
    }
    if (rule.confirmTicks != null && !hasPriceBand(rule)) {
      errors.push(`chartRule '${rule.id}': confirmTicks requires a price band`);
    }
    if (rule.maxDownTick !== undefined && !(rule.maxDownTick >= 0)) {
      errors.push(`chartRule '${rule.id}': maxDownTick must be ≥ 0`);
    }
    if (
      rule.afterFill !== undefined &&
      rule.afterFill !== "none" &&
      rule.afterFill !== "cheap" &&
      rule.afterFill !== "favorite"
    ) {
      errors.push(`chartRule '${rule.id}': afterFill must be none|cheap|favorite`);
    }
    if (
      rule.outOfBand !== undefined &&
      rule.outOfBand !== "keep" &&
      rule.outOfBand !== "cancel-lock"
    ) {
      errors.push(`chartRule '${rule.id}': outOfBand must be keep|cancel-lock`);
    }
    if (rule.minElapsedSec !== undefined && !(rule.minElapsedSec >= 0)) {
      errors.push(`chartRule '${rule.id}': minElapsedSec must be ≥ 0`);
    }
    if (rule.lossPct !== undefined && !(rule.lossPct > 0)) {
      errors.push(`chartRule '${rule.id}': lossPct must be > 0`);
    }
    if (rule.lossWindowMs !== undefined && !(rule.lossWindowMs > 0)) {
      errors.push(`chartRule '${rule.id}': lossWindowMs must be > 0`);
    }
    if (rule.dependsOn !== undefined && !Array.isArray(rule.dependsOn)) {
      errors.push(`chartRule '${rule.id}': dependsOn must be an array of ids`);
    } else if (Array.isArray(rule.dependsOn)) {
      for (const dep of rule.dependsOn) {
        if (typeof dep !== "string" || dep.length === 0) {
          errors.push(
            `chartRule '${rule.id}': dependsOn entries must be non-empty strings`,
          );
        }
      }
    }
  }
  for (const rule of rules) {
    for (const dep of uniqueDependsOn(rule)) {
      if (dep === rule.id) {
        errors.push(`chartRule '${rule.id}': dependsOn cannot include itself`);
      } else if (!ids.has(dep)) {
        errors.push(`chartRule '${rule.id}': dependsOn unknown id '${dep}'`);
      }
    }
  }
  if (chartRulesHaveCycle(rules)) {
    errors.push("chartRules: dependsOn cycle");
  }
  return errors;
}
