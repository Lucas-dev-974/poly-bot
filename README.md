# Polymarket Reverse Arbitrage Bot

A TypeScript/Node.js bot that executes **reverse arbitrage** on Polymarket's 15-minute Up/Down markets (BTC, ETH, SOL, etc.). The strategy identifies mispriced outcome pairs where buying both sides (YES + NO) costs less than $1, locking in risk-free profit when the market resolves.

## Strategy Overview

**Reverse Arbitrage** on binary (Up/Down) markets:

```
┌─────────────────────────────────────────────────────────────────┐
│                    MARKET MECHANICS                             │
├─────────────────────────────────────────────────────────────────┤
│  • Each 15-min window: one outcome pays $1, the other $0       │
│  • Normal arb: buy both at prices summing to < $1              │
│  • This bot: targets the CHEAP leg (reversal) + hedges the     │
│    EXPENSIVE leg (favorite) to create a covered pair           │
└─────────────────────────────────────────────────────────────────┘
```

**Example:**
- BTC Up/Down market, 5 min left
- Down token (cheap): best ask = $0.08 → buy for $0.08 (if wins: +$0.92)
- Up token (favorite): best ask = $0.87 (must already sit in `EXPENSIVE_BUY_MIN`–`MAX`) → hedge at $0.87 (`min(ask, EXPENSIVE_BUY_MAX)`), size 1:1 with cheap
- **Pair cost = $0.95 < $1.00** → **5¢ locked profit per $1 notional**
- If the favorite asks **above** `EXPENSIVE_BUY_MAX` (e.g. 0.97), **no new cheap** is posted — a limit hedge far below the ask is not a cover.

## Architecture

```
src/
├── index.ts                 # Entry point, wiring + main loop
├── config.ts                # All settings via env vars (validated)
├── bot.ts                   # Orchestrator: scan → books → opportunities → fills → resolve
├── strategy.ts              # Core arb logic: pick cheap/favorite, price levels, pair validation
├── trader.ts                # Live trading via @polymarket/clob-client-v2 (Polygon, CLOB)
├── trade-tracker.ts         # Position/pair state, window claims, posted orders, retry logic
├── position-resolver.ts     # Settlement detection via Gamma API (outcomePrices >= 0.99)
├── market-scanner.ts        # Finds active 15m Up/Down events from Gamma API
├── relayer.ts               # Deposit-wallet (V2) redemption via Polymarket relayer
├── simulated-broker.ts      # Simulation fill model (marketable + probabilistic)
├── simulated-ledger.ts      # Simulated cash balance with SQLite persistence
├── dashboard/
│   ├── server.ts            # HTTP + SSE dashboard (port 3105)
│   ├── events.ts            # Event bus (ring buffer + SQLite persistence)
│   └── balance.ts           # Portfolio tracking (collateral + positions)
├── db/
│   ├── database.ts          # SQLite schema + migrations (WAL mode)
│   ├── repositories.ts      # Type-safe repositories for all tables
│   └── index.ts             # Repository factory
├── types.ts                 # All shared interfaces
├── logger.ts                # Structured logging + event bus emission
└── utils/
    ├── market.ts            # Slug parsing, tick sizes, book helpers
    ├── prices.ts            # Price level generation, size computation
    └── random.ts            # Seeded xorshift32 RNG (deterministic sim)
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Dual mode** | `DRY_RUN=true` (simulation) / `DRY_RUN=false` (live CLOB orders) |
| **Persistence** | SQLite (WAL) for positions, pairs, ledger, order history, window claims |
| **Dashboard** | Real-time SSE dashboard at `http://localhost:3105` |
| **Redemption** | V2 deposit-wallet (POLY_1271) on-chain redeem via relayer |
| **Safety guards** | Exposure caps, max open per side, covered-pair requirement, depth checks |
| **Deterministic sim** | Seeded RNG for reproducible backtests |

## Configuration (Environment Variables)

Copy `.env.example` to `.env` and configure:

```bash
# Core
DRY_RUN=true                    # true = simulation, false = live trading
PRIVATE_KEY=0x...               # EOA private key (required for live)
FUNDER_ADDRESS=0x...            # Deposit wallet address (for redemption)

# Polymarket API
GAMMA_API_HOST=https://gamma-api.polymarket.com
CLOB_HOST=https://clob.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com
RELAYER_HOST=https://relayer-v2.polymarket.com
CHAIN_ID=137

# CLOB credentials (for live trading)
CLOB_API_KEY=...
CLOB_SECRET=...
CLOB_PASSPHRASE=...

# Builder credentials (for redemption via relayer)
BUILDER_API_KEY=...
BUILDER_SECRET=...
BUILDER_PASSPHRASE=...

# Strategy parameters
CHEAP_BUY_MIN=0.07              # Do not buy cheap if ask is already below this
CHEAP_BUY_MAX=0.25              # Cheap limit must stay in this band
CHEAP_ORDER_USDC=1              # USDC per cheap order
PAIR_LOCK_MAX=0.98              # Verrou profit : cheap + hedge ≤ cette valeur (< 1.00)
ENABLE_EXPENSIVE_HEDGE=true
EXPENSIVE_BUY_MIN=0.85          # Min price for expensive leg (must be favorite)
EXPENSIVE_BUY_MAX=0.95          # Max price for expensive leg
EXPENSIVE_ORDER_USDC=3          # Plafond secondaire du hedge (le dimensionnement principal est 1:1 avec le cheap rempli)
EXPENSIVE_ORDER_TYPE=FOK        # FOK or GTC — both price at min(bestAsk, max)
MAX_SHARES_PER_ORDER=20
MAX_OPEN_POSITIONS_PER_SIDE=1
MAX_EXPOSURE_USDC=45
POLL_INTERVAL_MS=2000
READONLY_LIVE=false
SIGNATURE_TYPE=3                # POLY_1271 deposit wallet
AUTO_REDEEM_WINNERS=false
MIN_MINUTES_BEFORE_CLOSE_TO_BUY=
SIM_MAX_RETRY_ATTEMPTS=20
SIM_REQUIRE_COVERED_PAIR=true   # skip new cheap unless favorite ask is in the hedge band

# Simulation
SIM_FILL_PROBABILITY_NON_MARKETABLE=0.3
SIM_RESOLVE_DELAY_SECONDS=5
SIM_RESOLVE_MAX_RETRIES=5
SIM_RESOLVE_RETRY_INTERVAL_MS=5000
SIM_RESOLVE_FALLBACK=none           # "none" required in live ; "probabilistic" dry-run only
SIM_RANDOM_SEED=                # empty = random

# Market filtering
MARKET_SLUG_PREFIXES=btc-updown-15m,eth-updown-15m
MINUTES_BEFORE_CLOSE_MIN=0
MINUTES_BEFORE_CLOSE_MAX=15

# Database
PERSISTENCE_ENABLED=true
DB_PATH=data/bot.db              # dry-run history
DB_PATH_LIVE=data/bot-live.db    # live trading history (separate)

# Dashboard
ENABLE_DASHBOARD=true
DASHBOARD_PORT=3105
```

## Installation & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run (dry-run by default)
npm start

# Or with tsx watch (auto-restart on change)
npm run dev
```

## Dashboard

Open `http://localhost:3105` for real-time monitoring:
- Live positions & PnL
- Active opportunities
- Balance & collateral
- Event log (SSE stream)
- Manual redemption trigger

The dashboard is a **SolidJS + Vite** frontend in `frontend/`:

```bash
# Dev mode — backend (tsx watch, :3105) + frontend (Vite, :5173) ensemble
npm run dev:all

# Dev mode séparé (Vite dev server on :5173, proxies API/SSE to backend on :3105)
cd frontend && npm install && npm run dev

# Production build (outputs to dist/dashboard/public/, served by the backend)
npm run build:dashboard

# Full build (backend + dashboard)
npm run build:all
```

The backend serves the built assets from `dist/dashboard/public/`. Run `npm run build:dashboard` before `npm start` if you want the compiled UI (Vite writes there). In dev, `npm run dev:all` uses the Vite proxy on :5173.

A GTC order posted without a CLOB `orderID` cannot be cancelled on the exchange (tracker-only cleanup).

## Database Schema (SQLite)

```
positions          → SimulatedPosition rows (open/won/lost)
arb_pairs          → Pair state (open/partial/covered/resolved)
ledger             → Single-row simulated cash balance
balance_snapshots  → Periodic portfolio snapshots
events             → Persisted bot events (opened/resolved/orders/stats)
trade_keys         → Deduplication keys for idempotency
retry_counts       → Order retry tracking
posted_orders      → Live GTC orders awaiting fill
window_claims      → Claimed cheap/expensive outcomes per 15m window
stats_snapshots    → Periodic stats (1/min, prune 30 j)
orders             → Order history (GTC/FOK/SIM)
redeems            → Relayer redeem attempts
bot_state          → Key-value runtime state
```

## Safety & Risk Controls

1. **Exposure cap** (`MAX_EXPOSURE_USDC`) — total open + resting cost never exceeds limit
2. **Per-side limit** (`MAX_OPEN_POSITIONS_PER_SIDE`) — max 1 order per outcome (configurable)
3. **Favorite already in band** — no new cheap unless the favorite ask is in `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]` (a hedge limit far below a 0.97 ask is not a cover)
4. **Covered-pair** (`SIM_REQUIRE_COVERED_PAIR`) — skip new cheap if no hedgeable favorite
5. **Favorite pick depth** — identifying the favorite only needs CLOB-min size (5 shares) at the touch; GTC hedges are not blocked by a thin top of book
6. **Pair cost (B)** — each cheap GTC level must satisfy `limit + min(favoriteAsk, expensiveBuyMax) < $1`; FOK hedge fires only after that cheap fills
7. **CLOB minimums** — order size floored at 5 shares / $1 notional; tick size never below 0.01
8. **Balance guard** — live orders skipped when cached CLOB collateral < estimated cost; 60s pause after 3 consecutive balance rejections
9. **Stale order cleanup** — cancel GTC orders after windowEnd + 5 min; unacked rows (no `orderId`) pruned at +15 min, tracked orders at +24 h
10. **Window claim** — outcomes stay locked for the window, but an uncommitted claim is dropped if the underdog flips; no claim on a one-sided book

## Redemption (V2 Deposit Wallet)

For resolved positions, the bot can redeem via Polymarket's relayer:
- Requires `BUILDER_API_KEY`, `BUILDER_SECRET`, `BUILDER_PASSPHRASE`
- Uses `FUNDER_ADDRESS` (deposit wallet holding the tokens)
- Submits batch: `setApprovalForAll` (if needed) + `redeemPositions`
- Polls relayer until `STATE_MINED`

`READONLY_LIVE` mode does not require `PRIVATE_KEY` (no trading client is created); it only needs `FUNDER_ADDRESS` for balance display.

```bash
# Trigger via dashboard or API
POST /api/redeem { "conditionId": "...", "outcomeIndex": 0, "negRisk": false }
```

## Testing

```bash
# Type check
npm run build

# Unit tests (node:test)
npm test

# Run simulation (dry-run)
DRY_RUN=true npm start
```

## Project Structure Rationale

- **Backend-side grouping**: All data transformation (pairing, enrichment, stats) happens in `bot.ts`/`strategy.ts`/`trade-tracker.ts` — the dashboard is a thin viewer
- **Window claims**: Outcomes stay locked for the window to avoid flip-flopping, unless nothing is committed and the underdog flips (claim is cleared and re-picked)
- **Posted order tracking**: Live GTC orders tracked separately from filled positions (they're "resting" exposure)
- **Deterministic simulation**: Seeded RNG enables reproducible backtests with identical seeds

## License

MIT