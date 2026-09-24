import type { Database } from "./database.js";
import {
  BalanceSnapshotRepository,
  BookSnapshotRepository,
  BotStateRepository,
  EventRepository,
  KeyRepository,
  LedgerRepository,
  MarketResolutionRepository,
  MarketRuleRepository,
  MarketSnapshotRepository,
  OpportunitySnapshotRepository,
  OrderRepository,
  PairRepository,
  PositionRepository,
  PostedOrderRepository,
  RedeemRepository,
  RetryRepository,
  WithdrawalRepository,
  StatsSnapshotRepository,
  WindowClaimRepository,
  BacktestPositionRepository,
  BacktestRunRepository,
  BacktestTradeRepository,
  SimKeyRepository,
  SimPairRepository,
  SimPositionRepository,
  SimPostedOrderRepository,
  SimRetryRepository,
  SimStateRepository,
  SimTradeRepository,
  SimWindowClaimRepository,
} from "./repositories.js";
import { StrategyGraphRepository } from "./strategy-graph-repo.js";

export interface Repositories {
  db: Database;
  positions: PositionRepository;
  pairs: PairRepository;
  ledger: LedgerRepository;
  balanceSnapshots: BalanceSnapshotRepository;
  events: EventRepository;
  keys: KeyRepository;
  retries: RetryRepository;
  postedOrders: PostedOrderRepository;
  windowClaims: WindowClaimRepository;
  botState: BotStateRepository;
  orders: OrderRepository;
  redeems: RedeemRepository;
  withdrawals: WithdrawalRepository;
  statsSnapshots: StatsSnapshotRepository;
  marketSnapshots: MarketSnapshotRepository;
  bookSnapshots: BookSnapshotRepository;
  opportunitySnapshots: OpportunitySnapshotRepository;
  marketResolutions: MarketResolutionRepository;
  marketRules: MarketRuleRepository;
  backtestRuns: BacktestRunRepository;
  backtestTrades: BacktestTradeRepository;
  backtestPositions: BacktestPositionRepository;
  strategyGraphs: StrategyGraphRepository;
  simPositions: SimPositionRepository;
  simPairs: SimPairRepository;
  simTrades: SimTradeRepository;
  simState: SimStateRepository;
  simPostedOrders: SimPostedOrderRepository;
  simKeys: SimKeyRepository;
  simRetries: SimRetryRepository;
  simWindowClaims: SimWindowClaimRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    db,
    positions: new PositionRepository(db),
    pairs: new PairRepository(db),
    ledger: new LedgerRepository(db),
    balanceSnapshots: new BalanceSnapshotRepository(db),
    events: new EventRepository(db),
    keys: new KeyRepository(db),
    retries: new RetryRepository(db),
    postedOrders: new PostedOrderRepository(db),
    windowClaims: new WindowClaimRepository(db),
    botState: new BotStateRepository(db),
    orders: new OrderRepository(db),
    redeems: new RedeemRepository(db),
    withdrawals: new WithdrawalRepository(db),
    statsSnapshots: new StatsSnapshotRepository(db),
    marketSnapshots: new MarketSnapshotRepository(db),
    bookSnapshots: new BookSnapshotRepository(db),
    opportunitySnapshots: new OpportunitySnapshotRepository(db),
    marketResolutions: new MarketResolutionRepository(db),
    marketRules: new MarketRuleRepository(db),
    backtestRuns: new BacktestRunRepository(db),
    backtestTrades: new BacktestTradeRepository(db),
    backtestPositions: new BacktestPositionRepository(db),
    strategyGraphs: new StrategyGraphRepository(db),
    simPositions: new SimPositionRepository(db),
    simPairs: new SimPairRepository(db),
    simTrades: new SimTradeRepository(db),
    simState: new SimStateRepository(db),
    simPostedOrders: new SimPostedOrderRepository(db),
    simKeys: new SimKeyRepository(db),
    simRetries: new SimRetryRepository(db),
    simWindowClaims: new SimWindowClaimRepository(db),
  };
}
