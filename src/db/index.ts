import type { Database } from "./database.js";
import {
  BalanceSnapshotRepository,
  BookSnapshotRepository,
  BotStateRepository,
  EventRepository,
  KeyRepository,
  LedgerRepository,
  MarketResolutionRepository,
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
  backtestRuns: BacktestRunRepository;
  backtestTrades: BacktestTradeRepository;
  backtestPositions: BacktestPositionRepository;
  strategyGraphs: StrategyGraphRepository;
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
    backtestRuns: new BacktestRunRepository(db),
    backtestTrades: new BacktestTradeRepository(db),
    backtestPositions: new BacktestPositionRepository(db),
    strategyGraphs: new StrategyGraphRepository(db),
  };
}
