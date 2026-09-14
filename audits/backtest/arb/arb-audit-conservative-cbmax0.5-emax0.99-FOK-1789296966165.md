# Audit backtest ARB — arb-audit-conservative-cbmax0.5-emax0.99-FOK-1789296966165

## Setup
- Preset: **conservative-cbmax0.5-emax0.99-FOK** (base conservative) / strategyId=arb
- Pair lock: **0.99**
- Cheap band: 0.07–0.5 | Expensive: 0.76–0.99
- Order USDC: cheap 1 / expensive 12 (FOK)
- Capital sim: 50 | max exposure: 25
- Univers: 85 fenêtres BTC 15m **complètes** / 365 listées

## Headline
| Metric | Value |
|--------|------:|
| PnL | **0** |
| Capital | 50 → 50 |
| Windows tested | 85 |
| Covered pairs | 0 |
| Uncovered pairs | 0 |
| Uncovered rate | n/a% |
| Fills / rejects | 0 / 0 |
| Unresolved windows | 0 |

## Flux (fills)
- BUY cheap: **0**
- BUY expensive (hedge): **0** (null% des cheap fills)
- SELL cheap (Policy A / band defend): **0** (null% des cheap fills)

## SELL reasons
```
[]
```

## Positions
```
[]
```

## Trade groups
```
[]
```

## Policy A / dust / defend hints
```
[]
```

## Worst windows
```
[]
```

## Best windows
```
[]
```
