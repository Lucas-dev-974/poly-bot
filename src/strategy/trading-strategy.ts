import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import type { StrategyId } from "./ids.js";

export interface StrategyContext {
  config: BotConfig;
  tracker: TradeTracker;
  event: UpDownEvent;
  books: TokenBook[];
  /** Backtest snapshot time. Live omits this → Date.now() at method entry. */
  nowMs?: number;
}

export interface RestingCheapContext {
  config: BotConfig;
  limitPrice: number;
  cheapBook: TokenBook | undefined;
  favoriteAsk: number | null;
  pairId: string;
  tracker?: TradeTracker;
  /** Backtest snapshot time. Live omits this → Date.now() at method entry. */
  nowMs?: number;
}

export type CheapOrderAction = "keep" | "take-ask" | "cancel-lock";

export interface RestingEdgeContext {
  config: BotConfig;
  edgeBook: TokenBook | undefined;
  pairId: string;
  tracker?: TradeTracker;
  nowMs?: number;
}

export type EdgeOrderAction = "keep" | "cancel-lock";

export interface DefendContext {
  config: BotConfig;
  favoriteAsk: number | null;
  filledCheap: number;
  filledExpensive: number;
  pairId: string;
  /** Ask of the filled cheap token. Needed for banded sell-cheap rules. */
  cheapAsk?: number | null;
  tracker?: TradeTracker;
  /** Backtest snapshot time. Live omits this → Date.now() at method entry. */
  nowMs?: number;
}

export interface HedgePostContext {
  config: BotConfig;
  tracker: TradeTracker;
  pairId: string;
  freshAsk: number | null;
  /** Backtest snapshot time. Live omits this → Date.now() at method entry. */
  nowMs?: number;
}

export interface EdgeSellContext {
  config: BotConfig;
  tracker: TradeTracker;
  pairId: string;
  /** Best bid live du token edge (favori). Null si book manquant. */
  expensiveBid: number | null;
  /** Prix de fill moyen de la jambe expensive. */
  expensiveFillPrice: number;
  /** Shares expensive fillées. */
  expensiveSize: number;
  /** Shares cheap fillées (0 = favori nu). */
  cheapFilled: number;
  /** Âge du marché en ms depuis windowStart. */
  marketAgeMs: number;
  /** Backtest snapshot time. Live omits this → Date.now() at method entry. Native edge-lead ignores it. */
  nowMs?: number;
}

export type HedgePostDecision =
  | { action: "post"; price: number }
  | { action: "skip"; reason: string }
  | { action: "defend"; reason: string };

export interface TradingStrategy {
  readonly id: StrategyId;
  readonly label: string;
  /**
   * Edge-lead : le moteur achète l'edge (favori) d'abord, puis le cheap
   * seulement après fill edge. Quand true, le bot contourne le C2 arb
   * (cheap fill avant favori), force GTC, annule le GTC edge resting s'il
   * sort de la bande edge, et annule le GTC cheap resting s'il sort de la
   * bande cheap (re-post au tick suivant si l'ask cheap rentre).
   */
  readonly leadsWithEdge: boolean;
  findOpportunities(ctx: StrategyContext): TradeOpportunity[];
  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction;
  /** Resting GTC edge (favori). Edge-lead / chart : cancel si hors bande. */
  edgeOrderAction(ctx: RestingEdgeContext): EdgeOrderAction;
  shouldDefend(ctx: DefendContext): boolean;
  /** Shares of cheap to sell if `shouldDefend`. Rounded to 2 decimals. 0 → no SELL. */
  defendShares(ctx: DefendContext): number;
  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision;
  /**
   * Edge-lead : vendre la jambe expensive (favori nu) quand aucun cheap n'est
   * fillé après un délai et que l'edge est en perte soutenue. Retourne false
   * pour arb/barbell (jamais de vente de l'edge).
   */
  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean;
  /** After a buy POST/GTC is accepted (not on emit). Chart once / dependsOn. */
  onBuyCommitted?(opportunity: TradeOpportunity): void;
  /** After a successful FOK SELL of the naked favorite. */
  onSellExpensiveCommitted?(pairId: string): void;
  /** After a successful FOK SELL of filled cheap (defend). */
  onDefendCommitted?(pairId: string): void;
}
