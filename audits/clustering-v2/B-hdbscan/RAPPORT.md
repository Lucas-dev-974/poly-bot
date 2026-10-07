# Étude B — Variables résumées + HDBSCAN

## Données

- Fichiers: `btc15_ticks_complete_…_28j.csv` / `btc15_windows_complete_…_28j.csv`
- Période: **2026-09-08 → 2026-10-05**, 677 fenêtres (Up 345 / Down 332)
- Train n=474 (2026-09-08 06:45:00+00:00 → 2026-09-18 16:00:00+00:00), P(Up)=0.504
- Holdout n=203 (2026-09-18 16:15:00+00:00 → 2026-10-05 07:15:00+00:00), P(Up)=0.522
- Prix book Up/Down uniquement; FEE=0

## Méthode

- Features résumées: vol mid_up, flips favori, max/min favorite ask, slope, time share fav ask≥0.70, mean/end spreads, mean/end ask_sum, mean/end depth imbalance, range mid, mid_up final
- Standardisation train; HDBSCAN grille min_cluster_size∈{10,20,40} × min_samples∈{5,10}
- **B1**: horizon [0,899) — **descriptif / look-ahead**, non tradable
- **B2**: horizon [0,300], décision à 300s — tradable; holdout assigné au médoïde train le plus proche (sinon noise)
- Edge (B2 seulement): BH train + même sens holdout n≥20 + WR > ask moyen

## B1 — Descriptif (look-ahead, NON tradable)

> Attention: features sur la fenêtre entière → fuite d'information. Sert uniquement à décrire la structure.

### mcs=10 ms=5: 2 clusters, noise=10.8%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 211 | 0.013 | 0.1818 | 8.7 | 0.653 | 0.60 |
| 1 | 212 | 0.988 | 0.1825 | 8.0 | 0.654 | 0.61 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 0.000 | 5.08e-65 | oui |
| 1 | 212 | 1.000 | 9.27e-64 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 1.000 | nan | non |
| 1 | 212 | 1.000 | nan | non |

### mcs=10 ms=10: 2 clusters, noise=16.9%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 193 | 0.013 | 0.1829 | 8.6 | 0.652 | 0.60 |
| 1 | 201 | 0.988 | 0.1823 | 7.6 | 0.649 | 0.62 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 0.000 | 1.55e-59 | oui |
| 1 | 201 | 1.000 | 1.74e-60 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 1.000 | nan | non |
| 1 | 201 | 1.000 | nan | non |

### mcs=20 ms=5: 2 clusters, noise=10.8%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 211 | 0.013 | 0.1818 | 8.7 | 0.653 | 0.60 |
| 1 | 212 | 0.988 | 0.1825 | 8.0 | 0.654 | 0.61 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 0.000 | 5.08e-65 | oui |
| 1 | 212 | 1.000 | 9.27e-64 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 1.000 | nan | non |
| 1 | 212 | 1.000 | nan | non |

### mcs=20 ms=10: 2 clusters, noise=16.9%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 193 | 0.013 | 0.1829 | 8.6 | 0.652 | 0.60 |
| 1 | 201 | 0.988 | 0.1823 | 7.6 | 0.649 | 0.62 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 0.000 | 1.55e-59 | oui |
| 1 | 201 | 1.000 | 1.74e-60 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 1.000 | nan | non |
| 1 | 201 | 1.000 | nan | non |

### mcs=40 ms=5: 2 clusters, noise=10.8%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 211 | 0.013 | 0.1818 | 8.7 | 0.653 | 0.60 |
| 1 | 212 | 0.988 | 0.1825 | 8.0 | 0.654 | 0.61 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 0.000 | 5.08e-65 | oui |
| 1 | 212 | 1.000 | 9.27e-64 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 211 | 1.000 | nan | non |
| 1 | 212 | 1.000 | nan | non |

### mcs=40 ms=10: 2 clusters, noise=16.9%
Profils (moyennes features train) — aperçu mid_up_t / vol / flips:
| C | n | mid_up_t | vol | flips | range | time≥0.70 |
|--:|--:|---------:|----:|------:|------:|----------:|
| 0 | 193 | 0.013 | 0.1829 | 8.6 | 0.652 | 0.60 |
| 1 | 201 | 0.988 | 0.1823 | 7.6 | 0.649 | 0.62 |

Cible `up_won`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 0.000 | 1.55e-59 | oui |
| 1 | 201 | 1.000 | 1.74e-60 | oui |

Cible `fav_wins`:
| C | n | WR | p | BH |
|--:|--:|---:|--:|:--:|
| 0 | 193 | 1.000 | nan | non |
| 1 | 201 | 1.000 | nan | non |

## B2 — Tradable (décision t=300s)

- Tests clusters: 4, BH-sig train: 1, edges: 0

### mcs=10 ms=5: 2 clusters, noise_train=79.3%, noise_holdout=0.18226600985221675

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|
| 0 | 82 | 0.561 | 3.22e-01 | non | 141 | 0.582 | up | 0.587 | 3.47 | non |
| 1 | 16 | 0.125 | 2.18e-03 | oui | 25 | 0.320 | down | 0.789 | -14.30 | non |

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|
| 0 | 82 | 0.683 | 8.11e-01 | non | 141 | 0.652 | favorite | 0.650 | 8.90 | non |
| 1 | 16 | 0.875 | 1.73e-01 | non | 25 | 0.680 | favorite | 0.802 | -16.31 | non |

### mcs=10 ms=10: 0 clusters, noise_train=100.0%, noise_holdout=1.0

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

### mcs=20 ms=5: 0 clusters, noise_train=100.0%, noise_holdout=1.0

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

### mcs=20 ms=10: 0 clusters, noise_train=100.0%, noise_holdout=1.0

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

### mcs=40 ms=5: 0 clusters, noise_train=100.0%, noise_holdout=1.0

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

### mcs=40 ms=10: 0 clusters, noise_train=100.0%, noise_holdout=1.0

#### Cible `up_won`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

#### Cible `fav_wins`

| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |
|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|

## Verdict edge (B2)

**Aucun edge économique robuste** sur B2: soit pas de signal BH sur train, soit non répliqué holdout, soit WR ≤ prix d'entrée implicite.

## Limites

- B1 look-ahead → ne pas trader
- HDBSCAN + assignation holdout heuristique (médoïde); noise souvent élevé
- Petite taille d'échantillon; BH conservateur
- Comparer WR au ask, pas seulement à la baseline P(Up)

## Conclusion et prochaines étapes

HDBSCAN sur résumés [0,300] ne livre pas d'edge holdout contre le prix implicite.
Prochaine étape: supervisé calibré (logistic / GBM) sur les mêmes features avec isotonic et EV vs ask, ou focus sur régimes de spread/ask_sum plutôt que clustering non supervisé.

---
*Généré par `scripts/research/clustering-v2/study_b_hdbscan.py` — aucun commit.*
