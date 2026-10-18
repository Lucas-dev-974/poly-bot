# Backtest officiel early-low — BTC 15m uniquement

**Overrides preset :** `earlyLowBuyAskMin=0.08, earlyLowBuyAskMax=0.1`

Execution : npx tsx scripts/research/early-low/backtest-btc-band.mts 500 180000 earlyLowBuyAskMin=0.08 earlyLowBuyAskMax=0.10

Univers = fenetres `btc-updown-15m` uniquement (ETH 15m exclu, il ne fait pas partie du preset live).

| Metrique | Valeur |
|---|---|
| fenetres BTC testees | 1986 (15m, >= 500 ticks, gap <= 180 s) |
| fenetres ignorees | 6970 (dont ETH 15m : 800, autres : 6170) |
| PnL total | +$6.22 |
| Capital | $500 -> $506.22 |
| Fills / rejects | 16 / 0 |
| Wins / losses (fenetres) | 2 / 14 -> WR 12.5 % |
| Profit factor | 1.44 |
| PnL depuis 09-29 | +$12.22 (2/8) |
| fenetres non resolues | 0 |
| Duree | 354.9 s |

## PnL par jour UTC

| Jour | PnL | fenetres tradees | W/L |
|---|---:|---:|---|
| 2026-09-13 | $-1.00 | 1 | 0/1 |
| 2026-09-14 | $-2.00 | 2 | 0/2 |
| 2026-09-18 | $-1.00 | 1 | 0/1 |
| 2026-09-24 | $-1.00 | 1 | 0/1 |
| 2026-09-27 | $-1.00 | 1 | 0/1 |
| 2026-09-30 | $-2.00 | 2 | 0/2 |
| 2026-10-02 | +$7.11 | 4 | 1/3 |
| 2026-10-03 | +$10.11 | 1 | 1/0 |
| 2026-10-04 | $-1.00 | 1 | 0/1 |
| 2026-10-05 | $-1.00 | 1 | 0/1 |
| 2026-10-07 | $-1.00 | 1 | 0/1 |

> **2/11 jours positifs.**

## Top 5 gains / pertes (fenetres)

| # | Gains | | Pertes | |
|---|---|---:|---|---:|
| 1 | `btc-updown-15m-1790944200` | +$10.11 | `btc-updown-15m-1791338400` | $-1.00 |
| 2 | `btc-updown-15m-1791048600` | +$10.11 | `btc-updown-15m-1791189900` | $-1.00 |
| 3 | `btc-updown-15m-1789336800` | $-1.00 | `btc-updown-15m-1791151200` | $-1.00 |
| 4 | `btc-updown-15m-1789345800` | $-1.00 | `btc-updown-15m-1790933400` | $-1.00 |
| 5 | `btc-updown-15m-1789419600` | $-1.00 | `btc-updown-15m-1790928900` | $-1.00 |