# Stratégie B1 — arbitrage binaire (maker cheap + hedge 1:1)

> Aligné sur le code de `polymarket-reverse-arbitrage-bot` (`ArbSizing`, `strategy.ts`, `bot.ts`).
> Live : deposit wallet V2 (`SIGNATURE_TYPE=3` par défaut). La stratégie se lit dans `data/bot-settings.json` (dashboard). `.env` ne contient que les secrets et l'infra.

---

## 1. Contexte et marchés ciblés

Le bot opère sur les marchés **Up or Down** de Polymarket à fenêtre **15 minutes** (préfixes configurables, défaut BTC + ETH). Ce sont des marchés de prédiction binaires à résolution rapide :

- Chaque fenêtre de 15 min définit un prix d'ouverture et un prix de clôture.
- Deux tokens : **Up** (paie 1 $ si prix final ≥ prix initial) et **Down** (paie 1 $ si prix final < prix initial).
- Le token gagnant paie **1,00 $**, le perdant paie **0,00 $**. Tenir 1 Up + 1 Down redeem **toujours 1,00 $**.

Ce n'est **pas** un ladder de limites ni une copie d'un carnet manuel. C'est un **arbitrage binaire** : un seul bid maker cheap, puis un hedge 1:1 seulement si le cheap est **fillé** et que `fillPrice + hedge ≤ PAIR_LOCK_MAX < 1.00`.

---

## 2. La stratégie « reverse »

### 2.1 Principe

Le chemin **voulu** est l'arbitrage binaire : acheter cheap + favori pour **≤ `PAIR_LOCK_MAX`**, lock `(1 − pairCost)` par share au redeem, **quel que soit** le gagnant.

Le cheap est l'underdog (best ask le plus bas). Le hedge est le favori, seulement si son ask est **déjà** dans `EXPENSIVE_BUY_MIN`–`MAX`. Si après fill le favori a bougé et que `fill + hedge > lock`, le bot **ne complète pas** la paire : le cheap devient un pari reverse jusqu'à résolution (ou FOK SELL si l'ask favori passe au-dessus du max).

Le payoff reverse d'un cheap **nu** reste asymétrique :

| Prix d'achat | Paiement | Rendement si gain |
|--------------|---------|-------------------|
| 7¢           | 1,00 $  | +1 329 %          |
| 8¢           | 1,00 $  | +1 150 %          |
| 9¢           | 1,00 $  | +1 011 %          |
| 10¢          | 1,00 $  | +900 %            |

### 2.2 Les deux jambes (legs)

Le bot poste un **BUY limit maker** sur le cheap, puis un hedge **seulement si** le cheap est **fillé** et que le verrou tient :

1. **Jambe « cheap » (reverse)** — UNDERDOG dans `CHEAP_BUY_MIN`–`MAX`. Un seul bid GTC à `min(bestAsk, CHEAP_BUY_MAX, PAIR_LOCK_MAX − hedge)`.
2. **Jambe « expensive » (hedge)** — FAVORI dont l'ask est **déjà** dans `EXPENSIVE_BUY_MIN`–`MAX`. Taille **1:1** avec le cheap **rempli**, au prix `min(ask, EXPENSIVE_BUY_MAX)`, **uniquement si** `fillPrice + hedge ≤ PAIR_LOCK_MAX`.

Ce n'est plus un ladder de limites ni un « completeur de paire ». Si le cheap fill à 0.20 et que le favori a bougé à 0.83 (`1.03 > lock`), **pas de hedge** : le cheap reste directionnel. Un hedge n'est jamais posté contre un cheap seulement *resting* (anti favori-nu).

**Nouveau cheap** : seulement si le favori est dans la bande hedge. Un GTC à 0.80 alors que le favori cote 0.97 n'est pas une couverture.

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
├── strategy/arb-sizing.ts — B1 : bid maker, hedge 1:1, verrou fillPrice + hedge
├── trader.ts          — soumission des ordres via ClobClient (Polymarket)
├── trade-tracker.ts   — déduplication des prix déjà postés par session
├── utils/market.ts    — parsing de slug, tick size, best bid/ask
├── utils/prices.ts    — niveaux de prix, calcul de taille, rendement
└── types.ts           — types (UpDownEvent, TokenBook, TradeOpportunity...)
```

### 3.1 Boucle de trading (`bot.ts`)

Toutes les `pollIntervalMs` (défaut code **5000** ms, JSON dashboard) :

1. Prune tracker (posted orders, window claims). **En live** : cancel GTC périmés, poll des fills CLOB (un `matched` n'ouvre une position que si le wallet **détient** les tokens).
2. Scan des marchés actifs (scanner).
3. Pour chaque événement : order books. **En live** : reprice/cancel du cheap resting (`replaceMarketableCheap`), défense des paires nues (`defendUncoveredPairs`).
4. `findOpportunities` + `ArbSizing` : bid cheap maker, hedge 1:1 **seulement** après fill et si le verrou tient.
5. Exécution cheap d'abord, puis hedge (`Trader.placeBuy`). Un hedge n'est jamais posté contre un cheap seulement resting.

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
- **Nouveau cheap seulement si le favori est dans la bande** `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]` (garde aussi active quand `ENABLE_EXPENSIVE_HEDGE` est true). Au-dessus du max (ex. 0.97), on n'ouvre pas de cheap. En dessous du min, ce n'est pas un favori.
- **Claim de fenêtre** : underdog/favori mémorisés (`window_claims`) pour éviter le flip-flop. Si **rien n'est commis** et que l'underdog a flipé, le claim est droppé et recalculé. Un claim cheap-only (`expensive=""`) peut encore recevoir le favori plus tard via `setWindowClaimExpensive`.
- **Hedge revalidé chaque tick** : si le favori dérive sous `EXPENSIVE_BUY_MIN`, on cesse de poster le hedge. Un cheap **déjà fillé** n'est pas dumpé pour autant (voir défense). Le hedge (FOK **ou** GTC) n'est généré que si le favori est **encore dans la bande** — un GTC au clamp sous un ask > max resterait sur le carnet et se remplirait plus tard en favori nu.
- **Coût de paire (B1, source de vérité `ArbSizing`)** :
  - **Nouveau cheap** : `limit + min(askFavori, EXPENSIVE_BUY_MAX) ≤ PAIR_LOCK_MAX` (défaut **0.98**). Bid = `min(bestAsk, CHEAP_BUY_MAX, PAIR_LOCK_MAX − hedgePrice)`. Si l'ask cheap est à 0.16 et le favori à 0.85, on **s'assoit à 0.13**. Si `PAIR_LOCK_MAX − hedge < CHEAP_BUY_MIN`, pas de cheap.
  - **Hedge après fill** : `fillPrice + min(askFavori, EXPENSIVE_BUY_MAX) ≤ PAIR_LOCK_MAX`. Sinon **pas de hedge** (cheap directionnel). Le lock du hedge utilise le **prix fillé**, pas le bid théorique.
  - **Hedge 1:1** avec le cheap rempli **encore non couvert** (`cheap fillé − hedge fillé`). `EXPENSIVE_ORDER_USDC` est un **plafond secondaire**. Un GTC n'est posté qu'après un cheap rempli. Un reste non couvert < 5 parts n'est pas hedgé (minimum CLOB).
- **Cheap resting** : **annulé** si le favori sort de `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]` ou si le bid dépasse le nouveau cap `PAIR_LOCK_MAX − hedge`. Si l'ordre était **partiellement** rempli, le bot annule d'abord le reste puis enregistre la part remplie (jamais de reste orphelin sur le carnet).
- **Défense (`defendPair`)** : FOK SELL au bid de **l'excédent non couvert** du cheap (`cheap fillé − hedge fillé`) **seulement si** l'ask favori **> EXPENSIVE_BUY_MAX** **et** la paire n'est **pas** déjà couverte 1:1. Un ask sous `EXPENSIVE_BUY_MIN` ne dump **pas** le cheap. Une paire déjà couverte n'est **jamais** vendue, même si le favori va à 1,00 $. Un excédent < 5 parts est tenu. Après une vente, tout hedge GTC encore resting sur la paire est annulé.
- Un fill CLOB `matched` n'ouvre une position cheap que si le wallet **détient** les tokens. Un FOK SELL n'est compté que si le solde de tokens a baissé.

### 3.4 Calcul de la taille (`strategy/arb-sizing.ts` + `utils/prices.ts`)

`ArbSizing` est la source de vérité B1 (bid, hedge 1:1, verrou fill). `computeSize` (`utils/prices.ts`) convertit un budget USDC en parts : plafonné à `MAX_SHARES_PER_ORDER`, arrondi à 2 décimales, minimum CLOB 5 parts et 1 $ de notionnel. Si l'arrondi tombe juste sous 1 $ (ex. 5.26 × 0.19), la taille est relevée d'un tick. Si un budget de 1 $ ne peut pas acheter 5 parts au bid lock, `ArbSizing` **descend** le bid vers `CHEAP_BUY_MIN` (toujours sous le lock) au lieu de sauter la fenêtre.

Le hedge est dimensionné **1:1** avec la taille cheap **remplie et non encore couverte** (`cheap fillé − hedge fillé`, pas le budget), plafonné par `EXPENSIVE_ORDER_USDC / hedgePrice` et `MAX_SHARES_PER_ORDER`. Prix FOK et GTC : `min(bestAsk, EXPENSIVE_BUY_MAX)`. Un GTC n'est posté qu'après un cheap rempli (anti favori-nu, C2). Si le budget plafonne le hedge, la paire est **partielle** : l'excédent cheap n'est coupé (SELL) que par la défense, si le favori sort au-dessus du max. **Attention** : `computeSize` exige 5 parts minimum — un plafond qui n'achète pas 5 parts au prix hedge (≈ 4.75 USDC à 0.95) ne produit **aucun** hedge.

Exemples :

- Cheap @ 13¢, budget 1 USDC → 7.69 parts.
- Hedge 1:1 @ 0.85, plafond 20 USDC → min(7.69, 23.5) = 7.69 parts (1:1, budget non contraignant).
- Hedge 1:1 @ 0.85, plafond 5 USDC → min(7.69, 5.88) = 5.88 parts (budget contraignant : 1.81 parts cheap restent nues — sous 5 parts, ni hedge complémentaire ni SELL de défense possibles).
- Hedge 1:1 @ 0.85, plafond 3 USDC → 3 / 0.85 = 3.52 parts < 5 → **aucun hedge** (`arb-pair-budget-insufficient`), cheap directionnel.
- Cheap 12 parts déjà hedgé 6 parts → prochain hedge = 6 parts (non couvert), jamais 12.
- Fill cheap 0.20 + favori 0.83, lock 0.98 → **aucun hedge** (1.03 > 0.98).

### 3.5 Exécution des ordres (`trader.ts`)

En mode `DRY_RUN=true`, aucun ordre n'est soumis — le bot simule (`SimulatedBroker` + `SimulatedLedger` + `PositionResolver`). En mode live :

- Création d'un `ClobClient` (Polymarket) via viem (wallet Polygon, `privateKeyToAccount`), dérivation des credentials API si nécessaire.
- Cheap : `createAndPostOrder` GTC. Hedge FOK ou GTC selon `EXPENSIVE_ORDER_TYPE`, au prix `min(bestAsk, EXPENSIVE_BUY_MAX)`. **Les deux types** exigent un cheap **filled** (pas un GTC cheap seulement posted).
- Si le cheap resting disparaît sans fill, ou si le cheap fillé est vendu par la défense, le hedge GTC resting de la même paire est annulé (évite un favori nu).
- Un `matched`/`canceled` CLOB dont les tokens n'apparaissent pas dans le wallet est re-vérifié 8 ticks (le solde CLOB peut retarder un fill maker) avant d'être traité comme un match fantôme.
- Un ordre GTC posté sans `orderID` CLOB n'est plus annulable côté exchange — il est seulement retiré du tracker.
- Un fill CLOB `matched` n'ouvre une position que si le solde de tokens conditionnels du funder le confirme (`finalizeLiveOrder`). Un FOK SELL n'est compté que si ce solde a **baissé** (`confirmedSoldSize`). Le hedge est bloqué si le solde cheap est inconnu ou à zéro.
- **Gardes** :
  - live : re-fetch du livre favori avant le hedge ; skip si hors bande ; `not-a-favorite` existe aussi en dry-run (`SimulatedBroker`) si `bestAsk < EXPENSIVE_BUY_MIN` ;
  - plafond d'exposition : `open + resting + coût estimé` vs `MAX_EXPOSURE_USDC` avant chaque ordre ;
  - cap de retries : une erreur CLOB est retentée, abandonnée après `SIM_MAX_RETRY_ATTEMPTS`.
- Un ordre posté est enregistré (`posted_orders`) et compte dans l'exposition resting. Cancel CLOB à `windowEnd + 5 min` ; lignes sans `orderId` prunées à +15 min ; ordres trackés à +24 h. Les claims de fenêtre expirent à `windowEnd + 900 s`.

### 3.6 Déduplication de session (`trade-tracker.ts`)

Un `Map<string, createdAt>` mémorise les clés `eventSlug:outcome:kind-price` déjà postées (pruné à 24 h). Un tick en cours ignore les ticks suivants (`ticking`). Les outcomes cheap/expensive sont **claimés** pour la fenêtre ; le claim cheap est relâché si rien n'est encore commis et que le reverse a flipé.

---

## 4. Exemple de fenêtre

**Marché :** Bitcoin Up or Down — 1:45–2:00 PM ET
**Contexte :** BTC pumped tôt → Up favori, Down cheap.

| Token             | Book     | Bot posts                                      |
|-------------------|----------|------------------------------------------------|
| Up (favori)       | ask 85¢ (dans 85–95¢) | hedge BUY 1:1 **après** fill cheap, si fill+0.85 ≤ 0.98 |
| Down (underdog)   | ask 16¢, lock 0.98 | **un** GTC maker @ 0.13 (`0.98−0.85`) |

Si Up cote **97¢** (hors `EXPENSIVE_BUY_MAX`), le bot **n'émet aucun cheap** sur cette fenêtre jusqu'à ce que le favori rentre dans la bande.

| Résultat | Paire couverte (0.13+0.85=0.98) | Cheap nu (lock raté après fill) |
|----------|----------------------------------|----------------------------------|
| Up gagne | redeem 1 $ → **+2 ¢ / share** lockés | Down → 0 $ (perte du cheap) |
| Down gagne | redeem 1 $ → **+2 ¢ / share** lockés | Down → 1 $ (gros payoff reverse) |

---

## 5. Paramétrage

**Source de vérité stratégie** : `data/bot-settings.json` (éditée depuis le dashboard). `.env` = secrets (`PRIVATE_KEY`, `FUNDER_ADDRESS`, Builder/Relayer) et infra (`DRY_RUN`, hôtes, ports, DB). En live, le JSON est **obligatoire**.

| Clé JSON                     | Défaut (code / example)         | Rôle                              |
|------------------------------|---------------------------------|-----------------------------------|
| `pollIntervalMs`              | 5000                            | Cadence de scan                   |
| `marketSlugPrefixes`          | btc-updown-15m, eth-updown-15m  | Marchés ciblés                    |
| `cheapBuyMin` / `cheapBuyMax` | 0.07 / 0.10                     | Fourchette du bid reverse         |
| `cheapOrderUsdc`              | 1                               | Budget par ordre cheap            |
| `pairLockMax`                 | 0.98                            | Verrou : bid et fill+hedge ≤ cette valeur |
| `enableExpensiveHedge`        | true                            | Active la jambe favori            |
| `expensiveBuyMin` / `Max`     | 0.85 / 0.95                     | Fourchette du hedge (favori)      |
| `expensiveOrderUsdc`          | 15                              | Plafond de coût du hedge 1:1 (≥ 5 parts au prix hedge, sinon aucun hedge) |
| `expensiveOrderType`          | FOK                             | FOK ou GTC                        |
| `maxSharesPerOrder`           | 20                              | Plafond de parts                  |
| `maxExposureUsdc`             | 45                              | Cap d'exposition (fills + reposants) |
| `minutesBeforeCloseMin` / `Max` | 0 / 15                        | Fenêtre de trading dans la fenêtre|
| `simResolveFallback`          | none                            | `none` obligatoire en live ; `probabilistic` = RNG dry-run only |

`.env` (hors stratégie) :

| Paramètre                    | Défaut                          | Rôle                              |
|------------------------------|---------------------------------|-----------------------------------|
| `DRY_RUN`                     | true                            | Sécurité (simulation)             |
| `PRIVATE_KEY`                 | —                               | Clé de signature (live)           |
| `FUNDER_ADDRESS`              | —                               | Wallet proxy Polymarket           |
| `SIGNATURE_TYPE`              | 3                               | 0=EOA, 2=Gnosis Safe, 3=POLY_1271 |

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

La stratégie **couverte** lock un petit profit certain à la résolution (`1 − pairCost` par share). Le cheap **nu** (lock inatteignable après fill, ou hedge désactivé) redevient un pari reverse asymétrique :

- **Paire couverte ≤ lock** → redeem 1 $ ; PnL = `(1 − pairCost) × size`, indépendant du gagnant.
- **Cheap nu** : la majorité expire à zéro ; un retournement paie ~1 000 % ; c'est un risque **non voulu** par B1, pas l'edge principal.
- **Hedge seul** n'est jamais posté (anti favori-nu). Un hedge 1:1 sur paire lockée gagne peu si le favori tient, et le cheap paie si retournement — le net est le lock.

### Risques identifiés

- **Cheap nu (directionnel).** Si le cheap fill et que `fill + askFavori > PAIR_LOCK_MAX`, le bot **ne hedge pas** et **ne vend pas** pour autant. C'est un pari jusqu'à résolution, sauf défense si l'ask favori passe **au-dessus** de `EXPENSIVE_BUY_MAX`.
- **Paire partielle.** Si `EXPENSIVE_ORDER_USDC` plafonne le hedge sous le 1:1, l'excédent cheap reste nu ; il n'est vendu que par la défense (favori > `EXPENSIVE_BUY_MAX`) et seulement s'il fait ≥ 5 parts. Un plafond < 5 parts au prix hedge supprime tout hedge.
- **La plupart des paris cheap seuls perdent.** Les tokens 7–10¢ expirent fréquemment worthless.
- **Les limites peuvent ne pas remplir.** Un bid maker à 0.13 quand l'ask est à 0.16 attend un vendeur.
- **Les deux jambes d'une paire couverte ne peuvent pas gagner ensemble.** Un côté va toujours à 0 $ ; le redeem de la paire est 1 $.
- **Argent réel.** Tester d'abord avec `DRY_RUN=true`. Les bandes, lock et budgets se changent dans le dashboard (`data/bot-settings.json`), pas dans `.env`.

---

## 7. Synthèse

Le projet implémente un **arbitrage binaire maker** (B1) sur marchés de prédiction 15 min :

1. **Détection automatique** underdog/favori à partir du best ask.
2. **Un bid cheap maker** seulement si le favori est déjà dans la bande hedge **et** le lock est atteignable, plus **un hedge 1:1** (FOK ou GTC au prix marché clampé) **uniquement** si `fill + hedge ≤ PAIR_LOCK_MAX`.
3. **Holding jusqu'à résolution** d'une paire **couverte**. Cheap **nu** : tenu directionnel si le lock ne passe plus ; FOK SELL (`defendPair`) seulement si le favori passe **au-dessus** de `EXPENSIVE_BUY_MAX` et que la paire n'est pas déjà 1:1.
4. **Sécurité intégrée** : dry-run par défaut, enums validés, `SIM_RESOLVE_FALLBACK=none` obligatoire en live, deposit wallet V2 (`SIGNATURE_TYPE=3`), confirmation de fill/SELL par solde de tokens.

C'est une automation d'arbitrage binaire (paire ≤ lock → profit locké à $1 de redeem), pas un completeur de paire au-dessus de $1. L'edge théorique vient d'un **maker cheap** sous `PAIR_LOCK_MAX − hedge` sur des carnets 15m dont `ask+ask` reste typiquement ~1.01.