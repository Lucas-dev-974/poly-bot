# Audit backtest ARB — arb-audit-conservative-cbmax0.12-emax0.92-FOK-1789294563600

## Setup
- Preset: **conservative-cbmax0.12-emax0.92-FOK** (base conservative) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.07–0.12 | Expensive: 0.76–0.92
- Order USDC: cheap 1 / expensive 12 (FOK)
- Capital sim: 50 | max exposure: 25
- Univers: 84 fenêtres BTC 15m **complètes** / 363 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **-12.27** |
| Capital | 50 → 37.73 |
| Windows tested | 84 |
| Covered pairs | 1 |
| Uncovered pairs | 76 |
| Uncovered rate | 98.7% |
| Fills / rejects | 154 / 58 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **77**
- BUY expensive (hedge): **1** (1.3% des cheap fills)
- SELL cheap (Policy A / band defend): **76** (98.7% des cheap fills)

## SELL reasons
```
[
  {
    "reason": "defend",
    "c": 76,
    "sz": 703.75,
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
    "c": 152,
    "sz": 1407.5,
    "pnlSum": -24.72
  },
  {
    "kind": "cheap",
    "status": "lost",
    "c": 1,
    "sz": 9.1,
    "pnlSum": -1
  },
  {
    "kind": "expensive",
    "status": "won",
    "c": 1,
    "sz": 9.1,
    "pnlSum": 1.09
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
    "c": 618,
    "sz": 5659.14,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": null,
    "filled": 1,
    "c": 77,
    "sz": 712.85,
    "pnlSum": 0
  },
  {
    "side": "SELL",
    "kind": "cheap",
    "reason": "defend",
    "filled": 1,
    "c": 76,
    "sz": 703.75,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "expensive",
    "reason": null,
    "filled": 1,
    "c": 1,
    "sz": 9.1,
    "pnlSum": 0
  }
]
```

## Policy A / dust / defend hints
```
[
  {
    "reason": "defend",
    "c": 76
  }
]
```

## Worst windows
```
[
  {
    "eventSlug": "btc-updown-15m-1788876900",
    "pnl": 0,
    "trades": 11,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788885000",
    "pnl": 0,
    "trades": 6,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788885900",
    "pnl": 0,
    "trades": 8,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788886800",
    "pnl": 0,
    "trades": 15,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788887700",
    "pnl": 0,
    "trades": 12,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1788888600",
    "pnl": 0,
    "trades": 15,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788889500",
    "pnl": 0,
    "trades": 15,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1788890400",
    "pnl": 0,
    "trades": 5,
    "fills": 2
  }
]
```

## Best windows
```
[
  {
    "eventSlug": "btc-updown-15m-1789291800",
    "pnl": 0,
    "trades": 12,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789290000",
    "pnl": 0,
    "trades": 6,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789289100",
    "pnl": 0,
    "trades": 22,
    "fills": 0
  },
  {
    "eventSlug": "btc-updown-15m-1789288200",
    "pnl": 0,
    "trades": 6,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789286400",
    "pnl": 0,
    "trades": 5,
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
    "trades": 8,
    "fills": 2
  },
  {
    "eventSlug": "btc-updown-15m-1789281000",
    "pnl": 0,
    "trades": 3,
    "fills": 2
  }
]
```
