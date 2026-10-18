# fav-band — backtest à gate horaire ET — stabilité split-half — runner officiel

- Généré : 2026-10-07T07:59:22.844Z — offline, copie VACUUM de `data/bot-live.db`, bot live intact
- Univers : **1298 fenêtres complètes** (critères {"minTicks":801,"maxGapMs":60000,"maxEdgeGapMs":null} → fenêtres 15m ; 5m exclues par minTicks) — période 2026-09-08 → 2026-10-07 (ET)
- Config IDENTIQUE pour tous les runs : bande **[0.70, 0.85]**, minElapsed **200 s**, max null, exit/switch OFF, budget 15 $ — **seul le gate horaire (et la période) diffère**
- Split : **H1** = 2026-09-08 → 2026-09-25 (avant la fenêtre d'observation paper), **H2** = 2026-09-26 → 2026-10-07 (= période où les tranches ont été détectées) — **capital simulé 500 $ en mode split** (sinon un run H2-seul peut mourir de capital : spirale "insufficient-capital" qui pollue les métriques)

## Comparaison

| Run | Fenêtres | Trades | W/L | WR | PnL | PnL % | MaxDD | PnL/DD |
|---|---|---|---|---|---|---|---|---|
| **baseline-H1** | 830 | 818 | 622/196 | 76 % | +$420.7 | 84.14 % | 246.83 | 1.704 |
| **union-ABC-H1** | 248 | 243 | 187/56 | 77 % | +$153.18 | 30.64 % | 65.24 | 2.348 |
| **union-AB-H1** | 110 | 108 | 83/25 | 77 % | +$72.7 | 14.54 % | 53.54 | 1.358 |
| **baseline-H2** | 468 | 459 | 329/130 | 72 % | $-237.98 | -47.6 % | 357.26 | -0.666 |
| **union-ABC-H2** | 139 | 134 | 97/37 | 72 % | $-49.89 | -9.98 % | 139.19 | -0.358 |
| **union-AB-H2** | 61 | 56 | 43/13 | 77 % | +$19.86 | 3.97 % | 42.05 | 0.472 |
| **baseline-full** | 1298 | 1277 | 951/326 | 74 % | +$182.72 | 36.54 % | 357.26 | 0.511 |
| **union-AB-full** | 171 | 164 | 126/38 | 77 % | +$92.56 | 18.51 % | 53.54 | 1.729 |
| **union-ABC-full** | 387 | 377 | 284/93 | 75 % | +$103.29 | 20.66 % | 141.18 | 0.732 |

## Stabilité split-half (PnL / MaxDD / PnL/DD / WR)

| Gate | H1 (830 f.) | H2 (468 f.) | Full (1298 f.) |
|---|---|---|---|
| **baseline** | +$420.7 / DD 246.83 / 1.704 / WR 76% | $-237.98 / DD 357.26 / -0.666 / WR 72% | +$182.72 / DD 357.26 / 0.511 / WR 74% |
| **union-ABC** | +$153.18 / DD 65.24 / 2.348 / WR 77% | $-49.89 / DD 139.19 / -0.358 / WR 72% | +$103.29 / DD 141.18 / 0.732 / WR 75% |
| **union-AB** | +$72.7 / DD 53.54 / 1.358 / WR 77% | +$19.86 / DD 42.05 / 0.472 / WR 77% | +$92.56 / DD 53.54 / 1.729 / WR 77% |

## Lectures

- **H1 (out-of-sample, moteur sain)** : baseline +$420.7 / PnL-DD 1.704 → union-ABC-H1 +$153.18 / **2.348 = 1,38× l'efficience du baseline** (31 % du PnL, 26 % du DD) — la tranche C (11–15) y est utile ; union-AB-H1 +$72.7 / 1.358 (0,80× : couper C coûte de l'efficience sur H1)
- **H2 (in-sample, régime whipsaw)** : baseline **−$237.98** (−0.666) → union-ABC-H2 −$49.89 (atténué mais négatif) ; **union-AB-H2 = le seul POSITIF : +$19.86 / DD 42.05 / WR 77 % (0.472)**
- **Stabilité** : WR union-AB = **77 % sur les deux moitiés** (baseline : 76 % H1 → 72 % H2) et DD stable (53.5 H1 / 42.1 H2) vs baseline (247 / 357). Le gate A+B est la configuration la plus robuste ; la tranche C n'apportait que sur H1.
- Couper la tranche C (11–15) : l'union-AB garde le WR et coupe le DD par rapport à l'union-ABC.

## Caveats

- Gate = **début de fenêtre marché en ET** (America/New_York) — même convention que l'étude des win-streaks (les libellés des questions marché).
- La tranche ne filtre pas le SIZING ni la pause : le moteur garde son état (pause whipsaw) à travers les fenêtres du run restreint.
- Les 5m ne sont pas dans l'univers backtest (minTicks 801 > 300 attendus pour une fenêtre 5m) — le gate horaire ne les teste pas.
- `skippedIncomplete: 0` : toutes les fenêtres testées sont déjà « complete » (>801 ticks).
- PnL % relatif au capital simulé du runner (`testConfig`, 75 $ — ou 500 $ en mode split)
- Journée 2026-10-07 partiellement tradée (base au moment de l'extraction).