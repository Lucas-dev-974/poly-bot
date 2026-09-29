# Sweep Hyperparamètres — Clustering SAX

**Date:** 2026-09-26T08:03:51.939Z
**Données:** 1146 fenêtres, baseline P(Up)=0.5035
**Grille:** série {levels,returns} × paa {60,120,200} × alphabet {6,8,10} × k {4,8,12,16} = 72 configs
**Critères:** silhouette ≥ 0.25 (séparabilité), ARI ≥ 0.6 (stabilité), BH-FDR 0.1 + |ΔP| ≥ MDE(n≥50)

## Top 10 configs (score = silhouette + ARI + 2×nb clusters significatifs)

| # | série | paa | alphabet | k | silhouette | ARI | clus n≥50 | maxAbsΔP | BH-sig | verdict |
|---|-------|-----|----------|---|------------|-----|-----------|----------|--------|---------|
| 1 | levels | 200 | 8 | 4 | 0.049 | 0.363 | 4 | 0.0080 | 0 | ❌ |
| 2 | levels | 200 | 10 | 4 | 0.027 | 0.353 | 4 | 0.0156 | 0 | ❌ |
| 3 | levels | 120 | 6 | 4 | 0.051 | 0.302 | 4 | 0.0196 | 0 | ❌ |
| 4 | levels | 60 | 6 | 4 | 0.053 | 0.279 | 4 | 0.0257 | 0 | ❌ |
| 5 | levels | 120 | 8 | 4 | 0.052 | 0.269 | 4 | 0.0080 | 0 | ❌ |
| 6 | levels | 60 | 8 | 4 | 0.052 | 0.265 | 4 | 0.0240 | 0 | ❌ |
| 7 | returns | 120 | 10 | 8 | 0.048 | 0.262 | 8 | 0.0038 | 0 | ❌ |
| 8 | returns | 120 | 10 | 12 | 0.036 | 0.259 | 12 | 0.0004 | 0 | ❌ |
| 9 | returns | 120 | 10 | 16 | 0.028 | 0.265 | 16 | 0.0019 | 0 | ❌ |
| 10 | levels | 60 | 10 | 4 | 0.031 | 0.258 | 4 | 0.0243 | 0 | ❌ |

## Synthèse par dimension (moyennes)

- **Série:** levels sil=0.025 vs returns sil=0.021
- **paa=60:** sil=0.018
- **paa=120:** sil=0.026
- **paa=200:** sil=0.026
- **alphabet=6:** sil=0.021
- **alphabet=8:** sil=0.022
- **alphabet=10:** sil=0.027
- **k=4:** sil=0.041, ari=0.174
- **k=8:** sil=0.025, ari=0.133
- **k=12:** sil=0.015, ari=0.128
- **k=16:** sil=0.012, ari=0.138

## Détail de la meilleure config

**levels, paa=200, alphabet=8, k=4** — silhouette=0.049, ARI=0.363

| Cluster | n | P(Up) | ΔP | p-value | BH-sig |
|---------|---|-------|-----|---------|--------|
| 0 | 312 | 0.5064 | +0.0029 | 0.9630 | ❌ |
| 1 | 351 | 0.5071 | +0.0036 | 0.9342 | ❌ |
| 2 | 222 | 0.4955 | -0.0080 | 0.8641 | ❌ |
| 3 | 261 | 0.5019 | -0.0016 | 1.0000 | ❌ |
