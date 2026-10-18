# fav-band — backtest par tranches horaires ET (03–05h, 09–10h, 11–15h) — runner officiel

- Généré : 2026-10-07T07:26:52.342Z — offline, copie VACUUM de `data/bot-live.db`, bot live intact
- Univers : **1296 fenêtres complètes** (critères {"minTicks":801,"maxGapMs":60000,"maxEdgeGapMs":null} → fenêtres 15m ; 5m exclues par minTicks) — période 2026-09-08 → 2026-10-07 (ET)
- Config IDENTIQUE pour tous les runs : bande **[0.70, 0.85]**, minElapsed **200 s**, max null, exit/switch OFF, budget cheapOrderUsdc 15 $ — **seul le gate horaire diffère**
- Tranches : A = 03:00–05:00 (116 fenêtres), B = 09:00–10:00 (53), C = 11:00–15:00 (216)

## Comparaison

| Run | Fenêtres | Trades | W/L | WR | PnL | PnL % | MaxDD | PnL/DD |
|---|---|---|---|---|---|---|---|---|
| **baseline-all-hours** | 1296 | 1275 | 949/326 | 74 % | +$176.13 | 234.84 % | 357.26 | 0.493 |
| **A-03:00-05:00 ET** | 116 | 113 | 86/27 | 76 % | +$50.11 | 66.81 % | 66.83 | 0.75 |
| **B-09:00-10:00 ET** | 53 | 49 | 38/11 | 78 % | +$35.86 | 47.81 % | 48.14 | 0.745 |
| **C-11:00-15:00 ET** | 216 | 213 | 158/55 | 74 % | +$10.73 | 14.31 % | 157.78 | 0.068 |
| **union-ABC** | 385 | 375 | 282/93 | 75 % | +$96.7 | 128.93 % | 141.18 | 0.685 |
| **complement** | 911 | 900 | 667/233 | 74 % | +$79.43 | 105.91 % | 332.45 | 0.239 |

## Lectures

- L'**union A+B+C** couvre 385 fenêtres sur 1296 (375 trades) — PnL +$96.7 (WR 75 %, DD 141.18)
- Le **complément** (tout sauf ces tranches) : 911 fenêtres, PnL +$79.43 (WR 74 %, DD 332.45)
- Baseline toutes heures : 1296 fenêtres, 1275 trades, PnL +$176.13 (WR 74 %)
- L'écart baseline − (union + complément) vient de l'état inter-fenêtres du moteur (pause whipsaw) : les runs restreints ne subissent pas les pertes d'autres tranches.

## PnL et trades par jour ET

| Jour (ET) | Trades base | PnL base | Trades union | PnL union | Trades compl. | PnL compl. |
|---|---|---|---|---|---|---|
| 2026-09-08 | 47 | +$123.1 | 25 | +$34.88 | 22 | +$88.22 |
| 2026-09-09 | 73 | +$105.69 | 22 | $-0.49 | 51 | +$106.18 |
| 2026-09-10 | 82 | $-64.81 | 26 | $-7.61 | 56 | $-57.2 |
| 2026-09-11 | 16 | +$67.44 | 6 | +$32.18 | 10 | +$35.26 |
| 2026-09-12 | 12 | +$27.14 | 1 | +$6.43 | 11 | +$20.71 |
| 2026-09-13 | 73 | $-46.23 | 15 | +$5.67 | 58 | $-51.9 |
| 2026-09-14 | 85 | +$85.24 | 24 | +$44.22 | 61 | +$41.02 |
| 2026-09-15 | 91 | $-207.27 | 23 | $-2.33 | 68 | $-204.94 |
| 2026-09-16 | 90 | +$194.13 | 26 | $-16.67 | 64 | +$210.8 |
| 2026-09-17 | 177 | +$65.36 | 48 | +$52.69 | 129 | +$12.67 |
| 2026-09-18 | 60 | +$46.81 | 27 | +$4.21 | 33 | +$42.6 |
| 2026-09-19 | 12 | +$24.1 | – | – | 12 | +$24.1 |
| 2026-10-01 | 2 | $-12.34 | – | – | 2 | $-12.34 |
| 2026-10-02 | 88 | +$34.17 | 25 | $-4.51 | 63 | +$38.68 |
| 2026-10-03 | 95 | $-61.8 | 28 | $-48.72 | 67 | $-13.08 |
| 2026-10-04 | 89 | $-90.93 | 27 | $-5.02 | 62 | $-85.91 |
| 2026-10-05 | 79 | $-65.9 | 26 | $-33.66 | 53 | $-32.24 |
| 2026-10-06 | 92 | $-89.51 | 25 | +$50.43 | 67 | $-139.94 |
| 2026-10-07 | 12 | +$41.74 | 1 | $-15 | 11 | +$56.74 |

## Caveats

- Gate = **début de fenêtre marché en ET** (America/New_York) — même convention que l'étude des win-streaks (les libellés des questions marché).
- La tranche ne filtre pas le SIZING ni la pause : le moteur garde son état (pause whipsaw) à travers les fenêtres du run restreint.
- `skippedIncomplete: 0` : tous les windows testés sont déjà « complete » (>801 ticks).
- Le jour 10-07 est partielle côté sim paper (journée en cours) ; l'univers backtest s'arrête à la dernière fenêtre snapshotée dans la base.