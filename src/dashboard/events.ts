import type { BotConfig } from "../config.js";
import type { EventRepository, OrderRepository } from "../db/repositories.js";
import type {
  OrderResult,
  SimulatedPosition,
  SimulatedStats,
  TokenBook,
  TradeOpportunity,
  UpDownEvent,
} from "../types.js";
import type { RelayerQuotaState } from "../relayer-quota.js";
import type { FavBandWhipsawStatus } from "../strategy/fav-band-strategy.js";

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
  | {
      type: "withdrawal";
      status: "pending" | "success" | "failed";
      to: string;
      amount: number;
      txHash?: string;
      message?: string;
    }
  | { type: "botControl"; enabled: boolean }
  | { type: "error"; message: string }
  | { type: "log"; message: string; data?: Record<string, unknown> }
  | { type: "strategyStatus"; status: FavBandWhipsawStatus }
  | { type: "wsStatus"; channel: "market" | "user"; connected: boolean; reconnects: number };

export interface BalanceSnapshot {
  availableCollateral: number;
  positionsValue: number;
  totalValue: number;
}

export interface PolymarketPosition {
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  /** size × avgPrice, or API initialValue when present. */
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
  /** Token ID CLOB de l'outcome opposé (Down si la position est Up, etc.). */
  oppositeAsset?: string;
  /** Nom de l'outcome opposé. */
  oppositeOutcome?: string;
  /** True when the row comes from /closed-positions (already redeemed). */
  closed: boolean;
  /** Close or market time in unix ms, used for recency sort. */
  timestamp: number;
}

type Listener = (event: BotEvent) => void;

const RING_BUFFER_SIZE = 500;

// Events worth persisting to SQLite for long-term history. High-volume or
// transient events (watching/scan/log/config) are excluded to limit writes.
const PERSISTED_EVENT_TYPES = new Set([
  "openedPosition",
  "resolvedPosition",
  "order",
  "resolution",
  "error",
]);

export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly history: BotEvent[] = [];
  private eventRepo: EventRepository | null = null;
  private orderRepo: OrderRepository | null = null;

  setEventRepository(repo: EventRepository | null): void {
    this.eventRepo = repo;
  }

  setOrderRepository(repo: OrderRepository | null): void {
    this.orderRepo = repo;
  }

  emit(event: BotEvent): void {
    this.history.push(event);
    if (this.history.length > RING_BUFFER_SIZE) {
      this.history.shift();
    }
    if (this.eventRepo && PERSISTED_EVENT_TYPES.has(event.type)) {
      this.eventRepo.insert(event.type, event);
    }
    if (event.type === "order") {
      this.orderRepo?.record(event.result, event.opportunity);
    }
    if (event.type === "openedPosition") {
      this.orderRepo?.markFilled(event.position);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replay(): BotEvent[] {
    return [...this.history];
  }

  clear(): void {
    this.history.length = 0;
  }
}

export const bus = new EventBus();
