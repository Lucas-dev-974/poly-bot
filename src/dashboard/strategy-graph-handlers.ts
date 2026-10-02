import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type BotConfig, toPublicConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import {
  applyRuntimeSettings,
  type EditableConfigKey,
} from "../runtime-settings.js";
import { parseStrategyId } from "../strategy/ids.js";
import type { StrategyGraph } from "../strategy/graph/types.js";
import { validateStrategyGraph } from "../strategy/graph/validate.js";
import { edgeLeadPocGraph } from "../strategy/graph/edge-lead-graph.js";
import { ensureEdgeOrderAction } from "../strategy/graph/ensure-edge-order.js";

/**
 * Handlers CRUD /api/strategy* — extraits de server.ts (split incremental).
 * Le routeur dans DashboardServer reste responsable de brancher les routes.
 */

export interface StrategyGraphHandlerCtx {
  config: BotConfig;
  repos: Repositories | undefined;
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
  assertCanHotSwapStrategy: (nextStrategyId: string) => void;
  configHandler: ((changed: Set<EditableConfigKey>) => void) | null;
}

export function handleEdgeLeadTemplate(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ graph: edgeLeadPocGraph() }));
}

export function handleListStrategies(
  ctx: StrategyGraphHandlerCtx,
  res: ServerResponse,
): void {
  const natives = [
    { id: "arb", name: "Arb", leadsWithEdge: false, native: true },
    { id: "barbell", name: "Barbell", leadsWithEdge: false, native: true },
    { id: "edge-lead", name: "Edge-lead", leadsWithEdge: true, native: true },
    { id: "reverse", name: "Reverse", leadsWithEdge: false, native: true },
  ];
  const custom = (ctx.repos?.strategyGraphs.list() ?? []).map((row) => ({
    ...row,
    native: false,
  }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      engines: [...natives, ...custom],
      activeId: ctx.config.strategyId,
      active: ctx.repos?.strategyGraphs.getActive(ctx.config.strategyId) ?? null,
    }),
  );
}

export function handleGetStrategy(
  ctx: StrategyGraphHandlerCtx,
  res: ServerResponse,
  rawId: string,
): void {
  let id: string;
  try {
    id = parseStrategyId(rawId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
    return;
  }
  if (!id.startsWith("custom:")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not a custom strategy graph" }));
    return;
  }
  const graph = ctx.repos?.strategyGraphs.get(id);
  if (!graph) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Strategy graph not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ graph }));
}

export async function handleValidateStrategy(
  ctx: StrategyGraphHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const graph = parseGraphBody(JSON.parse(await ctx.readBody(req)));
    const errors = validateStrategyGraph(graph, {
      pollIntervalMs: ctx.config.pollIntervalMs,
    });
    res.writeHead(errors.length > 0 ? 400 : 200, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ ok: errors.length === 0, errors }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message, errors: [message] }));
  }
}

export async function handleCreateStrategy(
  ctx: StrategyGraphHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  if (!ctx.repos) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Persistence is disabled" }));
    return;
  }
  try {
    const graph = parseGraphBody(JSON.parse(await ctx.readBody(req)));
    if (!graph.id) {
      graph.id = `custom:${randomUUID()}`;
    }
    graph.id = parseStrategyId(graph.id);
    if (ctx.repos.strategyGraphs.get(graph.id)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Strategy graph already exists" }));
      return;
    }
    const errors = validateStrategyGraph(graph, {
      pollIntervalMs: ctx.config.pollIntervalMs,
    });
    if (errors.length > 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors }));
      return;
    }
    const stored = ctx.repos.strategyGraphs.upsert(graph);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, graph: stored }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export async function handleUpdateStrategy(
  ctx: StrategyGraphHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  if (!ctx.repos) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Persistence is disabled" }));
    return;
  }
  try {
    const id = parseStrategyId(rawId);
    const graph = parseGraphBody(JSON.parse(await ctx.readBody(req)));
    graph.id = parseStrategyId(graph.id ?? id);
    if (graph.id !== id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Graph id must match URL" }));
      return;
    }
    if (!ctx.repos.strategyGraphs.get(id)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
      return;
    }
    const errors = validateStrategyGraph(graph, {
      pollIntervalMs: ctx.config.pollIntervalMs,
    });
    if (errors.length > 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors }));
      return;
    }
    const stored = ctx.repos.strategyGraphs.upsert(graph);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, graph: stored }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function handleDeleteStrategy(
  ctx: StrategyGraphHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
): void {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  if (!ctx.repos) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Persistence is disabled" }));
    return;
  }
  let id: string;
  try {
    id = parseStrategyId(rawId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
    return;
  }
  if (ctx.config.strategyId === id) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "Cannot delete the active strategy graph",
      }),
    );
    return;
  }
  const removed = ctx.repos.strategyGraphs.remove(id);
  if (!removed) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

export async function handleActivateStrategy(
  ctx: StrategyGraphHandlerCtx,
  req: IncomingMessage,
  res: ServerResponse,
  rawId: string,
): Promise<void> {
  if (!ctx.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  try {
    const id = parseStrategyId(rawId);
    ctx.assertCanHotSwapStrategy(id);
    const graph = ctx.repos?.strategyGraphs.get(id);
    if (!graph) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
      return;
    }
    const changed = await applyRuntimeSettings(
      ctx.config,
      { strategyId: id },
      undefined,
      graph.leadsWithEdge,
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
    const status = message.startsWith("Cannot change strategyId") ? 409 : 400;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
}

export function parseGraphBody(value: unknown): StrategyGraph {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid strategy graph");
  }
  return ensureEdgeOrderAction(value as StrategyGraph);
}
