import type { MarketView, SimulatedPosition } from "../types";

export function marketCoverage(positions: SimulatedPosition[]): "couvert" | "partiel" {
  const covered =
    positions.some((p) => p.kind === "cheap") &&
    positions.some((p) => p.kind === "expensive");
  return covered ? "couvert" : "partiel";
}

/** Quotes L1 du token d'une position, depuis le book live du store markets. */
export interface PositionQuotes {
  bid: number | null;
  ask: number | null;
}

export function currentQuotesForPosition(
  markets: Record<string, MarketView>,
  position: SimulatedPosition,
): PositionQuotes {
  const m = markets[position.eventSlug];
  const book = m?.books.find((b) => b.tokenId === position.tokenId);
  return { bid: book?.bestBid ?? null, ask: book?.bestAsk ?? null };
}

export function currentBidForPosition(
  markets: Record<string, MarketView>,
  position: SimulatedPosition,
): number | null {
  return currentQuotesForPosition(markets, position).bid;
}

export function reasonLabel(reason?: string): string {
  switch (reason) {
    case "insufficient-capital":
      return "capital insuffisant";
    case "exposure-cap":
      return "plafond exposition";
    case "no-ask":
      return "pas d'ask";
    case "no-fill":
      return "non rempli";
    case "readonly-live":
      return "mode lecture seule";
    case "not-a-favorite":
      return "pas un favori";
    case "insufficient-depth":
      return "profondeur insuffisante";
    case "insufficient-balance":
      return "solde insuffisant";
    case "too-close-to-close":
      return "trop proche de la clôture";
    case "killed-fok":
      return "FOK tué";
    case "killed-fok-sell":
      return "SELL FOK tué";
    case "filled-fok-sell":
      return "cheap vendu (défense)";
    case "cancelled":
      return "annulé";
    case "order-failed":
      return "échec CLOB";
    default:
      return reason || "rejeté";
  }
}
