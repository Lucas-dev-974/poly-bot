import type { TokenBook, TradeOpportunity } from "../types.js";
import { round2 } from "./ledger.js";

export interface CrossFill {
  filled: boolean;
  fillPrice?: number;
  size?: number;
  reason:
    | "marketable"
    | "resting"
    | "no-fill"
    | "no-ask"
    | "no-bid"
    | "insufficient-depth"
    | "insufficient-capital"
    | "exposure-cap";
}

export function buyFillAgainstBook(
  limitPrice: number,
  size: number,
  book: TokenBook | undefined,
  mode: "marketable" | "resting",
  requireFullSize = false,
): CrossFill {
  const bestAsk = book?.bestAsk ?? null;
  if (bestAsk === null) return { filled: false, reason: "no-ask" };
  if (limitPrice + 1e-12 < bestAsk) return { filled: false, reason: "no-fill" };

  let fillSize = size;
  const bestAskSize = book?.bestAskSize ?? null;
  if (bestAskSize !== null) {
    if (bestAskSize <= 0) return { filled: false, reason: "insufficient-depth" };
    fillSize = Math.min(fillSize, bestAskSize);
  }
  if (fillSize <= 0) return { filled: false, reason: "insufficient-depth" };
  if (requireFullSize && fillSize + 1e-12 < size) {
    return { filled: false, reason: "insufficient-depth" };
  }

  // Maker GTC: fill at the bid (limit). Taking the crashed ask made backtest
  // look like 4¢ cheap fills; live resting fills at the posted limit.
  // Taker / marketable: lift the ask, never pay more than the limit.
  const fillPrice = mode === "resting" ? limitPrice : Math.min(limitPrice, bestAsk);
  return {
    filled: true,
    fillPrice,
    size: round2(fillSize),
    reason: mode,
  };
}

export function sellFillAgainstBook(
  limitPrice: number,
  size: number,
  book: TokenBook | undefined,
  requireFullSize = true,
): CrossFill {
  const bestBid = book?.bestBid ?? null;
  if (bestBid === null) return { filled: false, reason: "no-bid" };
  if (bestBid + 1e-12 < limitPrice) return { filled: false, reason: "no-fill" };

  let fillSize = size;
  const bestBidSize = book?.bestBidSize ?? null;
  if (bestBidSize !== null) {
    if (bestBidSize <= 0) return { filled: false, reason: "insufficient-depth" };
    fillSize = Math.min(fillSize, bestBidSize);
  }
  if (fillSize <= 0) return { filled: false, reason: "insufficient-depth" };
  if (requireFullSize && fillSize + 1e-12 < size) {
    return { filled: false, reason: "insufficient-depth" };
  }

  const fillPrice = Math.max(limitPrice, bestBid);
  return {
    filled: true,
    fillPrice,
    size: round2(fillSize),
    reason: "marketable",
  };
}

export function estimatedBuyCost(opportunity: TradeOpportunity, fillPrice: number, size: number): number {
  return round2(fillPrice * size);
}
