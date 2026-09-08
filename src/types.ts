export type TradeSide = "BUY";

export interface GammaMarket {
  conditionId: string;
  slug: string;
  clobTokenIds: string;
  outcomes: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  active: boolean;
  closed: boolean;
}

export interface UpDownEvent {
  title: string;
  slug: string;
  market: GammaMarket;
  windowStart: number;
  windowEnd: number;
}

export interface TokenBook {
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestAskSize: number | null;
}

export interface TradeOpportunity {
  kind: "cheap" | "expensive";
  event: UpDownEvent;
  token: TokenBook;
  price: number;
  size: number;
  tickSize: string;
  negRisk: boolean;
  tradeKey: string;
  pairId: string;
}

export interface OrderResult {
  dryRun: boolean;
  tokenId: string;
  side: TradeSide;
  price: number;
  fillPrice?: number;
  size: number;
  filledSize?: number;
  filled?: boolean;
  reason?: string;
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
  response?: unknown;
}

export interface OrderBook {
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

export type PositionStatus = "open" | "won" | "lost";
export type FillReason = "marketable" | "probabilistic" | "resting";

export interface SimulatedPosition {
  id: string;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: "cheap" | "expensive";
  limitPrice: number;
  fillPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
  status: PositionStatus;
  resolvedAt?: number;
  pnl?: number;
  fillReason: FillReason;
  pairId: string;
  bestAskAtFill?: number | null;
  /** Type d'ordre ayant créé la position : GTC (limit resting), FOK (fill-or-kill), FAK (fill-and-kill), SIM (dry-run). */
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
}

export type ArbPairStatus = "open" | "partial" | "covered" | "resolved";

export interface SimulatedArbPair {
  id: string;
  eventSlug: string;
  eventTitle: string;
  windowEnd: number;
  cheapLegs: SimulatedPosition[];
  expensiveLegs: SimulatedPosition[];
  status: ArbPairStatus;
  realizedPnl?: number;
  resolvedAt?: number;
  directional?: boolean;
}

export interface SimulatedStats {
  realizedPnl: number;
  arbRealizedPnl: number;
  directionalRealizedPnl: number;
  openExposure: number;
  coveredExposure: number;
  uncoveredExposure: number;
  openPositionsCount: number;
  resolvedPositionsCount: number;
  wins: number;
  losses: number;
  winRate: number;
  fillRate: number;
  totalAttempted: number;
  totalFilled: number;
  coveredCount: number;
  uncoveredCount: number;
  coverRate: number;
}
