# SPÉCIFICATION — Modèle IA « patterns »
## Reconnaissance de patterns intra-marché (prix/liquidité) + patterns d'outcome inter-marchés

**Date :** 2026-09-16 · **Statut :** spécification v1 (à valider avant implémentation)
**Liée à :** `model-ia/SPEC-next-market.md` (collecte, gates G1, infra dataset partagées — ne pas dupliquer)
**Stack :** 100 % TypeScript (décision déjà prise, valable pour cette spec) · **Rôle :** recherche standalone d'abord, intégration seulement si baselines battues.

---

## 1. Objectif — deux tâches couplées, une seule pipeline

### Tâche A — Patterns intra-marché (prix / liquidité)
Reconnaître des **configurations de carnet récurrentes** au sein d'une fenêtre 15m et estimer ce qu'elles prédisent :

```
Contexte = fenêtre glissante de ~120 ticks (2 min) sur les 2 outcomes :
  séries bestBid/bestAsk ± tailles, ask2/ask3, bid2/bid3, spread, volume
─────────────────────────────────────
Sorties (têtes multiples) :
  (1) classe de pattern (découverte non supervisée, puis nommage humain)
  (2) P(Up gagne la fenêtre) — outcome head
  (3) direction du prix dans les 60 s suivantes — price head
Usage : pattern détecté → edge vs prix affiché → entrée/sortie
```

**Pertinence à vérifier (demande explicite de l'utilisateur) :** « à voir la pertinence ». Réponse mesurée : la pertinence est **déjà prouvée pour 4 patterns codés à la main** (dip-revert, flip-confirm, early-conviction, antiflip = +$305 à +$623 en backtest officiel). La tâche A ne part pas de zéro : elle doit **redécouvrir ces 4** (critère de validation minimal) puis chercher ce qu'ils ont raté.

### Tâche B — Patterns d'outcome inter-marchés (séquences type `up > up > down`)
Apprendre si l'historique des gagnants des fenêtres successives d'un même asset prédit le prochain :

```
Séquence des winners BTC 15m consécutifs (0=Up, 1=Down)
Features : streak courant, transitions Markov k=1..3, fréquences glissantes
─────────────────────────────────────
Sortie : P(Down gagne la prochaine fenêtre)
```

---

## 2. État mesuré — ce que disent les données (probe `scripts/research/ml-feasibility/probe-streaks.ts`)

### 2.1 Tâche B : P(Down) conditionné au préfixe d'outcomes, BTC 15m

| Préfixe | P(Down ensuite) | n | Effet min détectable (80 % puissance) |
|---|---:|---:|---:|
| **UUU** | **57,4 %** | 68 | ±17 pts |
| DDD | 55,6 % | 81 | ±16 pts |
| DUD | 55,3 % | 85 | ±15 pts |
| UDU | 53,6 % | 84 | ±15 pts |
| DUU | 52,4 % | 82 | ±15 pts |
| DDU | 47,6 % | 82 | ±15 pts |
| UDD | 43,9 % | 82 | ±15 pts |
| UUD | 43,2 % | 81 | ±16 pts |
| **Continuité globale** (dernier outcome se répète) | **48,3 %** | 644 | ≈ pile ou face |

**Lecture honnête :**
- L'intuition de l'utilisateur (« après des up, un down ») est **directionnellement présente** : UUU → 57,4 % de Down ensuite (+7,4 pts vs 50 %). C'est la seule strate au-dessus de 55 %.
- Mais avec n≈80 par bucket, l'effet minimal détectable est ±15–17 pts : **aucune de ces valeurs n'est statistiquement distinguishable du hasard aujourd'hui**.
- La continuité pure (48,3 %, n=644) = pas d'effet Markov-1. Le carnet prix déjà ces dépendances ou elles n'existent pas — indiscernable à ce n.
- **Projection après collecte 4 semaines** (~2 900 fenêtres, cf. SPEC-next-market) : ~350 fenêtres par bucket 3-lettres → MDE ±9 pts. L'effet UUU observé (+7,4) resterait **sous** le seuil. Conséquence : la tâche B ne peut pas vivre sur des buckets par préfixe ; elle doit **mutualiser la puissance via un modèle pooled** (logistique avec features de streak — chaque fenêtre contribue à tous les coefficients au lieu d'estimer un bucket isolé). C'est exactement la tâche B de la spec next-market : cette spec la REPREND telle quelle, en y ajoutant la tête « pattern ».

### 2.2 Tâche A : la donnée est abondante

510 fenêtres complètes × ~800 ticks × 14 colonnes carnet = **~400 000 contextes de ticks** exploitables dès aujourd'hui. La contrainte de la tâche A n'est pas n, c'est le **label** : un « pattern » n'a de valeur que s'il prédit (outcome, direction à 60 s, ou profit d'entrée) mieux que le prix courant.

---

## 3. Méthodologie — découverte puis confirmation (deux temps séparés)

### 3.1 Temps 1 : découverte non supervisée (laisser les patterns émerger)

1. **Discrétisation SAX** (Symbolic Aggregate approXimation — ~100 lignes TS : normalisation par fenêtre glissante + PAA + quantification en alphabet) sur les séries clés : ask favori, askSum, spread, imbalance, profondeur cumulée.
2. **Dictionnaire de shapelets** : extraire les sous-séquences motifs (longueurs 30/60/120 ticks) les plus fréquents/contrastés par clustering k-means sur les fenêtres SAX.
3. **Nommer** : chaque cluster reçoit ses stats conditionnelles (P(outcome), direction 60 s, WR des moteurs existants dedans) — les clusters qui recoupent dip/flip/convergence doivent apparaître naturellement (validation de la méthode).
4. **Filtre de pertinence** (répond directement au « à voir la pertinence ») : un pattern est retenu si (a) n ≥ 200 contextes, (b) écart conditionnel ≥ MDE à ce n, (c) il n'est PAS une redondance du prix courant (le contrôle causal du repo : même conditionnement sans l'événement pattern).

### 3.2 Temps 2 : confirmation supervisée (ce qui survit devient un modèle)

- **Modèle pooled unique** (une logistique TS, même architecture que SPEC-next-market §5) avec :
  - features de pattern (activation de chaque shapelet retenu, 0/1 ou distance),
  - features de streak (tâche B),
  - features carnet instantanées (baseline de contrôle).
- **Têtes multiples** : outcome (P(Up)), direction 60 s, qualité d'entrée (score calibré).
- **Walk-forward par jour** (identique SPEC-next-market §5.3 — jamais aléatoire).

### 3.3 Critère d'acceptation de la découverte

> Le modèle doit **redécouvrir au moins 3 des 4 patterns déjà implémentés** (dip, flip, convergence, antiflip) comme strates statistiquement distinctes, OU démontrer qu'ils ne sont pas séparables dans l'espace de features retenu.

C'est le test de fidélité de la pipeline : si la découverte non supervisée ne retrouve pas des patterns qui rapportent +$300-600 en backtest officiel, le problème est dans la pipeline de features, pas dans le marché.

---

## 4. Baselines à battre (identiques en esprit à SPEC-next-market §4, adaptées)

| # | Baseline | Définition |
|---|---|---|
| B1 | Constante 0,50 | référence log-loss |
| B2 | Base rate global / par session | fréquences marginales |
| B3 | Markov-1 | P(next \| dernier outcome) — mesuré : 48,3 % continuité = mort-née, à confirmer en walk-forward |
| B4 | **Ask courant** (tête outcome) | le prix affiché est déjà la meilleure proba implicite — baseline la plus dure |
| B5 | **Random walk** (tête direction 60 s) | P(hausse)=0,5 ; le prix à t prédit le prix à t+60s moins bien que ça = signal |

**Règle de survie :** toute tête qui ne bat pas sa baseline en walk-forward est coupée. Un pattern qui « existe » (test statistique) mais ne bat pas B4/B5 économiquement est un pattern mort — rapporté comme tel, pas intégré.

---

## 5. Architecture & arborescence (100 % TS)

```
scripts/research/patterns-ml/
  sax.mts           # discrétisation SAX + PAA (utilitaire pur, testable)
  shapelets.mts     # extraction/clustering de motifs
  dataset.mts       # contextes de ticks + labels + garde anti-fuite (ts feature < ts décision)
  discover.mts      # temps 1 : clusters + stats conditionnelles + filtre MDE
  train.mts         # temps 2 : logistique pooled multi-têtes (réutilise celle de next-market)
  evaluate.mts      # walk-forward, baselines B1–B5, attribution par jour
model-ia/patterns/
  report-discovery-<ts>.md/.json   # patterns découverts + stats
  report-confirm-<ts>.md/.json    # résultats walk-forward vs baselines
audits/backtest/patterns-ml/      # rapport final + index.md
```

Composants partagés avec next-market (ne pas dupliquer) : dataset builder, logistique, évaluateur walk-forward. Les scripts `ml-feasibility/` restent des probes jetables.

---

## 6. Gates GO / NO-GO

| Gate | Condition | Conséquence |
|---|---|---|
| **G-A1 découverte** | ≥ 3/4 patterns implémentés redécouverts, ou preuve de non-séparabilité | sinon : pipeline de features à revoir AVANT toute conclusion marché |
| **G-A2 pertinence** | ≥ 1 pattern NOUVEAU (non couvert par les moteurs existants) : n ≥ 200, effet ≥ MDE, bat B4/B5 en walk-forward | sinon : stop tâche A, les moteurs existants sont saturés |
| **G-B1 puissance** | collecte ≥ 2 000 fenêtres (partagée avec SPEC-next-market G1) | sinon : étendre la collecte |
| **G-B2 effet pooled** | logistique streak, coefficient de streak significatif (t ≥ 2) en walk-forward, bat B3 | sinon : stop tâche B, pas de dépendance inter-fenêtres |
| **G-ÉCO** | politique d'entrée sur patterns retenus : PnL sim positif ≥ 3 semaines/4, EV ≥ 0,02/share pré-enregistré | sinon : stop |
| **G-RUNNER** | runner officiel positif, calibration sim↔runner ±1 % | GO intégration (moteur natif ou filtre de qualité pour les moteurs existants) |

---

## 7. Risques spécifiques

| Risque | Mitigation |
|---|---|
| **Redondance pattern ≠ information** — un pattern peut « exister » sans porter d'info au-delà du prix courant (leçon dip-guard : l'entrée ≈ proba implicite = pas d'edge) | contrôle causal obligatoire : même conditionnement SANS l'événement pattern (pattern des moteurs new-strats) |
| **Multiple testing** — des dizaines de clusters testés → faux positifs garants | correction Benjamini-Hochberg sur la famille de tests + split-half (vieux jours vs jours récents, leçon whipsaw) |
| **Per-tick inflation** — 400k contextes corrélés | stats d'effet toujours résumées PAR FENÊTRE (un contexte déclencheur par fenêtre), jamais par tick |
| **Fuite temporelle** | garde automatique ts(feature) < ts(décision) + fenêtre glissante ne regarde que le passé |
| **Tâche B sous-puissance permanente** | pooling obligatoire (pas de buckets) + rapport honnête si l'effet reste < MDE après collecte : la dépendance inter-fenêtres n'existe pas, c'est un résultat |
| **Surfitting SAX/shapelets** (hyperparamètres : alphabet, longueurs) | hyperparamètres fixés sur le train uniquement, grille bornée (≤ 12 combinaisons), test walk-forward intact |

---

## 8. Phasage & effort

| Phase | Contenu | Effort |
|---|---|---|
| **P0 — outil + découverte** (immédiat, n actuel suffit) | sax.mts, shapelets.mts, dataset.mts, discover.mts sur 510 fenêtres ; G-A1 | 2 sessions |
| **P1 — confirmation à n actuel** | train/evaluate, baselines B1–B5 ; G-A2 (puissance limitée : seul un gros pattern survivra) | 1 session |
| **P2 — collecte** | partagée avec SPEC-next-market (4 semaines, passif) | ~0 |
| **P3 — confirmation finale** | ré-entraînement à ~2 900 fenêtres, G-B2 + G-ÉCO | 1–2 sessions |
| **P4 — runner officiel** | G-RUNNER → GO/NO-GO intégration | ½ session |

**Total effort actif : ~5 sessions** + collecte passive partagée avec la spec next-market (les deux specs consomment la même phase de collecte — lancer les deux P0 en même temps).

---

## 9. Ce que cette spec NE promet PAS

- Que des patterns nouveaux existent : les 4 moteurs actuels sont peut-être saturants (G-A2 est conçu pour le dire proprement).
- Que la tâche B aboutisse : l'effet observé (+7,4 pts sur UUU) est sous la puissance détectable même après 4 semaines de collecte ; seule la mutualisation pooled peut le révéler, et son absence est un résultat acceptable.
- Un calendrier de live : toute intégration passe par G-RUNNER et une nouvelle spec de wiring (`references/new-strategy-wiring.md`).

**Premier livrable (P0)** : le rapport de découverte — les clusters de patterns avec leurs stats conditionnelles, et le verdict « les 4 moteurs existants sont-ils redécouverts ». C'est la mesure de pertinence demandée, chiffrée, avant tout entraînement de modèle.