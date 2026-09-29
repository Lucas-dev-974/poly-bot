# Sweep Hyperparamètres — Clustering SAX

**Date:** 2026-09-26T10:44:42.171Z
**Données:** 1850 fenêtres, baseline P(Up)=0.5086
**Grille:** série {levels,returns} × paa {60,120,200} × alphabet {6,8,10} × k {4,8,12,16} = 72 configs
**Critères:** silhouette ≥ 0.25 (séparabilité), ARI ≥ 0.6 (stabilité), BH-FDR 0.1 + |ΔP| ≥ MDE(n≥50)

## Top 10 configs (score = silhouette + ARI + 2×nb clusters significatifs)

| # | série | paa | alphabet | k | silhouette | ARI | clus n≥50 | maxAbsΔP | BH-sig | verdict |
|---|-------|-----|----------|---|------------|-----|-----------|----------|--------|---------|
| 1 | levels | 60 | 6 | 4 | 0.059 | 0.457 | 4 | 0.0286 | 0 | ❌ |
| 2 | levels | 200 | 8 | 4 | 0.035 | 0.467 | 4 | 0.0220 | 0 | ❌ |
| 3 | levels | 200 | 10 | 4 | 0.056 | 0.423 | 4 | 0.0469 | 0 | ❌ |
| 4 | levels | 120 | 8 | 4 | 0.046 | 0.374 | 4 | 0.0279 | 0 | ❌ |
| 5 | levels | 60 | 8 | 4 | 0.047 | 0.338 | 4 | 0.0188 | 0 | ❌ |
| 6 | levels | 200 | 6 | 4 | 0.055 | 0.289 | 4 | 0.0240 | 0 | ❌ |
| 7 | levels | 120 | 10 | 4 | 0.032 | 0.300 | 4 | 0.0160 | 0 | ❌ |
| 8 | levels | 60 | 10 | 4 | 0.049 | 0.255 | 4 | 0.0258 | 0 | ❌ |
| 9 | levels | 120 | 6 | 12 | 0.042 | 0.234 | 12 | 0.0642 | 0 | ❌ |
| 10 | levels | 60 | 8 | 8 | 0.025 | 0.240 | 8 | 0.0801 | 0 | ❌ |

## Synthèse par dimension (moyennes)

- **Série:** levels sil=0.028 vs returns sil=0.018
- **paa=60:** sil=0.015
- **paa=120:** sil=0.025
- **paa=200:** sil=0.028
- **alphabet=6:** sil=0.019
- **alphabet=8:** sil=0.024
- **alphabet=10:** sil=0.026
- **k=4:** sil=0.046, ari=0.211
- **k=8:** sil=0.019, ari=0.144
- **k=12:** sil=0.015, ari=0.156
- **k=16:** sil=0.011, ari=0.140

## Détail de la meilleure config

**levels, paa=60, alphabet=6, k=4** — silhouette=0.059, ARI=0.457

| Cluster | n | P(Up) | ΔP | p-value | BH-sig |
|---------|---|-------|-----|---------|--------|
| 0 | 569 | 0.5237 | +0.0151 | 0.4982 | ❌ |
| 1 | 367 | 0.5177 | +0.0091 | 0.7682 | ❌ |
| 2 | 427 | 0.4801 | -0.0286 | 0.2577 | ❌ |
| 3 | 487 | 0.5092 | +0.0006 | 1.0000 | ❌ |
