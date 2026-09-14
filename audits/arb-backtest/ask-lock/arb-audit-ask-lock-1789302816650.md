# Audit backtest ARB — arb-audit-ask-lock-1789302816650

## Setup
- Preset: **ask-lock** (base ask-lock) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.01–0.49 | Expensive: 0.5–0.99
- Order USDC: cheap 1 / expensive 12 (FOK)
- Capital sim: 50 | max exposure: 25
- Univers: 88 fenêtres BTC 15m **complètes** / 372 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **0.23** |
| Capital | 50 → 50.23 |
| Windows tested | 88 |
| Covered pairs | 3 |
| Uncovered pairs | 0 |
| Uncovered rate | 0% |
| Fills / rejects | 6 / 3 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **3**
- BUY expensive (hedge): **3** (100% des cheap fills)
- SELL cheap (Policy A / band defend): **0** (0% des cheap fills)

## SELL reasons
```
[]
```

## Positions
```
[
  {
    "kind": "cheap",
    "status": "lost",
    "c": 2,
    "sz": 14.76,
    "pnlSum": -1.96
  },
  {
    "kind": "expensive",
    "status": "won",
    "c": 2,
    "sz": 14.76,
    "pnlSum": 2.11
  },
  {
    "kind": "cheap",
    "status": "won",
    "c": 1,
    "sz": 7.9,
    "pnlSum": 7.03
  },
  {
    "kind": "expensive",
    "status": "lost",
    "c": 1,
    "sz": 7.9,
    "pnlSum": -6.95
  }
]
```

## Trade groups
```
[
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": null,
    "filled": 1,
    "c": 3,
    "sz": 22.66,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "expensive",
    "reason": null,
    "filled": 1,
    "c": 3,
    "sz": 22.66,
    "pnlSum": 0
  }
]
```

## Policy A / dust / defend hints
```
[]
```

## Worst windows
```
[
  {
    "eventSlug": "btc-updown-15m-1789090200",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789094700",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789098300",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  }
]
```

## Best windows
```
[
  {
    "eventSlug": "btc-updown-15m-1789098300",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789094700",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789090200",
    "pnl": 0,
    "trades": 2,
    "fills": 2
  }
]
```
