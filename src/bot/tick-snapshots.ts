import type { BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import type { SimulatedLedger } from "../simulated-ledger.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { TokenBook, TradeOpportunity, UpDownEvent } from "../types.js";
import { gammaMarketStats } from "../utils/market.js";

export type TickSnapshotsDeps = {
  config: BotConfig; // shared mutable ref
  repos?: Repositories;
  tracker: TradeTracker;
  ledger: SimulatedLedger | null;
};

export class TickSnapshots {
  private lastStatsSnapshotAt = 0;
  private static readonly STATS_SNAPSHOT_MS = 60_000;

  constructor(private readonly deps: TickSnapshotsDeps) {}

  insertMarketSnapshots(events: UpDownEvent[], tickTs: number): void {
    for (const event of events) {
      const stats = gammaMarketStats(event.market);
      this.deps.repos?.marketSnapshots.insert({
        ts: tickTs,
        eventSlug: event.slug,
        eventTitle: event.title,
        conditionId: event.market.conditionId,
        windowStart: event.windowStart,
        windowEnd: event.windowEnd,
        volume: stats.volume,
        volume24hr: stats.volume24hr,
        liquidity: stats.liquidity,
        lastTradePrice: stats.lastTradePrice,
        spread: stats.spread,
      });
    }
  }

  insertBooks(event: UpDownEvent, books: TokenBook[], tickTs: number): void {
    for (const book of books) {
      this.deps.repos?.bookSnapshots.insert({
        ts: tickTs,
        eventSlug: event.slug,
        tokenId: book.tokenId,
        outcome: book.outcome,
        outcomeIndex: book.outcomeIndex,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        bestAskSize: book.bestAskSize,
        bestBidSize: book.bestBidSize ?? null,
        ask2: book.ask2 ?? null,
        ask2Size: book.ask2Size ?? null,
        ask3: book.ask3 ?? null,
        ask3Size: book.ask3Size ?? null,
        bid2: book.bid2 ?? null,
        bid2Size: book.bid2Size ?? null,
        bid3: book.bid3 ?? null,
        bid3Size: book.bid3Size ?? null,
      });
    }
  }

  insertOpportunities(
    event: UpDownEvent,
    opps: TradeOpportunity[],
    tickTs: number,
  ): void {
    for (const opp of opps) {
      this.deps.repos?.opportunitySnapshots.insert({
        ts: tickTs,
        eventSlug: event.slug,
        kind: opp.kind,
        tokenId: opp.token.tokenId,
        outcome: opp.token.outcome,
        price: opp.price,
        size: opp.size,
        executed: 0,
        pairId: opp.pairId,
      });
    }
  }

  pruneData(): void {
    const now = Date.now();
    const { repos, config, tracker } = this.deps;
    repos?.events.prune(now - 7 * 24 * 3600_000);
    repos?.balanceSnapshots.prune(now - 30 * 24 * 3600_000);
    repos?.statsSnapshots.prune(now - 30 * 24 * 3600_000);
    repos?.keys.prune(now - 24 * 3600_000);
    repos?.retries.prune(now - 24 * 3600_000);
    repos?.orders.prune(now - 7 * 24 * 3600_000);
    repos?.redeems.prune(now - 30 * 24 * 3600_000);
    if (config.marketSnapshotRetentionMs > 0) {
      repos?.marketSnapshots.prune(now - config.marketSnapshotRetentionMs);
    }
    if (config.bookSnapshotRetentionMs > 0) {
      repos?.bookSnapshots.prune(now - config.bookSnapshotRetentionMs);
    }
    repos?.opportunitySnapshots.prune(now - config.opportunitySnapshotRetentionMs);
    tracker.pruneMemory(now - 24 * 3600_000);
  }

  emitStats(totalAttempts: number): void {
    const stats = this.computeStats(totalAttempts);
    const statsType = this.deps.config.dryRun ? "simulatedStats" : "stats";
    bus.emit({ type: statsType, stats });
    const now = Date.now();
    if (now - this.lastStatsSnapshotAt >= TickSnapshots.STATS_SNAPSHOT_MS) {
      this.deps.repos?.statsSnapshots.insert(stats);
      this.lastStatsSnapshotAt = now;
    }
    if (this.deps.ledger) {
      const availableCollateral = this.deps.ledger.getBalance();
      const positionsValue = this.deps.tracker.getOpenExposure();
      const totalValue = availableCollateral + positionsValue;
      this.deps.repos?.balanceSnapshots.insert({
        availableCollateral,
        positionsValue,
        totalValue,
        source: "simulated",
      });
      bus.emit({ type: "balance", balance: { availableCollateral, positionsValue, totalValue } });
    }
  }

  computeStats(totalAttempts: number) {
    const openPositions = this.deps.tracker.getOpenPositions();
    const wins = this.deps.tracker.getCumulativeWins();
    const losses = this.deps.tracker.getCumulativeLosses();
    const resolved = wins + losses;
    const totalAttempted = totalAttempts;
    const totalFilled = resolved + openPositions.length;
    const coveredCount = this.deps.tracker.getCoveredCount();
    const uncoveredCount = this.deps.tracker.getUncoveredCount();
    const resolvedPairs = coveredCount + uncoveredCount;

    return {
      realizedPnl: this.deps.tracker.getRealizedPnl(),
      arbRealizedPnl: this.deps.tracker.getArbRealizedPnl(),
      directionalRealizedPnl: this.deps.tracker.getDirectionalRealizedPnl(),
      openExposure: this.deps.tracker.getOpenExposure(),
      coveredExposure: this.deps.tracker.getCoveredExposure(),
      uncoveredExposure: this.deps.tracker.getUncoveredExposure(),
      openPositionsCount: openPositions.length,
      resolvedPositionsCount: this.deps.tracker.getCumulativeResolvedCount(),
      wins,
      losses,
      winRate: resolved > 0 ? wins / resolved : 0,
      fillRate: totalAttempted > 0 ? totalFilled / totalAttempted : 0,
      totalAttempted,
      totalFilled,
      coveredCount,
      uncoveredCount,
      coverRate: resolvedPairs > 0 ? coveredCount / resolvedPairs : 0,
    };
  }
}
