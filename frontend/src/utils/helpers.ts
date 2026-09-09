import type { MarketView, SimulatedPosition } from "../types";

export function marketCoverage(positions: SimulatedPosition[]): "couvert" | "partiel" {
  const covered =
    positions.some((p) => p.kind === "cheap") &&
    positions.some((p) => p.kind === "expensive");
  return covered ? "couvert" : "partiel";
}

export function currentBidForPosition(
  markets: Record<string, MarketView>,
  position: SimulatedPosition,
): number | null {
  const m = markets[position.eventSlug];
  if (!m) return null;
  const book = m.books.find((b) => b.tokenId === position.tokenId);
  return book ? book.bestBid : null;
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
