import type { ServerResponse } from "node:http";
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { getMarketHistory } from "./market-history.js";
import { getMarketTrades } from "./market-trades.js";
import {
  getStrategyChartSeries,
  listStrategyChartWindows,
} from "./strategy-chart-api.js";

/**
 * Handlers market-history/trades/snapshots/bot-fills + strategy-chart —
 * extraits de server.ts (split incremental).
 */
export interface MarketDataHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
}

export async function handleMarketHistory(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const tokenId = url.searchParams.get("tokenId") ?? "";
  const oppositeTokenId = url.searchParams.get("oppositeTokenId") ?? "";
  const startTs = Number(url.searchParams.get("startTs"));
  const endTs = Number(url.searchParams.get("endTs"));

  if (!tokenId || !Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tokenId, startTs and endTs are required" }));
    return;
  }

  try {
    const result = await getMarketHistory(ctx.config, {
      tokenId,
      oppositeTokenId: oppositeTokenId || undefined,
      startTs,
      endTs,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

export async function handleMarketTrades(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const conditionId = url.searchParams.get("conditionId") ?? "";
  if (!conditionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "conditionId is required" }));
    return;
  }

  try {
    const trades = await getMarketTrades(ctx.config, conditionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ trades }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

export async function handleBookSnapshots(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const tokenId = url.searchParams.get("tokenId") ?? "";
  const startTs = Number(url.searchParams.get("startTs"));
  const endTs = Number(url.searchParams.get("endTs"));
  if (!tokenId || !Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tokenId, startTs and endTs are required" }));
    return;
  }
  const snapshots =
    ctx.repos?.bookSnapshots.byTokenAndRange(tokenId, startTs * 1000, endTs * 1000) ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ snapshots }));
}

export function handleMarketSnapshots(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const eventSlug = url.searchParams.get("eventSlug") ?? "";
  const startTs = Number(url.searchParams.get("startTs"));
  const endTs = Number(url.searchParams.get("endTs"));
  if (!eventSlug || !Number.isFinite(startTs) || !Number.isFinite(endTs)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "eventSlug, startTs and endTs are required" }));
    return;
  }
  const rows =
    ctx.repos?.marketSnapshots.bySlugAndRange(eventSlug, startTs * 1000, endTs * 1000) ?? [];
  const snapshots = rows.map((row) => ({
    ts: row.ts,
    volume: row.volume ?? null,
    volume24hr: row.volume24hr ?? null,
    liquidity: row.liquidity ?? null,
    spread: row.spread ?? null,
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ snapshots }));
}

/**
 * Fills du bot (table `orders`, filled=1) pour un ou plusieurs tokenIds.
 * Source de vérité pour l'heure et le prix d'entrée : l'API Data Polymarket
 * ne renvoie souvent qu'une jambe et la liste positions n'a pas d'heure de fill.
 */
export function handleBotFills(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const tokenIds = (url.searchParams.get("tokenIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokenIds.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tokenIds is required" }));
    return;
  }
  const rows = ctx.repos?.orders.filledByTokenIds(tokenIds) ?? [];
  const strategyByToken = new Map<string, string>();
  for (const position of ctx.repos?.positions.byTokenIds(tokenIds) ?? []) {
    if (position.strategyId) strategyByToken.set(position.tokenId, position.strategyId);
  }
  const fills = rows.map((r) => ({
    timestamp: Math.floor((r.filledTs ?? r.ts) / 1000),
    price: r.fillPrice ?? r.limitPrice,
    size: r.size,
    side: "BUY" as const,
    outcome: r.outcome,
    outcomeIndex: r.outcomeIndex,
    tokenId: r.tokenId,
    dryRun: r.dryRun === 1,
    strategyId: strategyByToken.get(r.tokenId),
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ fills }));
}

export function handleStrategyChartWindows(
  ctx: MarketDataHandlerCtx,
  res: ServerResponse,
): void {
  const windows = listStrategyChartWindows(ctx.repos);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ windows }));
}

export function handleStrategyChartSeries(
  ctx: MarketDataHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const eventSlug = url.searchParams.get("eventSlug") ?? "";
  const windowStart = Number(url.searchParams.get("windowStart"));
  const windowEnd = Number(url.searchParams.get("windowEnd"));
  if (!eventSlug || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "eventSlug, windowStart and windowEnd are required" }),
    );
    return;
  }
  const series = getStrategyChartSeries(
    ctx.repos,
    eventSlug,
    windowStart,
    windowEnd,
  );
  if (!series) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No series for this market" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(series));
}
