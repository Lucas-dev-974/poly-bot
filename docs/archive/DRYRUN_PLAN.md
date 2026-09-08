# Plan : Rendre le dryrun réaliste

> Document de conception pour `polymarket-reverse-arbitrage-bot` (v2.0.0).
> Objectif : transformer le dryrun d'un « log de quels ordres je posterais » en un
> **simulateur fidèle de P&L** (remplissage réaliste, suivi de positions, résolution,
> settlement).

---

## 1. Diagnostic — erreurs de logique dans le dryrun actuel

### 1.1 Aucune simulation de remplissage

`Trader.placeBuy` en dryrun retourne immédiatement un résultat sans consulter le
carnet d'ordres (`opportunity.token.bestAsk` est disponible mais ignoré). Chaque
ordre limite est considéré rempli à 100 % au prix limite.

### 1.2 Débit immédiat et total au prix limite

`ReverseBot.executeOpportunity` débite `size * price` (prix limite) dès le postage,
comme si l'ordre s'exécutait instantanément. Un ordre réel peut : ne pas se remplir,
se remplir partiellement, ou se remplir à un meilleur prix.

### 1.3 Aucun settlement / credit

`SimulatedLedger` n'a que `debit`, jamais `credit`. Le payoff de 1 $/part quand un
token gagne n'est jamais crédité. Le solde simulé ne fait que baisser — le P&L réalisé
est structurellement faux (ne peut que perdre). Un PNL latent est affiché côté
dashboard (`(bid - price) * size`) mais jamais réalisé.

### 1.4 Aucun suivi de positions ouvertes

`TradeTracker` est un simple `Set<string>` de clés postées
(`eventSlug:outcome:kind-price`). Aucune structure pour suivre les positions
remplies (token, prix, taille) ni leur résolution à `windowEnd`.

### 1.5 Prix de remplissage irréaliste (les deux jambes)

La stratégie (`pickReverseToken`) choisit l'underdog au **best ask le plus bas**, puis
génère des limites à 7–10¢ via `priceLevels` sans tenir compte de l'ask réel :

- Si l'ask est à **4¢**, la limite à 7¢ est *marketable* → se remplirait à **4¢**
  (amélioration de prix). Le dryrun débite 7¢/part.
- Si l'ask est à **12¢**, la limite à 7¢ ne se remplit **jamais**, mais le dryrun la
  considère remplie.

Même problème pour le hedge expensive (limite 90–95¢ vs ask à 97¢).

### 1.6 Rejet marque quand même le `tradeKey`

En cas de capital insuffisant, `executeOpportunity` marque le `tradeKey` puis
retourne. Le bot ne réessaiera jamais ce niveau, même si le capital se libère.

### 1.7 Gagnant jamais déterminé (cause racine du 1.3)

`windowEnd` est calculé mais jamais utilisé pour déclencher une résolution. Le
scanner filtre `closed=false`, donc une fois le marché résolu, il disparaît du scan
sans que le bot n'en tire la conclusion. Aucun mécanisme de settlement.

### 1.8 Dashboard : `BalanceTracker` live tourne inutilement en dryrun

En dryrun, `getAvailableCollateral` retourne `null` (→ 0 affiché), tandis que le
`SimulatedLedger` émet un `simulatedBalance` séparé. Le frontend les distingue, mais
le `BalanceTracker` live est du bruit superflu en dryrun.

### 1.9 P&L traité jambe par jambe, pas comme arbitrage apparié

La stratégie poste **les deux jambes** d'un marché Up/Down (cheap underdog +
expensive favori, voir `strategy.ts`). Sur 2 outcomes, une jambe gagne toujours
(payoff 1 $/part), donc le P&L réel est un P&L **d'arbitrage apparié** :
`1$ - (coûtCheap + coûtExpensive)` par part appariée. Le dryrun actuel (et le plan
§1–§8 avant ajout de l'étape 2bis) suit chaque jambe indépendamment : le P&L affiché
est bruité (jambe perdue = -cost, jambe gagnante = +size-cost) au lieu de refléter
le P&L garanti de la paire couverte. Corrigé par l'étape 2bis.

### 1.10 Jambe orpheline comptée comme arbitrage couvert

Si la jambe expensive n'est pas remplie (capital épuisé, no-fill), la jambe cheap
reste **découverte** — en live c'est une position directionnelle risquée, pas un
arbitrage. Rien dans le code actuel ne distingue « arbitrage couvert » de « position
directionnelle nue ». Corrigé par l'étape 2bis (paires `partial` labellisées
`directional`).

---

## 2. Architecture cible

```
Nouveau module: SimulatedBroker
├── reçoit TradeOpportunity + carnet (bestAsk, bestBid)
├── décide du remplissage (marketable / partial / no-fill)
├── débite au prix de remplissage (pas au prix limite)
├── enregistre la position ouverte (SimulatedPosition)
└── délègue le settlement à PositionResolver

Nouveau module: PositionResolver
├── surveille windowEnd de chaque position ouverte
├── à windowEnd + délai, détermine le gagnant (source: API Gamma résolue)
├── fallback probabiliste si l'API ne répond pas
├── crédite le ledger (1 $/part si gagnant, 0 sinon)
└── marque la position comme résolue + P&L réalisé

Extension: SimulatedLedger
└── credit(amount)        ← nouveau (débit existe déjà)

Extension: TradeTracker
├── openPositions: SimulatedPosition[]     ← nouveau
├── resolvedPositions: SimulatedPosition[] ← nouveau
├── retryCounts: Map<string, number>       ← nouveau (compteur de tentatives)
├── addOpenPosition(position)              ← nouveau
├── getOpenPositions()                     ← nouveau
├── getRealizedPnl()                       ← nouveau (sum des pnl résolus)
├── getOpenExposure()                      ← nouveau (sum des cost des positions open)
├── incrementRetry(key)                    ← nouveau
└── getRetryCount(key)                     ← nouveau

Nouveau type: SimulatedPosition (types.ts)
```

### Flux d'exécution cible (dryrun)

```
tick()
  → scanner.scan()
  → pour chaque event :
      → getTokenBooks()
      → findOpportunities()
      → pour chaque opportunity :
          → SimulatedBroker.attemptFill(opportunity)
              → marketable ?    fill au bestAsk, débit, créer position
              → non-marketable ? test de probabilité :
                    fill ?      débit, créer position
                    no-fill ?   NE PAS marquer tradeKey, retry au tick suivant
          → si fill : tracker.mark(tradeKey), tracker.addOpenPosition(position)
          → emit opportunity + order

PositionResolver (boucle indépendante ou sur chaque tick)
  → pour chaque position open avec windowEnd passé + délai :
      → résoudre (API Gamma ou fallback probabiliste)
      → ledger.credit(size * 1.00 si gagnant, 0 sinon)
      → position.status = won | lost, position.pnl = credit - cost
      → déplacer openPositions → resolvedPositions
      → emit resolvedPosition
```

---

## 3. Détail des étapes

### Étape 1 — Modéliser la position (`SimulatedPosition`)

Nouveau type dans `types.ts` :

```ts
export interface SimulatedPosition {
  id: string;                    // identifiant unique
  eventSlug: string;
  eventTitle: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  kind: "cheap" | "expensive";
  limitPrice: number;            // prix limite posté
  fillPrice: number;             // prix de remplissage effectif
  size: number;                  // parts remplies
  cost: number;                  // fillPrice * size
  windowEnd: number;             // timestamp de fin de fenêtre
  status: "open" | "won" | "lost";
  resolvedAt?: number;
  pnl?: number;                  // réalisé : credit - cost
  fillReason: "marketable" | "probabilistic" | "partial";
  pairId?: string;               // référence à la SimulatedArbPair (étape 2bis)
}
```

### Étape 2 — Étendre `SimulatedLedger` et `TradeTracker`

`SimulatedLedger` : ajouter `credit(amount)` (le débit existe déjà). Le ledger ne
fait que tenir le solde courant (`capital initial - debits + credits`).

`TradeTracker` : ajouter le suivi des positions et les métriques de P&L :

```ts
addOpenPosition(position: SimulatedPosition): void
getOpenPositions(): SimulatedPosition[]
getRealizedPnl(): number        // sum(position.pnl pour position résolue)
getOpenExposure(): number       // sum(position.cost pour position open)
incrementRetry(key: string): void
getRetryCount(key: string): number
// --- arbitrage couvert (étape 2bis) ---
getOrCreatePair(eventSlug: string, windowEnd: number): SimulatedArbPair
attachLeg(position: SimulatedPosition): void
getArbRealizedPnl(): number
getUncoveredExposure(): number
getCoveredExposure(): number
getCoveredCount(): number
getUncoveredCount(): number
```

Le P&L réalisé et l'exposition ouverte sont des métriques du tracker (qui connaît
les positions), pas du ledger (qui ne connaît que le solde). Voir §8.1.

### Étape 2bis — Position couverte d'arbitrage (`SimulatedArbPair`)

> **Motivation** : le bot s'appelle *reverse-arbitrage* et la stratégie
> (`strategy.ts`) poste **les deux jambes** d'un même marché Up/Down : une jambe
> *cheap* sur l'underdog (0.07–0.10¢) **et** une jambe *expensive* sur le favori
> (0.90–0.95¢). Sur un marché à 2 outcomes, **une des deux jambes gagne toujours**
> (payoff 1 $/part). Le P&L réel de la stratégie est donc un P&L **d'arbitrage
> apparié**, pas deux paris directionnels indépendants.
>
> Sans cette étape, le settlement crédite 1 $ au gagnant et 0 au perdant jambe par
> jambe : le P&L affiché est bruité et — surtout — **une jambe cheap dont le hedge
> expensive n'a pas été rempli** est comptée comme un arbitrage couvert alors qu'en
> live elle est une position directionnelle nue, donc risquée. Cette étape corrige
> les deux problèmes.

#### Nouveau type dans `types.ts`

```ts
export interface SimulatedArbPair {
  id: string;                       // = `${eventSlug}:${windowEnd}`
  eventSlug: string;
  eventTitle: string;
  windowEnd: number;
  cheapLeg?: SimulatedPosition;     // jambe underdog (kind="cheap")
  expensiveLeg?: SimulatedPosition; // jambe favorite (kind="expensive")
  status: "open" | "partial" | "covered" | "resolved";
  // open      : aucune jambe remplie (paire créée en attente)
  // partial   : une seule jambe remplie (arbitrage non couvert → directionnel)
  // covered   : les deux jambes remplies, en attente de résolution marché
  // resolved  : marché résolu, P&L apparié calculé
  realizedPnl?: number;             // P&L apparié (voir settlement ci-dessous)
  resolvedAt?: number;
  coverSlippageBps?: number;        // écart vs coût théorique parfait (métrique)
}
```

`SimulatedPosition` (étape 1) gagne un champ optionnel `pairId?: string` pour
relier chaque jambe à sa paire.

#### Couplage dans `TradeTracker`

Le tracker gère désormais une `Map<string, SimulatedArbPair>` indexée par
`pairId = eventSlug:windowEnd`. Nouvelles méthodes :

```ts
getOrCreatePair(eventSlug: string, windowEnd: number): SimulatedArbPair
attachLeg(position: SimulatedPosition): void   // met à jour cheapLeg/expensiveLeg
                                                // et recompute status (open/partial/covered)
getOpenPairs(): SimulatedArbPair[]              // status !== "resolved"
getResolvedPairs(): SimulatedArbPair[]
getArbRealizedPnl(): number                     // sum(paire.realizedPnl résolue)
getUncoveredExposure(): number                  // sum(cost des paires "partial")
getCoveredExposure(): number                    // sum(cost des paires "covered")
```

Quand une jambe est remplie (`SimulatedBroker.attemptFill` → fill), le `bot.ts`
appelle `tracker.attachLeg(position)` en plus de `tracker.addOpenPosition`. La
paire est créée à la volée si elle n'existe pas.

#### Résolution appariée dans `PositionResolver`

Le resolver continue de résoudre **chaque position** individuellement via l'API
Gamma (le gagnant est une propriété du marché, pas de la paire). Mais le **calcul
du P&L** et le **crédit ledger** se font au niveau de la paire :

1. Le resolver résout chaque jambe (`won`/`lost`, `pnl` individuel comme en étape 5).
2. Quand **les deux jambes** d'une paire sont résolues (`cheapLeg.status` et
   `expensiveLeg.status` ∈ {won, lost}), la paire passe `covered → resolved` :
   - `pair.realizedPnl = (creditCheap + creditExpensive) - (costCheap + costExpensive)`
     = `size * 1.00 - costCheap - costExpensive` (exactement une jambe paie 1 $).
   - Le ledger a déjà été crédité jambe par jambe en étape 5 ; ici on ne fait que
     **agréger et labelliser** le P&L comme « arbitrage couvert ».
3. Cas **partial** (une seule jambe remplie, l'autre no-fill/abandon) :
   - La jambe orpheline reste `open` puis est résolue seule.
   - La paire passe `partial → resolved` avec `realizedPnl = pnlJambeOrpheline`
     (donc soit `size - cost` si gagnante, soit `-cost` si perdante).
   - **Tag explicite** `directional: true` (à ajouter au type ou via un champ
     `uncoveredReason`) pour distinguer arbitrage couvert vs position directionnelle
     non couverte dans les logs et le dashboard.
4. Cas **double-fill mais résolution désynchronisée** : une jambe résolue avant
   l'autre. La paire reste `covered` jusqu'à la seconde résolution. Le P&L apparié
   n'est finalisé qu'une fois les deux jambes résolues. Le P&L « latent apparié »
     peut être affiché entre-temps (`creditAttendu = size` car une jambe gagne).

#### Exemple chiffré

Marché BTC-Up/Down, `windowEnd` T. Bot remplit jambe cheap à 0.07 (size 100, cost
7 $) et jambe expensive à 0.92 (size 100, cost 92 $). Coût total paire = 99 $.

- Up gagne → jambe cheap (underdog Up) `won` credit 100 $, jambe expensive `lost`
  credit 0 $. `pair.realizedPnl = 100 - 99 = +1 $`. ✅ arbitrage couvert.
- Si la jambe expensive **n'a pas été remplie** (no-fill) → paire `partial`,
  jambe cheap seule résolue. Up gagne → `realizedPnl = +93 $` mais tag
  `directional` (risque non couvert). Down gagne → `realizedPnl = -7 $`.
  Le dashboard doit afficher ce cas **à part** et non dans le bucket arbitrage.

#### Pourquoi le crédit ledger reste jambe par jambe

Le ledger tient le **solde courant** (capital - debits + credits), qui est un flux
de trésorerie jambe par jambe indépendant du couplage. Le couplage sert uniquement
au **calcul et à la présentation du P&L réalisé** (arbitrage vs directionnel). Cela
garde le ledger simple (pas de notion de paire) et évite toute double comptabilité
du crédit. Le resolver crédite via `ledger.credit(size)` sur la jambe gagnante en
étape 5 comme prévu ; l'étape 2bis ne fait qu'**agréger** ces crédits déjà passés
au niveau de la paire pour les métriques et le dashboard.

#### Métriques distinguées (à reporter dans `SimulatedStats`, étape 6)

```ts
arbRealizedPnl: number;        // sum(realizedPnl des paires "covered" résolues)
directionalRealizedPnl: number;// sum(realizedPnl des paires "partial" résolues)
coveredCount: number;          // paires résolues avec les 2 jambes
uncoveredCount: number;        // paires résolues avec 1 seule jambe
coverRate: number;             // coveredCount / (covered + uncovered)
uncoveredExposure: number;     // capital immobilisé dans du non couvert
```

Le `winRate` défini en étape 6 (wins/resolved au niveau jambe) devient
**secondaire** pour une stratégie d'arbitrage ; la métrique pertinente est le
`coverRate` et le `arbRealizedPnl`. Le winRate jambe par jambe reste affiché à
titre indicatif (une jambe cheap gagne rarement, c'est attendu).

#### Impact sur les étapes suivantes

- **Étape 3 (SimulatedBroker)** : inchangé, remplit jambe par jambe. Doit juste
  propager le `pairId` dans la `SimulatedPosition` créée (lu sur l'opportunity).
- **Étape 4 (bot.ts)** : après un fill, appeler `tracker.attachLeg(position)` en
  plus de `tracker.mark` / `tracker.addOpenPosition`. Le `pairId` se déduit de
  `opportunity.event.slug + opportunity.event.windowEnd`.
- **Étape 5 (PositionResolver)** : après résolution d'une jambe, vérifier si sa
  paire est entièrement résolue → finaliser `pair.realizedPnl` et status. Le
  resolver a besoin du tracker (déjà prévu §8.6) pour `getPair(pairId)`.
- **Étape 6 (dashboard)** : afficher deux buckets distincts — « Arbitrage couvert »
  (`covered`, `arbRealizedPnl`) et « Positions directionnelles non couvertes »
  (`partial`, `directionalRealizedPnl`, `uncoveredExposure`).
- **TradeOpportunity** gagne un champ dérivé `pairId: string` (calculé dans
  `strategy.ts` au moment de la construction) pour propager le couplage jusqu'au
  broker sans recalcul.

#### Allocation capital et couverture (clarifie §8.2)

§8.2 traitait l'allocation cheap vs expensive comme une question d'ordre
séquentiel. L'étape 2bis ajoute une contrainte explicite : **toute jambe cheap
remplie sans jambe expensive appariée devient une position directionnelle
non couverte**, dont le P&L est compté à part. Pour « comme du réel », on peut
soit (a) accepter ces positions partielles et les labelliser `directional`, soit
(b) ajouter un paramètre `SIM_REQUIRE_COVERED_PAIR=false` qui, à `true`, **rejette**
une jambe cheap si la jambe expensive n'est pas remplie dans le même tick (et
inversement). Phase 1 : accepter + labelliser (option a). Phase 2 : option (b)
paramétrable.

### Étape 3 — `SimulatedBroker` (remplissage réaliste)

Logique de remplissage d'une limite BUY contre le carnet :

#### Cas 1 — Marketable (limite ≥ bestAsk)

- Fill immédiat au `bestAsk` (price improvement vs prix limite).
- Débiter `bestAsk * size` (pas `limitPrice * size`).
- `fillReason = "marketable"`.

#### Cas 2 — Non-marketable (limite < bestAsk)

- L'ordre reste dans le carnet simulé.
- Probabilité de fill paramétrable `SIM_FILL_PROBABILITY_NON_MARKETABLE` (défaut 0.3).
- Ajustement par proximité au bestAsk : plus la limite est proche du bestAsk, plus
  la probabilité augmente. Ajustement par temps restant : plus de temps avant
  `windowEnd` = plus de chances qu'un vendeur traverse le prix.
- Formule proposée :

  ```
  p = baseProb * proximityFactor * timeFactor

  proximityFactor = 1 - (bestAsk - limitPrice) / bestAsk   ∈ [0, 1]
  timeFactor = minutesLeft / 15                             ∈ [0, 1]
  ```

- Si fill : débiter `limitPrice * size` (prix limite, pas d'amélioration car
  non-marketable), créer position.
- Si no-fill : **ne pas marquer le `tradeKey`**, permettre retry au tick suivant.
- `fillReason = "probabilistic"`.

#### Cas 3 — bestAsk null (carnet vide côté ask)

- No-fill systématique. Ne pas marquer le `tradeKey`.

#### Compteur de tentatives

Pour éviter une boucle infinie de retry sur un no-fill, ajouter un compteur par
`tradeKey` dans le `TradeTracker`. Après `SIM_MAX_RETRY_ATTEMPTS` (défaut 20)
tentatives sans fill, marquer définitivement le `tradeKey` (abandon).

#### Partial fill (optionnel, phase 2)

L'endpoint `/book` du CLOB ne retourne que les prix, pas les tailles des niveaux.
En phase 1, on fait du fill binaire (0 % ou 100 %). En phase 2, si on récupère la
profondeur via un endpoint richer, on peut simuler des partial fills.

### Étape 4 — Brancher le broker dans `bot.ts`

Remplacer l'appel direct à `trader.placeBuy` en dryrun par :

```
if (config.dryRun) :
    result = simBroker.attemptFill(opportunity)
    if result.filled :
        tracker.mark(tradeKey)
        tracker.addOpenPosition(position)
    else :
        tracker.incrementRetry(tradeKey)
        if retries >= max : tracker.mark(tradeKey)
        return   // pas de mark, retry possible
else :
    result = trader.placeBuy(opportunity)
    tracker.mark(tradeKey)
```

Le `SimulatedBroker` doit vérifier `ledger.canAfford(cost)` (avec `cost` calculé au
prix de remplissage estimé : `bestAsk * size` si marketable, `limitPrice * size`
sinon) **avant** de tenter le fill. Si capital insuffisant : ne pas remplir, **ne pas
marquer le `tradeKey`** (correction §1.6), logger le rejet, et permettre un retry
au tick suivant si le capital se libère. Le compteur de retry ne s'incrémente pas
pour un rejet capital (ce n'est pas un échec de fill, c'est une contrainte de solde).

Le `Trader.placeBuy` sec (sans carnet) reste utilisé en live.

### Étape 5 — `PositionResolver` (résolution)

#### Option A — Résolution réelle (recommandée)

- À `windowEnd + SIM_RESOLVE_DELAY_SECONDS` (défaut 60 s), interroger l'API Gamma :
  `GET /events?slug=...&closed=true`.
- Lire le résultat du marché : Polymarket expose l'outcome gagnant une fois résolu.
  Le token gagnant paie 1 $, le perdant 0 $.
- Retry jusqu'à `SIM_RESOLVE_MAX_RETRIES` (défaut 5) avec backoff (ex. +30 s).

#### Option B — Fallback probabiliste

Si l'API ne répond pas après N retries, ou si `SIM_RESOLVE_FALLBACK=probabilistic` :

- Estimer P(win) à partir du dernier prix connu du token (approximation : un token à
  8¢ → P(win) ≈ 8 %, éventuellement ajusté par un facteur de calibration).
- Tirer un résultat aléatoire biaisé.
- Logger un avertissement indiquant que la résolution est simulée, pas réelle.

#### Détermination du gagnant via l'API Gamma

L'API Gamma expose `market.outcomes` (JSON array) et, une fois résolu,
`market.closed = true` + le token gagnant identifiable via
`market.winningOutcome` ou le prix final (1.00 pour le gagnant, 0.00 pour le
perdant). Vérifier le schema exact au moment de l'implémentation (l'endpoint
`/markets?slug=...&closed=true` peut être plus direct que `/events`).

#### Settlement

- Si la position a gagné : `ledger.credit(size * 1.00)`, `pnl = size - cost`.
- Si la position a perdue : `ledger.credit(0)`, `pnl = -cost`.
- Déplacer la position de `openPositions` vers `resolvedPositions`.

#### Ordonnancement

Le `PositionResolver` tourne soit :
- dans une boucle `setInterval` indépendante (ex. toutes les 10 s), ou
- en début de chaque `tick()` du bot (check des positions à résoudre).

Préférer la boucle indépendante pour découpler résolution et scan de marchés.

### Étape 6 — Métriques et events bus

Nouveaux events dans `events.ts` :

```ts
| { type: "resolvedPosition"; position: SimulatedPosition }
| { type: "simulatedStats"; stats: SimulatedStats }

export interface SimulatedStats {
  realizedPnl: number;
  openExposure: number;
  openPositionsCount: number;
  resolvedPositionsCount: number;
  wins: number;
  losses: number;
  winRate: number;          // wins / resolved
  fillRate: number;         // filled / attempted
  totalAttempted: number;
  totalFilled: number;
}
```

Le dashboard affiche déjà un PNL latent ; ajouter à côté :
- PNL réalisé (cumul des positions résolues),
- exposition ouverte (capital immobilisé),
- win rate, fill rate,
- liste des positions résolues (avec pnl par position).

### Étape 7 — Désactiver le `BalanceTracker` live en dryrun

Dans `index.ts` :

```ts
if (config.enableDashboard && !config.dryRun) {
  const balance = new BalanceTracker(config);
  balance.start(() => trader.getAvailableCollateral());
}
```

En dryrun, le `SimulatedLedger` est l'unique source de vérité pour le solde.

### Étape 8 — Tests

- **Test fill marketable** : fenêtre synthétique, bestAsk = 0.04, limite = 0.07 →
  fill à 0.04, débit = 0.04 * size.
- **Test no-fill non-marketable** : bestAsk = 0.12, limite = 0.07, probabilité
  forcée à 0 → no-fill, tradeKey non marqué.
- **Test fill non-marketable probabiliste** : probabilité forcée à 1 → fill à 0.07.
- **Test settlement gagnant** : position résolue, token gagnant → credit = size.
- **Test settlement perdant** : position résolue, token perdant → credit = 0,
  pnl = -cost.
- **Test retry** : no-fill répété jusqu'à max retries → abandon, tradeKey marqué.
- **Test capital insuffisant** : debit rejeté, tradeKey non marqué (correction 1.6).
- **Test paire couverte gagnante** : deux jambes remplies (cheap 0.07 + expensive
  0.92, size 100), marché résolu → `pair.realizedPnl = +1 $`, `coverRate = 1.0`,
  `arbRealizedPnl` incrémenté.
- **Test paire partielle (jambe orpheline)** : seule la jambe cheap remplie,
  expensive no-fill → paire `partial` / `directional`. Up gagne →
  `realizedPnl = +93 $` dans le bucket `directionalRealizedPnl`, **pas** dans
  `arbRealizedPnl`. `uncoveredCount` incrémenté.
- **Test résolution désynchronisée** : jambe expensive résolue avant la cheap →
  paire reste `covered` jusqu'à la seconde résolution, puis `realizedPnl` finalisé.
- **Test paire couverte (étape 2bis)** : deux jambes cheap+expensive remplies sur
  le même event, marché résolu → `pair.status = resolved`,
  `pair.realizedPnl = size - costCheap - costExpensive`, comptée dans
  `arbRealizedPnl` / `coveredCount`.
- **Test jambe orpheline (étape 2bis)** : jambe cheap remplie, jambe expensive
  no-fill → `pair.status = partial` puis `resolved` avec tag `directional`,
  comptée dans `directionalRealizedPnl` / `uncoveredCount`, **pas** dans
  `arbRealizedPnl`.
- **Test couplage P&L apparié** : vérifier que sur une paire couverte,
  `arbRealizedPnl` est invariant au gagnant (Up ou Down gagne → même P&L apparié).
- **Test paire couverte gagnante** : deux jambes remplies (cheap 0.07, expensive
  0.92, size 100, coût 99 $), marché résolu → `pair.realizedPnl = +1 $`,
  `status = covered`, tag non `directional`.
- **Test paire couverte perdante côté cheap** : même paire, outcome Down gagne →
  jambe cheap `lost`, expensive `won`, `pair.realizedPnl = +1 $` (une jambe paie
  toujours 1 $). Vérifie l'invariance de l'arbitrage couvert.
- **Test jambe orpheline (partial)** : jambe cheap remplie, expensive no-fill puis
  abandon → paire `partial`, résolue seule. Up gagne → `realizedPnl = +93 $` tag
  `directional`. Down gagne → `realizedPnl = -7 $` tag `directional`. Vérifie que
  ces P&L vont dans le bucket directionnel, pas arbitrage.
- **Test double-fill résolution désynchronisée** : cheap résolue avant expensive →
  paire reste `covered` jusqu'à la seconde résolution, puis `realizedPnl` finalisé.
- **Test paire couverte gagnante** : jambe cheap + expensive remplies, outcome
  gagnant = jambe cheap → `pair.realizedPnl = size - (costCheap + costExpensive)`,
  statut `covered`, tag non `directional`.
- **Test paire couverte perdante (côté cheap)** : outcome gagnant = jambe expensive
  → `pair.realizedPnl = size - (costCheap + costExpensive)` (même valeur, une jambe
  paie 1 $), statut `covered`.
- **Test paire partielle (jambe orpheline)** : jambe cheap remplie, expensive
  no-fill → paire `partial`, jambe cheap résolue seule, `realizedPnl = pnlJambe`,
  tag `directional: true`, comptée dans `uncoveredCount` et non `coveredCount`.
- **Test `coverRate`** : N paires couvertes + M partielles →
  `coverRate = N / (N + M)`.
- **Test paire couverte gagnante** : cheap 0.07 + expensive 0.92 remplies, marché
  résolu → `pair.realizedPnl = size - costCheap - costExpensive` (ex. +1 $), paire
  `covered`, tag non directionnel.
- **Test paire couverte perdante** : même paire, autre outcome gagne → même
  `realizedPnl` (une jambe paie toujours 1 $), valide l'arbitrage.
- **Test jambe orpheline (partial)** : cheap rempli, expensive no-fill → paire
  `partial`, résolution seule, tag `directional`, P&L compté dans
  `directionalRealizedPnl` (pas `arbRealizedPnl`).
- **Test couplage désynchronisé** : cheap résolu avant expensive → paire reste
  `covered` jusqu'à la 2e résolution, puis `realizedPnl` finalisé.

---

## 4. Paramètres `.env` à ajouter

```env
# --- Simulation dryrun ---
SIM_FILL_PROBABILITY_NON_MARKETABLE=0.3   # P(fill) de base si limite < bestAsk
SIM_RESOLVE_DELAY_SECONDS=60              # délai avant lookup de résolution
SIM_RESOLVE_MAX_RETRIES=5                 # tentatives API Gamma (backoff +30s)
SIM_RESOLVE_FALLBACK=probabilistic        # probabilistic | none
SIM_MAX_RETRY_ATTEMPTS=20                 # retries de fill avant abandon
SIM_RANDOM_SEED=                          # seed pour fallback reproductible (vide = aléatoire)
```

Valeurs par défaut dans `config.ts` via `envNumber`/`envString`.

---

## 5. Ordre d'implémentation

1. `SimulatedPosition` (type, avec `pairId`) + `SimulatedArbPair` (type) + `credit`
   sur `SimulatedLedger` + suivi positions/paires/`getRealizedPnl`/
   `getArbRealizedPnl`/`getOpenExposure`/`getUncoveredExposure`/compteur retry sur
   `TradeTracker` — base. Voir §8.1 pour la justification du placement.
2. `SimulatedBroker` (remplissage marketable/non-marketable + compteur retry) — le
   cœur du réalisme.
3. Brancher le broker dans `bot.ts` (remplacer `placeBuy` dryrun) + correction du
   `tradeKey` sur no-fill/rejet + `attachLeg` pour couplage paire (étape 2bis).
4. `PositionResolver` (Option A: API Gamma résolue, fallback B: probabiliste) +
   boucle indépendante + finalisation appariée des paires `covered`/`partial`.
5. Métriques + events bus + dashboard (P&L arbitrage vs directionnel, fill rate,
   cover rate, win rate, positions résolues, buckets couvert/non couvert).
6. Désactiver `BalanceTracker` live en dryrun.
7. Tests (étape 8).

---

## 6. Ce que ce plan résout

| Problème (§1)         | Résolution                        |
|-----------------------|-----------------------------------|
| 1.1 Aucun fill        | SimulatedBroker (étape 3)         |
| 1.2 Débit prix limite | Débit au prix de remplissage (marketable au bestAsk, non-marketable au prix limite) |
| 1.3 Pas de settlement | PositionResolver + credit (étape 5) |
| 1.4 Pas de suivi      | SimulatedPosition + tracker (étape 1) |
| 1.5 Prix irréaliste   | Fill au bestAsk si marketable     |
| 1.6 Rejet marque key  | Correction dans bot.ts (étape 3)  |
| 1.7 Gagnant inconnu   | PositionResolver (étape 5)        |
| 1.8 Dashboard bruit   | Désactivation BalanceTracker (étape 7) |
| 1.9 P&L jambe par jambe au lieu d'arbitrage apparié | SimulatedArbPair + finalisation appariée (étape 2bis) |
| 1.10 Jambe orpheline comptée comme arbitrage couvert | Paires `partial` labellisées `directional` (étape 2bis) |
| 1.9 P&L jambe par jambe, arbitrage non apparié | SimulatedArbPair + couplage tracker/resolver (étape 2bis) |
| 1.9 P&L non apparié (arbitrage traité jambe par jambe) | SimulatedArbPair + résolution appariée (étape 2bis) |
| 1.10 Jambe orpheline non couverte comptée comme arbitrage | Pairs `partial` taggés `directional` + bucket séparé (étape 2bis) |
| 1.9 P&L jambe par jambe (non apparié) | SimulatedArbPair + résolution appariée (étape 2bis) |

---

## 7. Risques et limitations

- **Profondeur du carnet non disponible** : l'endpoint `/book` ne donne que les
  prix, pas les tailles. En phase 1, fill binaire (0/100 %). Partial fill reporté
  en phase 2 (endpoint richer ou API data).
- **Délai de résolution Polymarket** : un marché 15m peut mettre plusieurs minutes
  à être résolu officiellement. Le délai `SIM_RESOLVE_DELAY_SECONDS` (60 s) est un
  minimum ; ajuster selon observations réelles.
- **Fallback probabiliste non fidèle** : la résolution simulée donne un P&L bruité.
  À n'utiliser qu'en cas d'échec API, pas en mode par défaut.
- **Mémoire des positions** : les positions résolues s'accumulent en mémoire. Prévoir
  un rotation/garbage collection après N positions ou après X heures.
- **Frais gas (Polygon)** : Polymarket ne charge pas de fees de trading CLOB, mais
  poster/cancel un ordre coûte du gas. En dryrun, on ignore le gas (négligeable sur
  Polygon, ~centièmes de cent par ordre). À mentionner dans les logs pour ne pas
  fausser l'interprétation du P&L.
- **Pas de persistance** : le ledger, les positions et les stats sont en mémoire.
  Un redémarrage du bot perd tout l'historique du dryrun. Pour un dryrun longue
  durée, prévoir une persistance (fichier JSON ou SQLite) du ledger et des
  positions résolues. Reporté en phase 2, mais à documenter comme limite.
- **Non-reproductibilité du fallback probabiliste** : le tirage aléatoire sans seed
  rend le dryrun non reproductible. Ajouter un paramètre `SIM_RANDOM_SEED` (défaut:
  non déterministe) pour permettre des runs reproductibles en test.

---

## 8. Zones d'ombre identifiées et clarifications

### 8.1 Calcul du P&L réalisé : ledger vs tracker

Le P&L réalisé et l'exposition ouverte sont des métriques du `TradeTracker` (qui
connaît les positions et leur statut open/won/lost), pas du `SimulatedLedger` (qui
ne fait que tenir le solde courant via debits/credits). Un debit pour une position
open n'est pas une perte réalisée.

**Décision (appliquée en §2 et étape 2)** : le tracker expose `getRealizedPnl()`
(somme des `pnl` des positions résolues) et `getOpenExposure()` (somme des `cost`
des positions open). Le ledger expose seulement `getBalance()` (solde courant =
capital initial - debits + credits) et `credit(amount)`.

### 8.2 Ordre de traitement des opportunities et allocation de capital

`findOpportunities` génère les niveaux cheap (0.07 → 0.10) puis expensive
(0.90 → 0.95). Avec un capital limité, les premiers niveaux consomment le capital
et les suivants sont rejetés. L'ordre actuel (cheap d'abord, du moins cher au plus
cher) détermine quel niveau est rempli.

**Clarification** : conserver l'ordre actuel (cheap d'abord). Documenter que
l'allocation reflète la priorité cheap > expensive. Si on veut une allocation
explicite (ex. 60 % cheap / 40 % expensive), ajouter un paramètre
`SIM_CAPITAL_SPLIT_CHEAP_PCT` en phase 2. En phase 1, garder l'ordre séquentiel.

**Couplage à l'étape 2bis** : l'allocation séquentielle peut laisser une jambe
cheap remplie sans jambe expensive (capital épuisé entre les deux). L'étape 2bis
gère ce cas en labellisant la paire `partial` / `directional` plutôt qu'en la
comptant comme arbitrage couvert. Pour forcer un arbitrage strictement couvert en
phase 2, ajouter `SIM_REQUIRE_COVERED_PAIR=true` qui rejette une jambe cheap si la
jambe expensive du même event n'est pas remplie dans le même tick.

### 8.3 Sémantique du `tradeKey` : dryrun vs live

- **Live** : on marque le `tradeKey` au **postage** (avant de savoir si fill), car
  un ordre GTC reste vivant dans le carnet et on ne veut pas re-poster.
- **Dryrun réaliste** : on ne marque le `tradeKey` qu'au **fill**, pour permettre le
  retry sur no-fill.

C'est une divergence intentionnelle. **À documenter** dans le code et le STRATEGY.md
pour éviter la confusion. En dryrun, le `tradeKey` marque « un ordre rempli à ce
prix », pas « un ordre posté à ce prix ».

### 8.4 Extension du type `OrderResult`

Le type `OrderResult` actuel n'a que `price` (prix limite). En dryrun réaliste, le
résultat doit inclure :

```ts
export interface OrderResult {
  dryRun: boolean;
  tokenId: string;
  side: TradeSide;
  price: number;           // prix limite (existant)
  fillPrice?: number;      // prix de remplissage effectif (dryrun réaliste)
  size: number;
  filled?: boolean;        // dryrun: true si rempli, false si no-fill
  response?: unknown;
}
```

`filled` est spécifique au dryrun : en live, `placeBuy` poste un ordre GTC dont le
remplissage n'est pas synchrone, donc `filled` reste `undefined` (le suivi de
remplissement live est hors scope de ce plan). Le dashboard doit utiliser
`fillPrice ?? price` pour le PNL latent et n'afficher que les ordres
`filled === true` dans la liste des positions (en dryrun).

### 8.5 Résolution never-completed

Si l'API Gamma ne répond jamais après `SIM_RESOLVE_MAX_RETRIES` et
`SIM_RESOLVE_FALLBACK=none`, la position reste `open` à jamais. Le P&L est bloqué.

**Correction** : après épuisement des retries, forcer la résolution via le fallback
probabiliste même si `SIM_RESOLVE_FALLBACK=none` (avec un log d'erreur), OU marquer
la position comme `lost` avec `pnl = -cost` (conservateur). Préférer le fallback
probabiliste forcé avec un warning, plutôt que de laisser la position en suspens.

### 8.6 PositionResolver : référence au tracker et au ledger

Le `PositionResolver` a besoin d'accéder au `TradeTracker` (pour lire
`openPositions` et déplacer vers `resolvedPositions`) et au `SimulatedLedger`
(pour créditer). Préciser les dépendances dans le constructeur :

```ts
new PositionResolver(config, tracker, ledger)
```

### 8.7 Arrêt propre du bot

Actuellement le bot tourne avec des `setInterval` sans gestion de signal
`SIGINT`/`SIGTERM`. Avec l'ajout du `PositionResolver` (autre intervalle), prévoir
un graceful shutdown qui : stoppe les intervalles, résout les positions open
restantes (fallback), logge le P&L final. Reporté en phase 2 mais à mentionner.