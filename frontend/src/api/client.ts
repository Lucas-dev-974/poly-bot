import type { BotConfig, BotEvent, BotFillsResponse, BacktestPositionRow, BacktestProgress, BacktestResult, BacktestRunRequestSummary, BacktestRunSummary, BacktestSeriesPoint, BacktestWindowMeta, CompletenessRequest, LocalBookSnapshotResponse, LocalMarketSnapshotResponse, MarketHistoryResponse, MarketTradesResponse, OrderView, RelayerQuotaState, SimulatedPosition, StrategyId, WalletTradesResponse } from "../types";

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

export const api = {
  state: () => request<StateResponse>("/api/state"),
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
};