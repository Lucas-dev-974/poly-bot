import type { PositionKind } from "../types.js";
import type { Database } from "./database.js";

export interface MarketSnapshotRow {
  ts: number;
  eventSlug: string;
  eventTitle: string;
  conditionId: string;
  windowStart: number;
  windowEnd: number;
  volume?: number | null;
  volume24hr?: number | null;
  liquidity?: number | null;
  lastTradePrice?: number | null;
  spread?: number | null;
}

const MARKET_SNAPSHOT_COLUMNS =
  "ts, eventSlug, eventTitle, conditionId, windowStart, windowEnd, volume, volume24hr, liquidity, lastTradePrice, spread";

export class MarketSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: MarketSnapshotRow): void {
    this.db.run(
      `INSERT INTO market_snapshots (${MARKET_SNAPSHOT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.eventTitle,
        snapshot.conditionId,
        snapshot.windowStart,
        snapshot.windowEnd,
        snapshot.volume ?? null,
        snapshot.volume24hr ?? null,
        snapshot.liquidity ?? null,
        snapshot.lastTradePrice ?? null,
        snapshot.spread ?? null,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM market_snapshots WHERE ts < ?", [beforeTs]);
  }

  latestBySlug(eventSlug: string): MarketSnapshotRow | undefined {
    return this.db.get<MarketSnapshotRow>(
      `SELECT ${MARKET_SNAPSHOT_COLUMNS}
       FROM market_snapshots WHERE eventSlug = ? ORDER BY ts DESC LIMIT 1`,
      [eventSlug],
    );
  }

  bySlugAndRange(eventSlug: string, startTs: number, endTs: number): MarketSnapshotRow[] {
    return this.db.all<MarketSnapshotRow>(
      `SELECT ${MARKET_SNAPSHOT_COLUMNS}
       FROM market_snapshots
       WHERE eventSlug = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [eventSlug, startTs, endTs],
    );
  }

  titlesBySlug(): Array<{
    eventSlug: string;
    eventTitle: string;
    conditionId: string;
    windowStart: number;
    windowEnd: number;
  }> {
    return this.db.all(
      `SELECT eventSlug, MAX(eventTitle) AS eventTitle, MAX(conditionId) AS conditionId,
              MAX(windowStart) AS windowStart, MAX(windowEnd) AS windowEnd
       FROM market_snapshots GROUP BY eventSlug`,
    );
  }

  listForStrategyChart(): Array<{
    eventSlug: string;
    eventTitle: string;
    windowStart: number;
    windowEnd: number;
    ticks: number;
  }> {
    return this.db.all(
      `SELECT m.eventSlug,
              MAX(m.eventTitle) AS eventTitle,
              MAX(m.windowStart) AS windowStart,
              MAX(m.windowEnd) AS windowEnd,
              (SELECT COUNT(DISTINCT b.ts)
                 FROM book_snapshots b
                WHERE b.eventSlug = m.eventSlug) AS ticks
       FROM market_snapshots m
       GROUP BY m.eventSlug
       ORDER BY MAX(m.windowEnd) DESC`,
    );
  }
}

export interface BookSnapshotRow {
  ts: number;
  eventSlug: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestAskSize: number | null;
  bestBidSize?: number | null;
  ask2?: number | null;
  ask2Size?: number | null;
  ask3?: number | null;
  ask3Size?: number | null;
  bid2?: number | null;
  bid2Size?: number | null;
  bid3?: number | null;
  bid3Size?: number | null;
}

const BOOK_SNAPSHOT_COLUMNS =
  "ts, eventSlug, tokenId, outcome, outcomeIndex, bestBid, bestAsk, bestAskSize, bestBidSize, ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size";

export class BookSnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: BookSnapshotRow): void {
    this.db.run(
      `INSERT INTO book_snapshots (${BOOK_SNAPSHOT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.tokenId,
        snapshot.outcome,
        snapshot.outcomeIndex,
        snapshot.bestBid,
        snapshot.bestAsk,
        snapshot.bestAskSize,
        snapshot.bestBidSize ?? null,
        snapshot.ask2 ?? null,
        snapshot.ask2Size ?? null,
        snapshot.ask3 ?? null,
        snapshot.ask3Size ?? null,
        snapshot.bid2 ?? null,
        snapshot.bid2Size ?? null,
        snapshot.bid3 ?? null,
        snapshot.bid3Size ?? null,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM book_snapshots WHERE ts < ?", [beforeTs]);
  }

  byTokenAndRange(tokenId: string, startTs: number, endTs: number): BookSnapshotRow[] {
    return this.db.all<BookSnapshotRow>(
      `SELECT ${BOOK_SNAPSHOT_COLUMNS}
       FROM book_snapshots
       WHERE tokenId = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [tokenId, startTs, endTs],
    );
  }

  listTickGroups(): Array<{ eventSlug: string; ts: number; n: number }> {
    return this.db.all(
      `SELECT eventSlug, ts, COUNT(DISTINCT outcomeIndex) AS n
       FROM book_snapshots
       GROUP BY eventSlug, ts
       ORDER BY eventSlug, ts`,
    );
  }

  bySlugAndRange(eventSlug: string, startTs: number, endTs: number): BookSnapshotRow[] {
    return this.db.all<BookSnapshotRow>(
      `SELECT ${BOOK_SNAPSHOT_COLUMNS}
       FROM book_snapshots
       WHERE eventSlug = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`,
      [eventSlug, startTs, endTs],
    );
  }

  tokensBySlug(): Array<{ eventSlug: string; tokenId: string; outcomeIndex: number; outcome: string }> {
    return this.db.all(
      `SELECT eventSlug, tokenId, outcomeIndex, MAX(outcome) AS outcome
       FROM book_snapshots
       GROUP BY eventSlug, tokenId, outcomeIndex`,
    );
  }

  seriesUpDownBySlug(
    eventSlug: string,
    startTsMs: number,
    endTsMs: number,
  ): {
    up: Array<{ t: number; ask: number | null; bid: number | null }>;
    down: Array<{ t: number; ask: number | null; bid: number | null }>;
    upTokenId: string | null;
    downTokenId: string | null;
  } {
    const rows = this.bySlugAndRange(eventSlug, startTsMs, endTsMs);
    const up: Array<{ t: number; ask: number | null; bid: number | null }> = [];
    const down: Array<{ t: number; ask: number | null; bid: number | null }> = [];
    let upTokenId: string | null = null;
    let downTokenId: string | null = null;
    for (const row of rows) {
      const point = {
        t: Math.floor(row.ts / 1000),
        ask: row.bestAsk,
        bid: row.bestBid ?? null,
      };
      if (row.outcomeIndex === 0) {
        up.push(point);
        upTokenId ??= row.tokenId;
      } else {
        down.push(point);
        downTokenId ??= row.tokenId;
      }
    }
    return { up, down, upTokenId, downTokenId };
  }
}

export interface OpportunitySnapshotRow {
  ts: number;
  eventSlug: string;
  kind: PositionKind;
  tokenId: string;
  outcome: string;
  price: number;
  size: number;
  executed: number;
  pairId: string;
}

export class OpportunitySnapshotRepository {
  constructor(private readonly db: Database) {}

  insert(snapshot: OpportunitySnapshotRow): void {
    this.db.run(
      `INSERT INTO opportunity_snapshots (ts, eventSlug, kind, tokenId, outcome, price, size, executed, pairId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.ts,
        snapshot.eventSlug,
        snapshot.kind,
        snapshot.tokenId,
        snapshot.outcome,
        snapshot.price,
        snapshot.size,
        snapshot.executed,
        snapshot.pairId,
      ],
    );
  }

  prune(beforeTs: number): void {
    this.db.run("DELETE FROM opportunity_snapshots WHERE ts < ?", [beforeTs]);
  }
}

export interface MarketResolutionRow {
  eventSlug: string;
  winnerOutcomeIndex: number;
  source: string;
  ts: number;
}

export class MarketResolutionRepository {
  constructor(private readonly db: Database) {}

  get(eventSlug: string): MarketResolutionRow | undefined {
    return this.db.get<MarketResolutionRow>(
      `SELECT eventSlug, winnerOutcomeIndex, source, ts FROM market_resolutions WHERE eventSlug = ?`,
      [eventSlug],
    );
  }

  upsert(row: MarketResolutionRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO market_resolutions (eventSlug, winnerOutcomeIndex, source, ts)
       VALUES (?, ?, ?, ?)`,
      [row.eventSlug, row.winnerOutcomeIndex, row.source, row.ts],
    );
  }
}
