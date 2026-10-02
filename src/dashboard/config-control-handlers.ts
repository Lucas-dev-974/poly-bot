import type { IncomingMessage, ServerResponse } from "node:http";
import { type BotConfig, toPublicConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { BacktestJob } from "../backtest/job.js";
import { invalidateWindowsCache } from "../backtest/windows.js";
import {
  applyRuntimeSettings,
  keysForStrategy,
  sanitizePatch,
  type EditableConfigKey,
} from "../runtime-settings.js";
import { listStrategyPresets } from "../strategy-presets.js";
import { leadsWithEdgeFor } from "../strategy/registry.js";
import { strategyHotSwapBlockReason } from "../market-rules.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { ReverseBot } from "../bot/reverse-bot.js";

/**
 * Handlers /api/config*, /api/bot/control, /api/reset, /api/strategy/status* —
 * extraits de server.ts (split incremental).
 */
export interface ConfigControlHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
  tracker: TradeTracker | null;
  bot: ReverseBot | null;
  backtestJob: BacktestJob;
  configHandler: ((changed: Set<EditableConfigKey>) => void) | null;
  controlHandler: ((enabled: boolean) => void) | null;
  isPausedFn: (() => boolean) | null;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
  assertCanHotSwapStrategy: (nextStrategyId: string) => void;
}

export function assertCanHotSwapStrategy(
  config: BotConfig,
  tracker: TradeTracker | null,
  nextStrategyId: string,
): void {
  if (nextStrategyId === config.strategyId) return;
  const reason = strategyHotSwapBlockReason(
    tracker?.getOpenPositions().length ?? 0,
    tracker?.getAllPostedOrders().length ?? 0,
  );
  if (reason) throw new Error(reason);
}

export function handleGetConfig(
  ctx: ConfigControlHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      config: toPublicConfig(ctx.config),
      editableKeys: keysForStrategy(
        ctx.config.strategyId,
        leadsWithEdgeFor(ctx.config.strategyId, ctx.repos),
      ),
      leadsWithEdge:
        leadsWithEdgeFor(ctx.config.strategyId, ctx.repos) ?? false,
    }),
  );
}

export function handleGetConfigPresets(res: ServerResponse): void {
  try {
    const presets = listStrategyPresets();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ presets }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

export async function handlePatchConfig(
  ctx: ConfigControlHandlerCtx,
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
    const parsed = JSON.parse(body) as unknown;
    const patch = sanitizePatch(parsed);
    const nextId = patch.strategyId ?? ctx.config.strategyId;
    if (patch.strategyId !== undefined) {
      ctx.assertCanHotSwapStrategy(String(nextId));
    }
    if (typeof nextId === "string" && nextId.startsWith("custom:")) {
      if (!ctx.repos?.strategyGraphs.get(nextId)) {
        throw new Error(`Unknown custom strategy: ${nextId}`);
      }
    }
    const leadsWithEdge = leadsWithEdgeFor(nextId, ctx.repos);
    const changed = await applyRuntimeSettings(
      ctx.config,
      patch,
      undefined,
      leadsWithEdge,
    );
    ctx.configHandler?.(changed);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        config: toPublicConfig(ctx.config),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("Request body") ||
      message.startsWith("Unknown field") ||
      message.startsWith("Field not editable") ||
      message.startsWith("Invalid") ||
      message.startsWith("At least one") ||
      message.startsWith("Unknown custom") ||
      message.includes("must be")
      ? 400
      : message.startsWith("Cannot change strategyId")
        ? 409
        : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function handleBotControlState(
  ctx: ConfigControlHandlerCtx,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ enabled: !ctx.isPausedFn?.() }));
}

export async function handleBotControl(
  ctx: ConfigControlHandlerCtx,
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
    const parsed = JSON.parse(body) as { enabled?: boolean };
    const enabled = Boolean(parsed.enabled);
    ctx.controlHandler?.(enabled);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export async function handleReset(
  ctx: ConfigControlHandlerCtx,
  res: ServerResponse,
  req: IncomingMessage,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  ctx.backtestJob.cancelCurrent();
  await ctx.backtestJob.waitUntilIdle();
  invalidateWindowsCache();
  // Live-only bot: DB reset is never allowed (was dry-run only).
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Reset désactivé en mode live" }));
}

export function handleStrategyStatus(
  ctx: ConfigControlHandlerCtx,
  res: ServerResponse,
): void {
  if (!ctx.bot) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: null }));
    return;
  }
  const status = ctx.bot.getStrategyStatus();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status }));
}

export function handleStrategyStatusReset(
  ctx: ConfigControlHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  if (!ctx.bot) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Bot not initialized" }));
    return;
  }
  ctx.bot.resetWhipsawPause();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
