import { createServer } from "node:http";
import { type BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import {
  handleSimConfigPatch,
  handleSimControl,
  handleSimPositions,
  handleSimResolvedPaged,
  handleSimReset,
  handleSimResting,
  handleSimState,
  handleSimTrades,
  handleSimStrategyStatus as handleSimStrategyStatusFn,
  originForbidden,
  simEngineMissing,
} from "./sim-handlers.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import type { ManualBuyResult } from "../types.js";
import { ReverseBot } from "../bot/reverse-bot.js";
import type { EditableConfigKey } from "../runtime-settings.js";
import { BacktestJob } from "../backtest/job.js";
import {
  handleActivateStrategy as handleActivateStrategyGraph,
  handleCreateStrategy as handleCreateStrategyGraph,
  handleDeleteStrategy as handleDeleteStrategyGraph,
  handleEdgeLeadTemplate as handleEdgeLeadTemplateGraph,
  handleGetStrategy as handleGetStrategyGraph,
  handleListStrategies as handleListStrategiesGraph,
  handleUpdateStrategy as handleUpdateStrategyGraph,
  handleValidateStrategy as handleValidateStrategyGraph,
  type StrategyGraphHandlerCtx,
} from "./strategy-graph-handlers.js";
import {
  handleBacktestCancel as handleBacktestCancelFn,
  handleBacktestLowerLows as handleBacktestLowerLowsFn,
  handleBacktestRuns as handleBacktestRunsFn,
  handleBacktestSeries as handleBacktestSeriesFn,
  handleBacktestStart as handleBacktestStartFn,
  handleBacktestStatus as handleBacktestStatusFn,
  handleBacktestWalletTrades as handleBacktestWalletTradesFn,
  handleBacktestWindows as handleBacktestWindowsFn,
  type BacktestHandlerCtx,
} from "./backtest-handlers.js";
import {
  handleMarketRuleAdd as handleMarketRuleAddFn,
  handleMarketRules as handleMarketRulesFn,
  handleMarketRuleToggle as handleMarketRuleToggleFn,
  isValidMarketPrefix,
  MARKET_PREFIX_FORMAT as MARKET_PREFIX_FORMAT_CONST,
  type MarketRulesHandlerCtx,
} from "./market-rules-handlers.js";
import {
  handleRedeem as handleRedeemFn,
  handleWalletWithdraw as handleWalletWithdrawFn,
  handleWalletWithdrawQuote as handleWalletWithdrawQuoteFn,
  handleWalletWithdrawals as handleWalletWithdrawalsFn,
  type WalletHandlerCtx,
} from "./wallet-handlers.js";
import {
  assertCanHotSwapStrategy as assertCanHotSwapStrategyFn,
  handleBotControl as handleBotControlFn,
  handleBotControlState as handleBotControlStateFn,
  handleGetConfig as handleGetConfigFn,
  handleGetConfigPresets as handleGetConfigPresetsFn,
  handlePatchConfig as handlePatchConfigFn,
  handleReset as handleResetFn,
  handleStrategyStatus as handleStrategyStatusFn,
  handleStrategyStatusReset as handleStrategyStatusResetFn,
  type ConfigControlHandlerCtx,
} from "./config-control-handlers.js";
import {
  handleBotFills as handleBotFillsFn,
  handleBookSnapshots as handleBookSnapshotsFn,
  handleMarketHistory as handleMarketHistoryFn,
  handleMarketSnapshots as handleMarketSnapshotsFn,
  handleMarketTrades as handleMarketTradesFn,
  handleStrategyChartSeries as handleStrategyChartSeriesFn,
  handleStrategyChartWindows as handleStrategyChartWindowsFn,
  type MarketDataHandlerCtx,
} from "./market-data-handlers.js";
import {
  handleCloseOpenPosition as handleCloseOpenPositionFn,
  handleManualBuy as handleManualBuyFn,
  handleOpenPositions as handleOpenPositionsFn,
  handleOrders as handleOrdersFn,
  handlePolymarketPositions as handlePolymarketPositionsFn,
  handleResolvedPositions as handleResolvedPositionsFn,
  handleStatsByEngine as handleStatsByEngineFn,
  type PositionsHandlerCtx,
} from "./positions-handlers.js";
import {
  handleDbTables as handleDbTablesFn,
  handleEvents as handleEventsFn,
  handleRelayerQuota as handleRelayerQuotaFn,
  handleState as handleStateFn,
  resolvePublicDir,
  serveHtml as serveHtmlFn,
  serveStatic as serveStaticFn,
} from "./static-handlers.js";
import type { MarketRuleStore } from "../market-rules.js";

const { html: HTML_PATH, dir: PUBLIC_DIR } = resolvePublicDir();

export class DashboardServer {
  private tracker: TradeTracker | null = null;
  private trader: Trader | null = null;
  private resetFn: (() => void) | null = null;
  private configHandler: ((changed: Set<EditableConfigKey>) => void) | null = null;
  private controlHandler: ((enabled: boolean) => void) | null = null;
  private isPausedFn: (() => boolean) | null = null;
  private closePositionFn:
    | ((positionId: string) => Promise<
        | { ok: true; fillPrice: number; soldSize: number; pnl?: number }
        | { ok: false; error: string }
      >)
    | null = null;
  private manualBuyFn:
    | ((
        tokenId: string,
        shares: number,
        mode: "fok" | "resting",
      ) => Promise<ManualBuyResult>)
    | null = null;
  private marketRulesStore: MarketRuleStore | null = null;
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

  /** Store partagé avec le bot (même process) — obligatoire pour /toggle. */
  setMarketRuleStore(store: MarketRuleStore): void {
    this.marketRulesStore = store;
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

  setClosePositionHandler(
    fn: (positionId: string) => Promise<
      | { ok: true; fillPrice: number; soldSize: number; pnl?: number }
      | { ok: false; error: string }
    >,
  ): void {
    this.closePositionFn = fn;
  }

  /** Store a handler for dashboard-initiated manual buys (share count). */
  setManualBuyHandler(
    fn: (
      tokenId: string,
      shares: number,
      mode: "fok" | "resting",
    ) => Promise<ManualBuyResult>,
  ): void {
    this.manualBuyFn = fn;
  }

  /** Store a reference to the bot for strategy status queries. */
  private bot: ReverseBot | null = null;
  setBot(bot: ReverseBot): void {
    this.bot = bot;
  }

  /** Moteur paper trading (simulation live) — optionnel si init a échoué. */
  private simEngine: import("../paper/engine.js").PaperTradingEngine | null = null;
  setSimEngine(engine: import("../paper/engine.js").PaperTradingEngine): void {
    this.simEngine = engine;
  }

  /**
   * Fallback REST pour /api/polymarket-positions — réutilise les positions du
   * dernier poll de BalanceTracker (30 s), sans refetch réseau. Null si le bot
   * tourne sans funderAddress (tracker non instancié) → l'endpoint renverra [].
   */
  private balanceTracker: import("./balance.js").BalanceTracker | null = null;
  setBalanceTracker(
    tracker: import("./balance.js").BalanceTracker | null,
  ): void {
    this.balanceTracker = tracker;
  }

  start(): void {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (
        url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === "/guide" ||
        url.pathname === "/backtest" ||
        url.pathname === "/strategy-editor" ||
        url.pathname === "/donnees" ||
        url.pathname === "/simulation" ||
        url.pathname.startsWith("/simulation/") ||
        url.pathname.startsWith("/donnees/")
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

      if (url.pathname === "/api/db/tables" && req.method === "GET") {
        this.handleDbTables(res);
        return;
      }

      if (url.pathname === "/api/relayer-quota") {
        this.handleRelayerQuota(res);
        return;
      }

      if (url.pathname === "/api/polymarket-positions" && req.method === "GET") {
        this.handlePolymarketPositions(res);
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

      if (url.pathname === "/api/open-positions/close" && req.method === "POST") {
        void this.handleCloseOpenPosition(req, res);
        return;
      }

      if (url.pathname === "/api/manual-buy" && req.method === "POST") {
        void this.handleManualBuy(req, res);
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

      if (url.pathname === "/api/sim/state") {
        if (!this.simEngine) return simEngineMissing(res);
        handleSimState(this.simEngine, res);
        return;
      }

      if (url.pathname === "/api/sim/control" && req.method === "POST") {
        if (!this.isAllowedOrigin(req)) return originForbidden(res);
        if (!this.simEngine) return simEngineMissing(res);
        void handleSimControl(this.simEngine, req, res);
        return;
      }

      if (url.pathname === "/api/sim/config" && req.method === "PATCH") {
        if (!this.isAllowedOrigin(req)) return originForbidden(res);
        if (!this.simEngine) return simEngineMissing(res);
        void handleSimConfigPatch(this.simEngine, req, res);
        return;
      }

      if (url.pathname === "/api/sim/reset" && req.method === "POST") {
        if (!this.isAllowedOrigin(req)) return originForbidden(res);
        if (!this.simEngine) return simEngineMissing(res);
        handleSimReset(this.simEngine, res);
        return;
      }

      if (url.pathname === "/api/sim/positions") {
        if (!this.simEngine) return simEngineMissing(res);
        handleSimPositions(this.simEngine, url, res);
        return;
      }

      if (url.pathname === "/api/sim/resolved") {
        if (!this.simEngine) return simEngineMissing(res);
        handleSimResolvedPaged(this.simEngine, url, res);
        return;
      }

      if (url.pathname === "/api/sim/trades") {
        if (!this.simEngine) return simEngineMissing(res);
        handleSimTrades(this.simEngine, url, res);
        return;
      }

      if (url.pathname === "/api/sim/resting") {
        if (!this.simEngine) return simEngineMissing(res);
        handleSimResting(this.simEngine, url, res);
        return;
      }

      if (url.pathname === "/api/sim/strategy-status" && req.method === "GET") {
        if (!this.simEngine) return simEngineMissing(res);
        this.handleSimStrategyStatus(res);
        return;
      }

      if (url.pathname === "/api/sim/strategy-status/reset" && req.method === "POST") {
        if (!this.isAllowedOrigin(req)) return originForbidden(res);
        if (!this.simEngine) return simEngineMissing(res);
        this.simEngine.resetWhipsawPause();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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

      if (url.pathname === "/api/backtest/lower-lows" && req.method === "GET") {
        this.handleBacktestLowerLows(url, res);
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

      if (url.pathname === "/api/wallet/withdraw/quote" && req.method === "GET") {
        void this.handleWalletWithdrawQuote(res);
        return;
      }

      if (url.pathname === "/api/wallet/withdraw" && req.method === "POST") {
        void this.handleWalletWithdraw(req, res);
        return;
      }

      if (url.pathname === "/api/wallet/withdrawals" && req.method === "GET") {
        this.handleWalletWithdrawals(url, res);
        return;
      }

      if (url.pathname === "/api/stats/by-engine" && req.method === "GET") {
        this.handleStatsByEngine(res);
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

      if (url.pathname === "/api/strategy/status" && req.method === "GET") {
        this.handleStrategyStatus(res);
        return;
      }

      if (url.pathname === "/api/strategy/status/reset" && req.method === "POST") {
        this.handleStrategyStatusReset(req, res);
        return;
      }

      if (url.pathname === "/api/market-rules" && req.method === "GET") {
        this.handleMarketRules(res);
        return;
      }

      if (url.pathname === "/api/market-rules/add" && req.method === "POST") {
        void this.handleMarketRuleAdd(req, res);
        return;
      }

      if (url.pathname === "/api/market-rules/toggle" && req.method === "POST") {
        void this.handleMarketRuleToggle(req, res);
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
    await serveHtmlFn(HTML_PATH, res);
  }

  private async serveStatic(
    pathname: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await serveStaticFn(PUBLIC_DIR, pathname, res);
  }

  private handleEvents(
    res: import("node:http").ServerResponse,
    replay: boolean,
  ): void {
    handleEventsFn(res, replay);
  }

  private handleDbTables(res: import("node:http").ServerResponse): void {
    handleDbTablesFn(this.repos, res);
  }

  private handleState(res: import("node:http").ServerResponse): void {
    handleStateFn(this.config, res);
  }

  private handleRelayerQuota(res: import("node:http").ServerResponse): void {
    handleRelayerQuotaFn(res);
  }

  private handlePolymarketPositions(
    res: import("node:http").ServerResponse,
  ): void {
    handlePolymarketPositionsFn(this.positionsCtx(), res);
  }

  private handleGetConfig(res: import("node:http").ServerResponse): void {
    handleGetConfigFn(this.configControlCtx(), res);
  }

  private handleGetConfigPresets(res: import("node:http").ServerResponse): void {
    handleGetConfigPresetsFn(res);
  }

  /** Block strategyId change while open positions or resting GTCs exist. */
  private assertCanHotSwapStrategy(nextStrategyId: string): void {
    assertCanHotSwapStrategyFn(this.config, this.tracker, nextStrategyId);
  }

  private async handlePatchConfig(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handlePatchConfigFn(this.configControlCtx(), req, res);
  }

  private strategyGraphCtx(): StrategyGraphHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
      assertCanHotSwapStrategy: (id) => this.assertCanHotSwapStrategy(id),
      configHandler: this.configHandler,
    };
  }

  private backtestCtx(): BacktestHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
      backtestJob: this.backtestJob,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
    };
  }

  private walletCtx(): WalletHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
      trader: this.trader,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
    };
  }

  private marketRulesCtx(): MarketRulesHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
      tracker: this.tracker,
      marketRulesStore: this.marketRulesStore,
      configHandler: this.configHandler,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
    };
  }

  private configControlCtx(): ConfigControlHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
      tracker: this.tracker,
      bot: this.bot,
      backtestJob: this.backtestJob,
      configHandler: this.configHandler,
      controlHandler: this.controlHandler,
      isPausedFn: this.isPausedFn,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
      assertCanHotSwapStrategy: (id) => this.assertCanHotSwapStrategy(id),
    };
  }

  private positionsCtx(): PositionsHandlerCtx {
    return {
      repos: this.repos,
      tracker: this.tracker,
      balanceTracker: this.balanceTracker,
      closePositionFn: this.closePositionFn,
      manualBuyFn: this.manualBuyFn,
      isAllowedOrigin: (req) => this.isAllowedOrigin(req),
      readBody: (req) => this.readBody(req),
    };
  }

  private marketDataCtx(): MarketDataHandlerCtx {
    return {
      config: this.config,
      repos: this.repos,
    };
  }

  private handleEdgeLeadTemplate(res: import("node:http").ServerResponse): void {
    handleEdgeLeadTemplateGraph(res);
  }

  private handleListStrategies(res: import("node:http").ServerResponse): void {
    handleListStrategiesGraph(this.strategyGraphCtx(), res);
  }

  private handleGetStrategy(
    res: import("node:http").ServerResponse,
    rawId: string,
  ): void {
    handleGetStrategyGraph(this.strategyGraphCtx(), res, rawId);
  }

  private async handleValidateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleValidateStrategyGraph(this.strategyGraphCtx(), req, res);
  }

  private async handleCreateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleCreateStrategyGraph(this.strategyGraphCtx(), req, res);
  }

  private async handleUpdateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): Promise<void> {
    await handleUpdateStrategyGraph(this.strategyGraphCtx(), req, res, rawId);
  }

  private handleDeleteStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): void {
    handleDeleteStrategyGraph(this.strategyGraphCtx(), req, res, rawId);
  }

  private async handleActivateStrategy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    rawId: string,
  ): Promise<void> {
    await handleActivateStrategyGraph(this.strategyGraphCtx(), req, res, rawId);
  }

  private handleStrategyChartWindows(
    res: import("node:http").ServerResponse,
  ): void {
    handleStrategyChartWindowsFn(this.marketDataCtx(), res);
  }

  private handleStrategyChartSeries(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleStrategyChartSeriesFn(this.marketDataCtx(), url, res);
  }

  private async handleCloseOpenPosition(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleCloseOpenPositionFn(this.positionsCtx(), req, res);
  }

  private async handleManualBuy(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleManualBuyFn(this.positionsCtx(), req, res);
  }

  private handleOpenPositions(res: import("node:http").ServerResponse): void {
    handleOpenPositionsFn(this.positionsCtx(), res);
  }

  private handleResolvedPositions(res: import("node:http").ServerResponse): void {
    handleResolvedPositionsFn(this.positionsCtx(), res);
  }

  private handleOrders(res: import("node:http").ServerResponse): void {
    handleOrdersFn(this.positionsCtx(), res);
  }

  private async handleMarketHistory(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleMarketHistoryFn(this.marketDataCtx(), url, res);
  }

  private async handleMarketTrades(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleMarketTradesFn(this.marketDataCtx(), url, res);
  }

  private async handleBookSnapshots(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleBookSnapshotsFn(this.marketDataCtx(), url, res);
  }

  private handleMarketSnapshots(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleMarketSnapshotsFn(this.marketDataCtx(), url, res);
  }

  private handleBotFills(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleBotFillsFn(this.marketDataCtx(), url, res);
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
    await handleResetFn(this.configControlCtx(), res, req);
  }

  private async handleRedeem(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleRedeemFn(this.walletCtx(), req, res);
  }

  private handleBotControlState(res: import("node:http").ServerResponse): void {
    handleBotControlStateFn(this.configControlCtx(), res);
  }

  private handleStrategyStatus(res: import("node:http").ServerResponse): void {
    handleStrategyStatusFn(this.configControlCtx(), res);
  }

  /** GET /api/sim/strategy-status — statut whipsaw du moteur paper (fav-band). */
  private handleSimStrategyStatus(res: import("node:http").ServerResponse): void {
    handleSimStrategyStatusFn(this.simEngine, res);
  }

  private handleStrategyStatusReset(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    handleStrategyStatusResetFn(this.configControlCtx(), req, res);
  }

  /**
   * Validation du format d'une famille de slugs up/down. Multi-timeframe :
   * la durée vient du préfixe lui-même (15m, 5m, 1h…), le scanner dérive
   * son tag Gamma de la durée et chaque slug porte ses bornes.
   */
  static isValidMarketPrefix(prefix: string): boolean {
    return isValidMarketPrefix(prefix);
  }

  /** Format attendu, affiché dans le message d'erreur de /add. */
  static readonly MARKET_PREFIX_FORMAT = MARKET_PREFIX_FORMAT_CONST;

  /** GET /api/market-rules — règles + univers configuré + suggestions découvertes. */
  private handleMarketRules(res: import("node:http").ServerResponse): void {
    handleMarketRulesFn(this.marketRulesCtx(), res);
  }

  /** POST /api/market-rules/add — ajoute une famille à l'univers scanné. */
  private async handleMarketRuleAdd(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleMarketRuleAddFn(this.marketRulesCtx(), req, res);
  }

  /** POST /api/market-rules/toggle — recording/trading d'une famille. */
  private async handleMarketRuleToggle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleMarketRuleToggleFn(this.marketRulesCtx(), req, res);
  }

  /** GET /api/wallet/withdraw/quote — wallet state for the withdraw dialog. */
  private async handleWalletWithdrawQuote(
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleWalletWithdrawQuoteFn(this.walletCtx(), res);
  }

  /** POST /api/wallet/withdraw — gasless pUSD transfer via the relayer. */
  private async handleWalletWithdraw(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleWalletWithdrawFn(this.walletCtx(), req, res);
  }

  /** GET /api/wallet/withdrawals — manual withdrawal history (newest first). */
  private handleWalletWithdrawals(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleWalletWithdrawalsFn(this.walletCtx(), url, res);
  }

  /** GET /api/stats/by-engine — P&L / wins / losses agrégés par moteur. */
  private handleStatsByEngine(res: import("node:http").ServerResponse): void {
    handleStatsByEngineFn(this.positionsCtx(), res);
  }

  private async handleBotControl(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleBotControlFn(this.configControlCtx(), req, res);
  }

  private handleBacktestWindows(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleBacktestWindowsFn(this.backtestCtx(), url, res);
  }

  private async handleBacktestWalletTrades(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleBacktestWalletTradesFn(this.backtestCtx(), url, res);
  }

  private handleBacktestSeries(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleBacktestSeriesFn(this.backtestCtx(), url, res);
  }

  private async handleBacktestLowerLows(
    url: URL,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleBacktestLowerLowsFn(this.backtestCtx(), url, res);
  }

  private handleBacktestRuns(
    url: URL,
    res: import("node:http").ServerResponse,
  ): void {
    handleBacktestRunsFn(this.backtestCtx(), url, res);
  }

  private async handleBacktestStart(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    await handleBacktestStartFn(this.backtestCtx(), req, res);
  }

  private handleBacktestStatus(
    res: import("node:http").ServerResponse,
    id: string,
  ): void {
    handleBacktestStatusFn(this.backtestCtx(), res, id);
  }

  private handleBacktestCancel(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    id: string,
  ): void {
    handleBacktestCancelFn(this.backtestCtx(), req, res, id);
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
