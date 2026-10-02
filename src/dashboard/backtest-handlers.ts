import type { IncomingMessage, ServerResponse } from "node:http";
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { BacktestJob, type BacktestRunRequest } from "../backtest/job.js";
import {
  completenessFromSearchParams,
  normalizeCompletenessRequest,
} from "../backtest/completeness.js";
import { listBacktestWindows, seriesForSlugs } from "../backtest/windows.js";
import { getWalletTradesInRange } from "./market-trades.js";
import { parseStrategyId } from "../strategy/ids.js";

/**
 * Handlers /api/backtest/* — extraits de server.ts (split incremental).
 * Le routeur dans DashboardServer reste responsable de brancher les routes.
 */
export interface BacktestHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
  backtestJob: BacktestJob;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
}

export function handleBacktestWindows(
  ctx: BacktestHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const prefix = url.searchParams.get("prefix") ?? undefined;
  const completeOnly = url.searchParams.get("completeOnly") === "1";
  const windows = listBacktestWindows(ctx.repos, {
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
    prefix,
    completeOnly,
    completeness: completenessFromSearchParams(url.searchParams),
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ windows }));
}

export async function handleBacktestWalletTrades(
  ctx: BacktestHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "from and to are required" }));
    return;
  }
  try {
    const trades = await getWalletTradesInRange(ctx.config, from, to);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        trades,
        configured: Boolean(ctx.config.funderAddress),
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
}

export function handleBacktestSeries(
  ctx: BacktestHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const slugs = (url.searchParams.get("slugs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const series = seriesForSlugs(ctx.repos, slugs);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ series }));
}

export async function handleBacktestLowerLows(
  ctx: BacktestHandlerCtx,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  const slugs = (url.searchParams.get("slugs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const minSwingCents = Number(url.searchParams.get("minSwingCents") ?? 5);
  const retraceRatio = Number(url.searchParams.get("retraceRatio") ?? 0.25);
  const consecutiveRequired = Number(url.searchParams.get("consecutiveRequired") ?? 3);
  const lookbackMs = Number(url.searchParams.get("lookbackMs") ?? 120000);

  if (slugs.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [] }));
    return;
  }

  const series = seriesForSlugs(ctx.repos, slugs);

  const { analyzeLowerLows } = await import("../backtest/lower-lows.js");
  type LowerLowParams = import("../backtest/lower-lows.js").LowerLowParams;

  const params: LowerLowParams = {
    minSwingCents,
    retraceRatio,
    consecutiveRequired,
    lookbackMs,
  };

  const results = analyzeLowerLows(series, params);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results }));
}

export function handleBacktestRuns(
  ctx: BacktestHandlerCtx,
  url: URL,
  res: ServerResponse,
): void {
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const runs = ctx.repos?.backtestRuns.recent(limit) ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      runs: runs.map((row) => ({
        id: row.id,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        status: row.status,
        request: parseBacktestRequest(row.requestJson),
        result: parseJsonUnknown(row.resultJson),
        error: row.error,
      })),
    }),
  );
}

export async function handleBacktestStart(
  ctx: BacktestHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const body = JSON.parse(await ctx.readBody(req)) as BacktestRunRequest;
    body.strategyId = parseStrategyId(body.strategyId);
    const started = ctx.backtestJob.start(body);
    if ("error" in started) {
      res.writeHead(started.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: started.error, runId: started.runId }));
      return;
    }
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId: started.runId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function handleBacktestStatus(
  ctx: BacktestHandlerCtx,
  res: ServerResponse,
  id: string,
): void {
  const progress = ctx.backtestJob.getProgress(id);
  if (!progress) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Run introuvable" }));
    return;
  }
  const result = ctx.backtestJob.getResult(id);
  const positions = ctx.repos?.backtestPositions.byRun(id) ?? [];
  const row = ctx.repos?.backtestRuns.get(id);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      progress,
      result,
      positions,
      request: row ? parseBacktestRequest(row.requestJson) : null,
    }),
  );
}

export function handleBacktestCancel(
  ctx: BacktestHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): void {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  const ok = ctx.backtestJob.cancel(id);
  res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok }));
}

function parseJsonUnknown(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export function parseBacktestRequest(json: string): {
  strategyId?: string;
  presetId?: string;
  useCurrentConfig: boolean;
  completeOnly: boolean;
  completeness?: ReturnType<typeof normalizeCompletenessRequest>;
  settings?: Record<string, unknown>;
} | null {
  try {
    const body = JSON.parse(json) as BacktestRunRequest;
    const settings =
      body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : undefined;
    return {
      strategyId: body.strategyId,
      presetId: body.presetId,
      useCurrentConfig: body.useCurrentConfig === true,
      completeOnly: body.completeOnly !== false,
      completeness: normalizeCompletenessRequest(body.completeness),
      ...(settings ? { settings } : {}),
    };
  } catch {
    return null;
  }
}
