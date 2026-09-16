# Audit positions live — antiflip-revert (2026-09-16 06:40 UTC, bilan final 06:53)

Source : `data/bot-live.db` (lecture seule). Script : `scripts/research/antiflip-revert/live-audit.mts`.

## Bilan final (7/7 positions résolues)

| # | Fenêtre | Entrée | Prix | Statut | PnL | Elapsed à l'entrée |
|---|---|---|---:|---|---:|---|
| 1 | 02:15-02:30 | Down | 0.379 | lost | −2.09 $ | 826s |
| 2 | 02:30-02:45 | Down | 0.45 | lost | −2.25 $ | 280s |
| 3 | 01:50-02:05 | Up | 0.42 | **won** | **+3.04 $** | 269s |
| 4 | 01:55-02:10 | Up | 0.43 | lost | −2.15 $ | 858s |
| 5 | 02:10-02:25 | Down | 0.41 | lost | −2.05 $ | 343s |
| 6 | 02:35-02:50 | Up | 0.44 | lost | −2.25 $ | 364s |
| 7 | 02:50-03:05 | Up | 0.50 | **won** | **+2.50 $** | 307s |

**Total : 7 trades, 2 won / 5 lost, PnL −5.25 $** (WR 28.6 %) — ~1h40 de trading live.

## Conformité au signal — les 6 premières positions sont fidèles

Vérifié tick par tick depuis `book_snapshots` (flip horodaté, prix du favori/déchu,
spread, elapsed) : **toutes les 6 premières entrées passent les 7 gates** du moteur
(flip frais ≤ 90 s, nouveau favori 0.45-0.65, déchu dans bande + floor 0.40,
spread ≤ 0.05, elapsed ≥ 240 s, achat du déchu opposé au favori courant).

## ⚠️ La config live diverge du backtest calibré

`data/bot-settings.json` (hot-appliée via le dashboard) diffère du preset :

| Paramètre | Backtest calibré | Config live actuelle |
|---|---|---|
| `antiflipBandMax` | **0.45** | **0.50** ← élargi |
| `antiflipOrderUsdc` | 15 $ | 5.5 $ |
| `maxSharesPerOrder` | 30 | 5 |
| `maxExposureUsdc` | 450 $ | 10 $ |

Conséquence directe : la position #7 (déchu acheté à 0.50) est **conforme à la config
live mais hors du signal backtesté**. La zone 0.46-0.50 avait été écartée par le grid
de recherche : bande 0.35-0.50 = +$450 / DD $146 vs bande stricte 0.35-0.45 = +$609 /
DD $103. Pas illégal, mais non backtesté dans sa version exacte.

## Points d'exécution

- **FOK kills** : 2 des 8 ordres émis ont été tués par la profondeur (`killed-fok`)
  puis retentés au tick suivant avec un limit réévalué — comportement nominal (retry
  sans blocage re-entry), les 6 entrées ont fini fillées.
- **Price improvement** : 3 fills sous le limit (−0.01 à −0.04 vs tick d'émission),
  un FOK fillé exactement au prix courant. Pas de slippage pathologique.

## Lecture honnête du WR 28.6%

2 wins / 5 losses sur n=7 : l'intervalle binomial à 95 % est [4 %, 71 %]. Cet
échantillon **ne distingue pas** un moteur à 52 % d'un moteur malchanceux. Les 7
fenêtres couvrent ~1h40 consécutives — c'est une séquence, pas un échantillon. Sur
un moteur à 52 %, la probabilité d'observer ≤ 2 wins sur 7 est ≈ 26 % : non
exceptionnel. Le backtest sur 393 fenêtres reste la seule mesure fiable.

**Recommandation** : (1) décider si la bande 0.50 est voulue — sinon re-passer la
bande à 0.45 (hot-apply depuis le dialog) pour trader la config backtestée exactement ;
(2) laisser tourner et ré-auditer à ~30-40 trades clos avant de conclure sur le WR ;
(3) le sizing réduit (5.5 $ / exposure 10 $) est prudent et approprié pour une phase
de validation live — il a borné la perte du run à −5.25 $.

*Script réutilisable : `scripts/research/antiflip-revert/live-audit.mts` (vérification
des gates) et `live-snapshot.mts` (bilan PnL).*