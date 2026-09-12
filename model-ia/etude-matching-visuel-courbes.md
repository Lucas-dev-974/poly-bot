# Étude — Matching visuel de courbes Polymarket 15 min

**Date** : 2026-09-10  
**Statut** : papier d’étude (intention produit + faisabilité). Pas une spec d’implémentation, pas un plan de câblage dans le bot.  
**Objet** : figer ce que l’on veut faire avec un **modèle d’image**, et seulement cela.

---

## 0. Synthèse

On dispose d’un corpus d’images de marchés binaires Polymarket **Up or Down 15 minutes** (crypto). Chaque image montre les deux courbes de prix des tokens (**YES/Up** vert, **NO/Down** rouge), à taille fixe, à intervalle 1 s sur la fenêtre.

**Ce que l’on veut :** un modèle qui **apprend à reconnaître des courbes presque identiques**, puis, quand on lui passe **la moitié d’une image** (amorce de la fenêtre en cours), répond :

> **oui / non** : est-ce que je connais déjà une courbe qui pourrait être la même (ou très proche) ?

et, si oui, **lesquelles** (voisins dans la banque historique).

**Ce que l’on ne veut pas (dans ce papier) :**

- prédire le vainqueur du **prochain** marché 15 min à partir de l’image ;
- un classifieur d’outcome Up/Down sur la session en cours ;
- un « détecteur de régime » branché sur `arb` / `barbell` / `edge-lead`.

Ces pistes restent des **extensions possibles** (§10). Le livrable de ce travail est un **moteur de déjà-vu visuel**.

---

## 1. Contexte marché

### 1.1 Nature des graphes

Les marchés ciblés sont les fenêtres **15 minutes** Polymarket (préfixes typiques `btc-updown-15m`, éventuellement ETH). Ce ne sont **pas** des courbes de prix spot BTC/ETH.

| Trace | Couleur (UI actuelle) | Sens |
|---|---|---|
| Token Up / YES | vert `#3ee07a` | prix du contrat qui paie 1 $ si `spot_close ≥ spot_open` |
| Token Down / NO | rouge `#ff5b5b` | contrat complémentaire ; en pratique `YES + NO ≈ 1 $` |
| Volume, liquidité, spread | overlays (bleu, violet, …) | métadonnées de carnet / Gamma — **hors requête visuelle v1** |

Le vainqueur de la fenêtre est une **option digitale** sur le sous-jacent. Les courbes de l’image sont l’**opinion du carnet** (mids / bids-asks), mise à jour ~1 s.

L’UI empilée (plusieurs marchés sur un même écran, tooltip croisé) **n’est pas** l’unité d’apprentissage. Une unité = **un marché = une image isolée**, même cadrage.

### 1.2 Données brutes déjà persistées (bot)

Le bot SQLite enregistre déjà, hors PNG :

- `book_snapshots` : `bestBid` / `bestAsk` / sizes L1–L3, `outcomeIndex`, `eventSlug`, `ts`
- `market_snapshots` : volume, volume24h, liquidité, spread
- `market_resolutions` : vainqueur (`winnerOutcomeIndex`)

Ces tables permettent de **re-rendre** des PNG propres (sans chrome UI) et d’attacher des métadonnées aux voisins (vainqueur, slug, timestamps). Le matching lui-même se fait **sur l’image**, pas sur ces floats.

### 1.3 Pourquoi l’image, ici

Pour de la prédiction d’outcome, rasteriser un graphe est un mauvais encodage (perte de précision, chrome, leakage de la résolution).

Pour du **matching de forme**, l’image est l’objet naturel : on veut la Gestalt (deux traces 0–1 sur 15 min), telle qu’un œil humain dirait « ces deux sessions se ressemblent ».

---

## 2. Problème posé

### 2.1 Formulation

Soit :

- \(\mathcal{B}\) une banque d’images historiques \(I_1, \ldots, I_N\), une par fenêtre 15 min close ;
- \(Q\) une **requête** : moitié gauche d’une image (préfixe temporel ≈ 7,5 min, ou plus généralement un crop \([0, \tau]\)).

Le modèle calcule une similarité \(s(Q, I_k)\) et :

\[
\text{connu}(Q) = \mathbf{1}\big[\max_k s(Q, I_k) \ge \theta\big]
\]

Sortie opérationnelle :

1. booléen **connu / inconnu** ;
2. liste des **K plus proches** \(I_k\) avec score ;
3. (optionnel) métadonnées des voisins : slug, `windowStart`, vainqueur, asset.

« Identique » n’est **pas** l’égalité pixel à pixel. C’est une **proximité de forme** : même allure des deux jambes, tolérance à un léger décalage temporel, à un spread un peu plus large, à un gap de quelques secondes.

### 2.2 Contrat de comparaison (contrainte dure)

On ne compare **jamais** une moitié live à une image **terminée** (courbes collées à 0 et 1, ligne de résolution). Ce sont deux objets visuels différents ; le modèle dirait « inconnu » pour des amorces banales.

**Règle :** requête et index partagent le **même cadrage temporel**.

| Rôle | Contenu visuel |
|---|---|
| Requête | crop \([0, \tau]\) de la fenêtre en cours, Y ∈ [0, 1], pas de tooltip |
| Entrée d’index | **le même crop** \([0, \tau]\) calculé sur chaque fenêtre historique |
| Affichage après match | on **montre** le graphe complet du voisin (ce qui s’est passé ensuite), mais la **distance** ignore cette suite |

\(\tau\) v1 proposé : **moitié de fenêtre** (450 s). Variante utile : plusieurs index (180 s, 450 s, 720 s) pour interroger au fil de la session.

### 2.3 Ce que le booléen signifie

- **Oui** : « dans l’historique, il existe au moins une amorce dont la forme est assez proche, au seuil \(\theta\). »
- **Non** : « forme hors distribution de la banque, ou banque trop petite, ou seuil trop strict. »

Le booléen **n’est pas** : « le marché va finir comme le voisin ». Les voisins d’une même amorce peuvent avoir des issues Up **et** Down. Consulter l’issue des voisins est une **statistique d’analogues** (§10.1), pas la tâche v1.

---

## 3. Spécification des images

### 3.1 Unité

- Un fichier = un `eventSlug` = une fenêtre.
- Taille **identique** pour tout le corpus (proposition : 384×128 ou 512×160, plus large que haut — série temporelle).
- Axe Y **toujours** [0, 1] (prix token), jamais autoscale.
- Axe X = `[windowStart, windowStart + τ]` pour les crops, `[windowStart, windowEnd]` pour les vues complètes d’archivage.

### 3.2 Contenu v1 (strict)

Inclus :

- courbe Up (vert) : mid `(bestBid + bestAsk) / 2`, ou best ask si mid absent ;
- courbe Down (rouge), même convention ;
- fond sombre uni, pas de grille, pas d’axes, pas de labels, pas de tooltip ;
- gaps : rupture de trait si trou > 8 s (aligné sur `CHART_GAP_CUT_SEC` du dashboard).

Exclus v1 :

- volume, liquidité, spread, sizes (canaux supplémentaires = v2) ;
- marqueurs de trades du bot ;
- ligne de résolution / prix final 0–1 ;
- chrome empilé (plusieurs marchés sur une image).

### 3.3 Sources de rendu

Par ordre de préférence :

1. **Re-rendu déterministe** depuis `book_snapshots` (reproductible, sans UI).
2. PNG déjà exportés à l’unité, **si** le cadrage respecte §3.1–3.2.
3. Screenshot dashboard : **refusé** en training (tooltip, axes, plusieurs rows).

### 3.4 Identifiants

Chaque image (pleine ou crop) porte :

```
asset, eventSlug, windowStart, windowEnd, tau_sec, sha256_pixels
```

Le hash sert à dédupliquer les re-rendus. L’index stocke le vecteur + ces métadonnées, pas seulement le PNG.

---

## 4. Approche modèle

### 4.1 Famille

Tâche = **metric learning** + **recherche des plus proches voisins**, pas classification.

Pipeline :

```
PNG crop [0, τ]
    → encodeur CNN (EfficientNet-B0 ou ResNet18)
    → embedding L2-normalisé dim 128
    → index (cosine / faiss IP)
    → max similarité ≥ θ  →  connu
    → top-K voisins
```

Un ViT n’est pas nécessaire en v1 (corpus de l’ordre de milliers d’images, pas de millions).

### 4.2 Entraînement

Objectif : deux amorces **visuellement proches** → vecteurs proches ; deux formes distinctes → vecteurs éloignés.

Méthode proposée : **contrastif** (SimCLR / NT-Xent) ou **triplet**.

Paires **positives** (même fenêtre ou même forme) :

- crop gauche identique + jitter de brillance / léger bruit ;
- léger crop temporel (± quelques secondes) **sans inverser le temps** ;
- léger décalage vertical interdit (les niveaux 0.2 vs 0.8 sont de l’information).

Paires **négatives** : autre `eventSlug`.

**Augmentations interdites :**

- flip horizontal (inverse le temps) ;
- flip vertical (inverse Up/Down) ;
- rotations, color-jitter fort qui mélange vert et rouge.

Pré-entraînement ImageNet acceptable pour initialiser les bords ; le contrastif doit ensuite se faire **sur nos charts**.

### 4.3 Seuil \(\theta\)

\(\theta\) n’est pas appris par gradient. Il se **calibre** sur un jeu de paires jugées par un humain :

- « ces deux amorces, je les dirais jumelles » → similarité doit passer ;
- « ces deux-là, non » → doit échouer.

Métriques de calibration : précision/rappel du booléen *connu*, et inspection visuelle des faux positifs (lock-in Up matché avec lock-in Down, etc.).

Un second seuil plus souple peut renvoyer `incertain` plutôt qu’un oui/non brutal.

### 4.4 Banque trop petite / cold start

Tant que \(N\) est faible (quelques jours × 96 fenêtres BTC), beaucoup de requêtes seront **inconnues** — c’est correct. Le modèle ne doit pas forcer un match. Le papier considère qu’un corpus **utile** commence vers **plusieurs centaines** de fenêtres rendues proprement ; le contrastif devient intéressant vers **quelques milliers** (plusieurs mois, ou BTC+ETH).

---

## 5. Protocole d’évaluation

### 5.1 Splits

Split **temporel** uniquement (par jour / par semaine). Jamais de mélange aléatoire des PNG : une fenêtre du 10 septembre ne doit pas servir d’index pour une requête du 9 (fuite) **dans le protocole d’étude**. En prod, l’index peut contenir tout le passé strictement antérieur à la requête.

La fenêtre en cours n’est **jamais** dans l’index.

### 5.2 Tâches mesurées

| Tâche | Mesure | Remarque |
|---|---|---|
| Retrieval | Recall@K, mAP | un voisin « vrai » = similarité humaine ou même régime annoté plus tard |
| Booléen connu | précision, rappel, F1 au seuil \(\theta\) | dépend du seuil |
| Fidélité visuelle | revue manuelle top-5 | obligatoire ; le chiffre seul ment |
| Non-fuite | 0 voisin avec `windowStart` ≥ requête | test unitaire de l’index |

On **n’évalue pas** l’accuracy d’outcome. Si on la calcule en annexe (vote des voisins vs vainqueur réel), c’est un **diagnostic**, pas le critère de succès du papier.

### 5.3 Baseline (obligatoire avant le CNN)

Comparer l’encodeur appris à :

1. **DTW / distance L2** sur les séries `upMid`, `downMid` resampled 450 points — souvent déjà très bon ;
2. embedding image **sans** contrastif (ResNet ImageNet, pooling).

Si (1) bat le CNN sur le recall visuel, le CNN n’est pas justifié pour la v1. Le papier **assume** qu’on veut quand même l’image (intention produit) ; la baseline série sert à ne pas se mentir.

---

## 6. Inférence (usage visé)

Scénario cible :

1. Une fenêtre 15 min est **en cours**.
2. À \(\tau\) (ex. 7 min 30), on rend le crop gauche.
3. On interroge l’index des crops historiques au même \(\tau\).
4. UI / log :
   - `connu=false` → « pas d’analogue au seuil » ;
   - `connu=true` → grille des K graphes **complets** des voisins + scores.

Hors scope v1 : poster un ordre, changer de moteur, sizing.

---

## 7. Risques et limites

1. **Domain gap crop vs full** — déjà traité par la règle §2.2 ; c’est le risque n°1 si on l’ignore.
2. **Chrome et autoscale** — deux PNG « identiques métier » mais Y auto vs [0,1] ne matcheront pas.
3. **Leakage de résolution** — une amorce qui contient déjà la pente finale vers 0/1 (dernières minutes) n’est plus une « moitié » informative ; \(\tau\) trop tardif rend le matching trivial.
4. **Confondre jumeau et prédiction** — des courbes identiques sur 7 min peuvent diverger après. C’est normal.
5. **Biais d’asset / d’heure** — toutes les sessions BTC 14h UTC se ressemblent un peu ; le modèle peut matcher l’heure du jour plutôt que la micro-forme. Mitigation : évaluer aussi **intra-heure** et **cross-asset**.
6. **Illiquidité** — traits gappés : deux marchés morts se ressemblent tous. Un filtre `points_valides / 450` évite de déclarer « connu » sur du vide.
7. **Sans spot BTC** — deux amorces visuellement jumelles peuvent être l’une justifiée, l’autre mispricée. Hors scope matching.

---

## 8. Architecture logicielle (cible, hors bot live)

Proposition de dossier `model-ia/` (ce papier +, plus tard, le code) :

```
model-ia/
  etude-matching-visuel-courbes.md   ← ce document
  render/                            ← PNG depuis book_snapshots
  data/                              ← manifests (slug, tau, path, split)
  train/                             ← contrastif
  index/                             ← faiss / numpy + métadonnées
  query/                             ← CLI : PNG crop → connu + top-K
```

Aucune modification de `src/bot.ts` ni des stratégies n’est requise pour valider la thèse.

---

## 9. Critères de succès v1

Le papier est **validé** si, sur un hold-out temporel :

1. un opérateur reconnaît les top-5 comme « vraiment la même allure » dans la majorité des requêtes **connues** ;
2. le booléen *inconnu* se déclenche sur des formes rares / début de corpus, sans forcer des faux jumeaux ;
3. aucune fenêtre future n’apparaît dans l’index ;
4. la baseline DTW est reportée à côté du CNN.

Ce n’est **pas** un succès que le vote des voisins batte 50 % d’outcome.

---

## 10. Extensions (hors v1, volontairement séparées)

### 10.1 Statistique d’analogues

Une fois le retrieval fiable : parmi les K voisins, fraction de vainqueurs Up, fraction de fills cheap, etc. C’est un **tableau de bord**, pas un label d’entraînement.

### 10.2 Détecteur de régime

Regrouper les embeddings (k-means) et nommer lock-in, squeeze, flip, chop. Utile ensuite comme feu tricolore pour les moteurs du bot. **Dépend** d’un embedding de matching sain.

### 10.3 Prédiction d’outcome (marché N ou N+1)

Non recommandé comme tête du CNN image. Si un jour on le tente : features numériques + spot sous-jacent, split walk-forward, métrique Brier / PnL simulé — pas accuracy sur PNG.

---

## 11. Décisions figées par ce papier

| # | Décision |
|---|---|
| D1 | Tâche = **déjà-vu visuel** (oui/non + top-K), pas outcome, pas régime. |
| D2 | Requête = **préfixe temporel** ; index = **préfixes au même τ**. |
| D3 | Une image = un marché ; Y fixe [0, 1] ; pas de chrome. |
| D4 | Distance sur embeddings contrastifs ; seuil \(\theta\) calibre humainement. |
| D5 | Split temporel ; fenêtre courante exclue de l’index. |
| D6 | Pas d’intégration trading tant que §9 n’est pas tenu. |
| D7 | Baseline DTW sur séries mid **obligatoire**. |

---

## 12. Références internes

- Dashboard / rendu : `frontend/src/utils/chart.ts`, `frontend/src/utils/stacked-chart.ts` (couleurs, gaps 8 s, mids Up/Down).
- Persistance : `src/db/database.ts` — `book_snapshots`, `market_snapshots`, `market_resolutions`.
- Marchés 15 min : `STRATEGY.md` §1.
- Oracle spot / intelligence (extension, pas v1) : `audits/audit-5/audit-intelligence-2026-09-08.md` §9.1.

---

*Fin du papier d’étude. Prochaine étape éventuelle : renderer déterministe `book_snapshots` → PNG crops, puis baseline DTW, puis encodeur contrastif.*
