# Engine Replay × Clusters SAX

**Date:** 2026-09-26T07:34:48.405Z
**Config:** k=8, alphabet=8, paa=120, SAX sur série LEADER (max ask)
**Fenêtres avec ≥1 signal:** 1083 / 1145

## Résumé par moteur

| Moteur | Entrées | WR | Prix moyen | EV/share | t-stat |
|--------|---------|-----|------------|----------|--------|
| dip-revert | 835 | 60.2% | 0.598 | 0.4¢ | 0.26 |
| flip-confirm | 550 | 59.1% | 0.584 | 0.7¢ | 0.32 |
| early-conviction | 665 | 64.8% | 0.612 | 3.6¢ | 1.94 |
| antiflip | 668 | 43.1% | 0.432 | -0.1¢ | -0.04 |

## Matrice moteurs × clusters

| Moteur | C0 | C1 | C2 | C3 | C4 | C5 | C6 | C7 | Hors cluster |
|---|---|---|---|---|---|---|---|---|---|
| dip-revert | 178 (69%) | 90 (60%) | 152 (55%) | 135 (64%) | 54 (69%) | 39 (74%) | 47 (49%) | 140 (49%) | 0 |
| flip-confirm | 137 (63%) | 57 (61%) | 83 (49%) | 68 (49%) | 58 (83%) | 51 (69%) | 19 (53%) | 77 (48%) | 0 |
| early-conviction | 137 (73%) | 68 (62%) | 93 (57%) | 93 (62%) | 109 (80%) | 53 (70%) | 27 (33%) | 85 (53%) | 0 |
| antiflip | 111 (38%) | 66 (32%) | 142 (48%) | 119 (48%) | 33 (42%) | 21 (24%) | 47 (45%) | 129 (47%) | 0 |

## Chevauchement entre moteurs (fenêtres où les 2 signifient)

- dip-revert ∩ flip-confirm: 463
- dip-revert ∩ early-conviction: 467
- dip-revert ∩ antiflip: 648
- flip-confirm ∩ early-conviction: 257
- flip-confirm ∩ antiflip: 385
- early-conviction ∩ antiflip: 375

## Clusters (rappel)

| Cluster | n fenêtres | P(Up gagne) |
|---------|------------|-------------|
| 0 | 240 | 0.517 |
| 1 | 116 | 0.543 |
| 2 | 158 | 0.468 |
| 3 | 142 | 0.479 |
| 4 | 148 | 0.554 |
| 5 | 90 | 0.467 |
| 6 | 48 | 0.438 |
| 7 | 141 | 0.525 |