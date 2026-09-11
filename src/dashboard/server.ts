import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, resolve, sep } from "node:path";
import { type BotConfig, toPublicConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import { bus, type BotEvent } from "./events.js";
import { getRelayerQuota } from "../relayer-quota.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import {
  applyRuntimeSettings,
  keysForStrategy,
  sanitizePatch,
} from "../runtime-settings.js";
import type { EditableConfigKey } from "../runtime-settings.js";
import { listStrategyPresets } from "../strategy-presets.js";
import { getMarketHistory } from "./market-history.js";
import { getMarketTrades, getWalletTradesInRange } from "./market-trades.js";
import { BacktestJob, type BacktestRunRequest } from "../backtest/job.js";
import {
  completenessFromSearchParams,
  normalizeCompletenessRequest,
} from "../backtest/completeness.js";
import { invalidateWindowsCache, listBacktestWindows, seriesForSlugs } from "../backtest/windows.js";
import { parseStrategyId } from "../strategy/ids.js";
import { leadsWithEdgeFor } from "../strategy/registry.js";
import type { StrategyGraph } from "../strategy/graph/types.js";
import { validateStrategyGraph } from "../strategy/graph/validate.js";
import { edgeLeadPocGraph } from "../strategy/graph/edge-lead-graph.js";
import { ensureEdgeOrderAction } from "../strategy/graph/ensure-edge-order.js";
import {
  getStrategyChartSeries,
  listStrategyChartWindows,
} from "./strategy-chart-api.js";

/**
 * Always prefer the Vite build output (dist/dashboard/public).
 * tsx runs this file from src/dashboard/ — ./public there is a stale copy.
 */
function resolvePublicDir(): { html: string; dir: string } {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "../../dist/dashboard/public"), // src/dashboard/server.ts
    join(here, "public"), // dist/dashboard/server.js
  ];
  for (const dir of candidates) {
    const html = join(dir, "index.html");
    if (existsSync(html)) return { html, dir };
  }
  return { html: join(candidates[0], "index.html"), dir: candidates[0] };
}

const { html: HTML_PATH, dir: PUBLIC_DIR } = resolvePublicDir();

// MIME types pour les assets statiques servis depuis public/ (build Vite).
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export class DashboardServer {
  private tracker: TradeTracker | null = null;
  private trader: Trader | null = null;
  private resetFn: (() => void) | null = null;
  private configHandler: ((changed: Set<EditableConfigKey>) => void) | null = null;
  private controlHandler: ((enabled: boolean) => void) | null = null;
  private isPausedFn: (() => boolean) | null = null;
  private readonly backtestJob: BacktestJob;

  constructor(
    private readonly port: number,
    private readonly config: BotConfig,
    private readonly repos?: Repositories,
  ) {
    this.backtestJob = new BacktestJob(config, repos);
  }

  setTracker(tracker: TradeTracker): void {
    this.tracker = tracker;
  }

  setTrader(trader: Trader): void {
    this.trader = trader;
  }

  setResetHandler(fn: () => void): void {
    this.resetFn = fn;
  }

  setConfigHandler(fn: (changed: Set<EditableConfigKey>) => void): void {
    this.configHandler = fn;
  }

  setControlHandler(fn: (enabled: boolean) => void, isPausedFn: () => boolean): void {
    this.controlHandler = fn;
    this.isPausedFn = isPausedFn;
  }

  start(): void {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (
        url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === "/guide" ||
        url.pathname === "/backtest" ||
        url.pathname === "/strategy-editor"
      ) {
        void this.serveHtml(res);
        return;
      }

      if (url.pathname === "/events") {
        this.handleEvents(res, url.searchParams.get("replay") !== "0");
        return;
      }

      if (url.pathname === "/api/state") {
        this.handleState(res);
        return;
      }

      if (url.pathname === "/api/relayer-quota") {
        this.handleRelayerQuota(res);
        return;
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        this.handleGetConfig(res);
        return;
      }

      if (url.pathname === "/api/config" && req.method === "PATCH") {
        void this.handlePatchConfig(req, res);
        return;
      }

      if (url.pathname === "/api/config/presets" && req.method === "GET") {
        this.handleGetConfigPresets(res);
        return;
      }

      if (url.pathname === "/api/open-positions") {
        this.handleOpenPositions(res);
        return;
      }

      if (url.pathname === "/api/resolved-positions") {
        this.handleResolvedPositions(res);
        return;
      }

      if (url.pathname === "/api/orders") {
        this.handleOrders(res);
        return;
      }

      if (url.pathname === "/api/market-history") {
        void this.handleMarketHistory(url, res);
        return;
      }

      if (url.pathname === "/api/market-trades") {
        void this.handleMarketTrades(url, res);
        return;
      }

      if (url.pathname === "/api/book-snapshots") {
        void this.handleBookSnapshots(url, res);
        return;
      }

      if (url.pathname === "/api/market-snapshots") {
        this.handleMarketSnapshots(url, res);
        return;
      }

      if (url.pathname === "/api/bot-fills") {
        this.handleBotFills(url, res);
        return;
      }

      if (url.pathname === "/api/backtest/windows" && req.method === "GET") {
        this.handleBacktestWindows(url, res);
        return;
      }

      if (url.pathname === "/api/backtest/series" && req.method === "GET") {
        this.handleBacktestSeries(url, res);
        return;
      }

      if (url.pathname === "/api/backtest/wallet-trades" && req.method === "GET") {
        void this.handleBacktestWalletTrades(url, res);
        return;
      }

      if (url.pathname === "/api/backtest/runs" && req.method === "GET") {
        this.handleBacktestRuns(url, res);
        return;
      }

      if (url.pathname === "/api/backtest/run" && req.method === "POST") {
        void this.handleBacktestStart(req, res);
        return;
      }

      if (url.pathname.startsWith("/api/backtest/run/")) {
        const rest = url.pathname.slice("/api/backtest/run/".length);
        if (rest.endsWith("/cancel") && req.method === "POST") {
          this.handleBacktestCancel(req, res, rest.slice(0, -"/cancel".length));
          return;
        }
        if (req.method === "GET") {
          this.handleBacktestStatus(res, rest);
          return;
        }
      }

      if (url.pathname === "/api/reset" && req.method === "POST") {
        void this.handleReset(res, req);
        return;
      }

      if (url.pathname === "/api/redeem" && req.method === "POST") {
        void this.handleRedeem(req, res);
        return;
      }

      if (url.pathname === "/api/bot/control" && req.method === "POST") {
        void this.handleBotControl(req, res);
        return;
      }

      if (url.pathname === "/api/bot/control" && req.method === "GET") {
        this.handleBotControlState(res);
        return;
      }

      if (url.pathname === "/api/strategy-chart/windows" && req.method === "GET") {
        this.handleStrategyChartWindows(res);
        return;
      }

      if (url.pathname === "/api/strategy-chart/series" && req.method === "GET") {
        this.handleStrategyChartSeries(url, res);
        return;
      }

      if (url.pathname === "/api/strategy" && req.method === "GET") {
        this.handleListStrategies(res);
        return;
      }

      if (url.pathname === "/api/strategy/templates/edge-lead-poc" && req.method === "GET") {
        this.handleEdgeLeadTemplate(res);
        return;
      }

      if (url.pathname === "/api/strategy/validate" && req.method === "POST") {
        void this.handleValidateStrategy(req, res);
        return;
      }

      if (url.pathname === "/api/strategy" && req.method === "POST") {
        void this.handleCreateStrategy(req, res);
        return;
      }

      if (url.pathname.startsWith("/api/strategy/")) {
        const rest = decodeURIComponent(url.pathname.slice("/api/strategy/".length));
        if (rest.endsWith("/activate") && req.method === "POST") {
          void this.handleActivateStrategy(req, res, rest.slice(0, -"/activate".length));
          return;
        }
        if (req.method === "GET") {
          this.handleGetStrategy(res, rest);
          return;
        }
        if (req.method === "PUT") {
          void this.handleUpdateStrategy(req, res, rest);
          return;
        }
        if (req.method === "DELETE") {
          this.handleDeleteStrategy(req, res, rest);
          return;
        }
      }

      // Assets statiques du build Vite (JS/CSS hashed sous /assets/).
      // Le HTML de référence est servi par serveHtml() à la racine.
      if (url.pathname.startsWith("/assets/")) {
        void this.serveStatic(url.pathname, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    server.listen(this.port, "127.0.0.1", () => {
      console.log(`[dashboard] listening on http://127.0.0.1:${this.port}`);
      console.log(`[dashboard] static assets: ${PUBLIC_DIR}`);
    });

    // The redeem endpoint can take 1-3 minutes (relayer polling). Node's
    // default request timeout is 120s, which is too short. Allow 5 min.
    server.requestTimeout = 300_000;
    server.headersTimeout = 300_000;
  }

  private async serveHtml(res: import("node:http").ServerResponse): Promise<void> {
    try {
      const html = await readFile(HTML_PATH);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(
        `Failed to load dashboard: ${message}. Run npm run build:dashboard.`,
      );
    }
  }

  /**
   * Sert un asset statique depuis public/ (build Vite : JS/CSS hashed).
   * Sécurisé contre le path traversal : on résout le chemin et on vérifie
   * qu'il reste bien dans PUBLIC_DIR.
   */
  private async serveStatic(
    pathname: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    try {
      // Strip the leading slash: path.join on Windows treats "/assets/x" as
      // an absolute path and ignores PUBLIC_DIR.
      const relative = pathname.replace(/^\/+/, "");
      const resolved = resolve(PUBLIC_DIR, relative);
      const root = resolve(PUBLIC_DIR) + sep;
      if (resolved !== resolve(PUBLIC_DIR) && !resolved.startsWith(root)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const content = await readFile(resolved);
      const mime = MIME_TYPES[extname(resolved)] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private handleEvents(
    res: import("node:http").ServerResponse,
    replay: boolean,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: BotEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (replay) {
      for (const event of bus.replay()) {
        send(event);
      }
    }

    const unsubscribe = bus.subscribe(send);

    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  private handleState(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        config: toPublicConfig(this.config),
        events: bus.replay(),
      }),
    );
  }

  private handleRelayerQuota(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ quota: getRelayerQuota() }));
  }

  private handleGetConfig(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        config: toPublicConfig(this.config),
        editableKeys: keysForStrategy(
          this.config.strategyId,
          leadsWithEdgeFor(this.config.strategyId, this.repos),
        ),
        leadsWithEdge:
          leadsWithEdgeFor(this.config.strategyId, this.repos) ?? false,
      }),
    );
  }

  private handleGetConfigPresets(res: import("node:http").ServerResponse): void {
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

  private async handlePatchConfig(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      const parsed = JSON.parse(body) as unknown;
      const patch = sanitizePatch(parsed);
      const nextId = patch.strategyId ?? this.config.strategyId;
      if (typeof nextId === "string" && nextId.startsWith("custom:")) {
        if (!this.repos?.strategyGraphs.get(nextId)) {
          throw new Error(`Unknown custom strategy: ${nextId}`);
        }
      }
      const leadsWithEdge = leadsWithEdgeFor(nextId, this.repos);
      const changed = await applyRuntimeSettings(
        this.config,
        patch,
        undefined,
        leadsWithEdge,
      );
      this.configHandler?.(changed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          config: toPublicConfig(this.config),
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
        : 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private handleEdgeLeadTemplate(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ graph: edgeLeadPocGraph() }));
  }

  private handleListStrategies(res: import("node:http").ServerResponse): void {
    const natives = [
      { id: "arb", name: "Arb", leadsWithEdge: false, native: true },
      { id: "barbell", name: "Barbell", leadsWithEdge: false, native: true },
      { id: "edge-lead", name: "Edge-lead", leadsWithEdge: true, native: true },
    ];
    const custom = (this.repos?.strategyGraphs.list() ?? []).map((row) => ({
      ...row,
      native: false,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        engines: [...natives, ...custom],
        activeId: this.config.strategyId,
        active: this.repos?.strategyGraphs.getActive(this.config.strategyId) ?? null,
      }),
    );
  }

  private handleGetStrategy(
    res: import("node:http").ServerResponse,
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
    const graph = this.repos?.strategyGraphs.get(id);
    if (!graph) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Strategy graph not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ graph }));
  }

  private async handleValidateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    try {
      const graph = this.parseGraphBody(JSON.parse(await this.readBody(req)));
      const errors = validateStrategyGraph(graph, {
        pollIntervalMs: this.config.pollIntervalMs,
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

  private async handleCreateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    if (!this.repos) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Persistence is disabled" }));
      return;
    }
    try {
      const graph = this.parseGraphBody(JSON.parse(await this.readBody(req)));
      if (!graph.id) {
        graph.id = `custom:${randomUUID()}`;
      }
      graph.id = parseStrategyId(graph.id);
      if (this.repos.strategyGraphs.get(graph.id)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Strategy graph already exists" }));
        return;
      }
      const errors = validateStrategyGraph(graph, {
        pollIntervalMs: this.config.pollIntervalMs,
      });
      if (errors.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors }));
        return;
      }
      const stored = this.repos.strategyGraphs.upsert(graph);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, graph: stored }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private async handleUpdateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    if (!this.repos) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Persistence is disabled" }));
      return;
    }
    try {
      const id = parseStrategyId(rawId);
      const graph = this.parseGraphBody(JSON.parse(await this.readBody(req)));
      graph.id = parseStrategyId(graph.id ?? id);
      if (graph.id !== id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Graph id must match URL" }));
        return;
      }
      if (!this.repos.strategyGraphs.get(id)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
        return;
      }
      const errors = validateStrategyGraph(graph, {
        pollIntervalMs: this.config.pollIntervalMs,
      });
      if (errors.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors }));
        return;
      }
      const stored = this.repos.strategyGraphs.upsert(graph);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, graph: stored }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private handleDeleteStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): void {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    if (!this.repos) {
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
    if (this.config.strategyId === id) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "Cannot delete the active strategy graph",
        }),
      );
      return;
    }
    const removed = this.repos.strategyGraphs.remove(id);
    if (!removed) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleActivateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    try {
      const id = parseStrategyId(rawId);
      const graph = this.repos?.strategyGraphs.get(id);
      if (!graph) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Strategy graph not found" }));
        return;
      }
      const changed = await applyRuntimeSettings(
        this.config,
        { strategyId: id },
        undefined,
        graph.leadsWithEdge,
      );
      this.configHandler?.(changed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          config: toPublicConfig(this.config),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private parseGraphBody(value: unknown): StrategyGraph {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid strategy graph");
    }
    return ensureEdgeOrderAction(value as StrategyGraph);
  }

  private handleStrategyChartWindows(
    res: import("node:http").ServerResponse,
  ): void {
    const windows = listStrategyChartWindows(this.repos);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ windows }));
  }

  private handleStrategyChartSeries(
    url: URL,
    res: import("node:http").ServerResponse,
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
      this.repos,
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

  private handleOpenPositions(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        positions: this.tracker ? this.tracker.getOpenPositions() : [],
      }),
    );
  }

  private handleResolvedPositions(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        positions: this.tracker ? this.tracker.getResolvedPositions() : [],
      }),
    );
  }

  private handleOrders(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    const rows = this.repos?.orders.recent(100) ?? [];
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

  private async handleMarketHistory(
    url: URL,
    res: import("node:http").ServerResponse,
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
      const result = await getMarketHistory(this.config, {
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

  private async handleMarketTrades(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const conditionId = url.searchParams.get("conditionId") ?? "";
    if (!conditionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "conditionId is required" }));
      return;
    }

    try {
      const trades = await getMarketTrades(this.config, conditionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ trades }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async handleBookSnapshots(
    url: URL,
    res: import("node:http").ServerResponse,
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
      this.repos?.bookSnapshots.byTokenAndRange(tokenId, startTs * 1000, endTs * 1000) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ snapshots }));
  }

  private handleMarketSnapshots(
    url: URL,
    res: import("node:http").ServerResponse,
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
      this.repos?.marketSnapshots.bySlugAndRange(eventSlug, startTs * 1000, endTs * 1000) ?? [];
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
  private handleBotFills(
    url: URL,
    res: import("node:http").ServerResponse,
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
    const rows = this.repos?.orders.filledByTokenIds(tokenIds) ?? [];
    const strategyByToken = new Map<string, string>();
    for (const position of this.repos?.positions.byTokenIds(tokenIds) ?? []) {
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

  private isAllowedOrigin(req: import("node:http").IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    const allowed = [
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
      "http://localhost:5173", // dev Vite
      "http://127.0.0.1:5173",
    ];
    return allowed.includes(origin);
  }

  private async handleReset(
    res: import("node:http").ServerResponse,
    req: import("node:http").IncomingMessage,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    this.backtestJob.cancelCurrent();
    await this.backtestJob.waitUntilIdle();
    invalidateWindowsCache();
    if (!this.config.dryRun) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Reset désactivé en mode live" }));
      return;
    }
    try {
      this.resetFn?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private async handleRedeem(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    let conditionId = "";
    let outcomeIndex = 0;
    let negRisk = false;
    try {
      const body = await this.readBody(req);
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
      if (!this.trader) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Trader not initialized" }));
        return;
      }
      const result = await this.trader.redeemPosition(
        conditionId,
        outcomeIndex,
        negRisk,
      );
      this.repos?.redeems.insert({
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
        this.repos?.redeems.insert({
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

  private handleBotControlState(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: !this.isPausedFn?.() }));
  }

  private async handleBotControl(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    try {
      const body = await this.readBody(req);
      const parsed = JSON.parse(body) as { enabled?: boolean };
      const enabled = Boolean(parsed.enabled);
      this.controlHandler?.(enabled);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, enabled }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
  }

  private handleBacktestWindows(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const prefix = url.searchParams.get("prefix") ?? undefined;
    const completeOnly = url.searchParams.get("completeOnly") === "1";
    const windows = listBacktestWindows(this.repos, {
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
      prefix,
      completeOnly,
      completeness: completenessFromSearchParams(url.searchParams),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ windows }));
  }

  private async handleBacktestWalletTrades(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "from and to are required" }));
      return;
    }
    try {
      const trades = await getWalletTradesInRange(this.config, from, to);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          trades,
          configured: Boolean(this.config.funderAddress),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private handleBacktestSeries(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    const slugs = (url.searchParams.get("slugs") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const series = seriesForSlugs(this.repos, slugs);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ series }));
  }

  private handleBacktestRuns(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
    const runs = this.repos?.backtestRuns.recent(limit) ?? [];
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

  private async handleBacktestStart(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    try {
      const body = JSON.parse(await this.readBody(req)) as BacktestRunRequest;
      body.strategyId = parseStrategyId(body.strategyId);
      const started = this.backtestJob.start(body);
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

  private handleBacktestStatus(
    res: import("node:http").ServerResponse,
    id: string,
  ): void {
    const progress = this.backtestJob.getProgress(id);
    if (!progress) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Run introuvable" }));
      return;
    }
    const result = this.backtestJob.getResult(id);
    const positions = this.repos?.backtestPositions.byRun(id) ?? [];
    const row = this.repos?.backtestRuns.get(id);
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

  private handleBacktestCancel(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    id: string,
  ): void {
    if (!this.isAllowedOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
      return;
    }
    const ok = this.backtestJob.cancel(id);
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
  }

  private readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 64 * 1024) {
          reject(new Error("Request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }
}

function parseJsonUnknown(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function parseBacktestRequest(json: string): {
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