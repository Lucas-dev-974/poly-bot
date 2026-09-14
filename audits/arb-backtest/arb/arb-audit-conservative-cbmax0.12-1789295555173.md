# Audit backtest ARB — arb-audit-conservative-cbmax0.12-1789295555173

## Setup
- Preset: **conservative-cbmax0.12** (base conservative) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.07–0.12 | Expensive: 0.76–0.85
- Order USDC: cheap 1 / expensive 12 (GTC)
- Capital sim: 50 | max exposure: 25
- Univers: 85 fenêtres BTC 15m **complètes** / 364 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **-5.61** |
| Capital | 50 → 44.39 |
| Windows tested | 85 |
| Covered pairs | 0 |
| Uncovered pairs | 25 |
| Uncovered rate | 100% |
| Fills / rejects | 50 / 0 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **25**
- BUY expensive (hedge): **0** (0% des cheap fills)
- SELL cheap (Policy A / band defend): **25** (100% des cheap fills)

## SELL reasons
```
[
  {
    "reason": "defend",
    "c": 25,
    "sz": 201.82,
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
    "c": 50,
    "sz": 403.64,
    "pnlSum": -11.22
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
    "c": 708,
    "sz": 5904.72,
    "pnlSum": 0
  },
  {
    "side": "BUY",
    "kind": "cheap",
    "reason": null,
    "filled": 1,
    "c": 25,
    "sz": 201.82,
    "pnlSum": 0
  },
  {
    "side": "SELL",
    "kind": "cheap",
    "reason": "defend",
    "filled": 1,
    "c": 25,
    "sz": 201.82,
    "pnlSum": 0
  }
]
```

## Policy A / dust / defend hints
```
[
  {
    "reason": "defend",
    "c": 25
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
    "trades": 21,
    "fills": 2
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
    "eventSlug": "btc-updown-15m-1789294500",
    "pnl": 0,
    "trades": 3,
    "fills": 2
  },
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
  }
]
```
