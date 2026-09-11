import type { Repositories } from "../db/index.js";

export type StrategyChartWindow = {
  eventSlug: string;
  eventTitle: string;
  windowStart: number;
  windowEnd: number;
  ticks: number;
};

export type StrategyChartSeriesPoint = {
  t: number;
  ask: number | null;
  bid: number | null;
};

export function listStrategyChartWindows(
  repos: Repositories | undefined,
): StrategyChartWindow[] {
  if (!repos) return [];
  return repos.marketSnapshots.listForStrategyChart().map((row) => ({
    eventSlug: row.eventSlug,
    eventTitle: row.eventTitle,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    ticks: row.ticks,
  }));
}

export function getStrategyChartSeries(
  repos: Repositories | undefined,
  eventSlug: string,
  windowStart: number,
  windowEnd: number,
): {
  eventSlug: string;
  windowStart: number;
  windowEnd: number;
  up: StrategyChartSeriesPoint[];
  down: StrategyChartSeriesPoint[];
  upTokenId: string | null;
  downTokenId: string | null;
} | null {
  if (!repos || !eventSlug) return null;
  const startMs = windowStart * 1000;
  const endMs = windowEnd * 1000;
  const { up, down, upTokenId, downTokenId } = repos.bookSnapshots.seriesUpDownBySlug(
    eventSlug,
    startMs,
    endMs,
  );
  return {
    eventSlug,
    windowStart,
    windowEnd,
    up,
    down,
    upTokenId,
    downTokenId,
  };
}
