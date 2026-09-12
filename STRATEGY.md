# Stratégie — moteurs arb (B1), barbell, edge-lead et reverse

> Aligné sur le code (`TradingStrategy`, `ArbStrategy`, `BarbellStrategy`, `EdgeLeadStrategy`, `ReverseStrategy`, `createStrategy`, `bot/reverse-bot.ts`).
> Live : deposit wallet V2 (`SIGNATURE_TYPE=3` par défaut). La stratégie se lit dans `data/bot-settings.json` (dashboard). `.env` ne contient que les secrets et l'infra.

Le JSON actif choisit le **moteur** (`strategyId` : `arb` | `barbell` | `edge-lead` | `reverse`, ou `custom:<id>`). Les **profils** (`config/presets/*.json`) sont des packs de paramètres **liés à un moteur** (champ top-level `strategyId` obligatoire) : `conservative` / `coverage-max` (arb), `edge-lead`, `reverse`. Barbell **n'est pas** un lock de profit : le leftover cheap est un pari volontaire, variance plus élevée. **Edge-lead** inverse l'ordre : favori d'abord, puis cheap après fill (budgets USDC indépendants). **Reverse** (moteur) : grille maker cheap 7–10¢ + grille hedge favori 90–95¢ après fill cheap (`independentHedgeGrid`), sans lock 1:1 — à ne pas confondre avec le vocabulaire « reverse » historique du §2 (cheap nu si le hedge arb rate).

---

## 1. Contexte et marchés ciblés

Le bot opère sur les marchés **Up or Down** de Polymarket à fenêtre **15 minutes** (préfixes configurables, défaut BTC + ETH). Ce sont des marchés de prédiction binaires à résolution rapide :

- Chaque fenêtre de 15 min définit un prix d'ouverture et un prix de clôture.
- Deux tokens : **Up** (paie 1 $ si prix final ≥ prix initial) et **Down** (paie 1 $ si prix final < prix initial).
- Le token gagnant paie **1,00 $**, le perdant paie **0,00 $**. Tenir 1 Up + 1 Down redeem **toujours 1,00 $**.

Ce n'est **pas** un ladder de limites ni une copie d'un carnet manuel. Sur **`arb`**, c'est un **arbitrage binaire** : un seul bid maker cheap, puis un hedge 1:1 seulement si le cheap est **fillé** et que `fillPrice + hedge ≤ PAIR_LOCK_MAX < 1.00`. Sur **`barbell`**, même ordre cheap-then-hedge, mais la taille hedge est `filledCheap × barbellHedgeRatio` (défaut 0.5) **sans** verrou.

---

## 2. Vocabulaire « reverse » (historique) vs moteur `reverse`

> **Attention** : ce § décrit le **comportement résiduel de `arb`** quand le hedge lock échoue (cheap underdog nu). Ce n'est **pas** le moteur `ReverseStrategy` / preset `config/presets/reverse.json` (grilles indépendantes, voir intro).

### 2.1 Principe (arb + leftover)

Le chemin **voulu** de **`arb`** est l'arbitrage binaire : acheter cheap + favori pour **≤ `PAIR_LOCK_MAX`**, lock `(1 − pairCost)` par share au redeem, **quel que soit** le gagnant.

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
├── bot.ts             — re-export ReverseBot
├── bot/               — reverse-bot (orchestration) + lifecycle / resting / executor / balance-guard / tick-snapshots
├── market-scanner.ts  — découverte des marchés + order books (API Gamma + CLOB)
├── strategy.ts        — barrel arb (tests) + réexport des prédicats
├── strategy/          — TradingStrategy (arb, barbell, edge-lead, reverse, chart-rules), sizing, registry
├── trader.ts          — soumission des ordres via ClobClient (Polymarket)
├── trade-tracker.ts   — déduplication des prix déjà postés par session
├── utils/market.ts    — parsing de slug, tick size, best bid/ask
├── utils/prices.ts    — niveaux de prix, calcul de taille, rendement
└── types.ts           — types (UpDownEvent, TokenBook, TradeOpportunity...)
```

### 3.1 Boucle de trading (`bot.ts` / `bot/`)

L'orchestration vit dans `reverse-bot.ts` ; la logique live / resting / exécution / snapshots est sous `src/bot/`.

Toutes les `pollIntervalMs` (défaut code **5000** ms, JSON dashboard) :

1. Prune tracker (posted orders, window claims). **En live** : cancel GTC périmés, poll des fills CLOB (un `matched` n'ouvre une position que si le wallet **détient** les tokens).
2. Scan des marchés actifs (scanner).
3. Pour chaque événement : order books. **En live** : reprice/cancel du cheap resting (`replaceMarketableCheap`), défense des paires nues (`defendUncoveredPairs`).
4. `this.strategy.findOpportunities` : bid cheap maker, hedge selon le moteur **seulement** après fill.
5. Exécution cheap d'abord, puis hedge (`Trader.placeBuy`). Un hedge n'est jamais posté contre un cheap seulement resting. Live : `hedgeAtPostTime` revalide le livre avant le POST.

### 3.2 Découverte des marchés (`market-scanner.ts`)

La méthode `scan()` interroge l'API Gamma :

- `tag_slug=15M`, `active=true`, `closed=false`.
- Filtrage par préfixes de slug (`btc-updown-15m`, `eth-updown-15m`).
- Extraction de `windowStart` depuis le slug (regex `-(\d{10})$`).
- Filtrage temporel : on ne trade que si les minutes restantes sont dans `[MINUTES_BEFORE_CLOSE_MIN, MINUTES_BEFORE_CLOSE_MAX]` (par défaut 0–15 min, i.e. toute la fenêtre ; configurable pour ne trader qu'en fin de fenêtre, là où les tokens cheap apparaissent).

`getTokenBooks()` récupère l'order book CLOB (`/book?token_id=...`) pour chaque token et en extrait le `bestBid` et le `bestAsk`.

### 3.3 Logique de stratégie (`src/strategy/*`)

La **politique** vit dans `TradingStrategy` (`ArbStrategy` / `BarbellStrategy`). Le bot exécute (CLOB, soldes, exposition, tracker). `src/strategy.ts` est un barrel de tests : `findOpportunities` y appelle **toujours** `ArbStrategy` (ignore `config.strategyId`). Production : `createStrategy(config.strategyId)`.

Commun aux deux moteurs :

- **`pickReverseToken`** : parmi les tokens avec un ask, sélectionne celui au **best ask le plus bas** = l'underdog. Les deux asks doivent être présents (un carnet unilatéral ne crée pas de claim).
- **`pickFavoriteToken`** : l'autre token, ask **≥ `EXPENSIVE_BUY_MIN`**, avec au moins **5 shares** au best ask (minimum CLOB).
- **Nouveau cheap seulement si le favori est dans la bande** `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]`.
- **Claim de fenêtre** : underdog/favori mémorisés (`window_claims`).
- **Anti favori-nu** : hedge seulement après cheap fillé.
- **`hedgeAtPostTime` (live)** : 1) ask null → skip ; 2) ask > max → défendre si `shouldDefend`, sinon skip ; 3) ask < min → skip (pas de défense) ; 4) **arb seulement** : fill + hedge > lock → skip ; 5) POST à `min(ask, expensiveBuyMax)`.

**`arb`** — 1:1 + lock (`ArbSizing`) : bid `min(ask, cheapBuyMax, pairLockMax − hedge)`. Hedge = cheap fillé − hedge fillé. Cancel cheap si hors bande **ou** bid > lock − hedge. Défense : vendre `cheap − expensive`. `pairLockMax` ignoré par barbell mais toujours validé 0.90–0.99.

**`barbell`** — ratio (`BarbellSizing`) : bid `min(ask, cheapBuyMax)`, `pairLockOk` toujours true. Hedge = `min(uncovered, budget)` avec `uncovered = cheap × barbellHedgeRatio − hedge fillé`. Cancel cheap seulement si le favori **sort de la bande**. Défense : vendre uniquement la tranche filet manquante (ex. 10 cheap / 3 hedge / ratio 0.5 → vendre **2**, pas 7). Un remainder &lt; 5 parts n'est pas hedgé.

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

**Source de vérité stratégie** : `data/bot-settings.json` (éditée depuis le dashboard). `strategyId` choisit le moteur (`arb` défaut, `barbell`). Chaque fichier `config/presets/*.json` **déclare** `strategyId` ; les deux livrés (`coverage-max`, `conservative`) sont `arb`. `.env` = secrets et infra. En live, le JSON actif est **obligatoire**.

| Clé JSON                     | Défaut (code / example)         | Rôle                              |
|------------------------------|---------------------------------|-----------------------------------|
| `pollIntervalMs`              | 5000                            | Cadence de scan                   |
| `marketSlugPrefixes`          | btc-updown-15m, eth-updown-15m  | Marchés ciblés                    |
| `cheapBuyMin` / `cheapBuyMax` | 0.07 / 0.10                     | Fourchette du bid reverse         |
| `cheapOrderUsdc`              | 1                               | Budget par ordre cheap            |
| `strategyId`                  | arb                             | Moteur : `arb` (1:1 + lock) ou `barbell` (ratio, pas de lock) |
| `barbellHedgeRatio`           | 0.5                             | Cible hedge / cheap fillé pour barbell, ∈ (0, 1]. Ignoré par arb |
| `pairLockMax`                 | 0.98                            | Verrou arb : bid et fill+hedge ≤ cette valeur (toujours validé, ignoré par barbell) |
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

## 7. Moteur edge-lead (favori d'abord)

`strategyId: "edge-lead"` est un moteur **neuf**, indépendant d'arb/barbell. Il n'utilise **pas** `orchestrate.ts` pour l'entrée, ni `pairLockMax` / `cheapBuyMin/Max` comme signal. Le C2 arb (cheap fill avant favori) est **contourné seulement** pour ce moteur (`TradingStrategy.leadsWithEdge`).

### 7.1 Principe

On confirme que l'ask du **favori** (edge) reste dans une bande et **monte** pendant `edgeConfirmSamples` ticks consécutifs, on achète l'edge en **GTC** au best ask, **on attend le fill**, puis on poste le **cheap** au **best ask live** si son ask est dans `[edgeCheapBandMin, edgeCheapBandMax]` (ex. 0.04–0.14). Les tailles sont **indépendantes** (`edgeOrderUsdc` / prix edge vs `edgeCheapOrderUsdc` / ask cheap). Un déséquilibre de shares si les deux fillent est **accepté**. Jamais de cheap tant que l'edge est seulement resting.

### 7.2 Confirmation (5 ticks)

- `edgeConfirmSamples` ticks **consécutifs** valides (défaut 5). Durée réelle ≈ `(N−1) × pollIntervalMs` (poll 1s → ~4s entre 1er et 5e sample). Pas de fenêtre murale glissante.
- Chaque sample doit être dans `[edgeBandMin, edgeBandMax]` (défaut 0.85–0.90).
- Série globalement croissante : `last >= first` **et** `mean > first`. Un plat (0.85 × 5) **n'entre pas**.
- Drop tick-à-tick `> edgeMaxDownTick` (défaut 0.01) → reset. `0.86 → 0.85` OK.
- Identité edge sticky : si l'autre token devient plus cher avant tout POST, reset + nouveau claim. Après POST, le cancel hors bande se lit sur le token claimé. Après fill, le cheap est **toujours l'autre token** (pas de reflip), indépendamment de la bande edge.

### 7.3 Exécution

- **Edge** : toujours **GTC** au best ask, indépendant de `expensiveOrderType` (défaut global FOK — sinon le dispatch FOK-kill l'edge).
- **Cheap** : **seulement après fill edge** (pas après le POST). **Seule condition** : `edgeCheapBandMin ≤ round2(bestAsk) ≤ edgeCheapBandMax` → un **GTC au best ask** sur l'autre token que l'edge claimé. Taille = `computeSize(edgeCheapOrderUsdc, ask, maxSharesPerOrder)`. La bande edge et le buffer de confirmation **ne s'appliquent plus** après fill. Ask hors bande cheap → pas de cheap (pas de spam). GTC cheap **resting** hors bande cheap → **cancel + unmark** ; **re-post** au tick où l'ask rentre. Si le POST cheap échoue : **retry chaque tick** tant que l'ask reste in-band.
- **Cancel hors bande** : si l'ask du token edge claimé sort de la bande alors que l'edge GTC est **resting**, on annule ce GTC, puis `unmark` du tradeKey. Fills gardés. Un cheap resting n'est **pas** annulé par la bande edge.
- **Vente de l'edge nu** : si le cheap ne remplit jamais, l'edge (favori) reste un pari directionnel. Pour limiter la perte, le bot peut **vendre l'edge** (FOK SELL au best bid) quand (1) aucun cheap n'est fillé, (2) le marché a au moins `edgeSellExpensiveAfterMin` minutes, et (3) le best bid est en perte `>= edgeSellExpensiveLossPct` % sous le prix de fill, de façon **continue** pendant `edgeSellExpensiveLossWindowMs`. La perte est mesurée en % du fill price : `lossPct = (bid − fill)/fill × 100`. Une perte sous le seuil (ou un bid manquant) reset le timer de perte continue. Après la vente, la jambe expensive est marquée `sold` et le GTC edge resting est annulé.

### 7.4 Sizing CLOB

Le mode de sizing est piloté par `edgeSizingMode` (`shares` | `pusd` | `dynamic`). Dans tous les modes, la confirmation N ticks et les bandes (edge/cheap) restent appliquées — seul le calcul de **taille** change.

- **`dynamic`** (défaut) : budgets USDC découplés via `computeSize` (`utils/prices.ts`) : 5 shares min et 1 $ de notionnel. Chaque jambe a son propre plafond de shares :
  - **Edge** : `computeEdgeLeadEdgeSize` = `computeSize(edgeOrderUsdc, edgeAsk, maxShareEdge)`. Plafonné par `maxShareEdge` (indépendant de `maxSharesPerOrder` qui plafonne le cheap). Défaut `maxShareEdge = 20` (`config.ts`) ; le preset `edge-lead.json` le monte à `40`.
  - **Cheap** : `computeEdgeLeadCheapSize` = `computeSize(edgeCheapOrderUsdc, cheapAsk, maxSharesPerOrder)`.
- **`pusd`** : identique à `dynamic` pour le calcul (budget USDC / prix), mais le mode est explicite.
- **`shares`** : taille **fixe** par side — `edgeSharesEdge` (edge) et `edgeSharesCheap` (cheap), sans conversion budget/prix. Garde `>= 5` (minimum CLOB) : sous 5, la jambe est skip.

Ex. (preset `edge-lead.json`, `maxShareEdge = maxSharesPerOrder = 40`) : `edgeOrderUsdc=25` @ 0.85 → ~29.41 shares ; `edgeCheapOrderUsdc=5` @ 0.05 → **40** shares (plafonné). Pas de corrélation 1:1 entre les deux jambes. Un budget trop bas pour les minimums CLOB → skip de **cette** jambe seulement.

### 7.5 Paramètres edge-lead

| Clé JSON             | Défaut | Rôle |
|----------------------|--------|------|
| `edgeBandMin`        | 0.85   | Ask favori minimum de la bande de confirmation |
| `edgeBandMax`        | 0.90   | Ask favori maximum de la bande de confirmation |
| `edgeConfirmSamples` | 5      | Ticks consécutifs valides avant d'acheter l'edge |
| `edgeMaxDownTick`    | 0.01   | Drop tick-à-tick max toléré dans la série |
| `edgeCheapBandMin`   | 0.04   | Ask cheap minimum pour poster |
| `edgeCheapBandMax`   | 0.14   | Ask cheap maximum pour poster |
| `edgeOrderUsdc`      | 15     | Budget edge (size = budget / prix edge) — modes pUSD / dynamic |
| `edgeCheapOrderUsdc` | 5      | Budget cheap (size = budget / ask cheap) — modes pUSD / dynamic |
| `edgeSizingMode`     | dynamic| Mode de sizing : shares (fixe) / pUSD (budget USDC) / dynamic (actuel) |
| `edgeSharesEdge`     | 20     | Shares fixes de l'edge en mode shares (≥ 5) |
| `edgeSharesCheap`    | 20     | Shares fixes du cheap en mode shares (≥ 5) |
| `edgeSellExpensiveEnabled` | true | Active la vente de l'edge nu en perte |
| `edgeSellExpensiveAfterMin` | 8  | Âge du marché (min depuis l'ouverture) avant déclenchement |
| `edgeSellExpensiveLossPct`  | 10  | Perte % sous le fill price pour déclencher (ex. 10 = -10%) |
| `edgeSellExpensiveLossWindowMs` | 10000 | Durée de perte continue requise avant la vente |

Preset : `config/presets/edge-lead.json` (`pollIntervalMs: 1000`, `edgeOrderUsdc: 25`, `maxSharesPerOrder: 40`).

---

## 8. Synthèse

Le projet implémente un **arbitrage binaire maker** (B1) sur marchés de prédiction 15 min :

1. **Détection automatique** underdog/favori à partir du best ask.
2. **Un bid cheap maker** seulement si le favori est déjà dans la bande hedge **et** le lock est atteignable, plus **un hedge 1:1** (FOK ou GTC au prix marché clampé) **uniquement** si `fill + hedge ≤ PAIR_LOCK_MAX`.
3. **Holding jusqu'à résolution** d'une paire **couverte**. Cheap **nu** : tenu directionnel si le lock ne passe plus ; FOK SELL (`defendPair`) seulement si le favori passe **au-dessus** de `EXPENSIVE_BUY_MAX` et que la paire n'est pas déjà 1:1.
4. **Sécurité intégrée** : dry-run par défaut, enums validés, `SIM_RESOLVE_FALLBACK=none` obligatoire en live, deposit wallet V2 (`SIGNATURE_TYPE=3`), confirmation de fill/SELL par solde de tokens.

C'est une automation d'arbitrage binaire (paire ≤ lock → profit locké à $1 de redeem), pas un completeur de paire au-dessus de $1. L'edge théorique vient d'un **maker cheap** sous `PAIR_LOCK_MAX − hedge` sur des carnets 15m dont `ask+ask` reste typiquement ~1.01.