// Types miroir du backend (src/types.ts + src/dashboard/events.ts)
// Garder synchronisÃ© avec le backend lors des changements.

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
  bestBidSize: number | null;
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
  fillReason: FillReason;
  pairId: string;
  bestAskAtFill?: number | null;
  /** Type d'ordre ayant crÃ©Ã© la position : GTC, FOK, FAK ou SIM (dry-run). */
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
  /** Moteur qui a pris la position. Absent sur les lignes antérieures à la migration. */
  strategyId?: "arb" | "barbell" | "edge-lead";
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

export interface BotConfig {
  pollIntervalMs: number;
  marketSlugPrefixes: string[];
  cheapBuyMin: number;
  cheapBuyMax: number;
  expensiveBuyMin: number;
  expensiveBuyMax: number;
  enableExpensiveHedge: boolean;
  cheapOrderUsdc: number;
  /** Trading engine: arb = 1:1 + lock; barbell = cheap/hedge ratio, no lock. */
  strategyId: "arb" | "barbell" | "edge-lead";
  /** Target hedge / cheap fill ratio for barbell. Ignored by arb. (0, 1]. */
  barbellHedgeRatio: number;
  /** Verrou profit : bid+hedge à l'entrée et fillPrice+hedge après fill, tous deux ≤ pairLockMax. */
  pairLockMax: number;
  expensiveOrderUsdc: number;
  expensiveOrderType: "FOK" | "GTC";
  maxSharesPerOrder: number;
  maxOpenPositionsPerSide: number;
  maxExposureUsdc: number;
  minutesBeforeCloseMin: number;
  minutesBeforeCloseMax: number;
  minMinutesBeforeCloseToBuy: number | null;
  /** Edge-lead : bande de confirmation de l'ask du favori (edge). */
  edgeBandMin: number;
  edgeBandMax: number;
  /** Edge-lead : nombre de ticks consécutifs valides avant d'acheter l'edge. */
  edgeConfirmSamples: number;
  /** Edge-lead : drop tick-à-tick max toléré dans la série de confirmation. */
  edgeMaxDownTick: number;
  /** Edge-lead : conservé pour JSON/dashboard ; le prix cheap est l'ask live dans la bande. */
  edgeCheapMargin: number;
  /** Edge-lead : budget USDC de l'ordre edge (size = budget / prix edge). */
  edgeOrderUsdc: number;
  /** Edge-lead : plafond de shares de l'ordre edge (le cheap reste sur maxSharesPerOrder). */
  maxShareEdge: number;
  /** Edge-lead : budget USDC de l'ordre cheap (size = budget / ask cheap). Indépendant de l'edge. */
  edgeCheapOrderUsdc: number;
  /** Edge-lead : ask cheap minimum pour poster. */
  edgeCheapBandMin: number;
  /** Edge-lead : ask cheap maximum pour poster. */
  edgeCheapBandMax: number;
  dryRun: boolean;
  readonlyLive: boolean;
  clobHost: string;
  gammaApiHost: string;
  dataApiHost: string;
  enableDashboard: boolean;
  dashboardPort: number;
  simulatedCapital: number;
  simFillProbabilityNonMarketable: number;
  simResolveDelaySeconds: number;
  simResolveRetryIntervalMs: number;
  simResolveMaxRetries: number;
  simResolveFallback: "none" | "probabilistic";
  simMaxRetryAttempts: number;
  simRandomSeed?: string;
  simRequireCoveredPair: boolean;
  relayerHost: string;
  autoRedeemWinners: boolean;
  dbPath: string;
  persistenceEnabled: boolean;
  signatureType: number;
  chainId: number;
}

export interface BalanceSnapshot {
  availableCollateral: number;
  positionsValue: number;
  totalValue: number;
}

export interface RelayerQuotaState {
  exhausted: boolean;
  resetAt: number;
  observedAt: number;
  lastError: string | null;
}

export interface PolymarketPosition {
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  cost: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  endDate: string;
  icon: string;
  asset: string;
  conditionId: string;
  negRisk: boolean;
  oppositeAsset?: string;
  oppositeOutcome?: string;
  closed?: boolean;
  timestamp?: number;
}

/**
 * Cible unifiÃ©e pour le MarketHistoryModal : soit une PolymarketPosition, soit une MarketView.
 * Le graphique est TOUJOURS orientÃ© Up (vert) / Down (rouge) : upTokenId/downTokenId sont
 * rÃ©solus par l'adaptateur, quelle que soit la jambe cliquÃ©e.
 */
export interface ChartTarget {
  // --- Champs chart (obligatoires) ---
  title: string;
  slug: string;
  conditionId: string;
  /** Token de l'outcome Up (index 0). */
  upTokenId: string;
  /** Token de l'outcome Down (index 1), si connu. */
  downTokenId?: string;
  upOutcome: string;
  downOutcome: string;
  /** Jambe cliquÃ©e (0 = Up, 1 = Down) â†’ courbe mise en avant + cartes P&L. null = aucune (MarketView). */
  outcomeIndex: number | null;
  windowStart?: number;
  windowEnd?: number;
  // --- Champs position (optionnels, absents pour MarketView) ---
  avgPrice?: number;
  curPrice?: number;
  size?: number;
  cost?: number;
  cashPnl?: number;
  percentPnl?: number;
  currentValue?: number;
  closed?: boolean;
  timestamp?: number;
  /** Prix de rÃ¨glement du token Up (0 ou 1), indÃ©pendant de la jambe cliquÃ©e. */
  settlePrice?: number;
}

export type BotEvent =
  | { type: "config"; config: BotConfig }
  | { type: "balance"; balance: BalanceSnapshot }
  | { type: "simulatedBalance"; balance: number }
  | { type: "scan"; count: number; slugs?: string[] }
  | { type: "watching"; event: UpDownEvent; books: TokenBook[] }
  | { type: "opportunity"; opportunity: TradeOpportunity }
  | { type: "order"; result: OrderResult; opportunity: TradeOpportunity }
  | { type: "openedPosition"; position: SimulatedPosition }
  | { type: "resolvedPosition"; position: SimulatedPosition }
  | { type: "simulatedStats"; stats: SimulatedStats }
  | { type: "stats"; stats: SimulatedStats }
  | { type: "resolution"; message: string; data?: Record<string, unknown> }
  | { type: "polymarketPositions"; positions: PolymarketPosition[] }
  | { type: "relayerQuota"; quota: RelayerQuotaState }
  | { type: "botControl"; enabled: boolean }
  | { type: "error"; message: string }
  | { type: "log"; message: string; data?: Record<string, unknown> };

// Types UI enrichis
export interface MarketView extends UpDownEvent {
  books: TokenBook[];
  reverseTokenId?: string;
}

export interface OrderView {
  kind: "cheap" | "expensive";
  market: string;
  slug: string;
  tokenId: string;
  outcome: string;
  side?: "BUY" | "SELL";
  price: number;
  fillPrice?: number;
  size: number;
  windowEnd: number;
  filled: boolean;
  reason?: string;
  orderId?: string;
  orderType?: "GTC" | "FOK" | "FAK" | "SIM";
}

export interface LogEntry {
  ts: number;
  message: string;
  data?: Record<string, unknown>;
  isError: boolean;
}

export type BotMode = "dry" | "readonly" | "live";

// --- Historique de marché (graphique position) ---

export interface PricePoint {
  /** Unix timestamp en secondes. */
  t: number;
  /** Prix (probabilité implicite 0-1). */
  p: number;
}

export interface TradePoint {
  /** Unix timestamp en secondes. */
  timestamp: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: number;
}

export interface MarketHistoryResponse {
  history: PricePoint[];
  oppositeHistory: PricePoint[] | null;
}

export interface MarketTradesResponse {
  trades: TradePoint[];
}

/** Fill Data API du wallet (pas la table locale `positions`). */
export interface WalletTrade extends TradePoint {
  conditionId: string;
  slug: string;
  eventSlug: string;
}

export interface WalletTradesResponse {
  trades: WalletTrade[];
  configured: boolean;
}

/** Fill enregistré par le bot (table `orders`, filled=1). */
export interface BotFillPoint extends TradePoint {
  tokenId: string;
  dryRun: boolean;
  strategyId?: "arb" | "barbell" | "edge-lead";
}

export interface BotFillsResponse {
  fills: BotFillPoint[];
}

export interface BookSnapshotPoint {
  /** Timestamp Unix en millisecondes. */
  ts: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize?: number | null;
  bestAskSize?: number | null;
}

export interface LocalBookSnapshotResponse {
  snapshots: BookSnapshotPoint[];
}

export interface MarketMetricPoint {
  /** Timestamp Unix en millisecondes. */
  ts: number;
  volume: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  spread: number | null;
}

export interface LocalMarketSnapshotResponse {
  snapshots: MarketMetricPoint[];
}

export type StrategyId = "arb" | "barbell" | "edge-lead";

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

export interface BacktestProgress {
  runId: string;
  status: "running" | "done" | "error" | "cancelled";
  current: number;
  total: number;
  eventSlug: string | null;
  pct: number;
  error?: string;
}

export interface BacktestWindowResult {
  eventSlug: string;
  pnl: number | null;
  tradeCount: number;
  unresolved: boolean;
}

export interface CompletenessRequest {
  requireMinTicks?: boolean;
  minTicks?: number;
  requireMaxGap?: boolean;
  maxGapMs?: number;
  requireEdge?: boolean;
  maxEdgeGapMs?: number;
}

export interface BacktestRunRequestSummary {
  strategyId?: StrategyId;
  presetId?: string;
  useCurrentConfig: boolean;
  completeOnly: boolean;
  completeness?: CompletenessRequest;
  settings?: Partial<BotConfig>;
}

export interface BacktestRunSummary {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: BacktestProgress["status"] | string;
  request: BacktestRunRequestSummary | null;
  result: BacktestResult | null;
  error: string | null;
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
  windows: BacktestWindowResult[];
}

export interface BacktestPositionRow {
  id: string;
  runId: string;
  ts: number;
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: string;
  side: string;
  limitPrice: number;
  fillPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
  status: string;
  resolvedAt: number | null;
  pnl: number | null;
  fillReason: string | null;
  pairId: string;
  bestAskAtFill: number | null;
  orderType: string | null;
  strategyId: string | null;
}
