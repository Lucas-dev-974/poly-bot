import type { BotConfig, BotEvent, BotFillsResponse, LocalBookSnapshotResponse, MarketHistoryResponse, MarketTradesResponse, OrderView, RelayerQuotaState, SimulatedPosition } from "../types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `HTTP ${res.status} for ${url}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
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
}

export interface StrategyPreset {
  id: string;
  name: string;
  description: string;
  settings: Partial<BotConfig>;
}

export interface ConfigPresetsResponse {
  presets: StrategyPreset[];
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
  configPresets: () => request<ConfigPresetsResponse>("/api/config/presets"),
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
};