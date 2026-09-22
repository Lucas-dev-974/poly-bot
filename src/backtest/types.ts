import type { StrategyId } from "../strategy/ids.js";
import type { FillReason, PositionKind } from "../types.js";

export interface BacktestWindowMeta {
  eventSlug: string;
  eventTitle: string;
  windowStart: number;
  windowEnd: number;
  complete: boolean;
  tickCount: number;
  expectedTicks: number;
  maxGapMs: number;
  coveragePct: number;
  gapCount: number;
  firstTs?: number | null;
  lastTs?: number | null;
  upTokenId: string | null;
  downTokenId: string | null;
  conditionId: string | null;
}

export interface BacktestSeriesPoint {
  t: number;
  upMid: number | null;
  downMid: number | null;
  volume?: number | null;
  liquidity?: number | null;
  upSpread?: number | null;
  downSpread?: number | null;
  upBidSize?: number | null;
  upAskSize?: number | null;
  downBidSize?: number | null;
  downAskSize?: number | null;
}

export interface BacktestTradeRecord {
  ts: number;
  eventSlug: string;
  kind: PositionKind;
  outcome: string;
  side: "BUY" | "SELL";
  limitPrice: number;
  fillPrice: number | null;
  size: number;
  filled: boolean;
  reason: string | null;
  fillReason: FillReason | null;
  orderType: string | null;
  pairId: string | null;
  pnl: number | null;
}

export interface BacktestWindowResult {
  eventSlug: string;
  pnl: number | null;
  tradeCount: number;
  unresolved: boolean;
}

export interface BacktestResult {
  runId: string;
  strategyId: StrategyId;
  capitalStart: number;
  capitalEnd: number;
  pnl: number;
  windowsTested: number;
  windowsSkippedIncomplete: number;
  unresolvedWindows: number;
  fillCount: number;
  rejectCount: number;
  coveredPairs: number;
  uncoveredPairs: number;
  /** Résolutions gagnées (status won). Absent sur les vieux runs persistés. */
  wins?: number;
  /** Résolutions perdues (status lost). Absent sur les vieux runs. */
  losses?: number;
  /** Winrate strict = wins / (wins + losses). Absent si aucune résolution. */
  winRate?: number | null;
  windows: BacktestWindowResult[];
}

export interface BacktestProgress {
  runId: string;
  status: "running" | "done" | "error" | "cancelled";
  current: number;
  total: number;
  eventSlug: string | null;
  pct: number;
  error?: string;
}
