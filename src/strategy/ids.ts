export const STRATEGY_IDS = ["arb", "barbell", "edge-lead"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export function parseStrategyId(value: unknown): StrategyId {
  const raw = String(value).trim().toLowerCase();
  const match = STRATEGY_IDS.find((id) => id === raw);
  if (!match) {
    throw new Error(
      `Invalid strategyId: ${String(value)}. Allowed: ${STRATEGY_IDS.join(", ")}`,
    );
  }
  return match;
}
