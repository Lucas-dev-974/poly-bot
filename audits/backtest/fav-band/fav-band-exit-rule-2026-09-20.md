# Fav-band — règle de sortie « dégradation » (pics de plus en plus bas)

**Date** : 2026-09-20 · **Runner** : officiel `runBacktest` · **Univers** : 830 fenêtres BTC/ETH 15m complètes (`minTicks 801`, `maxGapMs 60s`) depuis `data/bot-live.db` (copie VACUUM, offline).

## Règle implémentée

Après le fill d'entrée, suivre l'ask du favori **détenu** (jamais le favori courant) :
chaque chute ≥ `favBandExitMinLowerHighDrop` sous le plus-haut courant = 1 « palier
échoué ». Après `favBandExitConsecutive` paliers dans `favBandExitLookbackMs`, SELL
FOK au bid (pipeline defend, `usesDefendAsExit`, précédent dip-revert TP) au lieu du
hold-résolution. Reprise au-dessus du dernier pic = reset. `favBandExitLossOnly`
(défaut on) = ne sortir que sous le prix d'entrée. Option `favBandExitSwitchEnabled` =
FOK buy du token inverse à son ask courant juste après la vente.

## Grille (specs 11, baseline = config backtestée exit OFF)

| label | PnL | PnL % | WR | trades | maxDD | PnL/DD | fills | rejects |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline-exit-off | **+420.70** | 560.93 | 76.0 | 818 | 246.83 | 1.704 | 818 | 4 |
| exit-drop0p05_n3 | +365.39 | 487.19 | 39.7 | 818 | **55.62** | **6.569** | 1311 | 4 |
| exit-drop0p03_n3 | +348.50 | 464.67 | 33.0 | 818 | 50.52 | 6.898 | 1366 | 4 |
| exit-drop0p05_n2 | +283.82 | 378.43 | 30.9 | 818 | 83.38 | 3.404 | 1383 | 4 |
| exit-on-default_minElapsed300 | +258.28 | 344.37 | 27.4 | 818 | 58.33 | 4.428 | 1412 | 4 |
| exit-drop0p02_n3 | +201.28 | 268.37 | 27.9 | 818 | 75.62 | 2.662 | 1408 | 4 |
| exit-drop0p015_n3 | +160.94 | 214.59 | 26.8 | 818 | 88.15 | 1.826 | 1417 | 4 |
| exit-drop0p015_n2 | +90.05 | 120.07 | 20.0 | 818 | 93.53 | 0.963 | 1472 | 4 |
| exit-drop0p03_n2 | −60.59 | −80.79 | 18.9 | 233 | 105.79 | −0.573 | 422 | 95 773 |
| exit-on-default_loss-only-off | −60.66 | −80.88 | 30.1 | 186 | 79.11 | −0.767 | 368 | 104 069 |
| exit-on-default (0.02/2) | −63.25 | −84.33 | 15.9 | 233 | 99.57 | −0.635 | 429 | 95 773 |
| exit-on-switch-on | −65.63 | −87.51 | 44.4 | 27 | 106.85 | −0.614 | 64 | 131 875 |

NB : WR = part des fenêtres tradées à PnL > 0 (incl. les sorties anticipées, d'où la
baisse mécanique du WR sur les variantes exit : un trade soldé en perte compte comme
fenêtre perdante même si le hold aurait gagné).

## Lecture

1. **La config par défaut intuitive (0.02/2 pics) est destructrice** : −63 vs +421.
   Un seuil de 2¢ sort sur le bruit du carnet (spread 1¢) : la chaîne de paliers se
   remplit sur du bruit de tick et vends des positions que le hold aurait gagnées
   (baseline WR 76 % → 16 %).
2. **Le seul axe défendable est la config LARGE (0.05 / 3 pics)** : −13 % de PnL
   (+365 vs +421) mais maxDD $247 → $56 (−77 %) et PnL/DD ×3.9 (1.70 → 6.57). C'est
   un trade-off risque/rendement, pas un free lunch : la sortie coupe les fenêtres
   où le favori se dégrade vraiment, au prix des rebonds qui finissaient gagnants.
3. **Le switch inverse (achat du token opposé après la vente) dégrade tout** :
   64 fills seulement, PnL négatif, 132k rejets — on rachète le token qui monte
   déjà (ask 0.44-0.52 après la dégradation) : le même verdict que l'étude hedge
   dip-revert (toute structure qui cède l'espérance du favori détenu dégrade).
   Switch livré OFF par défaut, gardé configurable pour tests manuels.
4. **Loss-only OFF est encore pire** : sortir « en dégradation » au-dessus du prix
   d'entrée taxe exactement les fenêtres gagnantes.

## Décisions ship

- Défauts : `favBandExitMinLowerHighDrop = 0.05`, `favBandExitConsecutive = 3`,
  lookback 120 s, loss-only ON, switch OFF (`favBandExitEnabled` OFF par défaut).
- Les 3 presets fav-band portent ces défauts (exit OFF tant que l'utilisateur ne
  l'active pas).
- Config recommandée si l'objectif est le drawdown : activer l'exit avec 0.05/3.

## Réserves honnêtes

- Un seul actif (BTC 15m), un seul régime ; les chiffres ne se somment pas avec
  d'autres rapports (univers différent).
- Le WR affiché mélange hold-gagnant et sortie-anticipée ; la métrique pertinente
  pour cette règle est PnL/DD, pas le WR.
- La sortie vend au bid L1 (runner) : en live, un carnet fin peut tuer le FOK SELL
  (le defendPair live retente au tick suivant — comportement hold-until-sold).

## Artefacts

- Script : `scripts/research/fav-band/exit-rule-backtest.mts` (réutilisable, étendre
  la liste `specs`).
- JSON brut : `fav-band-exit-rule-1789883396238.json` (ce dossier).
- Tests : `tests/fav-band.test.ts` — 28 pass (chaîne de paliers, resets, lookback,
  idempotence, validation config, e2e runner exit + e2e switch).