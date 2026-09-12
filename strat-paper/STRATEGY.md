# Stratégie du Reverse Bot — Documentation détaillée

Ce document décrit en profondeur la stratégie de trading mise en place par ce bot,
son modèle économique, la mécanique exacte du code, les hypothèses, et les risques.

---

## 1. Le marché cible : Up or Down sur 15 minutes

Polymarket propose des marchés **binaires** : chaque marché a exactement deux issues possibles.
Celui que le bot exploite est le format **Up or Down** sur des fenêtres de **15 minutes** pour BTC et ETH.

Chaque fenêtre produit **un événement** avec **deux tokens** :

| Token | Gagne si | Paiement |
|-------|----------|----------|
| **Up**   | prix de fin ≥ prix de début | $1.00 |
| **Down** | prix de fin < prix de début | $1.00 |
| *l'autre* | —                          | $0.00 |

Propriétés fondamentales de ces marchés :

- **Binaire parfait** : la somme des probabilités des deux tokens == 1. Un seul paiement.
- **Prix = probabilité implicite** : un token à `0.08` est évalué à 8% de chance de gagner.
- **Résolution à la fermeture** : pas d'exercice anticipé, on garde jusqu'à la fin.
- **Fenêtres glissantes** : de nouvelles fenêtres (ex. 1:45–2:00 PM ET) s'ouvrent constamment,
  ce qui offre un volume quasi-intarissable d'opportunités.

---

## 2. Le cœur de la stratégie : le « reverse bet »

### Le phénomène observé

En début de fenêtre, le prix d'un actif (BTC/ETH) **tend à dériver fortement dans un sens** :

```
BTC monte dans les 10 premières minutes
  → token Up   ~90–97¢  (le favori)
  → token Down ~3–10¢   (l'underdog)
```

La foule, réagissant à chaud à la tendance en cours, cote l'underdog comme **quasi-mort**
(2 à 10% de chance implicite).

### La thèse du bot

Le bot fait le pari **à contre-courant** : *l'underdog va se retourner avant la fermeture*.

> Les cours de 15 minutes sont très volatils. Une dérive forte en début de fenêtre
> ne garantit rien : un renversement de tendance dans les dernières minutes suffit
> pour que l'underdog gagne.

### Pourquoi « reverse » ?

Parce que le bot **achète le côté que la foule abandonne**, à un prix dérisoire,
en pariant sur un retournement — l'inverse du comportement grégaire.

---

## 3. Architecture en deux jambes (legs)

Une seule jambe du marché paie $1 par fenêtre. Le bot exécute donc **deux ordres
complémentaires** pour couvrir le jeu du « retour ou pas » :

### 3.1 Leg « cheap » — le pari reversed sur l'underdog

- **Cible** : l'outcome dont le meilleur ask est le **plus bas** (l'underdog).
- **Prix** : niveaux de limite `CHEAP_BUY_MIN` à `CHEAP_BUY_MAX`, soit **7¢ à 10¢** par défaut.
- **Budget** : `CHEAP_ORDER_USDC` (10 USDC par ordre).
- **Profil** : remplissage rare, mais rendement massif s'il se retourne.

| Prix d'achat | Paiement | Retour si gagné |
|--------------|----------|------------------|
| 7¢  | $1.00 | **+1,329%** |
| 8¢  | $1.00 | **+1,150%** |
| 9¢  | $1.00 | **+1,011%** |
| 10¢ | $1.00 | **+900%** |

### 3.2 Leg « hedge » — la couverture sur le favori

- **Cible** : l'autre outcome (le meilleur ask le plus haut de la paire).
- **Prix** : niveaux `EXPENSIVE_BUY_MIN` à `EXPENSIVE_BUY_MAX`, soit **90¢ à 95¢** par défaut.
- **Budget** : `EXPENSIVE_ORDER_USDC` (50 USDC par ordre).
- **Profil** : remplissage fréquent, petit profit.

| Prix d'achat | Paiement | Retour si gagné |
|--------------|----------|------------------|
| 95¢ | $1.00 | **+5%** |

### Le principe économique combiné

```
Leg cheap  : une mise de 10¢/action qui paie $1 si reversal → potentiel ~10×
Leg hedge  : une mise de 95¢/action qui paie +5% si le favori tient
```

**Une seule jambe gagne.** Mais :

- Quand **l'underdog se retourne** : la jambe cheap paie énormément, la hedge part à zéro. Le gain net est très largement positif.
- Quand **le favori tient** : la jambe cheap part à zéro, la hedge encaisse +5%. Couvre partiellement les pertes.

Sur des **centaines de fenêtres**, le raisonnement statistique est le suivant :
quelques gros revers (à fort multiple) suffisent à **absorber la perte de très nombreux
petits paris cheap perdants**, tandis que la jambe hedge fournit un flux régulier et
amortit la variance.

> Ce n'est pas un arbitrage sans risque : c'est une **stratégie d'espérance positive
> via l'asymétrie** — rarement de gros gains, souvent de petites pertes — avec une
> jambe de couverture qui lisse la courbe de PnL.

---

## 4. Mécanique exacte du code

### 4.1 Filtrage des marchés (`market-scanner.ts`)

`scan()` interroge l'API Gamma Polymarket :

```
GET /events
  ? tag_slug = "15M"
  ? active   = "true"
  ? closed   = "false"
  ? limit    = "50"
```

Puis dans le code, chaque événement est filtré sur :

1. **Slug** : doit commencer par `btc-updown-15m` ou `eth-updown-15m` (`matchesSlugPrefixes`).
2. **Date** : la fenêtre est parsée depuis le slug (timestamp Unix de 10 chiffres en fin de slug).
3. **Période** : `windowStart ≤ now ≤ windowStart + 900s`.
4. **Temps restant** : doit être dans `[MINUTES_BEFORE_CLOSE_MIN, MINUTES_BEFORE_CLOSE_MAX]`
   (par défaut toute la fenêtre 0–15 min).

### 4.2 Sélection underdog/favori (`strategy.ts`)

Pour chaque événement retenu, `getTokenBooks` charge les deux carnets d'ordres
via l'API CLOB (`GET /book?token_id=...`) et extrait le **meilleur ask**.

```
pickReverseToken  = le token avec le meilleur (min) best ask  → underdog
pickFavoriteToken = l'autre token ayant un ask                → favori
```

### 4.3 Construction des ordres (`reverse-strategy.ts` + `utils/prices.ts`)

Pour chaque token, le bot génère une **grille de prix** :

```
priceLevels(0.07, 0.10)  → [0.07, 0.08, 0.09, 0.10]
priceLevels(0.90, 0.95)  → [0.90, 0.91, ..., 0.95]
```

La grille cheap n'est posée que si l'ask underdog est encore `≥ cheapBuyMin`.
Sinon un bid 7-10¢ croiserait tout de suite et prendrait un token déjà mort
(4¢, 1¢) — même comportement en live qu'en backtest.

La grille est tronquée par `maxOpenPositionsPerSide` (positions open + GTC
resting + niveaux déjà émis dans le même tick), par côté token et par kind.
Avec un cap à 2, seuls les 2 premiers crans cheap et les 2 premiers crans
hedge sont posés.

Chaque niveau devient un ordre limit avec une taille calculée :

```
shares = min( budget / price , MAX_SHARES_PER_ORDER )
size   = max(1, floor(shares * 100) / 100)
```

### 4.4 Déduplication (`trade-tracker.ts`)

Le bot tourne indéfiniment et re-scannera les mêmes fenêtres. Pour ne pas
re-soumettre les mêmes ordres, une clé unique est enregistrée par niveau :

```
slug : outcome : {cheap|expensive} - price
```

Si la clé existe déjà dans la session, le niveau est sauté (`tracker.has`).

### 4.5 Exécution (`trader.ts`)

En mode **dry-run** : l'ordre est loggé, aucune soumission.

En mode **live** (`DRY_RUN=false`) :

- Authentification : clé privée (signature) + `funderAddress` (portefeuille proxy, signature type 2).
- Ordre limit **BUY**, type **GTC**, sur le `tokenID` cible.
- Le tick size est déduit du marché (`orderPriceMinTickSize`).

---

## 5. Exemple concret d'une fenêtre

**Marché :** Bitcoin Up or Down — 1:45–2:00 PM ET
**BTC a monté tôt** → Up favori, Down underdog

| Token | Carnet | Le bot poste |
|-------|--------|---------------|
| Up (favori)   | ask 97¢  | BUY limits @ 90–95¢ |
| Down (underdog) | ask 4¢ | BUY limits @ 7–10¢ |

**Scénario A — Down se retourne et gagne** :
- Jambes cheap : 90 parts @ 8¢ → $7.20 in → $90 out → **+$82.80**
- Jambes hedge : → $0
- **Net : gros gain**

**Scénario B — Up tient et gagne** :
- Jambes cheap : → $0
- Jambes hedge : 52 parts @ 95¢ → $49.40 in → $52 out → **+$2.60**
- **Net : petit gain**

---

## 6. Paramètres & réglages

### Stratégie

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CHEAP_BUY_MIN` | `0.07` | Borne basse des enchères cheap |
| `CHEAP_BUY_MAX` | `0.10` | Borne haute des enchères cheap |
| `CHEAP_ORDER_USDC` | `10` | Budget USDC par ordre cheap |
| `ENABLE_EXPENSIVE_HEDGE` | `true` | Active/désactive la jambe hedge |
| `EXPENSIVE_BUY_MIN` | `0.90` | Borne basse hedge |
| `EXPENSIVE_BUY_MAX` | `0.95` | Borne haute hedge |
| `EXPENSIVE_ORDER_USDC` | `50` | Budget USDC par ordre hedge |
| `MAX_SHARES_PER_ORDER` | `90` | Taille max en parts |

### Marchés & timing

| Variable | Défaut | Rôle |
|----------|--------|------|
| `MARKET_SLUG_PREFIXES` | `btc-updown-15m,eth-updown-15m` | Marchés scannés |
| `POLL_INTERVAL_MS` | `5000` | Fréquence de scan |
| `MINUTES_BEFORE_CLOSE_MIN` | `0` | Début des trades (min avant fermeture) |
| `MINUTES_BEFORE_CLOSE_MAX` | `15` | Fin des trades (min avant fermeture) |

Astuce : ne trader que la fin de fenêtre (quand les underdogs bon marché apparaissent) :

```env
MINUTES_BEFORE_CLOSE_MIN=3
MINUTES_BEFORE_CLOSE_MAX=12
```

### Sécurité

| Variable | Défaut | Rôle |
|----------|--------|------|
| `DRY_RUN` | `true` | Log seulement, pas de vrais ordres |

---

## 7. Hypothèses stratégiques

1. **Dérive initiale ≠ issue finale** : un mouvement en tout début de fenêtre
   n'est pas prédictif du résultat à 15 min.
2. **Asymétrie payante** : les sous-cotations des underdogs (< 10¢) sont si faibles
   que les rares revers sur-compensent les pertes fréquentes.
3. **Effet de volume** : la multiplicité des fenêtres 15m génère assez d'échantillons
   pour que l'espérance statistique se réalise.
4. **Le favori tient plus souvent qu'il ne le devrait peut-être à ce prix** :
   d'où la marge du hedge, qui est elle-même statistiquement positive.

---

## 8. Risques & limites

- **La plupart des paris cheap perdent.** Beaucoup de jetons 7–10¢ expirent sans valeur.
- **Les limites peuvent ne pas se remplir.** Enchérir à 7¢ quand l'ask est à 4¢ attend
  un vendeur. Un token très ciblé peut rester non rempli toute la fenêtre.
- **Les deux jambes ne peuvent pas gagner en même temps.** Une jambe va toujours à $0.
  Le « hedge » est un amortisseur, pas une garantie.
- **Variance de capital** : sans budget global, les petits paris perdants s'accumulent
  sur de nombreuses fenêtres.
- **Richesse du carnet** : la sélection underdog/favori ne repose que sur le best ask,
  sans tenir compte du bid ni de la profondeur réelle.
- **Latence de soumission** : un ordre passé très proche de la fermeture peut arriver
  sur une fenêtre déjà clôturée.
- **Argent réel** : toujours commencer avec `DRY_RUN=true`.

---

## 9. Synthèse

Le **reverse bot** exploite un biais comportemental des marchés Up/Down 15 min de
Polymarket : la foule sur-cote la tendance initiale et sous-cote l'underdog. En
postant des **limit BUY à 7–10¢ sur l'underdog** (pari à fort multiple sur un
retournement) couvert par des **limit BUY à 90–95¢ sur le favori** (petite marge
fréquente), il transforme l'asymétrie de prix en espérance positive, sur un grand
volume de fenêtres.

*Ce document est une documentation technique de la stratégie implémentée ; il ne
constitue pas un conseil financier.*
