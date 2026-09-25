import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { bus, type BalanceSnapshot, type PolymarketPosition } from "./events.js";

const FETCH_TIMEOUT_MS = 10_000;
const ACTIVE_PAGE_SIZE = 500;
const ACTIVE_MAX_OFFSET = 10_000;
const CLOSED_PAGE_SIZE = 50;
const CLOSED_MAX_PAGES = 200;

/**
 * Fetches total portfolio value periodically:
 * - available collateral (pUSD) via the authenticated CLOB client (live only)
 * - open positions value via the public Polymarket data API
 */
export class BalanceTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Positions du dernier poll réussi — cache pour le fallback REST dashboard. */
  private cachedPositions: PolymarketPosition[] = [];

  /**
   * Dernier set de positions connu (poll 30 s). Retourne [] tant que le
   * premier poll n'a pas abouti. Utilisé par GET /api/polymarket-positions.
   */
  lastPositions(): PolymarketPosition[] {
    return this.cachedPositions;
  }

  constructor(
    private readonly config: BotConfig,
    private readonly repos?: Repositories,
  ) {}

  start(fetchAvailable: () => Promise<number | null>): void {
    void this.poll(fetchAvailable);
    this.timer = setInterval(() => void this.poll(fetchAvailable), 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(fetchAvailable: () => Promise<number | null>): Promise<void> {
    try {
      const available = await fetchAvailable();
      const positions = await this.fetchPositions();
      this.cachedPositions = positions;
      const positionsValue = positions.reduce(
        (sum, position) => (position.closed ? sum : sum + position.currentValue),
        0,
      );
      bus.emit({ type: "polymarketPositions", positions });
      if (available === null) return;

      const snapshot: BalanceSnapshot = {
        availableCollateral: available,
        positionsValue,
        totalValue: available + positionsValue,
      };
      this.repos?.balanceSnapshots.insert({ ...snapshot, source: "live" });
      bus.emit({ type: "balance", balance: snapshot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bus.emit({ type: "error", message: `Balance fetch failed: ${message}` });
    }
  }

  private async fetchPositions(): Promise<PolymarketPosition[]> {
    const funder = this.config.funderAddress;
    if (!funder) return [];

    const [active, closed] = await Promise.all([
      this.fetchActivePositions(funder),
      this.fetchClosedPositions(funder),
    ]);

    const activeKeys = new Set(
      active.map((position) => positionKey(position)),
    );
    const uniqueClosed = closed.filter(
      (position) => !activeKeys.has(positionKey(position)),
    );
    return [...active, ...uniqueClosed];
  }

  private async fetchActivePositions(
    funder: string,
  ): Promise<PolymarketPosition[]> {
    const positions: PolymarketPosition[] = [];
    for (let offset = 0; offset <= ACTIVE_MAX_OFFSET; offset += ACTIVE_PAGE_SIZE) {
      const url = new URL("/positions", this.config.dataApiHost);
      url.searchParams.set("user", funder);
      url.searchParams.set("limit", String(ACTIVE_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sizeThreshold", "0");
      url.searchParams.set("includeArchived", "true");

      const raw = await this.fetchJson(url);
      positions.push(...raw.map((p) => mapActivePosition(p)));
      if (raw.length < ACTIVE_PAGE_SIZE) break;
    }
    return positions;
  }

  private async fetchClosedPositions(
    funder: string,
  ): Promise<PolymarketPosition[]> {
    const positions: PolymarketPosition[] = [];
    for (let page = 0; page < CLOSED_MAX_PAGES; page++) {
      const url = new URL("/closed-positions", this.config.dataApiHost);
      url.searchParams.set("user", funder);
      url.searchParams.set("limit", String(CLOSED_PAGE_SIZE));
      url.searchParams.set("offset", String(page * CLOSED_PAGE_SIZE));
      url.searchParams.set("sortBy", "TIMESTAMP");
      url.searchParams.set("sortDirection", "DESC");

      const raw = await this.fetchJson(url);
      positions.push(...raw.map((p) => mapClosedPosition(p)));
      if (raw.length < CLOSED_PAGE_SIZE) break;
    }
    return positions;
  }

  private async fetchJson(
    url: URL,
  ): Promise<Array<Record<string, unknown>>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      return Array.isArray(payload)
        ? (payload as Array<Record<string, unknown>>)
        : [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

function positionKey(position: PolymarketPosition): string {
  return `${position.conditionId}:${position.outcomeIndex}`;
}

function mapActivePosition(p: Record<string, unknown>): PolymarketPosition {
  const slug = String(p.slug ?? p.eventSlug ?? "");
  const endDate = String(p.endDate ?? "");
  const size = Number(p.size ?? 0);
  const avgPrice = Number(p.avgPrice ?? 0);
  return {
    title: String(p.title ?? ""),
    slug,
    outcome: String(p.outcome ?? ""),
    outcomeIndex: Number(p.outcomeIndex ?? 0),
    size,
    avgPrice,
    cost: Number(p.initialValue ?? size * avgPrice),
    currentValue: Number(p.currentValue ?? 0),
    cashPnl: Number(p.cashPnl ?? 0),
    percentPnl: Number(p.percentPnl ?? 0),
    curPrice: Number(p.curPrice ?? 0),
    redeemable: Boolean(p.redeemable ?? false),
    endDate,
    icon: String(p.icon ?? ""),
    asset: String(p.asset ?? ""),
    conditionId: String(p.conditionId ?? ""),
    negRisk: Boolean(p.negativeRisk ?? false),
    oppositeAsset: String(p.oppositeAsset ?? "") || undefined,
    oppositeOutcome: String(p.oppositeOutcome ?? "") || undefined,
    closed: false,
    timestamp: inferTimestamp(slug, endDate, Number(p.timestamp ?? 0)),
  };
}

function mapClosedPosition(p: Record<string, unknown>): PolymarketPosition {
  const slug = String(p.eventSlug || p.slug || "");
  const endDate = String(p.endDate ?? "");
  const size = Number(p.totalBought ?? p.size ?? 0);
  const avgPrice = Number(p.avgPrice ?? 0);
  const realizedPnl = Number(p.realizedPnl ?? p.cashPnl ?? 0);
  const cost = size * avgPrice;
  return {
    title: String(p.title ?? ""),
    slug,
    outcome: String(p.outcome ?? ""),
    outcomeIndex: Number(p.outcomeIndex ?? 0),
    size,
    avgPrice,
    cost,
    currentValue: 0,
    cashPnl: realizedPnl,
    percentPnl: cost > 0 ? (realizedPnl / cost) * 100 : 0,
    curPrice: Number(p.curPrice ?? 0),
    redeemable: false,
    endDate,
    icon: String(p.icon ?? ""),
    asset: String(p.asset ?? ""),
    conditionId: String(p.conditionId ?? ""),
    negRisk: Boolean(p.negativeRisk ?? false),
    oppositeAsset: String(p.oppositeAsset ?? "") || undefined,
    oppositeOutcome: String(p.oppositeOutcome ?? "") || undefined,
    closed: true,
    timestamp: inferTimestamp(slug, endDate, Number(p.timestamp ?? 0)),
  };
}

function inferTimestamp(slug: string, endDate: string, raw: number): number {
  const fromApi = toUnixMs(raw);
  if (fromApi > 0) return fromApi;
  const fromSlug = slugTimestampMs(slug);
  if (fromSlug > 0) return fromSlug;
  const fromEnd = Date.parse(endDate);
  return Number.isFinite(fromEnd) ? fromEnd : 0;
}

function slugTimestampMs(slug: string): number {
  const match = slug.match(/(\d{10})$/);
  return match ? Number(match[1]) * 1000 : 0;
}

function toUnixMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}
