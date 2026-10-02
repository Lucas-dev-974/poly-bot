import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { MarketRuleRow } from "../db/repositories.js";
import type { TradeTracker } from "../trade-tracker.js";
import {
  applyRuntimeSettings,
  sanitizePatch,
  type EditableConfigKey,
} from "../runtime-settings.js";
import { leadsWithEdgeFor } from "../strategy/registry.js";
import {
  prefixesWithLiveExposure,
  toggleTradingBlockReason,
  type MarketRuleStore,
} from "../market-rules.js";

/**
 * Handlers /api/market-rules* — extraits de server.ts (split incremental).
 */
export const MARKET_PREFIX_FORMAT =
  "<asset>-updown-<n>{m|h} (ex. btc-updown-15m, sol-updown-5m)";

export function isValidMarketPrefix(prefix: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*-updown-(\d+)([mh])$/.test(prefix);
}

export interface MarketRulesHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
  tracker: TradeTracker | null;
  marketRulesStore: MarketRuleStore | null;
  configHandler: ((changed: Set<EditableConfigKey>) => void) | null;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
}

export function handleMarketRules(
  ctx: MarketRulesHandlerCtx,
  res: ServerResponse,
): void {
  const rules = ctx.repos?.marketRules.list() ?? [];
  const configPrefixes = [...ctx.config.marketSlugPrefixes];
  const discovered = ctx.repos?.marketRules.discovered(
    configPrefixes,
    Date.now() - 90 * 24 * 3600_000,
  ).map((row) => ({
    prefix: row.prefix,
    lastSeenTs: row.lastSeenTs,
    slugCount: row.slugCount,
  })) ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ rules, configPrefixes, discovered }));
}

export async function handleMarketRuleAdd(
  ctx: MarketRulesHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const parsed = JSON.parse(await ctx.readBody(req)) as { prefix?: unknown };
    const prefix = typeof parsed.prefix === "string" ? parsed.prefix.trim() : "";
    if (!isValidMarketPrefix(prefix)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: `Format de famille invalide (attendu : ${MARKET_PREFIX_FORMAT})`,
      }));
      return;
    }
    if (!ctx.repos || !ctx.marketRulesStore) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Persistence disabled" }));
      return;
    }
    const existing = ctx.repos.marketRules.get(prefix);
    if (existing) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rule: existing }));
      return;
    }
    const rule: MarketRuleRow = ctx.repos.marketRules.setFlags(
      prefix,
      { recordingEnabled: true, tradingEnabled: true },
      "user",
    );
    if (!ctx.config.marketSlugPrefixes.includes(prefix)) {
      const leadsWithEdge = leadsWithEdgeFor(ctx.config.strategyId, ctx.repos);
      const changed = await applyRuntimeSettings(
        ctx.config,
        sanitizePatch({ marketSlugPrefixes: [...ctx.config.marketSlugPrefixes, prefix] }),
        undefined,
        leadsWithEdge,
      );
      ctx.configHandler?.(changed);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rule }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export async function handleMarketRuleToggle(
  ctx: MarketRulesHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const parsed = JSON.parse(await ctx.readBody(req)) as {
      prefix?: unknown;
      field?: unknown;
      enabled?: unknown;
    };
    const prefix = typeof parsed.prefix === "string" ? parsed.prefix : "";
    const field = parsed.field === "recording" || parsed.field === "trading" ? parsed.field : null;
    const enabled = parsed.enabled === true;
    if (!prefix || !field) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "prefix and field (recording|trading) are required" }));
      return;
    }
    if (!ctx.repos) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Persistence disabled" }));
      return;
    }
    if (!ctx.repos.marketRules.get(prefix)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Famille inconnue: ${prefix}` }));
      return;
    }
    let warning: string | null = null;
    if (field === "trading" && !enabled) {
      const exposure = prefixesWithLiveExposure(
        ctx.tracker?.getOpenPositions() ?? [],
        ctx.tracker?.getAllPostedOrders() ?? [],
      );
      const reason = toggleTradingBlockReason(prefix, exposure);
      if (reason) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: reason }));
        return;
      }
    }
    if (field === "recording" && !enabled) {
      warning =
        "Enregistrement désactivé : les fenêtres de cette famille seront incomplètes pour le backtest.";
    }
    if (!ctx.marketRulesStore) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Market rules store not initialized" }));
      return;
    }
    const patch = field === "recording" ? { recording: enabled } : { trading: enabled };
    ctx.marketRulesStore.setFlags(prefix, patch, ctx.repos);
    const rule = ctx.repos.marketRules.get(prefix);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rule, warning }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}
