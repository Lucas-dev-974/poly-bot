import type { BotConfig } from "./config.js";
import { bus } from "./dashboard/events.js";
import { log } from "./logger.js";
import type { TradeTracker } from "./trade-tracker.js";
import type { SimulatedPosition } from "./types.js";
import { SeededRng } from "./utils/random.js";

/** Verdict de règlement d'un marché binaire. */
type SettlementVerdict = "win" | "lose" | "void";

/** Prix de remboursement par token sur un règlement 50/50 (void). */
export const VOID_SETTLEMENT_PRICE = 0.5;

/**
 * winnerOutcomeIndex réservé au verdict "void" (settlement 50/50, aucun
 * gagnant) dans market_resolutions — 0=Up, 1=Down, 2=void.
 */
export const VOID_WINNER_INDEX = 2;

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
    // Skip to avoid double-counting PnL / re-emitting resolution for an already-settled leg.
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

    const verdict = await this.determineWinner(position);
    if (verdict === null) {
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

    if (verdict === "void") {
      this.resolveVoid(position);
      return;
    }

    const won = verdict === "win";

    const credit = won ? position.size : 0;

    position.status = won ? "won" : "lost";
    position.resolvedAt = Date.now();
    position.pnl = round2(credit - position.cost);

    this.tracker.resolvePosition(position);

    this.finalizePairIfComplete(position);

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

  /**
   * Règlement 50/50 (void) : aucun gagnant — les deux tokens sont remboursés
   * au prix de settlement (0.5). Avant ce chemin : un payload uma-resolved
   * 0.5/0.5 créditait les DEUX jambes comme gagnantes ($1 au lieu de $0.5,
   * l'ancien `price >= 0.5` s'appliquant des deux côtés), et un payload
   * 0.5/0.5 sans flag uma laissait la position ouverte pour toujours.
   */
  private resolveVoid(position: SimulatedPosition): void {
    const credit = round2(position.size * VOID_SETTLEMENT_PRICE);
    position.status = "void";
    position.resolvedAt = Date.now();
    position.pnl = round2(credit - position.cost);

    this.tracker.resolvePosition(position);

    this.finalizePairIfComplete(position);

    bus.emit({ type: "resolvedPosition", position });
    log("Position resolved (void 50/50 — refunded at settlement price)", {
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

  /** Finalise la paire quand toutes ses jambes sont hors statut "open". */
  private finalizePairIfComplete(position: SimulatedPosition): void {
    const pair = this.tracker.getPair(position.pairId);
    if (!pair) return;
    const legs = position.kind === "cheap" ? pair.cheapLegs : pair.expensiveLegs;
    const otherLegs = position.kind === "cheap" ? pair.expensiveLegs : pair.cheapLegs;
    const allLegsResolved =
      legs.every((leg) => leg.status !== "open") &&
      otherLegs.every((leg) => leg.status !== "open");
    if (allLegsResolved) {
      this.tracker.finalizePair(pair);
    }
  }

  private async determineWinner(
    position: SimulatedPosition,
  ): Promise<SettlementVerdict | null> {
    for (let attempt = 0; attempt < this.config.simResolveMaxRetries; attempt++) {
      try {
        const result = await this.fetchMarketResult(position.eventSlug);
        if (result) {
          const verdict = extractSettlement(result, position);
          if (verdict !== null) return verdict;
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
    return this.probabilisticWinner(position) ? "win" : "lose";
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

  private probabilisticWinner(position: SimulatedPosition): boolean {
    const p = clamp01(position.bestAskAtFill ?? position.fillPrice);
    return this.rng.chance(p);
  }
}

/**
 * Lit le règlement d'un marché binaire depuis un payload Gamma.
 * Retourne le verdict complet : "win", "lose" OU "void" (settlement 50/50,
 * prix intermédiaires égaux — les deux tokens sont alors remboursés au prix
 * de settlement). `null` = marché pas encore résolu.
 */
export function extractSettlement(
  result: GammaMarketResult,
  position: Pick<SimulatedPosition, "outcome"> &
    Partial<Pick<SimulatedPosition, "outcomeIndex">>,
): SettlementVerdict | null {
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
        if (price >= 0.99) return "win";
        if (price <= 0.01) return "lose";
        if (result.umaResolutionStatus === "resolved") {
          // Settlement officiel UMA : prix intermédiaires possibles.
          // Égaux des deux côtés (≈ 0.5/0.5) → void, pas un gagnant.
          const otherIdx = idx === 0 ? 1 : 0;
          const otherPrice =
            otherIdx < prices.length ? Number(prices[otherIdx]) : NaN;
          if (
            !Number.isNaN(otherPrice) &&
            Math.abs(price - otherPrice) < 1e-6
          ) {
            return "void";
          }
          return price >= 0.5 ? "win" : "lose";
        }
        return null;
      }
    }
  }
  if (result.winningOutcome !== undefined && result.winningOutcome !== "") {
    return result.winningOutcome.toLowerCase() === position.outcome.toLowerCase()
      ? "win"
      : "lose";
  }
  return null;
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
  // Wrapper rétro-compatible : les consumers historiques (backtest winnerIndex,
  // tests) raisonnent en booléen. Un void renvoie `true` pour "Up" — les
  // deux tokens valent 0.5, l'un n'est pas plus gagnant que l'autre ; les
  // chemins de CRÉDIT passent par extractSettlement, pas par ce wrapper.
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
    const verdict = extractSettlement(result, position);
    if (verdict === null) return null;
    return verdict === "win" || verdict === "void";
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
