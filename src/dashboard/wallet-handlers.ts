import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { Trader } from "../trader.js";
import { bus } from "./events.js";
import {
  getOnChainPusdBalance,
  validateWithdrawRequest,
  withdrawViaRelayer,
} from "../withdraw.js";

/**
 * Handlers redeem + wallet/withdraw* — extraits de server.ts (split incremental).
 */
export interface WalletHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
  trader: Trader | null;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
}

export async function handleRedeem(
  ctx: WalletHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  let conditionId = "";
  let outcomeIndex = 0;
  let negRisk = false;
  try {
    const body = await ctx.readBody(req);
    const parsed = JSON.parse(body) as {
      conditionId?: string;
      outcomeIndex?: number;
      negRisk?: boolean;
    };
    conditionId = String(parsed.conditionId ?? "");
    outcomeIndex = Number(parsed.outcomeIndex);
    negRisk = Boolean(parsed.negRisk);
    if (!conditionId || Number.isNaN(outcomeIndex)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "conditionId and outcomeIndex are required" }));
      return;
    }
    if (!ctx.trader) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Trader not initialized" }));
      return;
    }
    const result = await ctx.trader.redeemPosition(
      conditionId,
      outcomeIndex,
      negRisk,
    );
    ctx.repos?.redeems.insert({
      conditionId,
      outcomeIndex,
      negRisk: negRisk ? 1 : 0,
      txHash: result.txHash,
      source: "manual",
      success: 1,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, txHash: result.txHash, transactionId: result.transactionId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (conditionId) {
      ctx.repos?.redeems.insert({
        conditionId,
        outcomeIndex,
        negRisk: negRisk ? 1 : 0,
        txHash: null,
        source: "manual",
        success: 0,
        errorMessage: message,
      });
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export async function handleWalletWithdrawQuote(
  ctx: WalletHandlerCtx,
  res: ServerResponse,
): Promise<void> {
  const funder = ctx.config.funderAddress ?? null;
  if (!funder) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        funder: null,
        onChainPusd: null,
        clobAvailable: null,
        ready: false,
        reason: "FUNDER_ADDRESS non configuré",
      }),
    );
    return;
  }
  const onChainPusd = await getOnChainPusdBalance(ctx.config);
  const clobAvailable = ctx.trader
    ? await ctx.trader.getAvailableCollateral().catch(() => null)
    : null;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      funder,
      onChainPusd,
      clobAvailable,
      ready: onChainPusd !== null,
      reason: onChainPusd === null ? "Solde pUSD indisponible (RPC)" : null,
    }),
  );
}

export async function handleWalletWithdraw(
  ctx: WalletHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  let to = "";
  let amount = 0;
  try {
    const parsed = JSON.parse(await ctx.readBody(req)) as {
      amountUsd?: unknown;
      to?: unknown;
    };
    to = typeof parsed.to === "string" ? parsed.to : "";
    const onChainPusd = await getOnChainPusdBalance(ctx.config);
    if (onChainPusd === null) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "Solde pUSD indisponible : retrait impossible pour l'instant",
        }),
      );
      return;
    }
    const validation = validateWithdrawRequest({
      amountUsd: parsed.amountUsd,
      to: parsed.to,
      funder: ctx.config.funderAddress,
      onChainPusd,
    });
    if (!validation.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: validation.error }));
      return;
    }
    amount = validation.amount;
    to = validation.to;
    bus.emit({
      type: "withdrawal",
      status: "pending",
      to,
      amount,
    });
    const result = await withdrawViaRelayer(ctx.config, {
      to: validation.to,
      amountUsd: validation.amount,
    });
    ctx.repos?.withdrawals.insert({
      to,
      amount,
      txHash: result.txHash,
      source: "manual",
      success: 1,
    });
    bus.emit({
      type: "withdrawal",
      status: "success",
      to,
      amount,
      txHash: result.txHash,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        txHash: result.txHash,
        transactionId: result.transactionId,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (to) {
      ctx.repos?.withdrawals.insert({
        to,
        amount,
        txHash: null,
        source: "manual",
        success: 0,
        errorMessage: message,
      });
      bus.emit({ type: "withdrawal", status: "failed", to, amount, message });
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function handleWalletWithdrawals(
  ctx: WalletHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20)),
  );
  const withdrawals = ctx.repos?.withdrawals.recent(limit) ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ withdrawals }));
}
