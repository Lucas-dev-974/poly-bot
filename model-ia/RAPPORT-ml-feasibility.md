# Rapport de faisabilité — Modèle IA sur données marché enregistrées

**Date :** 2026-09-16 · **Source des chiffres :** `data/bot-live.db` (requêtes réelles, scripts `scripts/research/ml-feasibility/`)

---

## 1. Verdict

**Oui, c'est possible — et la donnée est déjà là.** Le repo contient ~8 jours d'historique tick-par-tick (1 Hz) sur 655 fenêtres BTC/ETH Up/Down, avec les résolutions associées. Un modèle peut être entraîné dès aujourd'hui sur trois des quatre objectifs demandés ; le quatrième (prédire le *prochain* marché avant ouverture) est faisable mais nettement plus faible.

**Le vrai défi n'est pas le ML, c'est la baseline.** Nos propres recherches l'ont montré : le prix ask courant EST déjà une bonne probabilité implicite (une entrée ≈ probabilité implicite = pas d'edge, leçon dip-guard). Le modèle ne doit pas être comparé à 50 % de hasard, mais au *calibrage* du carnet. S'il ne bat pas le log-loss du ask, il ne vaut rien.

---

## 2. Ce que contient la base (mesuré, pas supposé)

| Métrique | Valeur |
|---|---|
| Fenêtres distinctes (`eventSlug`) | **655** (BTC 649, ETH 6) |
| Période couverte | 2026-09-08 → 2026-09-16 (8,2 jours) |
| `book_snapshots` | 1 030 481 lignes (2 outcomes × ~1 tick/s) |
| `market_snapshots` | 515 445 lignes (volume, liquidity, lastTradePrice, spread) |
| `market_resolutions` | 651 (gagnant joint, pas inféré) |
| Slugs avec ≥ 801 ticks | **513** → **510** avec résolution |
| Ticks distincts par slug (moy/min/max) | 787 / 5 / 1748 |
| Équilibre de classes | 320 Up / 331 Down (≈ 48,9/51,1) — idéal |
| Lag résolution vs windowEnd | ≈ 97–103 s (normal, cf. audits antérieurs) |

**Features brutes disponibles par tick** (~14 colonnes de carnet × 2 outcomes) :
- 3 niveaux d'asks + tailles, 3 niveaux de bids + tailles, **pour UP et DOWN simultanément**
- market : `volume`, `volume24hr`, `liquidity`, `lastTradePrice`, `spread`

C'est une matière première riche : imbalance de carnet, profondeur cumulée, spread, micro-momentum, volume — tout est déjà là, horodaté à la seconde.

---

## 3. Les 4 objectifs, un par un

### 3.1 Analyse de liquidité ✅ trivial
Les 3 niveaux × tailles par côté et par outcome permettent de calculer profondeur cumulée, imbalance bid/ask, coût d'exécution simulé. C'est de l'ingénierie de features, pas de la recherche.

### 3.2 Analyse de prix ✅
Mid, spread, dérive du favori, askSum (somme des deux asks — déjà utilisée par les moteurs), lastTradePrice. Le piège connu : **près de la clôture, l'ask du perdant s'effondre à ~0,01** — toute feature mesurée trop tard lit le futur du marché, pas un signal.

### 3.3 Reconnaissance de patterns ✅ (c'est ici que le ML apporte quelque chose)
Dip, flip, convergence, momentum — les familles testées à la main (antiflip, flip-confirm, early-conviction, dip-revert) sont des patterns *codés à la main* qu'un modèle apprendrait automatiquement. Un GBM consommant les features du §2 découvrirait (ou pas) ces mêmes signaux. Valeur ajoutée réelle : explorer l'espace des patterns sans les pré-spécifier.

### 3.4 Prédire l'outcome — deux cas très différents

**a) Marché EN COURS (à l'instant t, avant résolution)** — ✅ le plus direct.
- Label : `market_resolutions.winnerOutcomeIndex` (0=Up, 1=Down), join par `eventSlug`.
- Tâche : classification binaire à chaque tick (ou points d'échantillonnage) à partir de l'historique du carnet.
- **Attention à la formulation** : prédire le gagnant n'est pas une edge. Un favori à 0,85 gagne ~85 % — le modèle qui dit « favori » a un haut winrate et zéro profit. La bonne cible est la **miscalibration** : moments où la probabilité réelle diverge du prix affiché. C'est exactement le workflow qui a produit les 3 moteurs directionnels (carte de calibration par tick → sim par fenêtre → contrôles causaux).

**b) Prochain marché (avant ouverture)** — ⚠️ beaucoup plus dur.
- Peu de features pré-ouverture : pas de carnet (les books sont vides sur les vieux marchés, constaté lors de l'audit multi-timeframe), seulement l'historique des marchés passés du même asset.
- Le signal candidat serait trans-fenêtres (continuité, streaks) — la famille wnstreak n3 n'avait que 65 fills : trop mince.
- Recommandation : ne PAS construire ça en premier. Le marché courant offre 400k+ points d'apprentissage ; le prochain marché en offre ~655 (1 vecteur par fenêtre), dominé par le bruit.

---

## 4. Schéma d'ensemble

```
 book_snapshots (1Hz, 2 outcomes)        market_snapshots
 ┌─────────────────────────────┐         ┌──────────────────┐
 │ bestBid/Ask ± sizes         │         │ volume, liquidity│
 │ ask2/ask3, bid2/bid3        │         │ lastTrade, spread│
 └──────────────┬──────────────┘         └────────┬─────────┘
                │  features par tick              │
                ▼                                 ▼
        ┌───────────────────────────────────────────┐
        │  FEATURE BUILDER (fenêtre glissante)      │
        │  imbalance, profondeur, dérive, elapsed % │
        └──────────────────────┬────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  MODÈLE (GBM d'abord)│
                    └──────────┬──────────┘
                               ▼
               P(Up gagne)  vs  ask affiché
                               ▼
                    edge = P(réelle) − prix
```

---

## 5. Plan d'exécution recommandé (phases, chacune avec livrable)

1. **Dataset builder** — réutiliser l'infra existante : `listBacktestWindows(repos, { completeness })` (ne JAMAIS ré-écrire les filtres SQL à la main). Sortie : un tableau (slug, tick, features, label futur) échantillonné **un point par fenêtre pour l'inférence de signal, par tick UNIQUEMENT pour la courbe de calibration**.
2. **Baseline de calibration** — log loss / Brier score du ask comme prédicteur. C'est le chiffre à battre. (Attendu d'après les audits : le ask est déjà bien calibré sauf sur des zones précises — c'est là que vit l'edge.)
3. **Modèle simple d'abord** — régression logistique puis GBM (LightGBM/XGBoost). Pas de deep learning : ~500 fenêtres c'est très peu pour un réseau, largement suffisant pour un GBM sur ~30 features.
4. **Split walk-forward par jour** — jamais de split aléatoire : 8 jours consécutifs = découper train sur jours 1-6, test sur 7-8. Un split aléatoire sur des ticks corrélés fuit (autocorrélation intra-fenêtre — la même raison qui a fait chuter un winrate per-tick de 67 % → 48 % une fois échantillonné par fenêtre).
5. **Validation officielle** — tout signal survivant est re-testé dans le runner officiel (`runBacktest`), pas seulement dans le sim. Le sim classe, le runner décide (règle du repo).
6. **Intégration** — soit comme moteur natif (checklist `references/new-strategy-wiring.md`, 6 touch-points config), soit comme feature supplémentaire dans un moteur existant.

**Critère de succès :** log loss test < baseline ask, ET edge exploitable après coûts (spread + kill FOK sur books minces niveau 1), ET t-stat ≥ ~2 sur EV/share par fenêtre.

---

## 6. Risques & honnêteté (les mêmes qui ont coûté du temps sur les moteurs actuels)

| Risque | Réalité mesurée / leçon du repo |
|---|---|
| **Régime unique** | 8 jours, 94 % BTC 15m. Un modèle qui teste bien sur ces données est un pari sur CE régime. Le dire dans chaque rapport. |
| **Artifact de fin de fenêtre** | L'ask perdant → 0,01 près de la clôture. Un modèle entraîné sans coupure temporelle apprendra à « prédire » en lisant l'effondrement — précision artificiellement haute, inutilisable en live. Couper les features à ~70-80 % de la fenêtre, ou masquer. |
| **Échantillonnage per-tick gonflé** | Les ticks d'une même fenêtre sont corrélés. Toute stat de performance se prend UN point d'entrée par fenêtre (premier trigger), pas par tick. |
| **Baseline forte** | L'ask est déjà la proba implicite. Le modèle doit trouver des zones de *miscalibration*, pas « prédire le gagnant ». Les 4 moteurs directionnels déjà implémentés SONT des patterns que le ML devra battre — s'il ne les surpasse pas, il n'apporte rien. |
| **Fuites de features** | `market_resolutions.ts` est post-résolution : interdit en feature. `volume24hr`/`liquidity` de market_snapshots sont OK mais à vérifier (horodatage). Un lag d'une tick sur les features du carnet est la garde standard. |
| **Books minces** | 3 niveaux seulement, kill FOK fréquent sur profondeur insuffisante. Un modèle qui ne modélise pas l'exécutable (depth ≥ size) produira des fills fantômes — la leçon des milliers de rejects silencieux. |
| **Capital/sizing** | `MIN_CLOB_SHARES = 5` rend muet tout signal dont band × budget < 5 shares. Un modèle ML n'y change rien — le sizing gate reste premier. |

---

## 7. Estimation d'effort

| Phase | Contenu | Taille |
|---|---|---|
| Dataset builder + features | réutilise `universe.mts`, ~1 script | ½ session |
| Baseline calibration + GBM + walk-forward | 1-2 scripts + rapport JSON/MD | 1 session |
| Validation runner officiel + rédaction | templates existants | ½ session |

Total ≈ 2 sessions, tout en réutilisant l'infra d'audit existante (complétude, loader partagé, runner officiel). Aucune nouvelle dépendance lourde nécessaire (LightGBM via npm/python au choix ; un GBM en JS pur existe aussi si on veut rester TS).

---

## 8. Recommandation

**Commencer par le marché en cours, tâche = calibration (P(réel) vs ask), modèle = GBM sur features de carnet + market, échantillonnage par fenêtre, split par jour.** C'est le prolongement naturel du workflow `search-new-strats` qui a déjà produit 3 moteurs validés — le ML automatisant l'étape « carte de calibration par tick » qui a été faite à la main. Le « prochain marché » est un axe de recherche séparé, à ne lancer que si le premier produit des résultats.

Le premier livrable concret et peu risqué : la **baseline de calibration chiffrée** (log loss du ask sur les 510 fenêtres complètes). Elle dit immédiatement s'il reste de la miscalibration à exploiter — avant même d'entraîner quoi que ce soit.