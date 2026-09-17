# SPÉCIFICATION — Modèle IA « next-market »
## Prédiction de l'outcome du prochain marché, avant ouverture

**Date :** 2026-09-16 · **Statut :** spécification v1 (à valider avant implémentation)
**Décisions utilisateur :** cible = outcome du **prochain** marché (features trans-fenêtres) · rôle = **recherche d'abord** (standalone, backtest, intégration seulement si baseline battue) · stack = **100 % TypeScript** · données = `bot-live.db` + **phase de collecte 2–4 semaines**.

---

## 1. Objectif

Prédire, **avant l'ouverture d'une fenêtre** BTC/ETH Up/Down 15m, la probabilité que Up (ou Down) gagne, à partir d'informations trans-fenêtres uniquement :

```
À t = windowStart du slug N (livre vide ou quasi vide)
Features = tout ce qui est connu AVANT t :
  historique des fenêtres précédentes du même asset
  + contexte temporel (session, jour)
  + microstructure de fin de fenêtre précédente
─────────────────────────────────────
Sortie : P(Up gagne) ∈ [0,1]
Usage : si |P − 0.50| ≥ seuil → entrée à l'ouverture sur Up ou Down
```

**Périmètre exclu de la v1** : l'inférence intra-fenêtre (déjà couverte par les moteurs existants), le trading du marché en cours, tout trading live. La v1 est un composant de recherche.

---

## 2. État des données (mesuré sur `data/bot-live.db`)

| Métrique | Valeur |
|---|---|
| Fenêtres résolues | 651 (320 Up / 331 Down) |
| Fenêtres complètes (≥ 801 ticks, gaps ≤ 60 s) avec résolution | 510 |
| Rythme de collecte | ~80 fenêtres/jour |
| Historique actuel | 8,2 jours |

### 2.1 Puissance statistique — le chiffre qui gouverne le plan

n requis pour distinguer P(Up)=p de 0,50 (α = 5 % bilatéral, puissance 80 %, test binomial) — **calculé, script `scripts/research/ml-feasibility/power-projection.ts`** :

| Effet cible P(Up) | n requis |
|---:|---:|
| 0,51 | 19 615 |
| 0,52 | 4 898 |
| **0,53** | **2 173** |
| 0,54 | 1 219 |
| **0,55** | **778** |
| 0,58 | 299 |
| 0,60 | 189 |

**Conséquence directe :** avec 655 fenêtres, on ne peut détecter que des effets ≥ 0,55 — et il faut EN PLUS réserver des fenêtres au test (le train ne compte pas). La collecte n'est pas optionnelle, c'est le prérequis.

### 2.2 Plan de collecte (phase 1)

Le bot enregistre déjà automatiquement (~80 fenêtres/jour). La phase 1 = **maintenir l'enregistrement** + deux ajouts :

1. **Période cible : 4 semaines** → ~2 900 fenêtres cumulées ≈ n requis pour l'effet cible minimal (0,53) avec train/test séparés.
2. **Collector de prix spot BTC/ETH (optionnel mais recommandé)** — le vrai déterminant d'une fenêtre Up/Down est le mouvement du sous-jacent pendant la fenêtre ; un historique spot pré-ouverture (returns 1m/5m/15m, session) serait la feature trans-fenêtre la plus informative. Proposition : klines publiques Binance/OKX (sans clé, rétroactif possible) — **à vérifier** (disponibilité/limites non auditées à ce jour). Sans ce collector, la v1 se limite aux features dérivées du carnet.
3. **Vérification quotidienne** : `market_resolutions` doit suivre les fenêtres (lag ~100 s constaté, normal).

**Gate G1 :** < 2 000 fenêtres résolues à la fin de la collecte → étendre la collecte, ne PAS entraîner.

---

## 3. Définition formelle de la tâche

### 3.1 Unité d'apprentissage
**Une ligne = une fenêtre** (jamais un tick). Cible : `winnerOutcomeIndex` de `market_resolutions` (0 = Up, 1 = Down).

### 3.2 Features trans-fenêtres (connues à l'ouverture, ordre croissant de risque de fuite)

| Groupe | Features | Source |
|---|---|---|
| **Historique d'outcomes** | winner des k dernières fenêtres du même asset (k=1,2,3), longueur/firection de streak | `market_resolutions` |
| **Clôture de fenêtre précédente** | ask du favori à T−60s/T−30s, askSum final, spread final, volume final | `book_snapshots` / `market_snapshots` (fenêtre N−1 uniquement) |
| **Microstructure inter-fenêtres** | imbalance bid/ask du carnet dans les 60 s AVANT l'ouverture de N (si des ordres reposent), profondeur | `book_snapshots` |
| **Rythme d'activité** | nb de trades, volume, liquidity moyennés sur les 3 dernières fenêtres | `market_snapshots` |
| **Contexte temporel** | heure UTC (sin/cos), jour de semaine, session (Asie/EU/US), minute dans l'heure | dérivé du slug/`windowStart` |
| **Prix spot (si collector §2.2)** | returns BTC 1m/5m/15m/1h pré-ouverture, volatilité réalisée | collector externe |

**Garde anti-fuite :** toute feature est calculée **strictement avant `windowStart` de la fenêtre cible** ; les features de la fenêtre N−1 n'utilisent que des ts ≤ windowEnd(N−1). Un test automatique (feature-timestamp ≤ open-timestamp) est un livrable obligatoire, pas une précaution au cas par cas.

### 3.3 Hypothèses à tester (peuvent toutes mourir — c'est le but)

- **H1 — momentum du sous-jacent** : la direction du dernier mouvement BTC pré-ouverture prédit le premier mouvement de la fenêtre (persistances courtes).
- **H2 — carry-over microstructure** : l'imbalance de fin de fenêtre N−1 se propage à l'ouverture de N (market makers / flow persistants).
- **H3 — biais de pricing** : le carnet d'ouverture est systématiquement biaisé (par ex. favori surpayé après une série de mêmes côtés — illusion de série des participants). L'edge = acheter le côté *sous-évalué* à l'ouverture.
- **H4 — effets de session** : les base rates Up/Down diffèrent par session (financement, horaires US).

---

## 4. Baselines — le modèle doit les battre, sinon NO-GO

| # | Baseline | Définition |
|---|---|---|
| B1 | **Constante 0,50** | prédire toujours 0,50 (log-loss de référence) |
| B2 | **Base rate global** | fréquence Up sur train (~0,49 mesuré : 320/651) |
| B3 | **Base rate conditionnel** | P(Up \| session) et P(Up \| k derniers winners) — les « règles métier » triviales |
| B4 | **Marché à l'ouverture** *(si données d'ouverture disponibles)* | prédire = ask Up à l'ouverture ; à ne comparer que sur les fenêtres où le carnet d'ouverture existe |

Un modèle qui ne bat pas B1–B3 en log-loss walk-forward est **mort**, quelle que soit sa précision affichée.

---

## 5. Modèle — stack 100 % TypeScript

### 5.1 Choix retenu : régression logistique implémentée en TS pur (~150 lignes)

- Descente de gradient (batch ou mini-batch), régularisation L2, features standardisées.
- **Pourquoi si simple :** ~650 fenêtres aujourd'hui, ~2 900 demain — c'est un problème à **une ligne par fenêtre**, pas un problème de deep learning. La logistique est interprétable (coefficients = force de chaque hypothèse H1–H4), déterministe, et sans dépendance.
- **Inventaire de l'écosystème JS (honnête) :** TensorFlow.js existe et fonctionne mais est un marteau-pilon pour 30 features scalaires ; les libs « ML tabulaire » npm sont vieillissantes ou non vérifiées — **aucune ne sera spécifiée sans vérification préalable**. La logistique maison est la solution boring et sous contrôle, alignée sur la règle du repo (solutions bien comprises > solutions clever).
- **Évolution v2 (si GO et si B1–B3 battus) :** arbre de décision / petit gradient boosting implémenté en TS pour les interactions non linéaires, OU port de l'inférence d'un modèle entraîné ailleurs — décision prise au gate G3, pas avant.

### 5.2 Arborescence (conventions du repo)

```
scripts/research/next-market-ml/
  dataset.mts       # builder : 1 ligne/fenêtre, features trans-fenêtres + garde anti-fuite
  baselines.mts     # B1–B4, log-loss + accuracy walk-forward
  train.mts         # logistique TS (weights exportés en JSON)
  evaluate.mts      # comparaison modèle vs baselines, par jour, t-stats
model-ia/
  SPEC-next-market.md          # cette spécification
  next-market/
    weights-<ts>.json          # artefacts modèle (versionnés avec les runs)
    report-<ts>.json/.md       # résultats walk-forward
audits/backtest/next-market-ml/  # rapport final + index.md mis à jour
```

### 5.3 Split walk-forward (obligatoire, jamais aléatoire)

- **Expanding window par jour** : train = jours [1..d−1], test = jour d, d avance jour par jour.
- Jamais de split aléatoire ni de split par fenêtre : les fenêtres adjacentes partagent régime et microstructure (autocorrélation — la même raison qui a fait chuter un winrate per-tick de 67 % → 48 % une fois échantillonné par fenêtre).
- Métriques rapportées **par jour** : log-loss, accuracy, Brier, PnL simulé (§6). Un modèle gagnant sur la totalité mais négatif plusieurs jours est un pari de régime — signalé comme tel.

---

## 6. Traduction économique (le modèle doit valoir de l'argent)

Prédiction → stratégie d'entrée à l'ouverture :

```
P(Up) prédite, ask Up à l'ouverture ≈ 0.505 (estimation; à mesurer)
EV/share = P − prix_d'entrée
Seuil d'entrée : |P − 0.50| tel que EV/share ≥ 0.02  (couvre spread + risque kill FOK)
```

- **Table EV (calculée, `power-projection.ts`) :** entrée 0,505 avec P=0,53 → EV 0,025/share ; P=0,55 → 0,045/share.
- Le backtest de la politique d'entrée (seuil, sizing `computeSize`, MIN_CLOB_SHARES = 5) se fait dans le **sim standalone fidélisé** d'abord (loader `research-new-strats/universe.mts`, un point d'entrée par fenêtre), puis — si G4 passe — dans le **runner officiel**. Le sim classe, le runner décide.
- Invariants programmatiques à chaque run (pattern verify-claims) : `sum(byDay) == pnl`, `WR == wins/fills`, t-stat EMPIRIQUE (std des PnL/trade), notional = prix d'entrée réel × size.

---

## 7. Gates GO / NO-GO (pré-enregistrés, non renégociables après coup)

| Gate | Condition de passage | Conséquence |
|---|---|---|
| **G1 — collecte** | ≥ 2 000 fenêtres résolues (4 semaines) | sinon étendre la collecte |
| **G2 — hypothèse** | au moins une feature-groupe (H1–H4) déplace P(Up) de ≥ 0,53 avec n ≥ 2 173, OU ≥ 0,55 avec n ≥ 778, en walk-forward | si aucun : NO-GO, stop propre, rapport |
| **G3 — modèle vs baselines** | log-loss walk-forward < min(B1, B2, B3) avec t-stat ≥ 2 sur l'EV/share des entrées | sinon : le modèle ne vaut rien, stop |
| **G4 — économique** | politique d'entrée (seuil EV ≥ 0,02/share) : PnL positif au sim sur ≥ 3 des 4 semaines de test, DD max supporté | sinon : stop, rapport |
| **G5 — runner officiel** | PnL positif sur le runner officiel, rejects ≈ 0, calibration sim↔runner ±1 % | GO intégration (nouvelle spec, moteur natif via `references/new-strategy-wiring.md`) |

Chaque gate produit son rapport JSON/MD horodaté dans `audits/backtest/next-market-ml/` + entrée dans `audits/backtest/index.md` (règle du repo).

---

## 8. Risques spécifiques (à relire à chaque gate)

| Risque | Mitigation |
|---|---|
| **Edge de pré-ouverture possiblement inexistant** — un carnet 15m efficient sur BTC 15m est l'hypothèse nulle sérieuse ; H1–H4 sont des hypothèses, pas des acquis | G2 pré-enregistré : si les baselines tiennent, on s'arrête. Le coût du no-go = 4 semaines de collecte passives (le bot trade pendant ce temps) |
| **n trop petit pour la v2 (interactions)** | la v1 logistique n'a pas besoin d'interactions ; toute v2 est conditionnée à G1+G3 |
| **Fuite temporelle** | garde anti-fuite automatisée (§3.2) + split par jour + features horodatées |
| **Régime unique (BTC, un seul mois)** | attribution PnL par jour obligatoire ; tout résultat porte la mention « un régime, un asset » |
| **Sur-apprentissage du seuil d'entrée** | seuil fixé AVANT l'évaluation économique (pré-enregistré), pas tuné sur le test |
| **Collector spot externe (si activé)** | dépendance réseau nouvelle : cache + fallback stale (pattern Open-Meteo déjà en place dans Polywatch), jamais bloquer le tick loop |

---

## 9. Phasage & effort

| Phase | Contenu | Durée / effort |
|---|---|---|
| **P0 — baseline immédiate** (peut démarrer sans collecte) | dataset.mts + baselines.mts sur les 510 fenêtres actuelles ; mesure de l'ask d'ouverture réel ; test rapide H1–H4 à n=510 (puissance limitée, detection seuil ~0,55) | 1 session |
| **P1 — collecte 4 semaines** | bot continue ; (opt.) collector spot BTC ; vérif hebdo résolutions | passif, ~0 effort/semaine |
| **P2 — entraînement v1** | train.mts logistique, evaluate.mts walk-forward, gates G2/G3 | 1–2 sessions |
| **P3 — backtest économique** | politique d'entrée sim fidélisé, gate G4 | 1 session |
| **P4 — validation officielle** | runner officiel, gate G5 → GO/NO-GO intégration | ½ session |

**Total effort actif : ~4–5 sessions** (le reste est de la collecte passive). Chaque phase se termine par un rapport et une décision de gate explicite.

---

## 10. Livrables de la phase P0 (seule phase non conditionnée)

1. `scripts/research/next-market-ml/dataset.mts` — dataset trans-fenêtres avec test anti-fuite
2. `scripts/research/next-market-ml/baselines.mts` — B1–B4 walk-forward sur 510 fenêtres
3. `model-ia/next-market/report-<ts>.md` — la réponse chiffrée à : « les baselines trans-fenêtres laissent-elles de la place ? »
4. Mise à jour `audits/backtest/index.md`

Si B1–B3 sont déjà au niveau du hasard ET qu'aucune strate (session, streak) ne s'en écarte à n=510, la phase de collecte devient la seule voie — et le rapport le dit avec les chiffres.