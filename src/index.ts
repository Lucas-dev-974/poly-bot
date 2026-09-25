import { ReverseBot } from "./bot.js";
import { AutoRedeemer } from "./auto-redeemer.js";
import { loadConfig, validateTradingConfig } from "./config.js";
import { BalanceTracker } from "./dashboard/balance.js";
import { DashboardServer } from "./dashboard/server.js";
import { bus } from "./dashboard/events.js";
import { Database } from "./db/database.js";
import { createRepositories } from "./db/index.js";
import { logError } from "./logger.js";
import { leadsWithEdgeFor } from "./strategy/registry.js";
import { PaperTradingEngine } from "./paper/engine.js";
import { Trader } from "./trader.js";

let db: Database | null = null;
let autoRedeemer: AutoRedeemer | null = null;
let balanceTracker: BalanceTracker | null = null;
let botRef: ReverseBot | null = null;
let paperRef: PaperTradingEngine | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  validateTradingConfig(config);

  db = new Database(config.dbPath, config.persistenceEnabled);
  db.init();
  const repos = createRepositories(db);
  if (config.strategyId.startsWith("custom:")) {
    if (!config.persistenceEnabled) {
      throw new Error(`custom strategy ${config.strategyId} requires persistence`);
    }
    const leadsWithEdge = leadsWithEdgeFor(config.strategyId, repos);
    if (leadsWithEdge === undefined) {
      throw new Error(`custom strategy ${config.strategyId} not found`);
    }
    validateTradingConfig(config, { leadsWithEdge });
  }
  bus.setEventRepository(repos.events);
  bus.setOrderRepository(repos.orders);
  // Seed idempotent : les familles configurées existent dans market_rules
  // (recording=1 / trading=1) — migration sans changement de comportement.
  repos.marketRules.ensureDefaults(config.marketSlugPrefixes);

  const trader = new Trader(config);
  await trader.init();

  if (config.funderAddress) {
    balanceTracker = new BalanceTracker(config, repos);
    balanceTracker.start(() => trader.getAvailableCollateral());
  }

  // Simulation live (paper trading) : moteur isolé, alimenté par les books
  // du bot live. Toujours instancié ; il ne trade que si activé (sim_state).
  let paperEngine: PaperTradingEngine | undefined;
  try {
    paperEngine = new PaperTradingEngine(config, repos);
    paperEngine.init();
    paperEngine.start();
    paperRef = paperEngine;
  } catch (error) {
    logError(error);
    // Ne pas laisser un moteur partiellement initialisé (tracker/ledger
    // undefined si init() a jeté) être exposé au dashboard : un poll
    // /api/sim/* sur ce handle crasherait le process.
    paperEngine = undefined;
  }

  const bot = new ReverseBot(config, trader, repos, paperEngine);
  botRef = bot;

  if (config.enableDashboard) {
    const dashboard = new DashboardServer(config.dashboardPort, config, repos);
    dashboard.start();
    dashboard.setTracker(bot.tracker);
    dashboard.setMarketRuleStore(bot.rules);
    dashboard.setTrader(trader);
    dashboard.setBalanceTracker(balanceTracker);
    if (paperEngine) {
      dashboard.setSimEngine(paperEngine);
    }
    dashboard.setResetHandler(() => {
      db?.reset();
      bot.reset();
      // Réaligne le moteur papier (cash/resting en mémoire) avec les tables
      // sim_* vidées par db.reset().
      paperRef?.reset();
      bus.clear();
    });
    dashboard.setConfigHandler((changed) => bot.onRuntimeSettingsChanged(changed));
    dashboard.setControlHandler(
      (enabled) => bot.setPaused(!enabled),
      () => bot.isPaused(),
    );
    dashboard.setClosePositionHandler((id) => bot.closePositionManual(id));
    dashboard.setManualBuyHandler((tokenId, shares, mode) =>
      bot.manualBuy(tokenId, shares, mode),
    );
    dashboard.setBot(bot);
  }

  autoRedeemer = new AutoRedeemer(config, trader, repos.redeems);
  autoRedeemer.start();

  await bot.init();
  await bot.run();
}

main().catch((error) => {
  logError(error);
  process.exit(1);
});

function shutdown(): void {
  autoRedeemer?.stop();
  balanceTracker?.stop();
  paperRef?.stop();
  void botRef?.stop();
  db?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);