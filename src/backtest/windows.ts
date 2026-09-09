import type { Repositories } from "../db/index.js";
import type { BookSnapshotRow } from "../db/repositories.js";
import type { TokenBook } from "../types.js";
import {
  DEFAULT_COMPLETENESS,
  EXPECTED_TICKS,
  evaluateCompleteness,
  isCompleteFromStats,
  windowBoundsFromSlug,
  type CompletenessCriteria,
} from "./completeness.js";
import { l1Spread } from "../utils/market.js";
import type { BacktestSeriesPoint, BacktestWindowMeta } from "./types.js";

const WINDOWS_CACHE_MS = 10_000;

let windowsCache: { at: number; value: BacktestWindowMeta[] } | null = null;

export function invalidateWindowsCache(): void {
  windowsCache = null;
}

function assetPrefix(slug: string): string {
  const dash = slug.indexOf("-");
  return dash > 0 ? slug.slice(0, dash) : slug;
}

export function windowMatchesPrefix(eventSlug: string, prefix: string): boolean {
  return eventSlug.startsWith(prefix) || assetPrefix(eventSlug) === prefix;
}

export function listBacktestWindows(
  repos: Repositories | undefined,
  filters: {
    from?: number;
    to?: number;
    prefix?: string;
    completeOnly?: boolean;
    completeness?: CompletenessCriteria;
  } = {},
): BacktestWindowMeta[] {
  if (!repos) return [];
  const now = Date.now();
  if (windowsCache && now - windowsCache.at < WINDOWS_CACHE_MS) {
    return applyWindowFilters(windowsCache.value, filters);
  }

  const groups = repos.bookSnapshots.listTickGroups();
  const ticksBySlug = new Map<string, number[]>();
  for (const row of groups) {
    if (row.n < 2) continue;
    const list = ticksBySlug.get(row.eventSlug) ?? [];
    list.push(row.ts);
    ticksBySlug.set(row.eventSlug, list);
  }

  const titles = new Map(
    repos.marketSnapshots.titlesBySlug().map((row) => [row.eventSlug, row]),
  );
  const tokens = repos.bookSnapshots.tokensBySlug();
  const upBySlug = new Map<string, string>();
  const downBySlug = new Map<string, string>();
  for (const token of tokens) {
    if (token.outcomeIndex === 0) upBySlug.set(token.eventSlug, token.tokenId);
    if (token.outcomeIndex === 1) downBySlug.set(token.eventSlug, token.tokenId);
  }

  const windows: BacktestWindowMeta[] = [];
  for (const [eventSlug, ticks] of ticksBySlug) {
    const bounds = windowBoundsFromSlug(eventSlug);
    if (!bounds) continue;
    const meta = titles.get(eventSlug);
    const stats = evaluateCompleteness(bounds.windowStart, bounds.windowEnd, ticks);
    windows.push({
      eventSlug,
      eventTitle: meta?.eventTitle ?? eventSlug,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      complete: stats.complete,
      tickCount: stats.tickCount,
      expectedTicks: EXPECTED_TICKS,
      maxGapMs: stats.maxGapMs,
      coveragePct: stats.coveragePct,
      gapCount: stats.gapCount,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
      upTokenId: upBySlug.get(eventSlug) ?? null,
      downTokenId: downBySlug.get(eventSlug) ?? null,
      conditionId: meta?.conditionId ?? null,
    });
  }

  windows.sort((a, b) => b.windowEnd - a.windowEnd || b.windowStart - a.windowStart);
  windowsCache = { at: now, value: windows };
  return applyWindowFilters(windows, filters);
}

function applyWindowFilters(
  windows: BacktestWindowMeta[],
  filters: {
    from?: number;
    to?: number;
    prefix?: string;
    completeOnly?: boolean;
    completeness?: CompletenessCriteria;
  },
): BacktestWindowMeta[] {
  const criteria = filters.completeness ?? DEFAULT_COMPLETENESS;
  return windows.flatMap((window) => {
    const complete = isCompleteFromStats(
      {
        tickCount: window.tickCount,
        maxGapMs: window.maxGapMs,
        firstTs: window.firstTs,
        lastTs: window.lastTs,
      },
      window.windowStart,
      window.windowEnd,
      criteria,
    );
    if (filters.completeOnly && !complete) return [];
    if (filters.from !== undefined && window.windowStart < filters.from) return [];
    if (filters.to !== undefined && window.windowStart > filters.to) return [];
    if (filters.prefix && !windowMatchesPrefix(window.eventSlug, filters.prefix)) {
      return [];
    }
    return [{ ...window, complete }];
  });
}

export function seriesForSlugs(
  repos: Repositories | undefined,
  slugs: string[],
): Record<string, BacktestSeriesPoint[]> {
  const out: Record<string, BacktestSeriesPoint[]> = {};
  if (!repos || slugs.length === 0) return out;
  for (const slug of slugs.slice(0, 50)) {
    const bounds = windowBoundsFromSlug(slug);
    if (!bounds) {
      out[slug] = [];
      continue;
    }
    const startMs = bounds.windowStart * 1000;
    const endMs = bounds.windowEnd * 1000;
    const rows = repos.bookSnapshots.bySlugAndRange(slug, startMs, endMs);
    const metrics = repos.marketSnapshots.bySlugAndRange(slug, startMs, endMs);
    out[slug] = rowsToSeries(rows, metrics);
  }
  return out;
}

function mid(bid: number | null, ask: number | null): number | null {
  return bid != null && ask != null ? (bid + ask) / 2 : null;
}

export function rowsToSeries(
  rows: BookSnapshotRow[],
  metrics: Array<{ ts: number; volume?: number | null; liquidity?: number | null }> = [],
): BacktestSeriesPoint[] {
  const byTs = new Map<
    number,
    {
      up?: BookSnapshotRow;
      down?: BookSnapshotRow;
      volume: number | null;
      liquidity: number | null;
    }
  >();
  for (const row of rows) {
    const entry = byTs.get(row.ts) ?? { volume: null, liquidity: null };
    if (row.outcomeIndex === 0) entry.up = row;
    else entry.down = row;
    byTs.set(row.ts, entry);
  }
  for (const row of metrics) {
    const entry = byTs.get(row.ts) ?? { volume: null, liquidity: null };
    entry.volume = row.volume ?? null;
    entry.liquidity = row.liquidity ?? null;
    byTs.set(row.ts, entry);
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, pair]) => ({
      t: Math.round(ts / 1000),
      upMid: mid(pair.up?.bestBid ?? null, pair.up?.bestAsk ?? null),
      downMid: mid(pair.down?.bestBid ?? null, pair.down?.bestAsk ?? null),
      volume: pair.volume,
      liquidity: pair.liquidity,
      upSpread: l1Spread(pair.up?.bestBid, pair.up?.bestAsk),
      downSpread: l1Spread(pair.down?.bestBid, pair.down?.bestAsk),
      upBidSize: pair.up?.bestBidSize ?? null,
      upAskSize: pair.up?.bestAskSize ?? null,
      downBidSize: pair.down?.bestBidSize ?? null,
      downAskSize: pair.down?.bestAskSize ?? null,
    }));
}

export function booksFromRows(rows: BookSnapshotRow[]): Map<number, TokenBook[]> {
  const byTs = new Map<number, TokenBook[]>();
  for (const row of rows) {
    const books = byTs.get(row.ts) ?? [];
    books.push({
      tokenId: row.tokenId,
      outcome: row.outcome,
      outcomeIndex: row.outcomeIndex,
      bestBid: row.bestBid,
      bestAsk: row.bestAsk,
      bestAskSize: row.bestAskSize,
      bestBidSize: row.bestBidSize ?? null,
      ask2: row.ask2 ?? null,
      ask2Size: row.ask2Size ?? null,
      ask3: row.ask3 ?? null,
      ask3Size: row.ask3Size ?? null,
      bid2: row.bid2 ?? null,
      bid2Size: row.bid2Size ?? null,
      bid3: row.bid3 ?? null,
      bid3Size: row.bid3Size ?? null,
    });
    byTs.set(row.ts, books);
  }
  return byTs;
}
