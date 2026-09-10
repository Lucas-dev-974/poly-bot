import type { BotConfig } from "../config.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { TradeOpportunity } from "../types.js";

export type OrderType = "GTC" | "FOK";

export function orderTypeFor(
  opportunity: TradeOpportunity,
  config: BotConfig,
  strategy: Pick<TradingStrategy, "leadsWithEdge">,
): OrderType {
  return opportunity.kind === "expensive" &&
    config.expensiveOrderType === "FOK" &&
    !strategy.leadsWithEdge
    ? "FOK"
    : "GTC";
}
