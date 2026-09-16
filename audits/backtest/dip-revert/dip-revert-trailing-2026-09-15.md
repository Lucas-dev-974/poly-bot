# Dip-revert — trailing stop (backtest, AUCUNE implémentation)

Date : 2026-09-15 · Univers : 396 fenêtres complètes (>801 ticks, gaps ≤ 60 s) · read-only
Script : `scripts/research/dip-revert-research/dip-trailing-sim.mts`
Fidélité : prix sur le **carnet du token détenu** (leçon v2 du 14/09), vente FOK walk
3 niveaux de bids (worst-price, killed si profondeur < size, re-quote chaque tick tant
que le trigger tient — même convention que les axes du 14/09), garde spread détenu ≤ 0.05,
hold-to-resolution si pas de trigger. Peak = max(ask détenu depuis l'entrée), initialisé
au prix d'entrée ; `armCents` = le trail ne s'arme qu'après peak ≥ entrée + N cents.

## Verdict : le trailing stop dégrade le PnL, mais améliore le drawdown

**AUCUNE config de trailing ne bat le hold-to-resolution en PnL absolu** (réf +325.35) :
le meilleur trailing (0.12 + arm 4¢ sur l'entrée winner) perd −115.76. Cohérent avec
tous les tests de sortie du 14/09.

**MAIS** — c'est le seul axe de sortie qui réduit le drawdown de façon substantielle :

| Config | PnL | Δ vs hold | **Max DD** | WR | sells |
|---|---|---|---|---|---|
| hold-ref (référence) | **+325.35** | 0 | 119.03 | 64.5 % | 0 |
| trail-0.12 + arm 4¢ (entrée winner) | 209.59 | −115.76 | **77.08** | 50.2 % | 187 |
| trail-0.15 absolu | 205.05 | −120.30 | **58.65** | 43.2 % | 201 |
| trailp-0.20 (relatif) | 151.36 | −173.99 | 70.37 | 36.6 % | 203 |
| trail-0.08 (serré) | 118.03 | −207.32 | 49.14 | 39.7 % | 231 |
| trail-0.05 (très serré) | 123.17 | −202.18 | 49.14 | 38.3 % | 236 |

Patterne net : plus le trail est serré, plus le drawdown baisse et plus le PnL
s'effondre. Le mécanisme : le trail coupe les positions perdantes avant la
résolution (bien) mais coupe AUSSI 30-50 % des winners avant qu'ils ne
touchent 1.00 (mal) — le payout perdu sur les winners coupés dépasse largement
la perte évitée sur les losers. WR passe de 64.5 % à 36-55 % selon la largeur.

Le « profit-arm » (le trail ne s'arme qu'après +4¢ au-dessus de l'entrée)
aide un peu : trail-0.12-arm4 (163.02) > trail-0.12 nu (119.37) — il empêche
le stop de sortir au premier faux rebond. Mais même armé, le trail reste
−115 à −180 sous le hold.

## Lecture par jour (trail 0.15, le moins pire)

```
         hold   trail-0.15   effet du trail
09-08: +104    +104          neutre
09-09:  +54     +51          neutre
09-10:  -20     +20          AIDE (coupe le crash)
09-11:  +92     +50          TAXE les gains
09-12:  -23     -31          ne suffit pas
09-13: +107     +23          TAXE fortement
09-14:  +25     -34          TAXE
09-15:  -14     +20          AIDE
```

Le trail aide les jours de crash (09-10, 09-15) mais taxe les jours verts
(09-11 : −42, 09-13 : −84, 09-14 : −59). Sur 8 jours : 2 jours aidés, 4 taxés,
2 neutres. Net négatif.

## Constat de simulation à noter

Les `kills` de vente sont nombreux (5-11 k sur 396 fenêtres) : après un flip,
la profondeur de bids du token détenu tombe sous la taille de position sur les
3 niveaux, et le sim re-quote chaque tick tant que le trigger tient — même
comportement qu'en live (killed-fok). Les sells « réussis » sont donc ceux où
la profondeur tenait ; le live verrait une proportion similaire de retries.

## Conclusion

Le trailing stop sur dip-revert est un instrument de **réduction de risque
payant** : tu échanges ~35 % du PnL (−120) contre ~35 % de drawdown en moins
(119 → 77-59). Économiquement : le signal gagne à la résolution, et toute
sortie anticipée — trail, stop fixe, take-profit — coupe l'asymétrie qui fait
la valeur du trade (payout 1$ si win vs −prix si loss).

Ma recommandation reste la même que pour le hedge : **ne pas implémenter**.
Si le drawdown te préoccupe, le sizing est le seul levier gratuit (réduire
`dipRevertOrderUsdc` réduit le DD proportionnellement sans toucher l'espérance
par share).

Rapport JSON : `dip-trailing-1789456947258.json`. Rien n'a été implémenté.