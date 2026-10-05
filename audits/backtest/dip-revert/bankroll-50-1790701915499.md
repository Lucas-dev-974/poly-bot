# Dip-revert 15m — bankroll backtest ($50 start)

Generated: 2026-09-29T17:11:55.498Z (machine local / ISO)
Universe: 730 complete BTC 15m windows (book_snapshots, >=801 ticks, maxGap<=60s, resolved).
Entry: dip-revert preset hold — band ask [0.55, 0.65], minDrop 0.03 lookback 60s, rebound (ask>low>=0.001), minElapsed 180s, maxElapsed 420s, spread<=0.04, depth guard, one entry/window.
Exit: **hold to resolution** (no partial TP) — best recent paper (partial-tp-grid: WR~63.6%, EV~+0.99).
Signals: 456 chronological 2026-09-08T06:34:03.246Z → 2026-09-19T06:18:00.112Z.
Unconstrained ref (fixed $15, no bankroll): n=456, WR=63.6%, total PnL=+452.48, EV/trade=+0.99.

## Position sizing (documented)

| Mode | Rule | Role |
|---|---|---|
| **capital-capped** | orderUsdc = min(capital, 15); size = min(orderUsdc/ask, 30); require size >= 5 and cost <= capital | **PRIMARY** |
| fixed-15 | Always $15 if capital funds full cost + size>=5, else skip | Sensitivity |
| kelly-lite | orderUsdc = min(15, f* * capital); f*=0.0956 (full sample Kelly from WR=63.6%, avgAsk=0.5975, b=(1-p)/p). Half-Kelly=0.0478 is inert at $50 (below MIN_CLOB). | Sensitivity |

Ruin: after a fill, if capital <= 0 then stop trading. Signals with insufficient capital for min CLOB size are **skipped** (not ruin).

## Primary: capital-capped

### capital-capped (PRIMARY)

| Metric | Value |
|---|---|
| Start capital | $50.00 |
| End capital | $502.48 |
| Total PnL | +452.48 |
| Peak capital | $614.78 |
| Max drawdown | $132.71 (21.6% of peak) |
| Signals seen | 456 |
| Trades taken | 456 |
| Trades skipped (undersized) | 0 |
| Wins / Losses | 290 / 166 |
| Win rate (taken) | 63.6% |
| Ruin | NO |


### Equity curve (primary, truncated)

| # | Entry (UTC) | Slug | Price | Order $ | Won | PnL | Capital after |
|---|---|---|---|---|---|---|---|
| 1 | 2026-09-08T06:34:03.246Z | btc-updown-15m-1788849000 | 0.590 | 15.00 | Y | +10.42 | 60.42 |
| 2 | 2026-09-08T06:48:24.387Z | btc-updown-15m-1788849900 | 0.580 | 15.00 | N | -15.00 | 45.42 |
| 3 | 2026-09-08T07:03:01.612Z | btc-updown-15m-1788850800 | 0.590 | 15.00 | N | -15.00 | 30.42 |
| 4 | 2026-09-08T07:19:07.299Z | btc-updown-15m-1788851700 | 0.580 | 15.00 | Y | +10.86 | 41.29 |
| 5 | 2026-09-08T07:34:33.781Z | btc-updown-15m-1788852600 | 0.590 | 15.00 | N | -15.00 | 26.29 |
| 6 | 2026-09-08T08:34:53.675Z | btc-updown-15m-1788856200 | 0.570 | 15.00 | Y | +11.32 | 37.60 |
| 7 | 2026-09-08T09:18:05.405Z | btc-updown-15m-1788858900 | 0.560 | 15.00 | Y | +11.79 | 49.39 |
| 8 | 2026-09-08T10:51:45.651Z | btc-updown-15m-1788864300 | 0.550 | 15.00 | Y | +12.27 | 61.66 |
| 9 | 2026-09-08T11:18:10.042Z | btc-updown-15m-1788866100 | 0.650 | 15.00 | Y | +8.08 | 69.74 |
| 10 | 2026-09-08T11:33:35.938Z | btc-updown-15m-1788867000 | 0.630 | 15.00 | N | -15.00 | 54.74 |
| 11 | 2026-09-08T11:48:14.269Z | btc-updown-15m-1788867900 | 0.650 | 15.00 | Y | +8.08 | 62.81 |
| 12 | 2026-09-08T12:19:18.998Z | btc-updown-15m-1788869700 | 0.580 | 15.00 | Y | +10.86 | 73.68 |
| … | … | (432 rows omitted) | … | … | … | … | … |
| 445 | 2026-09-18T20:04:57.012Z | btc-updown-15m-1789761600 | 0.590 | 15.00 | Y | +10.42 | 614.78 |
| 446 | 2026-09-18T20:48:23.112Z | btc-updown-15m-1789764300 | 0.580 | 15.00 | N | -15.00 | 599.78 |
| 447 | 2026-09-18T21:33:00.129Z | btc-updown-15m-1789767000 | 0.560 | 15.00 | N | -15.00 | 584.78 |
| 448 | 2026-09-19T03:36:10.579Z | btc-updown-15m-1789788600 | 0.620 | 15.00 | N | -15.00 | 569.78 |
| 449 | 2026-09-19T03:48:21.789Z | btc-updown-15m-1789789500 | 0.580 | 15.00 | N | -15.00 | 554.78 |
| 450 | 2026-09-19T04:03:01.409Z | btc-updown-15m-1789790400 | 0.590 | 15.00 | N | -15.00 | 539.78 |
| 451 | 2026-09-19T04:21:39.515Z | btc-updown-15m-1789791300 | 0.590 | 15.00 | Y | +10.42 | 550.21 |
| 452 | 2026-09-19T04:48:59.786Z | btc-updown-15m-1789793100 | 0.650 | 15.00 | N | -15.00 | 535.21 |
| 453 | 2026-09-19T05:33:00.830Z | btc-updown-15m-1789795800 | 0.550 | 15.00 | Y | +12.27 | 547.48 |
| 454 | 2026-09-19T05:50:00.955Z | btc-updown-15m-1789796700 | 0.550 | 15.00 | N | -15.00 | 532.48 |
| 455 | 2026-09-19T06:03:26.605Z | btc-updown-15m-1789797600 | 0.630 | 15.00 | N | -15.00 | 517.48 |
| 456 | 2026-09-19T06:18:00.112Z | btc-updown-15m-1789798500 | 0.560 | 15.00 | N | -15.00 | 502.48 |


## Sensitivity

### fixed-$15 (skip if underfunded)

| Metric | Value |
|---|---|
| Start capital | $50.00 |
| End capital | $502.48 |
| Total PnL | +452.48 |
| Peak capital | $614.78 |
| Max drawdown | $132.71 (21.6% of peak) |
| Signals seen | 456 |
| Trades taken | 456 |
| Trades skipped (undersized) | 0 |
| Wins / Losses | 290 / 166 |
| Win rate (taken) | 63.6% |
| Ruin | NO |

### kelly-lite (full sample Kelly f*, cap $15)

| Metric | Value |
|---|---|
| Start capital | $50.00 |
| End capital | $374.14 |
| Total PnL | +324.14 |
| Peak capital | $486.45 |
| Max drawdown | $132.71 (27.3% of peak) |
| Signals seen | 456 |
| Trades taken | 456 |
| Trades skipped (undersized) | 0 |
| Wins / Losses | 290 / 166 |
| Win rate (taken) | 63.6% |
| Ruin | NO |
| Kelly frac used | 0.0956 |

### kelly half-Kelly (inert check)

| Metric | Value |
|---|---|
| Start capital | $50.00 |
| End capital | $50.00 |
| Total PnL | +0.00 |
| Peak capital | $50.00 |
| Max drawdown | $0.00 (0% of peak) |
| Signals seen | 456 |
| Trades taken | 0 |
| Trades skipped (undersized) | 456 |
| Wins / Losses | 0 / 0 |
| Win rate (taken) | n/a |
| Ruin | NO |
| Kelly frac used | 0.0478 |


## Interpretation (short)

- Primary path starts at $50 and ends at **$502.48** (PnL +452.48).
- Ruin: **NO**.
- Max DD on primary: **$132.71** (21.6% of peak $614.78).
- Taken vs skipped: **456** taken, **0** skipped.
- With start $50 > order $15, capital-capped matches fixed-$15 unless equity dips below $15 (here min capitalAfter=$26.29).
- Compared to unconstrained fixed-$15 paper (PnL +452.48 on 456 fills), bankroll compounds the same dollar PnL when always sizing at $15.

## Notes

- Fills/PnL path aligned with partial-tp-grid.mts hold variant (same entry guards).
- No live settings changed; DB opened read-only; no push/remote; no real spend.
- Metrics above are computed from this run only — not invented.
