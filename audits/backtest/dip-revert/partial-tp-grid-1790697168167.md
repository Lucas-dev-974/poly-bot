# Dip-revert 15m - partial TP vs hold

Generated: 2026-09-29T15:52:48.167Z (box/local)
Universe: 730 complete BTC 15m windows (book_snapshots, >=801 ticks, maxGap<=60s, resolved).
Entries: dip-revert preset - band ask [0.55, 0.65], minDrop 0.03 lookback 60s, rebound (ask>low>=0.001), minElapsed 180s, maxElapsed 420s, spread<=0.04, $15/order max 30 shares, depth guard.
Fills: 456 (IS 228 / OOS 228). Split-half boundary: 2026-09-15T01:15:00.000Z.

## Full sample

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 456 | 0 (0%) | n/a | 63.6% | 63.6% | +452.48 | +0.99 | 1.000x |
| partial50 +0.08 | 456 | 401 (87.9%) | 100.0% | 63.6% | 63.6% | +289.84 | +0.64 | 0.641x |
| partial50 x1.20 | 456 | 383 (84%) | 100.0% | 63.6% | 63.6% | +332.12 | +0.73 | 0.734x |
| fullTP +0.08 | 456 | 401 (87.9%) | 100.0% | 0.0% | 87.9% | +127.21 | +0.28 | 0.281x |
| fullTP x1.20 | 456 | 383 (84%) | 100.0% | 0.0% | 84.0% | +211.76 | +0.46 | 0.468x |

## IS (older half)

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 228 | 0 (0%) | n/a | 65.4% | 65.4% | +321.64 | +1.41 | 1.000x |
| partial50 +0.08 | 228 | 200 (87.7%) | 100.0% | 65.4% | 65.4% | +189.72 | +0.83 | 0.590x |
| partial50 x1.20 | 228 | 191 (83.8%) | 100.0% | 65.4% | 65.4% | +210.05 | +0.92 | 0.653x |
| fullTP +0.08 | 228 | 200 (87.7%) | 100.0% | 0.0% | 87.7% | +57.81 | +0.25 | 0.180x |
| fullTP x1.20 | 228 | 191 (83.8%) | 100.0% | 0.0% | 83.8% | +98.46 | +0.43 | 0.306x |

## OOS (newer half)

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 228 | 0 (0%) | n/a | 61.8% | 61.8% | +130.84 | +0.57 | 1.000x |
| partial50 +0.08 | 228 | 201 (88.2%) | 100.0% | 61.8% | 61.8% | +100.12 | +0.44 | 0.765x |
| partial50 x1.20 | 228 | 192 (84.2%) | 100.0% | 61.8% | 61.8% | +122.07 | +0.54 | 0.932x |
| fullTP +0.08 | 228 | 201 (88.2%) | 100.0% | 0.0% | 88.2% | +69.40 | +0.30 | 0.530x |
| fullTP x1.20 | 228 | 192 (84.2%) | 100.0% | 0.0% | 84.2% | +113.29 | +0.50 | 0.866x |

## Gates (success criteria)

- Blended WR >= 50% on best partial: **YES** (best partial blended WR = 63.6%)
- EV >= ~0.7x hold: **YES** (best partial vs hold = 0.734x)

## Recommendation

**hold preferred but partial OK - "partial50 x1.20" meets WR>=50% and EV>=0.7x hold (0.734x), but does not beat hold EV**

## Notes

- Sold WR = fraction of TP-hit legs with sold PnL > 0 (should be ~100% when TP is above entry and fill at bid >= target).
- Residual WR = win rate of residual size held to resolution (among trades with residual > 0).
- Blended WR = fraction of trades with total PnL > 0 (sold leg + residual).
- Full TP variants are EV contrast only (not the shipping question).
- TP exit priced on HELD token bid only (never current favorite after identity flip).
- No live settings changed; DB opened read-only; no push/remote.
