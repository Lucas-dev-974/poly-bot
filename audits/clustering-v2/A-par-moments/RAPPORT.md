# Étude A — Clustering par moments (point-in-time)

## Données

- Fichier ticks: `data/datasets/btc15-clustering/btc15_ticks_complete_2026-09-08_to_2026-10-05_28j.csv`
- Fichier fenêtres: `btc15_windows_complete_2026-09-08_to_2026-10-05_28j.csv`
- Période: **2026-09-08 → 2026-10-05** (28 j), fenêtres complètes (gaps ≤5s)
- N fenêtres: **677** (Up 345 / Down 332)
- Split chronologique ~70/30 par `window_start`:
  - Train: n=474, 2026-09-08 06:45:00+00:00 → 2026-09-18 16:00:00+00:00, P(Up)=0.504
  - Holdout: n=203, 2026-09-18 16:15:00+00:00 → 2026-10-05 07:15:00+00:00, P(Up)=0.522
- Contrainte: **uniquement** prix book Up/Down (pas de spot BTC)
- Fees: aucun modèle hold-to-resolution générique dans `src/` (seul `repricingFeesRoundtrip=0.002` spécifique) → **FEE=0**

## Méthode

- Temps de décision t ∈ {120, 300, 450, 600} s
- Features passées uniquement (`elapsed_sec ≤ t`): resample 1s last-value + ffill, downsample bins 5s de `mid_up`, + résumés (mid, favorite ask, ask_sum, spreads, imbalance profondeur, vol, flips favori, max/min, slope 60s)
- Standardisation fit sur train; KMeans (k=3..10) et Agglomerative Ward; k choisi par silhouette train (tous k reportés)
- Assignation holdout: centroïde le plus proche
- Cibles: `up_won` et `favorite_at_t wins`
- Stats: n, WR, IC Wilson 95%, p binomial vs baseline, correction Benjamini-Hochberg **globale** sur tous les tests
- Edge si: significatif train après BH **et** même direction holdout n≥20 **et** WR > prix d'entrée moyen (ask)
- Économie: taker, achat du côté prédit au ask à t, hold to resolution, stake $4, payout $1/share

## Configurations testées

- 4 temps × 2 méthodes × 8 k × 2 cibles × k clusters ≈ **832** tests (clusters individuels)
- Significatifs train (BH global α=0.05): **307**
- Edges retenus (critères complets): **41**

## Résultats par temps de décision

### t = 120 s

- Baseline P(Up) train=0.504 / holdout=0.522
- Baseline P(fav wins) train=0.624 / holdout=0.557
- **kmeans**: meilleur k silhouette=4 (scores: k3=0.244, k4=0.247, k5=0.179, k6=0.182, k7=0.175, k8=0.176, k9=0.164, k10=0.155)

#### kmeans k=4 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 214 | 0.477 | [0.41,0.54] | 4.52e-01 | non | 100 | 0.530 | above | down | 0.484 | 14.06 | non |
| 1 | 132 | 0.689 | [0.61,0.76] | 2.40e-05 | oui | 56 | 0.643 | above | up | 0.684 | -10.90 | non |
| 2 | 1 | 0.000 | [0.00,0.79] | 4.96e-01 | non | 0 | nan | na | down | nan | nan | non |
| 3 | 127 | 0.362 | [0.28,0.45] | 1.36e-03 | oui | 47 | 0.362 | below | down | 0.679 | -4.43 | non |


#### kmeans k=4 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 214 | 0.561 | [0.49,0.63] | 5.68e-02 | non | 100 | 0.490 | below | favorite | 0.577 | -55.85 | non |
| 1 | 132 | 0.697 | [0.61,0.77] | 8.82e-02 | non | 56 | 0.643 | above | favorite | 0.684 | -10.90 | non |
| 2 | 1 | 0.000 | [0.00,0.79] | 3.76e-01 | non | 0 | nan | na | favorite | nan | nan | non |
| 3 | 127 | 0.661 | [0.58,0.74] | 4.11e-01 | non | 47 | 0.596 | above | favorite | 0.682 | -21.49 | non |

- **ward**: meilleur k silhouette=4 (scores: k3=0.221, k4=0.226, k5=0.162, k6=0.120, k7=0.113, k8=0.109, k9=0.110, k10=0.108)

#### ward k=4 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 154 | 0.636 | [0.56,0.71] | 1.20e-03 | oui | 70 | 0.600 | above | up | 0.665 | -27.55 | non |
| 1 | 109 | 0.312 | [0.23,0.40] | 7.11e-05 | oui | 43 | 0.372 | below | down | 0.689 | -10.39 | non |
| 2 | 208 | 0.510 | [0.44,0.58] | 8.90e-01 | non | 90 | 0.533 | above | up | 0.511 | 31.51 | non |
| 3 | 3 | 0.333 | [0.06,0.79] | 6.22e-01 | non | 0 | nan | na | down | nan | nan | non |


#### ward k=4 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 154 | 0.669 | [0.59,0.74] | 2.80e-01 | non | 70 | 0.600 | above | favorite | 0.665 | -27.55 | non |
| 1 | 109 | 0.725 | [0.63,0.80] | 2.98e-02 | non | 43 | 0.605 | above | favorite | 0.691 | -19.28 | non |
| 2 | 208 | 0.538 | [0.47,0.60] | 1.21e-02 | oui | 90 | 0.500 | below | favorite | 0.575 | -41.41 | non |
| 3 | 3 | 0.667 | [0.21,0.94] | 1.00e+00 | non | 0 | nan | na | favorite | nan | nan | non |

### t = 300 s

- Baseline P(Up) train=0.504 / holdout=0.522
- Baseline P(fav wins) train=0.694 / holdout=0.670
- **kmeans**: meilleur k silhouette=3 (scores: k3=0.277, k4=0.198, k5=0.196, k6=0.174, k7=0.179, k8=0.165, k9=0.155, k10=0.152)

#### kmeans k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 187 | 0.481 | [0.41,0.55] | 5.59e-01 | non | 94 | 0.500 | below | down | 0.466 | 40.35 | non |
| 1 | 147 | 0.293 | [0.23,0.37] | 2.23e-07 | oui | 44 | 0.318 | below | down | 0.771 | -23.13 | non |
| 2 | 140 | 0.757 | [0.68,0.82] | 1.46e-09 | oui | 65 | 0.692 | above | up | 0.745 | -21.68 | non |


#### kmeans k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 187 | 0.636 | [0.57,0.70] | 9.54e-02 | non | 94 | 0.617 | below | favorite | 0.618 | 4.45 | non |
| 1 | 147 | 0.694 | [0.62,0.76] | 1.00e+00 | non | 44 | 0.682 | above | favorite | 0.771 | -23.13 | non |
| 2 | 140 | 0.771 | [0.70,0.83] | 5.36e-02 | non | 65 | 0.738 | above | favorite | 0.751 | -0.81 | non |

- **ward**: meilleur k silhouette=3 (scores: k3=0.260, k4=0.209, k5=0.169, k6=0.131, k7=0.135, k8=0.126, k9=0.132, k10=0.116)

#### ward k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 185 | 0.454 | [0.38,0.53] | 1.86e-01 | non | 93 | 0.495 | below | down | 0.465 | 44.35 | non |
| 1 | 147 | 0.313 | [0.24,0.39] | 3.10e-06 | oui | 45 | 0.333 | below | down | 0.765 | -27.13 | non |
| 2 | 142 | 0.768 | [0.69,0.83] | 1.98e-10 | oui | 65 | 0.692 | above | up | 0.745 | -21.68 | non |


#### ward k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 185 | 0.638 | [0.57,0.70] | 1.10e-01 | non | 93 | 0.613 | below | favorite | 0.619 | 0.90 | non |
| 1 | 147 | 0.701 | [0.62,0.77] | 9.29e-01 | non | 45 | 0.689 | above | favorite | 0.766 | -19.58 | non |
| 2 | 142 | 0.761 | [0.68,0.82] | 1.01e-01 | non | 65 | 0.738 | above | favorite | 0.751 | -0.81 | non |

### t = 450 s

- Baseline P(Up) train=0.504 / holdout=0.522
- Baseline P(fav wins) train=0.753 / holdout=0.709
- **kmeans**: meilleur k silhouette=3 (scores: k3=0.285, k4=0.262, k5=0.210, k6=0.214, k7=0.191, k8=0.175, k9=0.161, k10=0.156)

#### kmeans k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 141 | 0.801 | [0.73,0.86] | 5.27e-13 | oui | 67 | 0.761 | above | up | 0.781 | -10.68 | non |
| 1 | 142 | 0.197 | [0.14,0.27] | 4.90e-14 | oui | 45 | 0.267 | below | down | 0.814 | -26.88 | non |
| 2 | 191 | 0.513 | [0.44,0.58] | 8.28e-01 | non | 91 | 0.473 | below | up | 0.523 | -40.93 | non |


#### kmeans k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 141 | 0.816 | [0.74,0.87] | 9.64e-02 | non | 67 | 0.776 | above | favorite | 0.792 | -7.34 | non |
| 1 | 142 | 0.817 | [0.75,0.87] | 8.02e-02 | non | 45 | 0.778 | above | favorite | 0.839 | -16.62 | non |
| 2 | 191 | 0.660 | [0.59,0.72] | 4.16e-03 | oui | 91 | 0.626 | below | favorite | 0.662 | -18.25 | non |

- **ward**: meilleur k silhouette=3 (scores: k3=0.258, k4=0.206, k5=0.182, k6=0.171, k7=0.153, k8=0.130, k9=0.123, k10=0.124)

#### ward k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 151 | 0.185 | [0.13,0.25] | 5.82e-16 | oui | 44 | 0.250 | below | down | 0.829 | -22.88 | non |
| 1 | 157 | 0.752 | [0.68,0.81] | 3.47e-10 | oui | 68 | 0.765 | above | up | 0.762 | -3.12 | OUI |
| 2 | 166 | 0.560 | [0.48,0.63] | 1.62e-01 | non | 91 | 0.473 | below | up | 0.537 | -47.78 | non |


#### ward k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 151 | 0.815 | [0.75,0.87] | 8.90e-02 | non | 44 | 0.773 | above | favorite | 0.839 | -17.32 | non |
| 1 | 157 | 0.764 | [0.69,0.82] | 7.82e-01 | non | 68 | 0.779 | above | favorite | 0.782 | -4.06 | non |
| 2 | 166 | 0.687 | [0.61,0.75] | 5.81e-02 | non | 91 | 0.626 | below | favorite | 0.670 | -20.83 | non |

### t = 600 s

- Baseline P(Up) train=0.504 / holdout=0.522
- Baseline P(fav wins) train=0.800 / holdout=0.744
- **kmeans**: meilleur k silhouette=3 (scores: k3=0.287, k4=0.269, k5=0.222, k6=0.212, k7=0.168, k8=0.160, k9=0.155, k10=0.167)

#### kmeans k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 177 | 0.548 | [0.47,0.62] | 2.60e-01 | non | 92 | 0.489 | below | up | 0.514 | 25.27 | non |
| 1 | 165 | 0.170 | [0.12,0.23] | 4.70e-19 | oui | 51 | 0.255 | below | down | 0.812 | -26.23 | non |
| 2 | 132 | 0.864 | [0.79,0.91] | 4.01e-18 | oui | 60 | 0.800 | above | up | 0.817 | 1.58 | non |


#### kmeans k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 177 | 0.706 | [0.64,0.77] | 3.41e-03 | oui | 92 | 0.652 | below | favorite | 0.734 | -44.62 | non |
| 1 | 165 | 0.861 | [0.80,0.91] | 5.16e-02 | non | 51 | 0.824 | above | favorite | 0.848 | -3.62 | non |
| 2 | 132 | 0.848 | [0.78,0.90] | 1.91e-01 | non | 60 | 0.817 | above | favorite | 0.835 | -2.49 | non |

- **ward**: meilleur k silhouette=3 (scores: k3=0.277, k4=0.250, k5=0.190, k6=0.188, k7=0.184, k8=0.138, k9=0.144, k10=0.140)

#### ward k=3 — cible `up_won`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 190 | 0.568 | [0.50,0.64] | 8.17e-02 | non | 91 | 0.505 | below | up | 0.527 | 28.61 | non |
| 1 | 166 | 0.175 | [0.12,0.24] | 1.38e-18 | oui | 54 | 0.259 | below | down | 0.811 | -28.53 | non |
| 2 | 118 | 0.864 | [0.79,0.91] | 2.11e-16 | oui | 58 | 0.793 | above | up | 0.823 | -2.67 | non |


#### ward k=3 — cible `fav_wins`

| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |
|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|
| 0 | 190 | 0.721 | [0.65,0.78] | 8.53e-03 | oui | 91 | 0.659 | below | favorite | 0.731 | -38.07 | non |
| 1 | 166 | 0.849 | [0.79,0.90] | 1.21e-01 | non | 54 | 0.815 | above | favorite | 0.844 | -5.92 | non |
| 2 | 118 | 0.856 | [0.78,0.91] | 1.36e-01 | non | 58 | 0.810 | above | favorite | 0.842 | -6.74 | non |

## Verdict edge

**41 edge(s) retenu(s):**

- t=120 kmeans k=7 cible=up_won C2: n_ho=27 WR=0.741 entry=0.694 PnL=$9.60 (stake $4.0/trade, fee=0.0)
- t=120 kmeans k=8 cible=up_won C3: n_ho=25 WR=0.720 entry=0.699 PnL=$4.70 (stake $4.0/trade, fee=0.0)
- t=120 ward k=5 cible=up_won C4: n_ho=25 WR=0.760 entry=0.710 PnL=$9.25 (stake $4.0/trade, fee=0.0)
- t=120 ward k=6 cible=up_won C4: n_ho=25 WR=0.760 entry=0.710 PnL=$9.25 (stake $4.0/trade, fee=0.0)
- t=120 ward k=7 cible=up_won C4: n_ho=25 WR=0.760 entry=0.710 PnL=$9.25 (stake $4.0/trade, fee=0.0)
- t=120 ward k=8 cible=up_won C4: n_ho=25 WR=0.760 entry=0.710 PnL=$9.25 (stake $4.0/trade, fee=0.0)
- t=120 ward k=9 cible=up_won C4: n_ho=25 WR=0.760 entry=0.710 PnL=$9.25 (stake $4.0/trade, fee=0.0)
- t=120 ward k=10 cible=up_won C1: n_ho=22 WR=0.727 entry=0.715 PnL=$3.25 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=6 cible=up_won C5: n_ho=32 WR=0.781 entry=0.774 PnL=$1.87 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=7 cible=up_won C1: n_ho=35 WR=0.771 entry=0.760 PnL=$0.99 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=7 cible=fav_wins C5: n_ho=36 WR=0.639 entry=0.604 PnL=$10.22 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=8 cible=up_won C3: n_ho=34 WR=0.794 entry=0.785 PnL=$4.41 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=9 cible=up_won C4: n_ho=23 WR=0.696 entry=0.623 PnL=$10.05 (stake $4.0/trade, fee=0.0)
- t=300 kmeans k=9 cible=fav_wins C1: n_ho=43 WR=0.605 entry=0.598 PnL=$5.46 (stake $4.0/trade, fee=0.0)
- t=300 ward k=5 cible=up_won C4: n_ho=24 WR=0.792 entry=0.761 PnL=$1.17 (stake $4.0/trade, fee=0.0)
- t=300 ward k=6 cible=up_won C4: n_ho=24 WR=0.792 entry=0.761 PnL=$1.17 (stake $4.0/trade, fee=0.0)
- t=300 ward k=7 cible=up_won C4: n_ho=24 WR=0.792 entry=0.761 PnL=$1.17 (stake $4.0/trade, fee=0.0)
- t=300 ward k=8 cible=up_won C4: n_ho=24 WR=0.792 entry=0.761 PnL=$1.17 (stake $4.0/trade, fee=0.0)
- t=300 ward k=9 cible=up_won C4: n_ho=24 WR=0.792 entry=0.761 PnL=$1.17 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=4 cible=up_won C3: n_ho=50 WR=0.640 entry=0.621 PnL=$12.72 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=5 cible=up_won C2: n_ho=42 WR=0.690 entry=0.634 PnL=$25.63 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=6 cible=up_won C3: n_ho=44 WR=0.659 entry=0.644 PnL=$10.10 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=7 cible=fav_wins C0: n_ho=43 WR=0.674 entry=0.650 PnL=$4.85 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=8 cible=fav_wins C4: n_ho=44 WR=0.659 entry=0.642 PnL=$3.15 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=9 cible=up_won C8: n_ho=24 WR=0.792 entry=0.740 PnL=$7.77 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=9 cible=fav_wins C2: n_ho=34 WR=0.647 entry=0.640 PnL=$-0.30 (stake $4.0/trade, fee=0.0)
- t=450 kmeans k=10 cible=up_won C2: n_ho=25 WR=0.760 entry=0.699 PnL=$9.35 (stake $4.0/trade, fee=0.0)
- t=450 ward k=3 cible=up_won C1: n_ho=68 WR=0.765 entry=0.762 PnL=$-3.12 (stake $4.0/trade, fee=0.0)
- t=450 ward k=4 cible=up_won C0: n_ho=68 WR=0.765 entry=0.762 PnL=$-3.12 (stake $4.0/trade, fee=0.0)
- t=450 ward k=8 cible=up_won C7: n_ho=20 WR=0.900 entry=0.845 PnL=$5.30 (stake $4.0/trade, fee=0.0)
- t=450 ward k=8 cible=fav_wins C6: n_ho=25 WR=0.680 entry=0.672 PnL=$2.20 (stake $4.0/trade, fee=0.0)
- t=450 ward k=9 cible=up_won C7: n_ho=20 WR=0.900 entry=0.845 PnL=$5.30 (stake $4.0/trade, fee=0.0)
- t=450 ward k=9 cible=fav_wins C6: n_ho=25 WR=0.680 entry=0.672 PnL=$2.20 (stake $4.0/trade, fee=0.0)
- t=450 ward k=10 cible=up_won C7: n_ho=20 WR=0.900 entry=0.845 PnL=$5.30 (stake $4.0/trade, fee=0.0)
- t=450 ward k=10 cible=fav_wins C6: n_ho=24 WR=0.708 entry=0.672 PnL=$6.20 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=7 cible=up_won C4: n_ho=25 WR=0.920 entry=0.894 PnL=$4.21 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=7 cible=up_won C6: n_ho=33 WR=0.818 entry=0.811 PnL=$7.25 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=8 cible=up_won C1: n_ho=29 WR=0.828 entry=0.814 PnL=$-1.22 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=9 cible=up_won C3: n_ho=23 WR=0.913 entry=0.890 PnL=$3.73 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=10 cible=up_won C4: n_ho=23 WR=0.913 entry=0.890 PnL=$3.73 (stake $4.0/trade, fee=0.0)
- t=600 kmeans k=10 cible=up_won C5: n_ho=29 WR=0.828 entry=0.822 PnL=$8.51 (stake $4.0/trade, fee=0.0)

## Économie (rappel)

- Achat taker au ask à t, hold jusqu'à résolution, stake plat $4, payout $1/share
- Break-even WR ≈ prix d'entrée moyen
- Un cluster « favori gagne 75% » n'est **pas** un edge si le favori coûte 0.75

## Limites

- 677 fenêtres seulement; holdout ~30% → clusters fins ont n_ho souvent <20
- Multiplicité élevée (centaines de tests) → BH très conservateur
- Features book only; pas de microstructure latente / flow externe
- Assignation holdout par centroïde (Ward n'a pas de predict natif)
- Pas de coûts de latence / partial fills

## Conclusion et prochaines étapes

Quelques configurations franchissent le filtre edge; prioriser une validation forward (paper) sur ces (t, méthode, k, cluster) uniquement, avec taille d'échantillon plus large.

---
*Généré par `scripts/research/clustering-v2/study_a_moments.py` — aucun commit.*
