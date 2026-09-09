# Polymarket Reverse Arbitrage Bot

A TypeScript/Node.js bot that executes **B1 true arbitrage** on Polymarket's 15-minute Up/Down markets (BTC, ETH, SOL, etc.). It posts a maker bid on the cheap (underdog) leg and, only after that bid fills, hedges 1:1 on the favorite — and only when `cheapFill + hedgeAsk ≤ PAIR_LOCK_MAX < 1.00`, locking a small profit at resolution.

## Strategy Overview

**Covered pair (binary market):** one side pays $1, the other $0. Holding 1 Up + 1 Down always redeems **$1.00**. Buying both for **≤ `PAIR_LOCK_MAX`** (default 0.98) locks `(1 − pairCost)` per share.

```
┌─────────────────────────────────────────────────────────────────┐
│                    B1 — TRUE ARB                                │
├─────────────────────────────────────────────────────────────────┤
│  Cheap GTC maker: min(ask, CHEAP_BUY_MAX, PAIR_LOCK_MAX − hedge)│
│  Hedge 1:1 only after cheap FILLS, and only if                  │
│    fillPrice + min(favoriteAsk, EXPENSIVE_BUY_MAX)              │
│      ≤ PAIR_LOCK_MAX                                            │
│  Otherwise: hold cheap directional — never lock a pair ≥ $1     │
└─────────────────────────────────────────────────────────────────┘
```

**Example (lock 0.98):**
- Favorite ask **0.85** (inside `EXPENSIVE_BUY_MIN`–`MAX`) → max cheap bid = `0.98 − 0.85 = 0.13`
- Cheap ask 0.16 → sit at **0.13** (do not wait for ask+ask ≤ lock; 15m books usually sum to ~1.01)
- After a **0.13 fill**, hedge 1:1 at 0.85 → pair cost **0.98** → **2¢ locked** per share
- If the cheap fills at **0.20** and the favorite has moved to **0.83** (`0.20+0.83=1.03 > 0.98`) → **no hedge**. Cheap stays directional (badge *partiel*).
- If the favorite asks **above** `EXPENSIVE_BUY_MAX` (e.g. 0.97) with an **uncovered** cheap → FOK **SELL** the uncovered excess (`cheap − hedge`) at the bid (`defendPair`), then cancel any resting GTC hedge. A pair already covered 1:1 is **never** sold, even if the favorite goes to $1.

A GTC hedge is never posted against a *resting* cheap (anti naked-favorite). If a resting cheap is cancelled without a fill, any hedge GTC on that pair is cancelled too.

## Architecture

```
src/
├── index.ts                 # Entry point, wiring + main loop
├── config.ts                # All settings via env vars (validated)
├── bot.ts                   # Orchestrator: scan → books → opportunities → fills → resolve
├── strategy.ts              # Orchestration: pick cheap/favorite, bands, defense predicates
├── strategy/arb-sizing.ts   # B1 source of truth: maker bid, 1:1 hedge, fill-price pair lock
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

## Configuration

Two files, no overlap:

| File | What it holds |
|------|----------------|
| `.env` | Secrets and infra: `DRY_RUN`, keys, hosts, dashboard port, DB paths |
| `data/bot-settings.json` | **All strategy parameters** (bands, lock, budgets, poll, sim). Edited from the dashboard. |

Copy `.env.example` to `.env`. Copy `bot-settings.example.json` to `data/bot-settings.json` (or save once from the dashboard). Live (`DRY_RUN=false`) **refuses to start** without that JSON. Leftover `CHEAP_*` / `EXPENSIVE_*` / `POLL_*` in `.env` are ignored.

```bash
# .env — secrets + infra
DRY_RUN=true                    # true = simulation, false = live trading
PRIVATE_KEY=0x...               # EOA private key (required for live)
FUNDER_ADDRESS=0x...            # Deposit wallet address (for redemption)
READONLY_LIVE=false
SIGNATURE_TYPE=3                # POLY_1271 deposit wallet
AUTO_REDEEM_WINNERS=false

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

# Database
PERSISTENCE_ENABLED=true
DB_PATH=data/bot.db              # dry-run history
DB_PATH_LIVE=data/bot-live.db    # live trading history (separate)

# Dashboard
ENABLE_DASHBOARD=true
DASHBOARD_PORT=3105
```

Strategy keys (dashboard → `data/bot-settings.json`). See `bot-settings.example.json`.

```json
{
  "pollIntervalMs": 5000,
  "marketSlugPrefixes": ["btc-updown-15m", "eth-updown-15m"],
  "cheapBuyMin": 0.07,
  "cheapBuyMax": 0.10,
  "cheapOrderUsdc": 1,
  "pairLockMax": 0.98,
  "enableExpensiveHedge": true,
  "expensiveBuyMin": 0.85,
  "expensiveBuyMax": 0.95,
  "expensiveOrderUsdc": 15,
  "expensiveOrderType": "FOK",
  "maxSharesPerOrder": 20,
  "maxOpenPositionsPerSide": 1,
  "maxExposureUsdc": 45,
  "simRequireCoveredPair": true,
  "simResolveFallback": "none"
}
```

`expensiveOrderUsdc` is a secondary cap on the 1:1 hedge. Below 5 shares at the hedge price there is no hedge. A $1 cheap at 0.07 needs ~14 USDC to cover 1:1 at 0.95.

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
positions          → SimulatedPosition rows (open/won/lost/sold)
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
6. **Pair lock (B1)** — new cheap GTC: `limit + min(favoriteAsk, expensiveBuyMax) ≤ PAIR_LOCK_MAX`. Hedge after fill: `fillPrice + min(freshAsk, expensiveBuyMax) ≤ PAIR_LOCK_MAX`. If the lock fails after fill, the cheap is held directional (no Down at a locked loss).
7. **Pair defense** — FOK SELL the **uncovered** cheap (`filled cheap − filled hedge`, ≥ 5 shares) at the bid only if the favorite ask is **above** `EXPENSIVE_BUY_MAX` **and** the pair is not already covered 1:1. A covered pair is held to redeem even if the favorite prints $1. Ask below `EXPENSIVE_BUY_MIN` does not dump the cheap. After a sale, resting GTC hedges of that pair are cancelled.
8. **CLOB fill confirmation** — a CLOB `matched` is not enough: cheap positions open only when the funder holds the tokens (re-checked up to 8 ticks, since the CLOB balance can lag a maker fill); FOK sells are confirmed by token-balance drop (ghost MATCHED / empty `makingAmount` are ignored). A partially filled cheap that must be repriced/cancelled is cancelled **first**, then the filled part is booked — no remainder is left orphaned on the book.
9. **CLOB minimums** — order size floored at 5 shares / $1 notional; tick size never below 0.01
10. **Balance guard** — live orders skipped when cached CLOB collateral < estimated cost; 60s pause after 3 consecutive balance rejections
11. **Stale order cleanup** — cancel GTC orders after windowEnd + 5 min; unacked rows (no `orderId`) pruned at +15 min, tracked orders at +24 h
12. **Window claim** — outcomes stay locked for the window, but an uncommitted claim is dropped if the underdog flips; no claim on a one-sided book

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