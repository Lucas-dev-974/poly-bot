# Backtest officiel early-low — preset actuel (hold intégral)

**Overrides preset :** `earlyLowBuyAskMax=0.1`

Exécution : npx tsx scripts/research/early-low/backtest-preset.mts 500 180000

Config = `config/presets/early-low.json` tel que lu au moment du run :

| Métrique | Valeur |
|---|---|
| Fenêtres testées | 2784 (15m, ≥ 500 ticks, gap ≤ 180 s) |
| Fenêtres ignorées | 6170 |
| PnL total | +$12.83 |
| Capital | $500 → $512.83 |
| Fills / rejects | 33 / 0 |
| Wins / losses (fenêtres) | 4 / 29 → WR 12.1 % |
| Fenêtres non résolues | 0 |
| Durée | 463.6 s |

## PnL par jour UTC

| Jour | PnL | Fenêtres tradées | W/L |
|---|---:|---:|---|
| 2026-09-13 | $-1.00 | 1 | 0/1 |
| 2026-09-14 | $-2.00 | 2 | 0/2 |
| 2026-09-18 | $-1.00 | 1 | 0/1 |
| 2026-09-19 | +$11.50 | 1 | 1/0 |
| 2026-09-20 | $-2.00 | 2 | 0/2 |
| 2026-09-21 | $-3.00 | 3 | 0/3 |
| 2026-09-23 | +$9.11 | 2 | 1/1 |
| 2026-09-24 | $-2.00 | 2 | 0/2 |
| 2026-09-25 | $-1.00 | 1 | 0/1 |
| 2026-09-27 | $-3.00 | 3 | 0/3 |
| 2026-09-29 | $-2.00 | 2 | 0/2 |
| 2026-09-30 | $-3.00 | 3 | 0/3 |
| 2026-10-01 | $-2.00 | 2 | 0/2 |
| 2026-10-02 | +$7.11 | 4 | 1/3 |
| 2026-10-03 | +$10.11 | 1 | 1/0 |
| 2026-10-04 | $-1.00 | 1 | 0/1 |
| 2026-10-05 | $-1.00 | 1 | 0/1 |
| 2026-10-07 | $-1.00 | 1 | 0/1 |

> **4/18 jours positifs.**

## Top 5 gains / pertes (fenêtres)

| # | Gains | | Pertes | |
|---|---|---:|---|---:|
| 1 | `eth-updown-15m-1789802100` | +$11.50 | `btc-updown-15m-1791338400` | $-1.00 |
| 2 | `eth-updown-15m-1790179200` | +$10.11 | `btc-updown-15m-1791189900` | $-1.00 |
| 3 | `btc-updown-15m-1790944200` | +$10.11 | `btc-updown-15m-1791151200` | $-1.00 |
| 4 | `btc-updown-15m-1791048600` | +$10.11 | `btc-updown-15m-1790933400` | $-1.00 |
| 5 | `btc-updown-15m-1789336800` | $-1.00 | `btc-updown-15m-1790928900` | $-1.00 |
## Split BTC / ETH (triangulation)

| Segment | Trades | PnL | W/L | Profit factor | PnL 09-29→ | W/L 09-29→ |
|---|---:|---:|---|---:|---:|---|
| BTC seul (univers preset) | 16 | +6.22 | 2/14 | 1.44 | +12.22 | 2/8 |
| ETH seul (hors preset) | 17 | +6.61 | 2/15 | 1.44 | −5.00 | 0/5 |

## Delta vs run band 0.12 (même univers, même jour)

| Métrique | Preset 0.12 | **Band 0.10** | Delta |
|---|---:|---:|---:|
| BTC total 29 j | +$24.63 (39 tr) | **+$6.22 (16 tr)** | **−$18.41** |
| BTC depuis 09-29 | +$1.18 (15 tr) | **+$12.22 (10 tr)** | **+$11.04** |
| BTC PF 29 j | 1.77 | 1.44 | −0.33 |

**Lecture du delta** : le resserrement 0.10 élimine 23 fenêtres BTC dont le PnL cumulé dans le run 0.12 est **+$22.45** (4 gagnants +$8.09 chacun tombés dans [0.10, 0.12), 19 pertes −1$ : ces tickets à bas prix sont nettement plus souvent des gagnants que la moyenne). Sur la période récente (09-29→10-07), le 0.10 fait +$12.22 vs +$1.18 au 0.12 : les fenêtres retirées y étaient surtout perdantes (7 pertes, 0 gagnant BTC récent retiré).

