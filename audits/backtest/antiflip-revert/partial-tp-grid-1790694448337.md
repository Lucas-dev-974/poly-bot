# Antiflip 15m — partial TP vs hold

Generated: 2026-09-29T15:07:28.337Z (box/local)
Universe: 730 complete BTC 15m windows (book_snapshots, ≥801 ticks, maxGap≤60s, resolved).
Entries: antiflip-revert preset — minElapsed 240s, flip lookback 90s, deposed ask [0.35, 0.45] floor 0.4, fav [0.45, 0.65], spread≤0.05, $15/order max 30 shares.
Fills: 431 (IS 215 / OOS 216). Split-half boundary: 2026-09-14T20:30:00.000Z.

## Full sample

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 431 | 0 (0%) | n/a | 46.4% | 46.4% | +416.97 | +0.97 | 1.000× |
| partial50 +0.08 | 431 | 350 (81.2%) | 100.0% | 46.4% | 46.4% | +261.80 | +0.61 | 0.628× |
| partial50 x1.20 | 431 | 346 (80.3%) | 100.0% | 46.4% | 46.4% | +283.85 | +0.66 | 0.681× |
| fullTP +0.08 | 431 | 350 (81.2%) | 100.0% | 0.0% | 81.2% | +106.62 | +0.25 | 0.255× |
| fullTP x1.20 | 431 | 346 (80.3%) | 100.0% | 0.0% | 80.3% | +150.72 | +0.35 | 0.362× |

## IS (older half)

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 215 | 0 (0%) | n/a | 52.1% | 52.1% | +572.70 | +2.66 | 1.000× |
| partial50 +0.08 | 215 | 173 (80.5%) | 100.0% | 52.1% | 52.1% | +312.68 | +1.45 | 0.546× |
| partial50 x1.20 | 215 | 171 (79.5%) | 100.0% | 52.1% | 52.1% | +330.82 | +1.54 | 0.578× |
| fullTP +0.08 | 215 | 173 (80.5%) | 100.0% | 0.0% | 80.5% | +52.65 | +0.24 | 0.092× |
| fullTP x1.20 | 215 | 171 (79.5%) | 100.0% | 0.0% | 79.5% | +88.95 | +0.41 | 0.155× |

## OOS (newer half)

| Variant | n | TP hits | Sold WR | Residual WR | Blended WR | Total PnL | EV/trade | vs hold |
|---|---|---|---|---|---|---|---|---|
| hold (baseline) | 216 | 0 (0%) | n/a | 40.7% | 40.7% | -155.73 | -0.72 | 1.000× |
| partial50 +0.08 | 216 | 177 (81.9%) | 100.0% | 40.7% | 40.7% | -50.88 | -0.24 | 0.327× |
| partial50 x1.20 | 216 | 175 (81%) | 100.0% | 40.7% | 40.7% | -46.98 | -0.22 | 0.301× |
| fullTP +0.08 | 216 | 177 (81.9%) | 100.0% | 0.0% | 81.9% | +53.97 | +0.25 | -0.347× |
| fullTP x1.20 | 216 | 175 (81%) | 100.0% | 0.0% | 81.0% | +61.77 | +0.29 | -0.397× |

## Gates (success criteria)

- Blended WR ≥ 50% on best partial: **NO** (best partial blended WR = 46.4%)
- EV ≥ ~0.7× hold: **NO** (best partial vs hold = 0.681×)

## Recommendation

**hold only — hold EV +0.97 ≥ best partial +0.66 (partial50 x1.20); criteria WR≥50%=false, EV≥0.7×hold=false**

## Notes

- Sold WR = fraction of TP-hit legs with sold PnL > 0 (should be ~100% when TP is above entry and fill at bid ≥ target).
- Residual WR = win rate of residual size held to resolution (among trades with residual > 0).
- Blended WR = fraction of trades with total PnL > 0 (sold leg + residual).
- Full TP variants are EV contrast only (not the shipping question).
- No live settings changed; DB opened read-only; no push/remote.
