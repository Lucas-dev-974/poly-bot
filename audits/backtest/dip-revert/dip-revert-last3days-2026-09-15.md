# Dip-revert — backtest 3 DERNIERS JOURS (09-13, 09-14, 09-15 UTC)

Date : 2026-09-15 · Périmètre : fenêtres complètes des 3 derniers jours (09-13: 59,
09-14: 87, 09-15: 29 — jour partiel, données jusqu'à ~06:10Z).
Script : `scripts/research/dip-revert-research/dip-last3days.mts` (réutilise les sims
calibrées : entry axes + trailing). Read-only.

## Tableau (ranked par PnL)

| Config | fills | WR | PnL | Δ vs hold | 09-13 / 09-14 / 09-15 |
|---|---|---|---|---|---|
| **hold-base (réf)** | 107 | 64.5 % | **+118.05** | 0 | +107 / +25 / −14 |
| s003 (spread 0.03) | 107 | 64.5 | +118.05 | 0 (no-op) | idem |
| d050 (drop 0.05 seul) | 103 | 64.1 | +113.93 | −4.1 | +93 / +34 / −14 |
| e120 | 114 | 62.3 | +82.82 | −35.23 | +127 / −61 / +17 |
| live-band0.63 | 103 | 62.1 | +79.43 | −38.62 | +99 / −8 / −12 |
| e150+d050 | 108 | 62.0 | +69.33 | −48.72 | +92 / −9 / −14 |
| e150+d050+max420 | 87 | 62.1 | +69.15 | −48.90 | +101 / −26 / −7 |
| trail-0.12-arm4-winner | 108 | 38.9 | −4.68 | −122.73 | +16 / −52 / +31 |
| trail-0.15-arm4 | 107 | 40.2 | −18.27 | −136.32 | +23 / −76 / +35 |
| live-e480 | 71 | 57.7 | **−51.85** | **−169.90** | −102 / +58 / −7 |

## Ce que ça change vs le backtest 8 jours

**1. Les axes gagnants du 8 jours ne gagnent plus sur les 3 derniers jours.**
`e150+d050` (meilleur axe global : +392 sur 8 j) fait **−48.7 vs hold** ici ;
`e150+d050+max420` pareil (−48.9). La raison : le gain de ces axes venait
principalement du 09-10 (+122 vs −5) et 09-12 (+20 vs −23) — deux jours
**hors** de la fenêtre. Sur les 3 derniers jours, l'entrée tardive 150 s et le
drop 0.05 ne trouvent pas les mêmes setups.

**2. La bande live 0.63 reste inférieure à 0.65** (−38.6 sur 3 j) — ce verdict
reste valable sur la période récente. Rétablir 0.65 reste recommandé.

**3. `minElapsed 480` (la valeur dans ton JSON) est CATASTROPHIQUE** : −169.9
vs hold, WR 57.7 %, et surtout **09-13 à −102** (il manque 60 % des signaux :
à 480 s il ne reste que 4 min pour trader, les meilleurs setups sont passés).
Le runtime ne l'utilise pas (les fills prouvent elapsed ~180) — mais si un
PATCH dashboard l'appliquait, tu couperais le PnL de moitié. À corriger de
toute façon.

**4. Le trailing stop reste perdant** sur la période récente (−123 à −136),
avec le même pattern : il aide le 09-15 (+31/+35 vs −14) et détruit le 09-14
(−52/−76 vs +25).

**5. `minDrop 0.05` SEUL reste quasi neutre** (−4.1) : le drop profond n'est
pas nuisible en soi, c'est la combinaison avec l'entrée tardive 150 s qui
perte sur la période récente.

## Implication pour la décision en cours

Ma reco précédente (patch e150+d050+max420) reposait sur les 8 jours. En
restricting aux 3 derniers jours, **la base officielle reste la meilleure
config** et les axes d'entrée alternatifs ne sur-performent plus. Deux lectures
possibles :
- **Prudente** : garder la base (elapsed 180, drop 0.03, band 0.65) — le
  backtest récent ne justifie plus un changement d'entrée.
- **Contrarian** : les 3 derniers jours contiennent le régime LIVE (le 15 est
  le jour où le bot tourne) ; l'axe e150+d050 a fait ses preuves sur un échantillon
  2,5× plus grand.

Point non ambigu : **rétablir band 0.65 et ne JAMAIS appliquer elapsed 480**.

JSON : `dip-last3days-1789457247140.json`. Rien n'implémenté.