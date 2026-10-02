import type { BotConfig, BotEvent, BotFillsResponse, BacktestPositionRow, BacktestProgress, BacktestResult, BacktestRunRequestSummary, BacktestRunSummary, BacktestSeriesPoint, BacktestWindowMeta, CompletenessRequest, EngineStatsRow, LocalBookSnapshotResponse, LocalMarketSnapshotResponse, ManualBuyResult, MarketHistoryResponse, MarketRuleRow, MarketRulesResponse, MarketTradesResponse, OrderView, RelayerQuotaState, SimulatedPosition, StrategyId, ToggleMarketRuleResponse, WalletQuote, WalletTradesResponse, WithdrawalRow, WithdrawResponse, FavBandWhipsawStatus } from "../types";

/** Réponse GET /api/sim/state (hydratation de la page Simulation). */
export interface SimStateResponse {
  ok: boolean;
  state: SimEngineState;
  effectiveConfig: BotConfig;
  open: SimulatedPosition[];
  resolved: SimulatedPosition[];
  resting: SimRestingOrder[];
  trades: SimTrade[];
}

/** Ligne de l'historique des ordres simulés (sim_trades). */
export interface SimTrade {
  ts: number;
  eventSlug: string;
  kind: string;
  outcome: string;
  side: string;
  limitPrice: number;
  fillPrice: number | null;
  size: number;
  filled: number;
  reason: string | null;
  fillReason: string | null;
  orderType: string | null;
  pairId: string | null;
  pnl: number | null;
}

export interface SimRestingOrder {
  key: string;
  tokenId: string;
  outcome: string;
  kind: string;
  limitPrice: number;
  size: number;
  cost: number;
  windowEnd: number;
}

export interface SimEngineState {
  enabled: boolean;
  cash: number;
  positionsValue: number;
  total: number;
  capitalInitial: number;
  strategyId: string;
  presetId: string | null;
  stats: import("../types").SimulatedStats;
}

export interface SimConfigPatch {
  strategyId?: string;
  presetId?: string | null;
  /** Patch de clés runtime éditables — filtré/validé côté backend (sanitizePatch). */
  settings?: Partial<BotConfig>;
  capital?: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `HTTP ${res.status} for ${url}`;
    try {
      const body = (await res.json()) as { error?: string; errors?: string[] };
      if (body.error) message = body.error;
      else if (body.errors?.length) message = body.errors.join("; ");
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface StateResponse {
  config: BotConfig;
  events: BotEvent[];
}

export interface PositionsResponse {
  positions: SimulatedPosition[];
}

export interface OrdersResponse {
  orders: OrderView[];
}

export interface RedeemRequest {
  conditionId: string;
  outcomeIndex: number;
  negRisk: boolean;
}

export interface RedeemResponse {
  ok: boolean;
  txHash?: string;
  error?: string;
}

export interface ClosePositionRequest {
  positionId: string;
}

export interface ClosePositionResponse {
  ok: boolean;
  fillPrice?: number;
  soldSize?: number;
  pnl?: number;
  error?: string;
}

export interface ConfigResponse {
  config: BotConfig;
  editableKeys: string[];
  leadsWithEdge?: boolean;
}

export interface StrategyEngineSummary {
  id: string;
  name: string;
  description?: string | null;
  leadsWithEdge: boolean;
  native: boolean;
  version?: number;
}

export interface StrategyListResponse {
  engines: StrategyEngineSummary[];
  activeId: string;
  active: unknown;
}

export interface StrategyGraphResponse {
  ok?: boolean;
  graph: import("../strategy-editor/graph-types").StrategyGraph;
  errors?: string[];
  error?: string;
}

export interface RelayerQuotaResponse {
  quota: RelayerQuotaState;
}

export interface UpdateConfigResponse {
  ok: boolean;
  config?: BotConfig;
  error?: string;
}

export interface BotControlResponse {
  ok: boolean;
  enabled?: boolean;
  error?: string;
}

export interface StrategyStatusResponse {
  status: FavBandWhipsawStatus | null;
}

export const api = {
  state: () => request<StateResponse>("/api/state"),
  dbTables: () =>
    request<{ tables: Array<{ name: string; count: number }> }>("/api/db/tables"),
  /** Fallback REST positions Polymarket (cache du dernier poll BalanceTracker). */
  polyPositions: () =>
    request<{ positions: import("../types").PolymarketPosition[] }>(
      "/api/polymarket-positions",
    ),
  config: () => request<ConfigResponse>("/api/config"),
  relayerQuota: () =>
    request<{ quota: RelayerQuotaState }>("/api/relayer-quota"),
  openPositions: () => request<PositionsResponse>("/api/open-positions"),
  resolvedPositions: () => request<PositionsResponse>("/api/resolved-positions"),
  orders: () => request<OrdersResponse>("/api/orders"),
  marketHistory: (p: {
    tokenId: string;
    oppositeTokenId?: string;
    startTs: number;
    endTs: number;
  }) => {
    const params = new URLSearchParams({
      tokenId: p.tokenId,
      startTs: String(p.startTs),
      endTs: String(p.endTs),
    });
    if (p.oppositeTokenId) params.set("oppositeTokenId", p.oppositeTokenId);
    return request<MarketHistoryResponse>(`/api/market-history?${params.toString()}`);
  },
  marketTrades: (conditionId: string) =>
    request<MarketTradesResponse>(
      `/api/market-trades?conditionId=${encodeURIComponent(conditionId)}`,
    ),
  localBookSnapshots: (p: { tokenId: string; startTs: number; endTs: number }) => {
    const params = new URLSearchParams({
      tokenId: p.tokenId,
      startTs: String(p.startTs),
      endTs: String(p.endTs),
    });
    return request<LocalBookSnapshotResponse>(`/api/book-snapshots?${params.toString()}`);
  },
  localMarketSnapshots: (p: { eventSlug: string; startTs: number; endTs: number }) => {
    const params = new URLSearchParams({
      eventSlug: p.eventSlug,
      startTs: String(p.startTs),
      endTs: String(p.endTs),
    });
    return request<LocalMarketSnapshotResponse>(`/api/market-snapshots?${params.toString()}`);
  },
  botFills: (tokenIds: string[]) =>
    request<BotFillsResponse>(
      `/api/bot-fills?tokenIds=${encodeURIComponent(tokenIds.filter(Boolean).join(","))}`,
    ),
  reset: () =>
    request<{ ok: boolean; error?: string }>("/api/reset", { method: "POST" }),
  updateConfig: (body: Partial<BotConfig>) =>
    request<UpdateConfigResponse>("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  redeem: (body: RedeemRequest) =>
    request<RedeemResponse>("/api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  walletWithdrawQuote: () => request<WalletQuote>("/api/wallet/withdraw/quote"),
  walletWithdraw: (body: { amountUsd: number; to: string }) =>
    request<WithdrawResponse>("/api/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  walletWithdrawals: (limit = 20) =>
    request<{ withdrawals: WithdrawalRow[] }>(
      `/api/wallet/withdrawals?limit=${limit}`,
    ),
  statsByEngine: () =>
    request<{ engines: EngineStatsRow[] }>("/api/stats/by-engine"),
  marketRules: () =>
    request<MarketRulesResponse>("/api/market-rules"),
  addMarketRule: (body: { prefix: string }) =>
    request<{ ok: boolean; rule?: MarketRuleRow; error?: string }>(
      "/api/market-rules/add",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  toggleMarketRule: (body: {
    prefix: string;
    field: "recording" | "trading";
    enabled: boolean;
  }) =>
    request<ToggleMarketRuleResponse>("/api/market-rules/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  closePosition: (body: ClosePositionRequest) =>
    request<ClosePositionResponse>("/api/open-positions/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  manualBuy: (body: {
    tokenId: string;
    shares: number;
    mode: "fok" | "resting";
  }) =>
    request<ManualBuyResult>("/api/manual-buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  setBotEnabled: (enabled: boolean) =>
    request<BotControlResponse>("/api/bot/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  botControlState: () => request<{ enabled: boolean }>("/api/bot/control"),
  backtestWindows: (q: {
    from?: number;
    to?: number;
    prefix?: string;
    completeOnly?: boolean;
    completeness?: CompletenessRequest;
  }) => {
    const params = new URLSearchParams();
    if (q.from !== undefined) params.set("from", String(q.from));
    if (q.to !== undefined) params.set("to", String(q.to));
    if (q.prefix) params.set("prefix", q.prefix);
    if (q.completeOnly) params.set("completeOnly", "1");
    const c = q.completeness;
    if (c) {
      if (c.requireMinTicks !== undefined) params.set("requireMinTicks", c.requireMinTicks ? "1" : "0");
      if (c.minTicks !== undefined) params.set("minTicks", String(c.minTicks));
      if (c.requireMaxGap !== undefined) params.set("requireMaxGap", c.requireMaxGap ? "1" : "0");
      if (c.maxGapMs !== undefined) params.set("maxGapMs", String(c.maxGapMs));
      if (c.requireEdge !== undefined) params.set("requireEdge", c.requireEdge ? "1" : "0");
      if (c.maxEdgeGapMs !== undefined) params.set("maxEdgeGapMs", String(c.maxEdgeGapMs));
    }
    const qs = params.toString();
    return request<{ windows: BacktestWindowMeta[] }>(`/api/backtest/windows${qs ? `?${qs}` : ""}`);
  },
  backtestSeries: (slugs: string[]) =>
    request<{ series: Record<string, BacktestSeriesPoint[]> }>(
      `/api/backtest/series?slugs=${encodeURIComponent(slugs.join(","))}`,
    ),
  backtestLowerLows: (slugs: string[], params?: {
    minSwingCents?: number;
    retraceRatio?: number;
    consecutiveRequired?: number;
    lookbackMs?: number;
  }) => {
    const qs = new URLSearchParams();
    qs.set("slugs", slugs.join(","));
    if (params?.minSwingCents !== undefined) qs.set("minSwingCents", String(params.minSwingCents));
    if (params?.retraceRatio !== undefined) qs.set("retraceRatio", String(params.retraceRatio));
    if (params?.consecutiveRequired !== undefined) qs.set("consecutiveRequired", String(params.consecutiveRequired));
    if (params?.lookbackMs !== undefined) qs.set("lookbackMs", String(params.lookbackMs));
    return request<{ results: import("../types").LowerLowAnalysisResult[] }>(
      `/api/backtest/lower-lows?${qs.toString()}`,
    );
  },
  backtestWalletTrades: (from: number, to: number) =>
    request<WalletTradesResponse>(
      `/api/backtest/wallet-trades?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`,
    ),
  backtestStart: (body: {
    strategyId: StrategyId;
    presetId?: string;
    useCurrentConfig?: boolean;
    settings?: Partial<BotConfig>;
    completeOnly?: boolean;
    completeness?: CompletenessRequest;
    from?: number;
    to?: number;
    prefixes?: string[];
  }) =>
    request<{ runId: string; error?: string }>("/api/backtest/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  backtestStatus: (id: string) =>
    request<{
      progress: BacktestProgress;
      result: BacktestResult | null;
      positions: BacktestPositionRow[];
      request: BacktestRunRequestSummary | null;
    }>(`/api/backtest/run/${encodeURIComponent(id)}`),
  backtestRuns: (limit = 20) =>
    request<{
      runs: BacktestRunSummary[];
    }>(`/api/backtest/runs?limit=${limit}`),
  backtestCancel: (id: string) =>
    request<{ ok: boolean }>(`/api/backtest/run/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  strategyChartWindows: () =>
    request<{
      windows: Array<{
        eventSlug: string;
        eventTitle: string;
        windowStart: number;
        windowEnd: number;
        ticks: number;
      }>;
    }>("/api/strategy-chart/windows"),
  strategyChartSeries: (p: {
    eventSlug: string;
    windowStart: number;
    windowEnd: number;
  }) => {
    const params = new URLSearchParams({
      eventSlug: p.eventSlug,
      windowStart: String(p.windowStart),
      windowEnd: String(p.windowEnd),
    });
    return request<{
      eventSlug: string;
      windowStart: number;
      windowEnd: number;
      up: Array<{ t: number; ask: number | null; bid: number | null }>;
      down: Array<{ t: number; ask: number | null; bid: number | null }>;
      upTokenId: string | null;
      downTokenId: string | null;
    }>(`/api/strategy-chart/series?${params.toString()}`);
  },
  strategyList: () => request<StrategyListResponse>("/api/strategy"),
  strategyTemplate: () =>
    request<{ graph: import("../strategy-editor/graph-types").StrategyGraph }>(
      "/api/strategy/templates/edge-lead-poc",
    ),
  strategyGet: (id: string) =>
    request<{ graph: import("../strategy-editor/graph-types").StrategyGraph }>(
      `/api/strategy/${encodeURIComponent(id)}`,
    ),
  strategyValidate: async (graph: import("../strategy-editor/graph-types").StrategyGraph) => {
    const res = await fetch("/api/strategy/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(graph),
    });
    const body = (await res.json()) as { ok?: boolean; errors?: string[]; error?: string };
    return {
      ok: Boolean(body.ok),
      errors: body.errors ?? (body.error ? [body.error] : []),
    };
  },
  strategyCreate: (graph: import("../strategy-editor/graph-types").StrategyGraph) =>
    request<StrategyGraphResponse>("/api/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(graph),
    }),
  strategyUpdate: (id: string, graph: import("../strategy-editor/graph-types").StrategyGraph) =>
    request<StrategyGraphResponse>(`/api/strategy/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(graph),
    }),
  strategyActivate: (id: string) =>
    request<{ ok: boolean; config?: BotConfig; error?: string }>(
      `/api/strategy/${encodeURIComponent(id)}/activate`,
      { method: "POST" },
    ),
  strategyStatus: () => request<StrategyStatusResponse>("/api/strategy/status"),
  strategyStatusReset: () =>
    request<{ ok: boolean; error?: string }>("/api/strategy/status/reset", {
      method: "POST",
    }),

  // ---- Simulation live (paper trading) ----
  simState: () =>
    request<SimStateResponse>("/api/sim/state"),
  simControl: (enabled: boolean) =>
    request<{ ok: boolean; enabled?: boolean; error?: string }>("/api/sim/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  simUpdateConfig: (patch: SimConfigPatch) =>
    request<{ ok: boolean; error?: string }>("/api/sim/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  simReset: () =>
    request<{ ok: boolean; error?: string; archived?: number; archiveBatchId?: string }>(
      "/api/sim/reset",
      { method: "POST" },
    ),
  simPositions: (status: "open" | "resolved" = "open") =>
    request<{ positions: SimulatedPosition[] }>(
      `/api/sim/positions?status=${status}`,
    ),
  simTrades: (
    limit = 200,
    opts?: { slug?: string; filledOnly?: boolean },
  ) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts?.slug) params.set("slug", opts.slug);
    if (opts?.filledOnly) params.set("filled", "1");
    return request<{ trades: SimTrade[] }>(`/api/sim/trades?${params.toString()}`);
  },
  simResting: (slug: string) =>
    request<{ resting: SimRestingOrder[] }>(
      `/api/sim/resting?slug=${encodeURIComponent(slug)}`,
    ),
  simStrategyStatus: () =>
    request<{ status: FavBandWhipsawStatus | null }>("/api/sim/strategy-status"),
  simStrategyStatusReset: () =>
    request<{ ok: boolean; error?: string }>("/api/sim/strategy-status/reset", {
      method: "POST",
    }),
};