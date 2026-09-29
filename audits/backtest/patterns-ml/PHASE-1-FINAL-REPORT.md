# PHASE 1 — RAPPORT FINAL : Découverte de Patterns (Clustering non supervisé)

**Date de clôture :** 2026-09-26
**Statut :** ✅ TERMINÉE — verdict **non-séparabilité documentée** (issue alternative prévue au Gate G-A1)
**Décision :** Arrêt de la piste clustering. Pas de Phase 2 supervisée lancée sur cette base.

---

## 1. Résumé exécutif

La Phase 1 avait pour objectif de **redécouvrir les 4 patterns codés à la main** (dip-revert, flip-confirm, early-conviction, antiflip) comme strates statistiques distinctes, afin de valider la pipeline ML avant d'entraîner un modèle supervisé.

**Résultat : les deux critères de sortie du Gate G-A1 sont tranchés, tous deux en échec :**

| Critère G-A1 | Seuil | Mesuré | Verdict |
|---|---|---|---|
| Patterns redécouverts comme clusters significatifs | ≥ 3/4 | **0/4** | ❌ |
| Non-séparabilité documentée (silhouette < 0.25) | — | silhouette = **0.031** | ✅ prouvée |

Le clustering SAX/k-medoids sur les fenêtres BTC 15m up/down **ne capture aucune structure directionnelle exploitable**. Un sweep systématique de **72 configurations d'hyperparamètres** confirme que ce n'est pas un problème de réglage : **0/72 configs** n'atteint les seuils de séparabilité/stabilité/significativité.

**C'est un résultat négatif valide et reproductible**, obtenu avec des contrôles statistiques rigoureux (MDE, test binomial exact Clopper-Pearson, Benjamini-Hochberg FDR 10%, validation split-half ARI, contrôle causal logistique out-of-cluster, baseline prix B4).

---

## 2. Ce qui a été construit

Pipeline 100 % TypeScript (`.mts` ESM), zéro dépendance ML, dans `model-ia/scripts/research/patterns-ml/` :

| Fichier | Rôle | État |
|---|---|---|
| `sax.mts` | Discrétisation SAX (z-norm → PAA → re-z-norm → quantiles gaussiens) | ✅ corrigé (re-z-norm post-PAA, cf. arXiv 1210.5118) |
| `shapelets.mts` | k-medoids (PAM exact) sur distance Hamming, matrice de distances Uint16 plate, swaps O(n), CLARA déterministe (mulberry32) | ✅ réécrit |
| `dataset.mts` | Chargement 1146 fenêtres, features contexte, labels, garde anti-fuite | ✅ corrigé (requêtes groupées, book snapshots à la place de market_snapshots) |
| `discover.mts` | Clustering plein-fenêtre + ARI split-half réel + régression logistique Newton-Raphson + baseline B4 + binomial exact + BH step-up | ✅ réécrit |
| `engine-replay.mts` | Replay des 4 moteurs natifs sur les fenêtres DB + matrice moteurs × clusters | ✅ créé |
| `sweep-hparams.mts` | Grille 72 configs {série} × {paa 60/120/200} × {alphabet 6/8/10} × {k 4/8/12/16} | ✅ créé |
| `unit-tests.mts` | 24 tests unitaires (SAX, Hamming, PAM déterminisme, MDE, binomial exact, BH, ARI, logistique) | ✅ 24/24 passants |

**Bugs majeurs corrigés en cours de route :**
- Comparaison Hamming sur longueurs mixtes → crash (protection + clustering plein-fenêtre)
- Rapports vides (`medoids: []`) → shapelets impossibles avec longueurs [30,60,120] sur SAX 10 symboles
- Hang de 9 min sur `buildDataset` → N+1 query + full-scan `market_snapshots` (515k lignes × 1143 fenêtres)
- `windowStart` déjà en ms multiplié par 1000 → 0 trades pour 3 moteurs

---

## 3. Résultats principaux

### 3.1 Découverte — Gate G-A1 (rapport `report-discovery-2026-09-26T07-30-51-239Z`)

- **0/4 patterns redécouverts.** Les correspondances cluster↔moteur trouvées (antiflip ×3, dip-revert ×1) ont des ΔP de −7.3% à +8.1%, toutes non significatives (p ≥ 0.09, BH-sig = ❌).
- **Silhouette : 0.031** (seuil non-séparabilité : 0.25) — clusters sans structure réelle.
- **ARI split-half : 0.146** (seuil : 0.6) — les clusters ne se reproduisent pas entre la 1ère et la 2ème moitié des jours.
- **Contrôle causal :** le conditionnement par features brutes (logit) et par prix (B4) explique tout ce que les clusters "expliquent". Aucun edge résiduel.

### 3.2 WR des moteurs réels (rapport `report-engine-replay-2026-09-26T07-35-36-672Z`)

Replay sur 1145 fenêtres DB (1083 avec ≥1 signal), convention leader = max ask :

| Moteur | Entrées | WR | Prix moyen | EV/share | t-stat |
|---|---|---|---|---|---|
| early-conviction | 665 | **64.8%** | 0.612 | **+3.6¢** | 1.94 |
| dip-revert | 835 | 60.2% | 0.598 | +0.4¢ | 0.26 |
| flip-confirm | 550 | 59.1% | 0.584 | +0.7¢ | 0.32 |
| antiflip | 668 | 43.1% | 0.432 | −0.1¢ | −0.04 |

**Lecture :** `early-conviction` est le seul moteur dont l'EV dépasse la marge de bruit (t=1.94, non significatif à n=665, MDE ≈ ±9%). Aucun moteur ne bat statistiquement son prix d'entrée moyen. Les WR élevés (60–65%) s'expliquent par l'achat de favoris à 0.58–0.61 — c'est la baseline prix, pas de l'alpha.

### 3.3 Sweep hyperparamètres — 72 configs (rapport `report-hparam-sweep-2026-09-26T08-03-51-900Z`)

Grille : {levels, returns} × paa {60,120,200} × alphabet {6,8,10} × k {4,8,12,16} sur 1146 fenêtres, exécutée en 54 s.

- **0/72 configs** avec un seul cluster significatif après BH-FDR 10%.
- Meilleure config (levels, paa=200, alphabet=8, k=4) : silhouette 0.049, ARI 0.363, maxAbsΔP = 0.8%, p-values 0.86–1.00.
- Tendances : silhouette max à k=4 (0.041) et décroît avec k ; alphabet 10 > 8 > 6 (négligeable) ; paa 120–200 > 60 (négligeable).
- **Conclusion : l'échec n'est pas un problème d'hyperparamétrage.** L'espace SAX/Hamming ne contient pas la structure recherchée sur ces données.

---

## 4. Verdict sur le Gate G-A1

Le plan de Phase 1 (`PHASE-1-DEVELOPMENT.md` §1) prévoyait deux issues :

> "≥ 3/4 patterns redécouverts **OU preuve documentée de non-séparabilité** dans l'espace de features (silhouette < 0.25)"

L'issue alternative est **atteinte et documentée** : silhouette = 0.031 << 0.25, ARI = 0.146 << 0.6, 0/72 configs significatives, contrôle causal négatif. La pipeline fonctionne (24/24 tests, données chargées, stats correctes) — **c'est la donnée qui ne contient pas le signal dans cette représentation**.

## 5. Limites connues de ce verdict

À garder en tête avant toute conclusion définitive sur les données elles-mêmes :

1. **n = 1146 fenêtres** (~8 jours). La puissance statistique reste faible : MDE ≈ ±9% par cluster à n≈200. Un vrai edge de +3–5% serait invisible à cette taille d'échantillon.
2. **Représentation testée unique** : SAX plein-fenêtre + Hamming. DTW, features spectrales, ou shapelets sous-séquences n'ont pas été testés (le shapelet sous-séquence a été abandonné après le premier échec).
3. **Horizon unique** : clusters figés à elapsed fixe ; pas de dynamique temporelle intra-fenêtre modélisée.
4. **Labels binaires only** : P(Up gagne). Le prix d'entrée (EV) n'entre pas dans le critère de significativité des clusters.

## 6. Artefacts produits (inventaire)

```
model-ia/scripts/research/patterns-ml/
  sax.mts  shapelets.mts  dataset.mts  discover.mts
  engine-replay.mts  sweep-hparams.mts  unit-tests.mts
model-ia/patterns/
  report-discovery-2026-09-26T07-30-51-239Z.md/.json   # G-A1 final
  report-engine-replay-2026-09-26T07-35-36-672Z.md/.json
  report-hparam-sweep-2026-09-26T08-03-51-900Z.md/.json/.csv   # 72 configs
  (+ rapports intermédiaires 05-06, 05-34, 07-17, 07-20 ; engine-replay 07-34 ×2)
model-ia/PHASE-1-DEVELOPMENT.md   # plan initial
model-ia/PHASE-1-FINAL-REPORT.md  # ce document
```

## 7. Décision et suite

**Décision : arrêt de la partie IA ici**, conformément au choix validé. Aucun modèle supervisé n'est entraîné sur cette base — le prérequis de la Phase 2 (patterns validés) n'est pas rempli, et un classifieur supervisé sur les mêmes features apprendrait le bruit ou la baseline prix (le contrôle logistique out-of-cluster l'a démontré).

**Si la piste est un jour reprise**, les angles mentionnés en §5 sont les seuls justifiés par ce qui précède : (a) collecte de données supplémentaire pour la puissance statistique, (b) représentation alternative (DTW / spectrale), (c) critère EV plutôt que P(Up) seul. La pipeline et les 24 tests unitaires sont prêts à être réutilisés tels quels.