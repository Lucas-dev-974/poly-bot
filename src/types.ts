import type { StrategyId } from "./strategy/ids.js";

export type TradeSide = "BUY" | "SELL";

export interface GammaMarket {
  conditionId: string;
  slug: string;
  clobTokenIds: string;
  outcomes: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  active: boolean;
  closed: boolean;
  volume?: number | string | null;
  volumeNum?: number | string | null;
  volume24hr?: number | string | null;
  liquidity?: number | string | null;
  liquidityNum?: number | string | null;
  lastTradePrice?: number | string | null;
  spread?: number | string | null;
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
  /** Size at the best bid. Null when unknown (legacy snapshots). */
  bestBidSize: number | null;
  /** L2/L3 for analytics persistence. Absent on legacy / test books. */
  ask2?: number | null;
  ask2Size?: number | null;
  ask3?: number | null;
  ask3Size?: number | null;
  bid2?: number | null;
  bid2Size?: number | null;
  bid3?: number | null;
  bid3Size?: number | null;
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
  /** Chart rule that emitted this buy. Used to commit once / dependsOn after POST. */
  chartRuleId?: string;
  /** Optional override (FOK for ask-lock / fav-band). Default inferred by kind. */
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
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

/** "sold" = cheap leg sold via pair defense (defendPair) before resolution. */
export type PositionStatus = "open" | "won" | "lost" | "sold";
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
  /** Prix de revente pour les positions sold. Null si non vendue. */
  sellPrice?: number | null;
  fillReason: FillReason;
  pairId: string;
  bestAskAtFill?: number | null;
  /** Type d'ordre ayant créé la position : GTC (limit resting), FOK (fill-or-kill), FAK (fill-and-kill), SIM (dry-run). */
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
  /** Moteur qui a pris la position. Absent sur les lignes antérieures à la migration. */
  strategyId?: StrategyId;
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
