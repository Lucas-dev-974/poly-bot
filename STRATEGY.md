# Stratégie de « Reverse Arbitrage » sur marchés Polymarket 15m BTC/ETH

> Papier d'analyse du bot `polymarket-reverse-arbitrage-bot` (v2.0.0).
> Compte de trading : [@odahoa](https://polymarket.com/@odahoa?tab=activity) — proxy wallet `0xe2511c9e41c5e762887e538b1d6e7221807aa237` (Gnosis Safe, `SIGNATURE_TYPE=2`).

---

## 1. Contexte et marchés ciblés

Le bot opère sur les marchés **Up or Down** de Polymarket à fenêtre **15 minutes** pour le Bitcoin (BTC) et l'Ethereum (ETH). Ce sont des marchés de prédiction binaires à résolution rapide :

- Chaque fenêtre de 15 min définit un prix d'ouverture et un prix de clôture.
- Deux tokens : **Up** (paie 1 $ si prix final ≥ prix initial) et **Down** (paie 1 $ si prix final < prix initial).
- Le token gagnant paie **1,00 $**, le perdant paie **0,00 $**.

Le bot reproduit de façon automatisée les ordres qui étaient placés manuellement sur @odahoa : limites rondes (7¢–95¢), 20–90 parts, uniquement des `BUY`, tenus jusqu'à résolution.

---

## 2. La stratégie « reverse »

### 2.1 Principe

Sur une fenêtre de 15 min, le prix BTC/ETH trend souvent dans un sens dès les premières minutes. La foule (`crowd`) prix alors :

- Le **token favori** (Up si pump, Down si dump) autour de 90–97¢.
- Le **token underdog** (le côté opposé) autour de 3–10¢.

La stratégie « reverse » parie sur un **retournement** avant la clôture : le token quasi-mort à 7–10¢ revient à la vie et paie 1 $. Le rendement asymétrique est énorme :

| Prix d'achat | Paiement | Rendement si gain |
|--------------|---------|-------------------|
| 7¢           | 1,00 $  | +1 329 %          |
| 8¢           | 1,00 $  | +1 150 %          |
| 9¢           | 1,00 $  | +1 011 %          |
| 10¢          | 1,00 $  | +900 %            |

### 2.2 Les deux jambes (legs)

Le bot poste systématiquement des ordres **BUY limit** sur **les deux côtés** de chaque fenêtre :

1. **Jambe « cheap » (reverse)** — UNDERDOG dans `CHEAP_BUY_MIN`–`MAX` : petites mises, gros payoff potentiel (~10–14×).
2. **Jambe « expensive » (hedge)** — FAVORI dont l'ask est **déjà** dans `EXPENSIVE_BUY_MIN`–`MAX` : un seul ordre 1:1, gain petit mais plus fréquent.

L'idée centrale : un seul retournement gagnant couvre plusieurs pertes cheap, tandis que le hedge encaisse quand le favori tient. Les deux jambes ne peuvent pas gagner simultanément (un seul token paie 1 $), mais elles capturent deux régimes de résultat.

**Règle actuelle** : pas de *nouveau* cheap tant que le favori n'est pas dans la bande hedge. Un GTC à 0.80 alors que le favori cote 0.97 n'est pas une couverture — c'est un cheap nu. Si un cheap est déjà commis, le hedge peut encore être posté.

### 2.3 Pourquoi « reverse » ?

La foule surestime la persistance de la tendance intra-fenêtre :

```
BTC pumps dans les 10 premières minutes
  → Up token   ~90–97¢  (favori)
  → Down token ~3–10¢   (underdog, supposé mort)
```

Le pari reverse : **il se retourne avant la clôture**. Sur des fenêtres de 15 min, l'extrême volatilité du BTC/ETH rend les retournements statistiquement plausibles, et le pricing de l'underdog à un chiffre sous-évalue cette probabilité.

---

## 3. Architecture technique

Le code est en TypeScript (ESM, via `tsx`), organisé en modules clairs :

```
src/
├── index.ts           — point d'entrée
├── config.ts          — chargement/validation des paramètres (.env)
├── bot.ts             — boucle principale (ReverseBot)
├── market-scanner.ts  — découverte des marchés + order books (API Gamma + CLOB)
├── strategy.ts        — détection underdog/favori + construction des opportunités
├── trader.ts          — soumission des ordres via ClobClient (Polymarket)
├── trade-tracker.ts   — déduplication des prix déjà postés par session
├── utils/market.ts    — parsing de slug, tick size, best bid/ask
├── utils/prices.ts    — niveaux de prix, calcul de taille, rendement
└── types.ts           — types (UpDownEvent, TokenBook, TradeOpportunity...)
```

### 3.1 Boucle de trading (`bot.ts`)

Toutes les 5 s (`POLL_INTERVAL_MS=5000`) :

1. Scan des marchés actifs (scanner).
2. Pour chaque événement, récupération des order books.
3. `findOpportunities` déduit underdog/favori et génère les opportunités.
4. Exécution des ordres via `Trader.placeBuy`, en marquant chaque clé pour éviter le repost.

### 3.2 Découverte des marchés (`market-scanner.ts`)

La méthode `scan()` interroge l'API Gamma :

- `tag_slug=15M`, `active=true`, `closed=false`.
- Filtrage par préfixes de slug (`btc-updown-15m`, `eth-updown-15m`).
- Extraction de `windowStart` depuis le slug (regex `-(\d{10})$`).
- Filtrage temporel : on ne trade que si les minutes restantes sont dans `[MINUTES_BEFORE_CLOSE_MIN, MINUTES_BEFORE_CLOSE_MAX]` (par défaut 0–15 min, i.e. toute la fenêtre ; configurable pour ne trader qu'en fin de fenêtre, là où les tokens cheap apparaissent).

`getTokenBooks()` récupère l'order book CLOB (`/book?token_id=...`) pour chaque token et en extrait le `bestBid` et le `bestAsk`.

### 3.3 Logique de stratégie (`strategy.ts`)

Le cœur décisionnel :

- **`pickReverseToken`** : parmi les tokens avec un ask, sélectionne celui au **best ask le plus bas** = l'underdog. Les deux asks doivent être présents (un carnet unilatéral ne crée pas de claim).
- **`pickFavoriteToken`** : l'autre token, ask **≥ `EXPENSIVE_BUY_MIN`**, avec au moins **5 shares** au best ask (minimum CLOB). La profondeur n'est **pas** calée sur `CHEAP_BUY_MIN` (ça gonflait le seuil, ex. 16 shares à 5¢, et bloquait un favori dans la bande).
- **Nouveau cheap seulement si le favori est dans la bande** `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]`. Au-dessus du max (ex. 0.97), on attend. En dessous du min, ce n'est pas un favori.
- **Claim de fenêtre** : underdog/favori mémorisés (`window_claims`) pour éviter le flip-flop. Si **rien n'est commis** et que l'underdog a flipé, le claim est droppé et recalculé. Un claim cheap-only (`expensive=""`) peut encore recevoir le favori plus tard via `setWindowClaimExpensive`.
- **Hedge revalidé chaque tick** : si le favori dérive sous `EXPENSIVE_BUY_MIN`, on cesse de poster le hedge.
- **Coût de paire** : `prix cheap + min(ask favori, EXPENSIVE_BUY_MAX) ≤ PAIR_LOCK_MAX` (défaut **0.98**, verrou profit < 1.00). Hedge **1:1** après cheap *filled*, seulement si le favori est **encore dans la bande**. `EXPENSIVE_ORDER_USDC` est un plafond secondaire (le dimensionnement principal est 1:1 avec le cheap rempli).
- **Cheap** : un seul bid à `min(bestAsk, CHEAP_BUY_MAX)`, borné par `PAIR_LOCK_MAX − hedgePrice`, s'il est dans `[CHEAP_BUY_MIN, CHEAP_BUY_MAX]` et que l'ask cheap n'est pas déjà sous le floor. **Hedge** : un seul ordre au `min(ask favori, EXPENSIVE_BUY_MAX)`.

### 3.4 Calcul de la taille (`utils/prices.ts`)

La taille cheap = budget USDC / prix, plafonnée à `MAX_SHARES_PER_ORDER`, arrondie à 2 décimales, minimum CLOB 5 parts et 1 $ de notionnel. Si l'arrondi tombe juste sous 1 $ (ex. 5.26 × 0.19), la taille est relevée d'un tick.

Le hedge est dimensionné **1:1** avec la taille cheap **remplie** (pas le budget), plafonné par `EXPENSIVE_ORDER_USDC / hedgePrice` et `MAX_SHARES_PER_ORDER`. Prix FOK et GTC : `min(bestAsk, EXPENSIVE_BUY_MAX)`. Un GTC n'est posté qu'après un cheap rempli (anti favori-nu, C2). Si le budget est insuffisant pour couvrir le cheap rempli, le hedge est limité et l'excédent cheap est coupé via SELL (`defendPair`).

Exemples :

- Cheap @ 13¢, budget 1 USDC → 7.69 parts.
- Hedge 1:1 @ 0.85, plafond 20 USDC → min(7.69, 23.5) = 7.69 parts (1:1, budget non contraignant).
- Hedge 1:1 @ 0.85, plafond 3 USDC → min(7.69, 3.52) = 3.52 parts (budget contraignant, 4.17 parts cheap excédentaires coupées via SELL).

### 3.5 Exécution des ordres (`trader.ts`)

En mode `DRY_RUN=true`, aucun ordre n'est soumis — le bot simule (`SimulatedBroker` + `SimulatedLedger` + `PositionResolver`). En mode live :

- Création d'un `ClobClient` (Polymarket) via viem (wallet Polygon, `privateKeyToAccount`), dérivation des credentials API si nécessaire.
- Cheap : `createAndPostOrder` GTC. Hedge : FOK (`createAndPostMarketOrder`) ou GTC selon `EXPENSIVE_ORDER_TYPE`, au prix `min(bestAsk, EXPENSIVE_BUY_MAX)`.
- FOK hedge : uniquement après un cheap **filled** (pas un GTC cheap seulement posted).
- Si le cheap resting disparaît sans fill, le hedge GTC de la même paire est annulé (évite un favori nu).
- Un ordre GTC posté sans `orderID` CLOB n'est plus annulable côté exchange (2.37) — il est seulement retiré du tracker.
- **Gardes au même niveau qu'en dry-run** :
  - hedge rejeté (`not-a-favorite`) si `bestAsk < EXPENSIVE_BUY_MIN` ;
  - plafond d'exposition : la somme des ordres postés reposants (`MAX_EXPOSURE_USDC`) est vérifiée avant chaque ordre ;
  - cap de retries : une erreur CLOB est retentée, abandonnée après `SIM_MAX_RETRY_ATTEMPTS`.
- Un ordre posté est enregistré (`posted_orders`), exposé au plafond, et purgé une fois sa fenêtre passée (900 s).

### 3.6 Déduplication de session (`trade-tracker.ts`)

Un `Map<string, createdAt>` mémorise les clés `eventSlug:outcome:kind-price` déjà postées (pruné à 24 h). Un tick en cours ignore les ticks suivants (`ticking`). Les outcomes cheap/expensive sont **claimés** pour la fenêtre ; le claim cheap est relâché si rien n'est encore commis et que le reverse a flipé.

---

## 4. Exemple de fenêtre

**Marché :** Bitcoin Up or Down — 1:45–2:00 PM ET
**Contexte :** BTC pumped tôt → Up favori, Down cheap.

| Token             | Book     | Bot posts                                      |
|-------------------|----------|------------------------------------------------|
| Up (favori)       | ask 87¢ (dans 85–95¢) | 1 hedge BUY @ 0.87, 1:1 cheap |
| Down (underdog)   | ask 8¢                | BUY limits @ cheap min–max    |

Si Up cote **97¢** (hors `EXPENSIVE_BUY_MAX`), le bot **n'émet aucun cheap** sur cette fenêtre jusqu'à ce que le favori rentre dans la bande.

| Résultat            | Jambe cheap    | Jambe hedge           |
|---------------------|----------------|-----------------------|
| Up gagne            | Down → 0 $     | Up → petit profit     |
| Down se retourne    | Down → gros profit | Up → 0 $          |

---

## 5. Paramétrage (`.env`)

| Paramètre                    | Défaut                          | Rôle                              |
|------------------------------|---------------------------------|-----------------------------------|
| `POLL_INTERVAL_MS`            | 5000                            | Cadence de scan                   |
| `MARKET_SLUG_PREFIXES`        | btc-updown-15m,eth-updown-15m   | Marchés ciblés                    |
| `CHEAP_BUY_MIN/MAX`           | 0.07 / 0.10                     | Fourchette des bids reverse       |
| `CHEAP_ORDER_USDC`            | 1                               | Budget par ordre cheap            |
| `ENABLE_EXPENSIVE_HEDGE`      | true                            | Active la jambe favori            |
| `EXPENSIVE_BUY_MIN/MAX`       | 0.85 / 0.95                     | Fourchette du hedge (favori)      |
| `EXPENSIVE_ORDER_USDC`        | 3                               | Plafond de coût du hedge 1:1      |
| `EXPENSIVE_ORDER_TYPE`        | FOK                             | FOK ou GTC                        |
| `MAX_SHARES_PER_ORDER`        | 20                              | Plafond de parts                  |
| `MAX_EXPOSURE_USDC`           | 45                              | Cap d'exposition (fills + reposants) |
| `MINUTES_BEFORE_CLOSE_MIN/MAX`| 0 / 15                          | Fenêtre de trading dans la fenêtre|
| `DRY_RUN`                     | true                            | Sécurité (log uniquement)         |
| `PRIVATE_KEY`                 | —                               | Clé de signature (live)           |
| `FUNDER_ADDRESS`              | —                               | Wallet proxy Polymarket           |
| `SIGNATURE_TYPE`              | 3                               | 0=EOA, 2=Gnosis Safe, 3=POLY_1271 |
| `SIM_RESOLVE_FALLBACK`        | none                            | `none` obligatoire en live ; `probabilistic` = RNG dry-run only |

### Résolution et fallback

À `windowEnd + SIM_RESOLVE_DELAY_SECONDS`, le gagnant est lu via l'API Gamma (`outcomePrices` : "1" = gagnant, "0" = perdant) avec retries. Si l'API ne répond pas : `SIM_RESOLVE_FALLBACK=probabilistic` résout par probabilité `fillPrice` (note : biaise favorablement le hedge en cas de panne API) ; `none` laisse la position ouverte pour être retentée.

### Trading en fin de fenêtre uniquement

Quand les tokens cheap n'apparaissent qu'en fin de fenêtre :

```env
MINUTES_BEFORE_CLOSE_MIN=3
MINUTES_BEFORE_CLOSE_MAX=12
```

---

## 6. Profil de risque / rendement

La stratégie est **asymétrique et orientée fréquence** :

- **La majorité des bids cheap (7–10¢) expirent à zéro** → pertes fréquentes mais petites (≤ 10 USDC par ordre).
- **Quelques retournements gagnants** rapportent ~1 000–1 300 % → un seul gain peut couvrir des dizaines de pertes cheap.
- **Le hedge (90–95¢)** gagne plus souvent (le favori tient fréquemment) mais avec un rendement marginal (~5 %), et perd ~90–95 % si retournement.
- **Les deux jambes ne gagnent jamais ensemble** ; l'espérance repose sur la fréquence des retournements vs. la constance des favoris.

### Risques identifiés

- **La plupart des paris cheap perdent.** Les tokens 7–10¢ expirent fréquemment worthless.
- **Les limites peuvent ne pas remplir.** Bider 7¢ quand l'ask est à 4¢ attend un vendeur qui descend.
- **Les deux jambes ne peuvent pas gagner ensemble.** Un côté va toujours à 0 $.
- **Argent réel.** Tester d'abord avec `DRY_RUN=true`.

---

## 7. Synthèse

Le projet implémente une stratégie de **market-making directionnel inversé** sur marchés de prédiction binaires ultra-courts :

1. **Détection automatique** underdog/favori à partir du best ask.
2. **Ladder cheap** seulement si le favori est déjà dans la bande hedge, plus **un hedge 1:1** (FOK ou GTC au prix marché clampé), dédupliqués par fenêtre.
3. **Holding jusqu'à résolution** (jamais de SELL) — capture du payoff binaire 0 $/1 $.
4. **Sécurité intégrée** : dry-run par défaut, enums validés, `SIM_RESOLVE_FALLBACK=none` obligatoire en live, deposit wallet V2 (`SIGNATURE_TYPE=3`).

C'est une automation fidèle du comportement manuel observé sur @odahoa : mises petites sur les cotes extrêmes, pari sur la non-persistance des tendances intra-fenêtre, et couverture par le côté favori. L'edge théorique vient de la **sur-réaction du crowd pricing** en début de fenêtre : les underdogs à 3–10¢ sont sous-évalués quand un retournement de 15 min sur BTC/ETH reste statistiquement plausible.