# Phase 2 — SIGNAL sim chainlink-lag

- Généré: 2026-09-25T22:58:33.091Z
- Univers aligné runner: 827 fenêtres résolues (>= 801 ticks, gap <= 60 s), avec barre: 827
- Feed simulé: klines 1s Binance (data.binance.vision) ; barre BACKWARD (A6)
- Gates: ask ∈ [0.1, 0.8], spread <= 0.03, depth FOK, elapsed ∈ [30, 600] s, 1 trigger/fenêtre
- Sizing: 5$ / ask (cap 30 shares, min CLOB 5) ; hold to resolution

## Grille familles × seuils

| Famille | Seuil | n | WR | PnL$ | PnL%/trade | t-stat | Ask moyen (breakeven) |
|---|---|---|---|---|---|---|---|
| A-proj | 0.1 | 415 | 74.94% | 101.15$ | 4.88% | 1.61 | 0.71 |
| B-naive | 0.1 | 128 | 64.06% | 42.88$ | 6.70% | 0.81 | 0.62 |
| C-confirm2 | 0.1 | 389 | 74.55% | 52.73$ | 2.72% | 0.88 | 0.72 |
| C-confirm3 | 0.1 | 379 | 74.14% | 28.79$ | 1.52% | 0.49 | 0.73 |
| A-proj | 0.15 | 171 | 77.19% | 44.99$ | 5.26% | 1.18 | 0.73 |
| B-naive | 0.15 | 38 | 60.53% | -12.91$ | -6.81% | -0.53 | 0.64 |
| C-confirm2 | 0.15 | 153 | 73.20% | -7.04$ | -0.92% | -0.19 | 0.73 |
| C-confirm3 | 0.15 | 139 | 70.50% | -33.28$ | -4.79% | -0.91 | 0.74 |
| A-proj | 0.2 | 71 | 70.42% | -15.09$ | -4.25% | -0.57 | 0.74 |
| B-naive | 0.2 | 16 | 62.50% | -2.74$ | -3.43% | -0.17 | 0.67 |
| C-confirm2 | 0.2 | 63 | 69.84% | -20.69$ | -6.57% | -0.84 | 0.75 |
| C-confirm3 | 0.2 | 56 | 71.43% | -13.12$ | -4.69% | -0.57 | 0.75 |
| A-proj | 0.25 | 32 | 75.00% | 2.60$ | 1.62% | 0.15 | 0.74 |
| B-naive | 0.25 | 7 | 42.86% | -13.67$ | -39.08% | -1.34 | 0.71 |
| C-confirm2 | 0.25 | 26 | 65.38% | -15.31$ | -11.78% | -0.91 | 0.74 |
| C-confirm3 | 0.25 | 24 | 62.50% | -19.86$ | -16.56% | -1.22 | 0.75 |
| A-proj | 0.3 | 17 | 52.94% | -23.87$ | -28.10% | -1.65 | 0.74 |
| B-naive | 0.3 | 6 | 33.33% | -15.40$ | -51.39% | -1.65 | 0.70 |
| C-confirm2 | 0.3 | 14 | 64.29% | -11.68$ | -16.70% | -0.97 | 0.76 |
| C-confirm3 | 0.3 | 16 | 62.50% | -14.99$ | -18.75% | -1.15 | 0.76 |

## Détail financier (configs principales)

### A-proj @ 0.1 (meilleur n de la famille principale)

| Métrique | Valeur |
|---|---|
| **Capital de base** (max drawdown + 1 mise) | **77.17$** |
| Mise par trade (cost = shares × ask, cap 30 sh) | 5.00$ en moyenne (2073.60$ engagés au total) |
| AVG Win / AVG Loss | +2.00$ / -5.00$ (payoff 0.40) |
| Max Win / Max Loss | +5.00$ / -5.00$ |
| Trades gagnants / perdants | 311 / 104 (WR 74.94%) |
| WR breakeven (payoff-driven) | 71.45% (WR réel 74.94%) |
| Max drawdown (courbe cumulée) | 72.18$ |
| ROI sur capital de base | 131.07% |
| t-stat (EV/trade vs 0) | 1.61 |

### A-proj @ 0.15 (défaut plan)

| Métrique | Valeur |
|---|---|
| **Capital de base** (max drawdown + 1 mise) | **42.22$** |
| Mise par trade (cost = shares × ask, cap 30 sh) | 5.00$ en moyenne (854.47$ engagés au total) |
| AVG Win / AVG Loss | +1.82$ / -5.00$ (payoff 0.36) |
| Max Win / Max Loss | +3.47$ / -5.00$ |
| Trades gagnants / perdants | 132 / 39 (WR 77.19%) |
| WR breakeven (payoff-driven) | 73.33% (WR réel 77.19%) |
| Max drawdown (courbe cumulée) | 37.23$ |
| ROI sur capital de base | 106.55% |
| t-stat (EV/trade vs 0) | 1.18 |

### Contrôle (favori sans signal)

| Métrique | Valeur |
|---|---|
| **Capital de base** (max drawdown + 1 mise) | **99.39$** |
| Mise par trade (cost = shares × ask, cap 30 sh) | 5.00$ en moyenne (3967.92$ engagés au total) |
| AVG Win / AVG Loss | +3.58$ / -5.00$ (payoff 0.72) |
| Max Win / Max Loss | +4.80$ / -5.00$ |
| Trades gagnants / perdants | 472 / 322 (WR 59.45%) |
| WR breakeven (payoff-driven) | 58.24% (WR réel 59.45%) |
| Max drawdown (courbe cumulée) | 94.39$ |
| ROI sur capital de base | 82.93% |
| t-stat (EV/trade vs 0) | 0.69 |

## Split-half (famille A, meilleur seuil viable)

- moitié ancienne: n=85, WR 74.12%, PnL%/trade -0.35%, PnL -1.47$
- moitié récente: n=86, WR 80.23%, PnL%/trade 10.81%, PnL 46.46$
- btc: n=151, WR 76.82%, PnL%/trade 4.31%
- eth: n=20, WR 80.00%, PnL%/trade 12.51%

- Rejets (par fenêtre, au premier blocage): ask-band(0.85)=25, ask-band(0.92)=17, ask-band(0.82)=17, ask-band(0.88)=15, ask-band(0.89)=15, ask-band(0.83)=14, ask-band(0.91)=14, ask-band(0.84)=14, ask-band(0.87)=13, ask-band(0.90)=13, ask-band(0.81)=13, ask-band(0.95)=12, ask-band(0.86)=11, ask-band(0.94)=11, ask-band(0.93)=11, ask-band(0.96)=10, depth=7, ask-band(0.97)=4, ask-band(0.98)=2, ask-band(0.99)=2, spread=2

## Verdict

**DEAD** — aucune config avec n >= 100 ET PnL%/trade > 0 ET t >= 2. Meilleure: B-naive@0.1 (n=128, PnL%/trade 6.70%, t=0.81). Ne PAS wirer le moteur.
