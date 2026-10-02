import type { IncomingMessage, ServerResponse } from "node:http";
import type { Repositories } from "../db/index.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { ManualBuyResult } from "../types.js";
import { MIN_CLOB_SHARES } from "../utils/prices.js";
import type { BalanceTracker } from "./balance.js";

/**
 * Handlers positions / orders / manual-buy / stats — extraits de server.ts (split incremental).
 */
export interface PositionsHandlerCtx {
  repos: Repositories | undefined;
  tracker: TradeTracker | null;
  balanceTracker: BalanceTracker | null;
  closePositionFn:
    | ((positionId: string) => Promise<
        | { ok: true; fillPrice: number; soldSize: number; pnl?: number }
        | { ok: false; error: string }
      >)
    | null;
  manualBuyFn:
    | ((
        tokenId: string,
        shares: number,
        mode: "fok" | "resting",
      ) => Promise<ManualBuyResult>)
    | null;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
}

export function handlePolymarketPositions(
  ctx: PositionsHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ positions: ctx.balanceTracker?.lastPositions() ?? [] }),
  );
}

export async function handleCloseOpenPosition(
  ctx: PositionsHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const body = await ctx.readBody(req);
    const parsed = JSON.parse(body) as { positionId?: string };
    const positionId = String(parsed.positionId ?? "");
    if (!positionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "positionId is required" }));
      return;
    }
    if (!ctx.closePositionFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Close handler not initialized" }));
      return;
    }
    const result = await ctx.closePositionFn(positionId);
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

/**
 * POST /api/manual-buy — achat manuel depuis le dashboard.
 * Body : { tokenId: string; shares: number } (nombre de shares, min 5).
 * Délègue au bot (RestingManager.manualBuy) : budget pUSD calculé côté
 * bot (shares × best ask), FOK BUY au best ask puis tracking de la
 * position (résolution auto à la fin de fenêtre).
 */
export async function handleManualBuy(
  ctx: PositionsHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const body = await ctx.readBody(req);
    const parsed = JSON.parse(body) as {
      tokenId?: string;
      shares?: number;
      mode?: string;
    };
    const tokenId = String(parsed.tokenId ?? "").trim();
    const shares = Math.floor(Number(parsed.shares));
    const mode =
      parsed.mode === "resting" ? ("resting" as const) : ("fok" as const);
    if (!tokenId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "tokenId is required" }));
      return;
    }
    if (!Number.isFinite(shares) || shares < MIN_CLOB_SHARES) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: `shares must be an integer ≥ ${MIN_CLOB_SHARES}`,
        }),
      );
      return;
    }
    if (!ctx.manualBuyFn) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Manual buy handler not initialized" }));
      return;
    }
    const result = await ctx.manualBuyFn(tokenId, shares, mode);
    res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function handleOpenPositions(
  ctx: PositionsHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      positions: ctx.tracker ? ctx.tracker.getOpenPositions() : [],
    }),
  );
}

export function handleResolvedPositions(
  ctx: PositionsHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      positions: ctx.tracker ? ctx.tracker.getResolvedPositions() : [],
    }),
  );
}

export function handleOrders(
  ctx: PositionsHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  const rows = ctx.repos?.orders.recent(100) ?? [];
  res.end(
    JSON.stringify({
      orders: rows.map((row) => ({
        kind: row.kind,
        market: row.eventTitle,
        slug: row.eventSlug,
        tokenId: row.tokenId,
        outcome: row.outcome,
        side: row.side,
        price: row.limitPrice,
        fillPrice: row.fillPrice ?? undefined,
        orderId: row.orderId ?? undefined,
        size: row.size,
        windowEnd: row.windowEnd,
        filled: row.filled === 1,
        reason: row.reason ?? undefined,
        orderType: row.orderType,
      })),
    }),
  );
}

/** GET /api/stats/by-engine — P&L / wins / losses agrégés par moteur. */
export function handleStatsByEngine(
  ctx: PositionsHandlerCtx,
  res: ServerResponse,
): void {
  const engines = ctx.repos?.positions.engineStats() ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ engines }));
}
