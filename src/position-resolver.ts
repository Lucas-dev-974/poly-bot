import type { BotConfig } from "./config.js";
import { bus } from "./dashboard/events.js";
import { log } from "./logger.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { SimulatedPosition } from "./types.js";
import { SeededRng } from "./utils/random.js";

export interface GammaMarketResult {
  // Gamma may return these as JSON-serialized STRINGS (e.g. '["Up","Down"]')
  // or as already-parsed arrays depending on the endpoint/version.
  outcomes?: string | string[];
  winningOutcome?: string;
  outcomePrices?: string | string[];
  closed?: boolean;
  umaResolutionStatus?: string;
}

export class PositionResolver {
  private rng: SeededRng;
  private readonly resolving = new Set<string>();

  constructor(
    private readonly config: BotConfig,
    private readonly tracker: TradeTracker,
  ) {
    this.rng = new SeededRng(
      config.simRandomSeed ? `${config.simRandomSeed}:resolver` : undefined,
    );
  }

  reseed(seed?: string): void {
    this.rng = new SeededRng(seed ? `${seed}:resolver` : undefined);
  }

  async resolveDue(): Promise<void> {
    const now = Date.now() / 1000;
    const due = this.tracker
      .getOpenPositions()
      .filter((position) => now >= position.windowEnd + this.config.simResolveDelaySeconds);

    for (const position of due) {
      if (this.resolving.has(position.id)) continue;
      this.resolving.add(position.id);
      try {
        await this.resolvePosition(position);
      } catch (error) {
        // resolveDue runs from a fire-and-forget setInterval: an uncaught
        // rejection here (DB write, unexpected payload) would crash the
        // process and leave live GTC orders unattended on the exchange.
        const message = error instanceof Error ? error.message : String(error);
        log("Position resolution failed, will retry next cycle", {
          market: position.eventTitle,
          outcome: position.outcome,
          error: message,
        });
        bus.emit({ type: "error", message: `Resolution failed: ${message}` });
      } finally {
        this.resolving.delete(position.id);
      }
    }
  }

  private async resolvePosition(position: SimulatedPosition): Promise<void> {
    // Guard: a position may already be resolved (status !== "open") if it was
    // resolved in a previous cycle but still appeared in getOpenPositions() due
    // to a race, or after a restart while the in-memory tracker hadn't synced.
    // Re-crediting the ledger would inflate the simulated cash, so skip it.
    if (position.status !== "open") {
      log("Position already resolved - skipping re-resolution", {
        market: position.eventTitle,
        outcome: position.outcome,
        kind: position.kind,
        status: position.status,
      });
      // Remove from open list WITHOUT re-counting PnL/wins/losses.
      this.tracker.pruneResolvedPosition(position);
      bus.emit({ type: "resolvedPosition", position });
      return;
    }

    const won = await this.determineWinner(position);
    if (won === null) {
      log("Position left open - no winner could be determined (fallback=none)", {
        market: position.eventTitle,
        outcome: position.outcome,
        kind: position.kind,
      });
      bus.emit({
        type: "resolution",
        message: "Position left open - no winner could be determined (fallback=none)",
        data: { market: position.eventTitle, outcome: position.outcome },
      });
      return;
    }

    const credit = won ? position.size : 0;

    position.status = won ? "won" : "lost";
    position.resolvedAt = Date.now();
    position.pnl = round2(credit - position.cost);

    this.tracker.resolvePosition(position);

    const pair = this.tracker.getPair(position.pairId);
    if (pair) {
      const legs = position.kind === "cheap" ? pair.cheapLegs : pair.expensiveLegs;
      const otherLegs = position.kind === "cheap" ? pair.expensiveLegs : pair.cheapLegs;
      const allLegsResolved =
        legs.every((leg) => leg.status !== "open") &&
        otherLegs.every((leg) => leg.status !== "open");
      if (allLegsResolved) {
        this.tracker.finalizePair(pair);
      }
    }

    bus.emit({ type: "resolvedPosition", position });
    log(`Position resolved (${won ? "won" : "lost"})`, {
      market: position.eventTitle,
      outcome: position.outcome,
      kind: position.kind,
      fillPrice: position.fillPrice,
      size: position.size,
      cost: position.cost,
      credit,
      pnl: position.pnl,
    });
  }

  private async determineWinner(
    position: SimulatedPosition,
  ): Promise<boolean | null> {
    for (let attempt = 0; attempt < this.config.simResolveMaxRetries; attempt++) {
      try {
        const result = await this.fetchMarketResult(position.eventSlug);
        if (result) {
          const winner = this.extractWinner(result, position);
          if (winner !== null) return winner;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("Resolution API error", { attempt: attempt + 1, error: message });
      }
      await sleep(this.config.simResolveRetryIntervalMs);
    }

    if (this.config.simResolveFallback === "none") {
      log("Resolution fallback=none - leaving position open after retries", {
        market: position.eventTitle,
      });
      return null;
    }

    log("Resolution fallback (probabilistic) after retries exhausted", {
      market: position.eventTitle,
    });
    bus.emit({
      type: "resolution",
      message: "Resolution fallback (probabilistic) after retries exhausted",
      data: { market: position.eventTitle, outcome: position.outcome },
    });
    return this.probabilisticWinner(position);
  }

  private async fetchMarketResult(
    eventSlug: string,
  ): Promise<GammaMarketResult | null> {
    // IMPORTANT: we must query /events (not /markets) here. The Gamma API's
    // /markets endpoint does not index 15m up/down markets by their event slug
    // — it returns [] for slugs like "btc-updown-15m-<ts>". The /events endpoint
    // does return the event with its nested market, which contains
    // outcomePrices and outcomes for settlement detection.
    const market = await this.fetchEventMarket(eventSlug);
    if (market) return market;
    // Some Gamma deployments omit closed events unless closed=true is set.
    return this.fetchEventMarket(eventSlug, true);
  }

  private async fetchEventMarket(
    eventSlug: string,
    closed?: boolean,
  ): Promise<GammaMarketResult | null> {
    const url = new URL("/events", this.config.gammaApiHost);
    url.searchParams.set("slug", eventSlug);
    if (closed === true) url.searchParams.set("closed", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const events = (await response.json()) as Array<{
        markets?: GammaMarketResult[];
      }>;
      return events[0]?.markets?.[0] ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractWinner(
    result: GammaMarketResult,
    position: SimulatedPosition,
  ): boolean | null {
    return extractWinner(result, position);
  }

  private probabilisticWinner(position: SimulatedPosition): boolean {
    const p = clamp01(position.bestAskAtFill ?? position.fillPrice);
    return this.rng.chance(p);
  }
}

function parseGammaList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return null;
    }
  }
  return null;
}

export function extractWinner(
  result: GammaMarketResult,
  position: Pick<SimulatedPosition, "outcome"> &
    Partial<Pick<SimulatedPosition, "outcomeIndex">>,
): boolean | null {
    // Polymarket's Gamma API exposes the winner via `outcomePrices` — a
    // JSON-serialized string (or already-parsed array) holding prices
    // parallel to `outcomes`. The winning outcome has "1", the loser "0".
    // The `winningOutcome` field is typically empty.
    //
    // Empirically (checked 2026-09-03), `outcomePrices` flips to settlement
    // values (1/0, or 0.9995/0.0005 pre-`closed`) BEFORE the `closed` flag
    // becomes true. We therefore detect settlement from `outcomePrices`
    // first, and only use `closed` / `umaResolutionStatus` as a fallback
    // once Gamma itself marks the market resolved.
    //
    // IMPORTANT: we must NOT use a `>= 0.5` threshold on a live book.
    // During trading a favorite can sit at 0.90+ (e.g. 0.92/0.08);
    // `>= 0.5` would falsely resolve it. Settlement values are at the
    // extremes (1/0 or 0.9995/0.0005), so we only treat a value as
    // resolved when it is >= 0.99 or <= 0.01 — unless Gamma reports
    // `umaResolutionStatus=resolved`, in which case the official winner
    // is already known even if prices have not snapped yet.
    const prices = parseGammaList(result.outcomePrices);
    const outcomes = parseGammaList(result.outcomes);
    if (prices && outcomes) {
      let idx = outcomes.findIndex(
        (name) => name.toLowerCase() === position.outcome.toLowerCase(),
      );
      if (idx < 0 && position.outcomeIndex != null) {
        idx = position.outcomeIndex;
      }
      if (idx >= 0 && idx < prices.length) {
        const price = Number(prices[idx]);
        if (!Number.isNaN(price)) {
          if (price >= 0.99) return true;
          if (price <= 0.01) return false;
          if (result.umaResolutionStatus === "resolved") {
            return price >= 0.5;
          }
          return null;
        }
      }
    }
    if (result.winningOutcome !== undefined && result.winningOutcome !== "") {
      return result.winningOutcome.toLowerCase() === position.outcome.toLowerCase();
    }
    return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
