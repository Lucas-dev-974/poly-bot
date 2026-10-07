# Synthèse — Clustering v2 (BTC 15m Polymarket)

## Données

- Période: **2026-09-08 → 2026-10-05** (28 j), fenêtres complètes (gaps ≤5s)
- N=677 (Up 345 / Down 332)
- Train n=474 (2026-09-08 06:45:00+00:00 → 2026-09-18 16:00:00+00:00), P(Up)=0.504
- Holdout n=203 (2026-09-18 16:15:00+00:00 → 2026-10-05 07:15:00+00:00), P(Up)=0.522
- Prix book Up/Down uniquement (pas de spot BTC); **FEE=0** (seul fee repo: repricingFeesRoundtrip=0.002, ignoré)

## Étude A — Clustering par moments

- Tests: 832 ; BH-sig train: 307 ; edges complets: **41** (configs corrélées)
- Edges uniques approx. (t, méthode, cible, côté): **13**

### Meilleurs edges holdout (par PnL)

| t | méthode | k | cible | C | côté | n_ho | WR_ho | entry | PnL | p(train) |
|--:|:--------|--:|:------|--:|:----:|-----:|------:|------:|----:|---------:|
| 450 | kmeans | 5 | up_won | 2 | up | 42 | 0.690 | 0.634 | 25.63 | 1.32e-02 |
| 450 | kmeans | 4 | up_won | 3 | down | 50 | 0.640 | 0.621 | 12.72 | 1.04e-02 |
| 300 | kmeans | 7 | fav_wins | 5 | favorite | 36 | 0.639 | 0.604 | 10.22 | 1.28e-02 |
| 300 | kmeans | 9 | up_won | 4 | down | 23 | 0.696 | 0.623 | 10.05 | 8.64e-04 |
| 120 | kmeans | 7 | up_won | 2 | up | 27 | 0.741 | 0.694 | 9.60 | 4.64e-05 |
| 120 | ward | 5 | up_won | 4 | up | 25 | 0.760 | 0.710 | 9.25 | 4.05e-05 |
| 600 | kmeans | 10 | up_won | 5 | up | 29 | 0.828 | 0.822 | 8.51 | 3.20e-09 |
| 450 | ward | 10 | fav_wins | 6 | favorite | 24 | 0.708 | 0.672 | 6.20 | 1.09e-02 |
| 450 | ward | 8 | up_won | 7 | up | 20 | 0.900 | 0.845 | 5.30 | 6.49e-07 |
| 450 | kmeans | 7 | fav_wins | 0 | favorite | 43 | 0.674 | 0.650 | 4.85 | 8.84e-03 |
| 300 | kmeans | 8 | up_won | 3 | up | 34 | 0.794 | 0.785 | 4.41 | 5.68e-09 |
| 600 | kmeans | 7 | up_won | 4 | down | 25 | 0.920 | 0.894 | 4.21 | 1.61e-09 |

Rapport détaillé: `audits/clustering-v2/A-par-moments/RAPPORT.md`

## Étude B — HDBSCAN résumés

- **B1** [0,899): descriptif look-ahead — 2 clusters, noise ~11–17% ; **non tradable**
- **B2** [0,300] tradable: surtout du bruit (noise 79–100%); mcs=10/ms=5 → 2 clusters
- B2: tests=4, BH-sig=1, **edges=0**

Rapport: `audits/clustering-v2/B-hdbscan/RAPPORT.md`

## Verdict global

L'étude A détecte des écarts économiques **marginaux** sur holdout pour certains clusters (souvent des régimes où mid_up/ask sont déjà informatifs). Les n_ho sont petits (20–40), les configs se chevauchent, et le PnL cumulé reste modeste (quelques $ à dizaines de $ sur ~20–40 trades à stake $4).
L'étude B (HDBSCAN) **ne confirme aucun edge** tradable à t=300.
**Conclusion prudente:** pas de signal clustering robuste et scalable ; les « edges » A sont fragiles hors-échantillon et sous forte multiplicité.

## Prochaine étape recommandée

1. Réduire la multiplicité: fixer t=300, KMeans k=3–6, une seule cible.
2. Supervisé calibré (proba vs ask) avec EV explicite plutôt que clustering non supervisé.
3. Ou bandes simples (fav ask ∈ [0.55, 0.70] à t=300) avec le même protocole holdout/BH/économie.

---
*Aucun commit. Scripts: `scripts/research/clustering-v2/`*
