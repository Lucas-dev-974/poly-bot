# PHASE 1 — Développement Modèle IA Reconnaissance de Patterns

**Date :** 2026-09-26  
**Statut :** Proposition — à valider avant démarrage  
**Basé sur :** `SPEC-patterns.md`, `SPEC-next-market.md`, `RAPPORT-ml-feasibility.md`

---

## 1. Objectif de la Phase 1

**Découvrir et valider** les patterns intra-marché (carnet prix/liquidité) sur les données **actuellement disponibles** (510 fenêtres complètes) — sans attendre la collecte longue.

C'est le **Temps 1 (découverte non supervisée)** de `SPEC-patterns.md` §3.1, appliqué aux données existantes. Le but : **redécouvrir les 4 patterns codés à la main** (dip-revert, flip-confirm, early-conviction, antiflip = +$305 à +$623 en backtest officiel) comme preuve que la pipeline fonctionne, puis identifier ce qu'ils ont raté.

**Critère de sortie (Gate G-A1) :** ≥ 3/4 patterns implémentés redécouverts comme strates statistiquement distinctes, OU preuve documentée de non-séparabilité dans l'espace de features (matrice de confusion clusters vs patterns connus + silhouette score inter-clusters < 0.25).

> **Note importante :** La Phase 1 est **exploratoire** (P0 dans SPEC-patterns §8). La puissance statistique est limitée (n=510 fenêtres, ~1 contexte/fenêtre). Le filtre de pertinence strict (n ≥ 200, effet ≥ MDE) s'applique en **Phase 2 (P1)**. En Phase 1, on utilise un seuil assoupli `n ≥ 50` pour identifier les clusters candidats.

---

## 2. Périmètre — Ce qui EST dans la Phase 1

| Composant | Description | Livrable |
|-----------|-------------|----------|
| **SAX discrétisation** | Normalisation fenêtre glissante + PAA + quantification alphabet (~100 lignes TS) sur 5 séries : ask favori, askSum, spread, imbalance, profondeur cumulée (bid+ask) | `scripts/research/patterns-ml/sax.mts` |
| **Shapelets / motifs** | Extraction sous-séquences (longueurs 30/60/120 ticks) → **k-medoids (PAM) sur distance Hamming des chaînes SAX** (k paramétrable, défaut 12) → centroïdes = shapelets | `scripts/research/patterns-ml/shapelets.mts` |
| **Dataset builder** | Charge 510 fenêtres complètes → **1 contexte par fenêtre à elapsed fixe (défaut 30%, max 75%)** → features : séries brutes (5 séries) + représentations SAX + labels (outcome winner, direction prix 60s) + garde anti-fuite `ts(feature) < ts(décision)` + coupure `maxElapsedPct = 0.75` | `scripts/research/patterns-ml/dataset.mts` |
| **Découverte clusters** | Stats conditionnelles par cluster : n, P(Up gagne), direction 60s, WR moteurs existants (dip/flip/convergence/antiflip) dedans, filtre MDE assoupli (n ≥ 50, effet ≥ MDE), **contrôle causal : même conditionnement SANS pattern (features brutes seulement)**, **split-half validation (jours 1-4 vs 5-8)** | `scripts/research/patterns-ml/discover.mts` |
| **Rapport de découverte** | Clusters + stats + verdict « 4 moteurs redécouverts ? » + matrice confusion + patterns NOUVEAUX candidats | `model-ia/patterns/report-discovery-<ts>.md/.json` |

---

## 3. Périmètre — Ce qui N'EST PAS dans la Phase 1

| Exclu | Raison | Phase ultérieure |
|-------|--------|------------------|
| Entraînement modèle supervisé (logistique pooled multi-têtes) | Nécessite patterns validés par la découverte | Phase 2 (P1 dans SPEC-patterns) |
| Filtre de pertinence strict (n ≥ 200, effet ≥ MDE, bat B4/B5 en walk-forward) | Puissance insuffisante à n=510 ; Gate G-A2 | Phase 2 (P1) |
| Tâche B — patterns inter-marchés (streaks UUU→Down) | Sous-puissance à n=510 ; nécessite collecte 4 semaines partagée avec SPEC-next-market | Phase 3 (P2/P3) |
| Backtest économique / runner officiel | Gate G-ÉCO / G-RUNNER | Phase 4/5 |
| Intégration comme moteur natif | Nécessite GO complet + nouvelle spec wiring | Post-Phase 5 |

---

## 3. Stack & Contraintes Techniques

| Contrainte | Décision |
|------------|----------|
| **Langage** | 100 % TypeScript (`.mts` ESM) — décision repo, alignée SPEC-patterns §5 |
| **Dépendances ML** | **Aucune** — SAX, PAA, k-medoids (PAM), logistique implémentés en TS pur (pas de tfjs, pas de python). Règle repo : solutions boring > clever. |
| **Split validation** | Walk-forward par jour (jamais aléatoire) — même contrainte que SPEC-next-market §5.3 |
| **Anti-fuite** | Garde automatique `ts(feature) < ts(décision)` + test unitaire obligatoire dans `dataset.mts` + coupure `maxElapsedPct = 0.75` |
| **Réutilisation avec next-market** | Partager **uniquement utilitaires** : `evaluate.mts` (walk-forward splitter, baselines B1–B3, anti-leak test), `dataset/utils.mts` (chargement DB, filtres complétude). **Pas de partage du dataset builder** (structure radicalement différente : 1 ligne/fenêtre trans-fenêtres vs 1 ligne/contexte intra-fenêtre). |

---

## 4. Arborescence Cible

```
scripts/research/patterns-ml/
  sax.mts           # discrétisation SAX + PAA (utilitaire pur, testable unitairement)
  shapelets.mts     # extraction sous-séquences + k-medoids (PAM) distance Hamming sur SAX
  dataset.mts       # contextes ticks + labels + garde anti-fuite + coupure maxElapsedPct
  discover.mts      # temps 1 : clusters + stats conditionnelles + split-half + contrôle causal + filtre MDE
  evaluate.mts      # utilitaires partagés : walk-forward splitter, baselines B1–B3, anti-leak test
  utils.mts         # utilitaires partagés : chargement DB, filtres complétude (partagé next-market)
model-ia/patterns/
  report-discovery-<ts>.md/.json   # patterns découverts + stats + verdict G-A1 + matrice confusion
audits/backtest/patterns-ml/
  report-discovery-<ts>.md         # copie archivée + entrée index.md
```

---

## 5. Plan Détaillé — 2 Sessions (selon SPEC-patterns §8)

### Session 1 — Infrastructure + SAX + Shapelets + Dataset (≈ 4–5h)

| Étape | Description | Validation |
|-------|-------------|------------|
| 1.1 | Créer `scripts/research/patterns-ml/` + `model-ia/patterns/` + `audits/backtest/patterns-ml/` | Dossiers existent |
| 1.2 | `sax.mts` : normalisation z-score par fenêtre glissante (stride = windowTicks, pas de chevauchement) → PAA (10 segments) → quantification alphabet (taille paramétrable, défaut 8) sur 5 séries : ask favori, askSum, spread, imbalance, profondeur cumulée (bid+ask) | Test unitaire : série constante → même symbole ; série croissante → symboles croissants ; inverse → symboles décroissants |
| 1.3 | `shapelets.mts` : pour chaque fenêtre SAX, extraire sous-séquences longitudes [30, 60, 120] ticks → **k-medoids (PAM) avec distance Hamming** sur alphabets SAX (k paramétrable, défaut 12) → médiodes = shapelets représentatifs | Test : sur données synthétiques pattern connu (ex. V-shape dip = `aaabbbccc`), un médiod capture la forme ; silhouette score > 0.3 |
| 1.4 | `dataset.mts` : charge 510 fenêtres complètes → **1 contexte par fenêtre à `elapsedPct = 0.30` (configurable), rejet si `elapsedPct > 0.75`** → features : 5 séries brutes (60 ticks avant tick cible) + 5 représentations SAX + labels (outcome winner, direction prix 60s) + garde anti-fuite `feature.ts < decision.ts` | Test anti-fuite : `feature.ts < decision.ts` pour 100% lignes ; 1 ligne/fenêtre max ; 0 ligne après 75% elapsed |

### Session 2 — Découverte + Split-Half + Contrôle Causal + Rapport + Gate G-A1 (≈ 4–5h)

| Étape | Description | Validation |
|-------|-------------|------------|
| 2.1 | `discover.mts` : lance clustering sur 510 fenêtres × 1 contexte/fenêtre → pour chaque cluster : compte n, P(Up gagne), direction 60s, WR moteurs existants (dip/flip/convergence/antiflip) dedans | Sortie JSON structuré |
| 2.2 | **Split-half** : ré-entraîne clusters sur jours 1-4 seulement → prédit clusters jours 5-8 → compare stabilité (ARI > 0.6, centroïdes similaires) | Clusters instables = écartés |
| 2.3 | **Contrôle causal** : pour chaque cluster significatif (n ≥ 50), calcule Δ = P(Up\|pattern) - P(Up\|features_brutes_seulement) au même tick. Garde si Δ ≥ MDE(n) après correction Benjamini-Hochberg (FDR 10%) | Patterns redondants vs prix = écartés |
| 2.4 | Mapping clusters → 4 patterns connus : dip-revert, flip-confirm, early-conviction, antiflip. Au moins 3/4 doivent apparaître comme clusters distincts avec stats significatives (n ≥ 50, Δ ≥ MDE) | **Gate G-A1** : PASS/FAIL documenté + matrice confusion + silhouette inter-clusters |
| 2.5 | Génère `report-discovery-<ts>.md` : tableau clusters, stats, mapping patterns connus, verdict G-A1, patterns NOUVEAUX candidats (pour Phase 2) | Archive dans `audits/backtest/patterns-ml/` + maj `audits/backtest/index.md` |

---

## 6. Données d'Entrée (Disponibles Aujourd'hui)

| Source | Volume | Utilisation |
|--------|--------|-------------|
| `data/bot-live.db` → `book_snapshots` | 1 030 481 lignes (2 outcomes × ~1 Hz) | Séries ask/bid ± tailles, spread, profondeur |
| `data/bot-live.db` → `market_snapshots` | 515 445 lignes | volume, liquidity, lastTradePrice |
| `data/bot-live.db` → `market_resolutions` | 651 résolutions (510 avec fenêtre complète) | Labels outcome winner + fenêtre complète |
| Fenêtres complètes (≥ 801 ticks, gaps ≤ 60s, avec résolution) | **510** | Unité d'apprentissage = **1 contexte par fenêtre à elapsed fixe 30% (max 75%)** |

> **Note :** L'échantillonnage **1 contexte par fenêtre à elapsed fixe** (pas par tick, pas « premier tick pattern ») évite l'inflation per-tick qui a fait chuter un winrate de 67% → 48% dans l'historique du repo, et élimine la fuite circulaire.

---

## 7. Baselines de Référence (pour Phase 2, mais définies ici)

| # | Baseline | Définition |
|---|----------|------------|
| B1 | Constante 0,50 | Log-loss de référence |
| B2 | Base rate global / par session | Fréquences marginales |
| B3 | Markov-1 | P(next \| dernier outcome) — mesuré 48,3% continuité |
| B4 | **Ask courant** (tête outcome) | Prix affiché = meilleure proba implicite — **baseline la plus dure** |
| B5 | **Random walk** (tête direction 60s) | P(hausse)=0,5 |

> Règle : toute tête qui ne bat pas sa baseline en walk-forward est coupée (SPEC-patterns §4).
> **Phase 1 n'évalue PAS contre ces baselines** — c'est le rôle de Phase 2 (P1). Phase 1 = découverte + filtre causal + split-half.

---

## 8. Risques & Mitigations (Phase 1)

| Risque | Mitigation |
|--------|------------|
| **SAX/shapelets ne redécouvrent pas les 4 patterns** | Hyperparamètres bornés (alphabet 6–10, k 8–16, longueurs 30/60/120) — grille ≤ 12 combos testées sur train seulement ; si échec → diagnostique features (pas marché) |
| **Clusters trop grands / mélangés** | k-medoids (PAM) initialisé par k-medoids++ ; silhouette score pour choisir k ; **split-half (vieux jours vs jours récents) pour valider stabilité** (ARI > 0.6) |
| **Fuite temporelle subtile (artefacts fin de fenêtre)** | Test automatisé `feature.ts < decision.ts` dans `dataset.mts` + coupure `maxElapsedPct = 0.75` + audit manuel sur 10 fenêtres |
| **Multiple testing (dizaines de clusters)** | Correction Benjamini-Hochberg (FDR 10%) sur la famille de tests + **split-half validation** (leçon whipsaw) |
| **Patterns "existent" mais pas d'edge vs prix (redondance)** | **Contrôle causal obligatoire** : même conditionnement SANS pattern (features brutes seulement) — calcule Δ = P(Up\|pattern) - P(Up\|brut) |
| **Distance k-means inadaptée aux chaînes SAX** | **k-medoids (PAM) avec distance Hamming** — pas k-means euclidien. Implémentation TS pure (~50 lignes). |

---

## 9. Décisions à Valider Avant Démarrage

| # | Question | Recommandation | Votre Choix |
|---|----------|----------------|-------------|
| 1 | **Lancer Phase 1 maintenant ?** | Oui — données suffisantes, pas de blocage collecte | ⬜ Oui / ⬜ Non / ⬜ Modifier |
| 2 | **Alphabet SAX par défaut ?** | 8 symboles (équilibre granularité/bruit) | ⬜ 8 / ⬜ Autre : \_\_\_ |
| 3 | **k médiodes par défaut ?** | 12 (couvre 4 connus + marge découverte) | ⬜ 12 / ⬜ Autre : \_\_\_ |
| 4 | **Longueurs shapelets ?** | [10, 20, 40] segments PAA (≈ [30s, 1min, 2min] à 1 Hz, fenêtre complète) | ⬜ Valider / ⬜ Modifier |
| 5 | **elapsedPct échantillonnage ?** | 30% (configurable), max 75% (coupure artefacts fin fenêtre) | ⬜ 30% / ⬜ Autre : \_\_\_ |
| 6 | **Seuil n minimal Phase 1 ?** | 50 (exploratoire), 200 en Phase 2 | ⬜ 50 / ⬜ Autre : \_\_\_ |
| 7 | **Seuil MDE Phase 1 ?** | Puissance 80%, α=5% bilatéral → MDE(n=50) ≈ ±19 pts ; FDR 10% Benjamini-Hochberg | ⬜ Standard / ⬜ Autre |
| 8 | **Partage utilitaires avec next-market P0 ?** | Oui — `evaluate.mts` (walk-forward, baselines, anti-leak) + `dataset/utils.mts` (DB loading) uniquement | ⬜ Oui (recommandé) / ⬜ Séparé |

---

## 10. Livrables de Fin de Phase 1

1. **Code :** 4 fichiers `.mts` dans `scripts/research/patterns-ml/` (sax, shapelets, dataset, discover) + tests unitaires
2. **Rapport :** `model-ia/patterns/report-discovery-<ts>.md` avec :
   - Tableau clusters (id, n, P(Up), direction 60s, WR moteurs, p-value, MDE, Δ causal, verdict)
   - Mapping vers 4 patterns connus (dip/flip/convergence/antiflip) — **matrice de confusion**
   - **Split-half stability** (ARI, similarité centroïdes jours 1-4 vs 5-8)
   - **Verdict Gate G-A1** : PASS / FAIL + justification
   - Silhouette score inter-clusters (si < 0.25 → non-séparabilité documentée)
   - Liste patterns NOUVEAUX candidats pour Phase 2 (n ≥ 50, Δ ≥ MDE, stable split-half)
3. **Archive :** Copie dans `audits/backtest/patterns-ml/` + entrée `audits/backtest/index.md`
4. **Décision :** GO → Phase 2 (confirmation supervisée, filtre n ≥ 200, baselines B1–B5) OU STOP (pipeline features à revoir)

---

## 11. Estimation Effort Total

| Phase | Contenu | Effort |
|-------|---------|--------|
| **Phase 1 (cette prop.)** | Découverte non supervisée sur données actuelles | **2 sessions** |
| Phase 2 | Confirmation supervisée (logistique pooled) à n actuel | 1 session |
| Phase 3 | Collecte 4 semaines (partagée next-market) | ~0 actif |
| Phase 4 | Ré-entraînement final ~2 900 fenêtres + gates G-B2/G-ÉCO | 1–2 sessions |
| Phase 5 | Runner officiel + intégration | ½ session |

**Total actif : ~5 sessions** (identique à SPEC-patterns §8).

---

## 12. Prochaine Action

> **Si vous validez cette Phase 1** : je crée les 4 fichiers `.mts` squelettes + tests unitaires, puis on lance la Session 1.

**Commande pour démarrer :**
```bash
# Créer l'arborescence
mkdir -p scripts/research/patterns-ml model-ia/patterns audits/backtest/patterns-ml

# Puis je génère sax.mts, shapelets.mts, dataset.mts, discover.mts
```

---

*Document généré automatiquement depuis les specs existantes. À valider/amender avant exécution.*