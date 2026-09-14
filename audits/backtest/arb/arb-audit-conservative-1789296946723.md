# Audit backtest ARB — arb-audit-conservative-1789296946723

## Setup
- Preset: **conservative** (base conservative) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.07–0.18 | Expensive: 0.76–0.85
- Order USDC: cheap 1 / expensive 12 (GTC)
- Capital sim: 50 | max exposure: 25
- Univers: 85 fenêtres BTC 15m **complètes** / 365 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **-8.03** |
| Capital | 50 → 41.97 |
| Windows tested | 85 |
| Covered pairs | 1 |
| Uncovered pairs | 79 |
| Uncovered rate | 98.75% |
| Fills / rejects | 161 / 59 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **80**
- BUY expensive (hedge): **2** (2.5% des cheap fills)
- SELL cheap (Policy A / band defend): **79** (98.8% des cheap fills)

## SELL reasons
```
[
  {
    "reason": "defend",
    "c": 79,
    "sz": 464.22,
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
    "c": 158,
    "sz": 928.44,
    "pnlSum": -16.18
  },
  {
    "kind": "expensive",
    "status": "won",
    "c": 2,
    "sz": 5.89,
    "pnlSum": 1.06
  },
  {
    "kind": "cheap",
    "status": "lost",
    "c": 1,
    "sz": 5.89,
    "pnlSum": -1
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
    "c": 456,
    "sz": 2634.78,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": null,
    "filled": 1,
    "c": 80,
    "sz": 470.11,
    "pnlSum": 0
  },
  {
    "side": "SELL",
    "kind": "cheap",
    "reason": "defend",
    "filled": 1,
    "c": 79,
    "sz": 464.22,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "expensive",
    "reason": null,
    "filled": 1,
    "c": 2,
    "sz": 5.89,
    "pnlSum": 0
  }
]
```

## Policy A / dust / defend hints
```
[
  {
    "reason": "defend",
    "c": 79
  }
]
```

## Worst windows
```
[
  {
    "eventSlug": "btc-updown-15m-1788876900",
    "pnl": 0,
    "trades": 6,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788885000",
    "pnl": 0,
    "trades": 8,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788885900",
    "pnl": 0,
    "trades": 9,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788886800",
    "pnl": 0,
    "trades": 5,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788887700",
    "pnl": 0,
    "trades": 8,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788888600",
    "pnl": 0,
    "trades": 9,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788889500",
    "pnl": 0,
    "trades": 4,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788890400",
    "pnl": 0,
    "trades": 4,
    "fills": 2
  }
]
```

## Best windows
```
[
  {
    "eventSlug": "btc-updown-15m-1789294500",
    "pnl": 0,
    "trades": 3,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789291800",
    "pnl": 0,
    "trades": 9,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789290000",
    "pnl": 0,
    "trades": 7,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789289100",
    "pnl": 0,
    "trades": 3,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789288200",
    "pnl": 0,
    "trades": 8,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789286400",
    "pnl": 0,
    "trades": 4,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789284600",
    "pnl": 0,
    "trades": 3,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789282800",
    "pnl": 0,
    "trades": 7,
    "fills": 2
  }
]
```
