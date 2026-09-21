export const STRATEGY_IDS = ["arb", "barbell", "edge-lead", "reverse", "fav-band", "dip-revert", "antiflip-revert", "flip-confirm", "early-conviction", "open-entry", "probability-repricing"] as const;
export type NativeStrategyId = (typeof STRATEGY_IDS)[number];
export type StrategyId = NativeStrategyId | `custom:${string}`;

export function parseStrategyId(value: unknown): StrategyId {
  const raw = String(value).trim().toLowerCase();
  if (raw.startsWith("custom:")) {
    const rest = raw.slice("custom:".length);
    if (!rest) {
      throw new Error(
        `Invalid strategyId: ${String(value)}. custom id must be non-empty`,
      );
    }
    return `custom:${rest}`;
  }
  const match = STRATEGY_IDS.find((id) => id === raw);
  if (!match) {
    throw new Error(
      `Invalid strategyId: ${String(value)}. Allowed: ${STRATEGY_IDS.join(", ")}, or custom:<id>`,
    );
  }
  return match;
}

export function asStrategyId(value: unknown): StrategyId | undefined {
  if (value == null || value === "") return undefined;
  try {
    return parseStrategyId(value);
  } catch {
    return undefined;
  }
}
