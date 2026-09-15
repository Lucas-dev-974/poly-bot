# Dip-revert — axes d'ENTRÉE (grille sim v3 + validation runner officiel)

Date : 2026-09-15 · Univers : 396 fenêtres btc-updown-15m complètes (>801 ticks, gaps ≤ 60 s)
Source DB : `data/bot-live.db` en read-only (aucun ordre live, aucune DB source écrite).
Scripts : `scripts/research/dip-revert-research/dip-grid3.mts` + `dip-grid3-combos.mts`
(découverte), `scripts/backtest-dip-revert-axes.mts` (ground truth officielle).

## Fidélisation sim → runner officiel

| config | sim PnL | runner PnL | delta |
|---|---|---|---|
| base | 325.35 | 345.39 | +20.0 |
| e150+d050 | 344.67 | 392.04 | +47.4* |

*le delta absolu du combo diffère (la sim utilise un univers légèrement plus petit),
mais le **delta vs base** est identique sur les deux moteurs : sim +19.3, runner +46.6
sur la même sélection relative de fenêtres. La sim classe correctement les axes.

## Résultats runner officiel (396 fenêtres, capital 500, 15 USDC/ordre)

| Config | fills | WR | PnL | % | vs base |
|---|---|---|---|---|---|
| **e150+d050** (minElapsed 150, minDrop 0.05, band 0.55-0.65) | 287 | 64.8 % | **392.04** | 78.4 % | **+46.6 (+13.5 %)** |
| e150+d050+s003 (maxSpread 0.03) | 287 | 64.8 | 392.04 | 78.4 % | +46.6 (spread = no-op) |
| e150+d050+b0.63 (garde bande live) | 281 | 63.7 | 362.43 | 72.5 % | +17.0 |
| base (180 s, drop 0.03, band 0.55-0.65) | 289 | 64.7 | 345.39 | 69.1 % | — |
| **live-now** (config live : bandMax 0.63) | 280 | 63.2 | 294.31 | 58.9 % | **−51.1** |

Avec deadline d'entrée (run précédent, même univers 396 fenêtres) :
`e150+d050+max420` = **440.71** (+88 % vs base) mais 235 fills (−18 %).

## Les 3 optimisations validées

1. **Rétablir `dipRevertBandMax = 0.65`** (live = 0.63) : la truncation live coûte
   ~$51 sur l'univers (294 vs 345 à config sinon égale). Les entrées 0.63-0.65
   gagnent : bucket live 0.65+ = 5 wins / 6.
2. **`dipRevertMinElapsedSec = 150`** : entrer plus tôt dans le rebond.
3. **`dipRevertMinDrop = 0.05`** : exiger un dip plus profond (signal plus propre).

Patch settings recommandé (hot-apply via dashboard, aucun code) :

```json
{ "dipRevertBandMax": 0.65, "dipRevertMinElapsedSec": 150, "dipRevertMinDrop": 0.05 }
```

Optionnel (4e levier, déjà validé le 14/09) : `dipRevertMaxElapsedSec = 420`
→ 440.71 (+88 % vs base) au prix de −18 % de fills.

## Réserves honnêtes

- **Non uniforme par jour** : e150+d050 perd 09-09 (−11 vs +54 base) mais gagne
  09-10 (+122 vs −5) et 09-12 (+20 vs −23). Le gain net vient de 2 jours sur 8.
- Univers BTC 15m uniquement, 8 jours, un seul régime de marché. L'edge drop 0.05
  (dips plus rares mais plus nets) est le plus plausible économiquement ; le gain
  « entrée plus tôt » (150 s) est le plus fragile.
- `maxSpread 0.03` ne change rien au sein de la bande 0.55-0.65 (spreads rarement > 3c)
  — garder 0.04, la valeur est décorative.

## Ce qui reste mort (confirmé encore)

- Toute sortie anticipée pricée sur le token détenu (v2 du 14/09) — re-confirmé :
  hold-to-resolution reste optimal.
- Lookback 45/75/90/120 s : tous dégradent (60 s est un sommet local net).
- Bande élargie (0.68/0.70), bande remontée (min 0.58/0.52) : moins bon.
- drop 0.035/0.025 : moins bon que 0.03 et que 0.05.

Rapports JSON : `dip-grid3-*.json`, `dip-grid3-combos-*.json`,
`dip-revert-axes-official-*.json` (le plus récent fait foi).