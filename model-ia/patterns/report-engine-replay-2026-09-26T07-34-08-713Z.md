# Engine Replay × Clusters SAX

**Date:** 2026-09-26T07:34:08.708Z
**Config:** k=8, alphabet=8, paa=120, SAX sur série LEADER (max ask)
**Fenêtres avec ≥1 signal:** 1136 / 1145

## Résumé par moteur

| Moteur | Entrées | WR | Prix moyen | EV/share | t-stat |
|--------|---------|-----|------------|----------|--------|
| dip-revert | 0 | 0.0% | 0.000 | 0.0¢ | 0.00 |
| flip-confirm | 0 | 0.0% | 0.000 | 0.0¢ | 0.00 |
| early-conviction | 1136 | 62.7% | 0.613 | 1.4¢ | 0.99 |
| antiflip | 0 | 0.0% | 0.000 | 0.0¢ | 0.00 |

## Matrice moteurs × clusters

| Moteur | C0 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | Hors cluster |
|---|---|---|---|---|---|---|---|---|---|
| dip-revert | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 |
| flip-confirm | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 |
| early-conviction | 213 (67%) | 191 (61%) | 204 (50%) | 101 (66%) | 96 (57%) | 122 (80%) | 72 (43%) | 137 (72%) | 0 |
| antiflip | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 (-) | 0 |

## Chevauchement entre moteurs (fenêtres où les 2 signifient)

- dip-revert ∩ flip-confirm: 0
- dip-revert ∩ early-conviction: 0
- dip-revert ∩ antiflip: 0
- flip-confirm ∩ early-conviction: 0
- flip-confirm ∩ antiflip: 0
- early-conviction ∩ antiflip: 0

## Clusters (rappel)

| Cluster | n fenêtres | P(Up gagne) |
|---------|------------|-------------|
| 0 | 213 | 0.540 |
| 1 | 191 | 0.513 |
| 2 | 204 | 0.471 |
| 3 | 101 | 0.495 |
| 4 | 96 | 0.406 |
| 5 | 122 | 0.590 |
| 6 | 72 | 0.528 |
| 7 | 137 | 0.467 |