# Audit backtest ARB — arb-audit-conservative-cbmax0.1-1789294445436

## Setup
- Preset: **conservative-cbmax0.1** (base conservative) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.07–0.1 | Expensive: 0.76–0.85
- Order USDC: cheap 1 / expensive 12 (GTC)
- Capital sim: 50 | max exposure: 25
- Univers: 84 fenêtres BTC 15m **complètes** / 362 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **-2.95** |
| Capital | 50 → 47.05 |
| Windows tested | 84 |
| Covered pairs | 0 |
| Uncovered pairs | 9 |
| Uncovered rate | 100% |
| Fills / rejects | 18 / 0 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **9**
- BUY expensive (hedge): **0** (0% des cheap fills)
- SELL cheap (Policy A / band defend): **9** (100% des cheap fills)

## SELL reasons
```
[
  {
    "reason": "defend",
    "c": 9,
    "sz": 85,
    "pnlSum": 0
  }
]
```

## Positions
```
[
  {
    "kind": "cheap",
    "status": "sold",
    "c": 18,
    "sz": 170,
    "pnlSum": -5.9
  }
]
```

## Trade groups
```
[
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": "resting",
    "filled": 0,
    "c": 744,
    "sz": 7440,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": null,
    "filled": 1,
    "c": 9,
    "sz": 85,
    "pnlSum": 0
  },
  {
    "side": "SELL",
    "kind": "cheap",
    "reason": "defend",
    "filled": 1,
    "c": 9,
    "sz": 85,
    "pnlSum": 0
  }
]
```

## Policy A / dust / defend hints
```
[
  {
    "reason": "defend",
    "c": 9
  }
]
```

## Worst windows
```
[
  {
    "eventSlug": "btc-updown-15m-1788876900",
    "pnl": 0,
    "trades": 5,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788885000",
    "pnl": 0,
    "trades": 5,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788885900",
    "pnl": 0,
    "trades": 7,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788886800",
    "pnl": 0,
    "trades": 19,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788887700",
    "pnl": 0,
    "trades": 9,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788888600",
    "pnl": 0,
    "trades": 18,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788889500",
    "pnl": 0,
    "trades": 13,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788890400",
    "pnl": 0,
    "trades": 2,
    "fills": 0
  }
]
```

## Best windows
```
[
  {
    "eventSlug": "btc-updown-15m-1789291800",
    "pnl": 0,
    "trades": 8,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789290000",
    "pnl": 0,
    "trades": 15,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789289100",
    "pnl": 0,
    "trades": 13,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789288200",
    "pnl": 0,
    "trades": 4,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789286400",
    "pnl": 0,
    "trades": 7,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789284600",
    "pnl": 0,
    "trades": 4,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789282800",
    "pnl": 0,
    "trades": 3,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789281000",
    "pnl": 0,
    "trades": 4,
    "fills": 0
  }
]
```
