import type { BotConfig } from "../config.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import type { StrategyId } from "./ids.js";

export interface StrategyContext {
  config: BotConfig;
  tracker: TradeTracker;
  event: UpDownEvent;
  books: TokenBook[];
}

export interface RestingCheapContext {
  config: BotConfig;
  limitPrice: number;
  cheapBook: TokenBook | undefined;
  favoriteAsk: number | null;
}

export type CheapOrderAction = "keep" | "take-ask" | "cancel-lock";

export interface DefendContext {
  config: BotConfig;
  favoriteAsk: number | null;
  filledCheap: number;
  filledExpensive: number;
}

export interface HedgePostContext {
  config: BotConfig;
  tracker: TradeTracker;
  pairId: string;
  freshAsk: number | null;
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
}
