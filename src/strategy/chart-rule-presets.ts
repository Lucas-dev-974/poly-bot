/** Shared Edge-lead chart preset (editor + backend). No Node/config imports. */

export type EdgeLeadChartRulePreset = {
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
};

/** Trois règles qui reproduisent le moteur edge-lead natif. */
export function edgeLeadChartRules(durationSec = 900): EdgeLeadChartRulePreset[] {
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
