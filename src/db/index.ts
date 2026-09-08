import type { Database } from "./database.js";
import {
  BalanceSnapshotRepository,
  BookSnapshotRepository,
  BotStateRepository,
  EventRepository,
  KeyRepository,
  LedgerRepository,
  MarketSnapshotRepository,
  OpportunitySnapshotRepository,
  OrderRepository,
  PairRepository,
  PositionRepository,
  PostedOrderRepository,
  RedeemRepository,
  RetryRepository,
  StatsSnapshotRepository,
  WindowClaimRepository,
} from "./repositories.js";

export interface Repositories {
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
  statsSnapshots: StatsSnapshotRepository;
  marketSnapshots: MarketSnapshotRepository;
  bookSnapshots: BookSnapshotRepository;
  opportunitySnapshots: OpportunitySnapshotRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
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
    statsSnapshots: new StatsSnapshotRepository(db),
    marketSnapshots: new MarketSnapshotRepository(db),
    bookSnapshots: new BookSnapshotRepository(db),
    opportunitySnapshots: new OpportunitySnapshotRepository(db),
  };
}
