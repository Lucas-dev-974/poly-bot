# Plan — Éditeur graphique de moteur stratégique (POC edge-lead)

> Date : 2026-09-10
> Statut : **Proposition — à valider avant implémentation**
> Périmètre : POC basé sur `edge-lead`, éditeur visuel node-based, activation live + backtest.

> **Errata 2026-09-10** — corrections post-refactor bot (P1–P4) + contrat `TradingStrategy` actuel :
> - Contrat : **6 méthodes + 1 flag** (`shouldSellExpensiveEdge` + `EdgeSellContext` manquaient ; câblage live via `resting-manager.sellExpensiveEdgeIfNeeded`).
> - Orchestration : `src/bot/reverse-bot.ts` (hot-swap `onRuntimeSettingsChanged` → `lifecycle`/`resting`/`executor.setStrategy`) ; resting/sell edge/`cheapOrderAction` → `resting-manager.ts` ; execute/C2/`hedgeAtPostTime`/`orderTypeFor` → `opportunity-executor.ts` ; lifecycle → `live-order-lifecycle.ts` ; `src/bot.ts` = re-export `ReverseBot` uniquement.
> - `edgeOrderAction` = **extension optionnelle Phase 5 proposée**, **pas** dans le `TradingStrategy` courant.
> - `dagLayout` : `frontend/src/guide/dagLayout` (utilisé par guide `Diagrams`) — à réutiliser/adapter pour strategy-editor, pas déjà une page éditeur.
> - Phase 5 (ops temporels) reste additive **après** parité des 6 méthodes.
>
> **Errata 2026-09-10 (audit 2 — zones d'ombre tranchées)** :
> 1. **Parité `shouldSellExpensiveEdge`** : grapher vraiment (pas de stub `false`, pas d'op opaque). Phase 1 ajoute les primitifs `eq`/`lt`/`gt`/`lte`/`gte`/`add`/`sub`/`mul`/`div` + timer stateful `holdTrueFor` (clé `pairId`). Sous-graphe §4.2bis. Horloge = `GraphContext.nowMs` (fallback `Date.now()` si tick non ouvert) — **identique au natif** (`Date.now()` dans `EdgeLeadStrategy.shouldSellExpensiveEdge`). Phase 5 n'injecte **pas** `nowMs` dans `EdgeSellContext` natif (hors décision) : les tests 10b/10c restent en horloge murale.
> 2. **Ops temporels cheap/defend** : ajouter **seulement** `pairId: string` à `RestingCheapContext` et `DefendContext` (champs ignorés par arb/barbell/edge-lead natifs). Les bornes de fenêtre viennent du cache `pairWindow*` appris en `findOpportunities`. **Pas** de `windowStart`/`windowEnd` sur ces contextes. Ordre live (`reverse-bot.processEvent`) : `manageLiveResting` **puis** `findOpportunities` → le cache du tick courant n'est pas encore à jour pendant cheap/defend (on lit le tick précédent ; 1er tick d'une paire → `null` → ops temporels `false`). Idem backtest (`manageRestingPolicy` avant `findOpportunities`).
> 3. **Clés/validation custom** : `keysForStrategy` / `validateConfigCoherence` **chargent le graphe** (getter `leadsWithEdgeFor(id)`) ; ils cessent d'être pures. Contrainte boot : `loadConfig()` tourne **avant** `db.init()` dans `index.ts` → ne pas valider l'edge custom au parse ; re-valider après repos. `applyRuntimeSettings` / dashboard reçoivent le getter (repos).
> 4. **Collision de noms** : op booléen tracker `hasEdgeFill` / `hasCheapFill` ; `cheapFilled` = nombre `EdgeSellContext` ; `filledCheap` = nombre `DefendContext`.
> 5. **Autres figés** : modèle d'évaluation = accumulateur `TradeOpportunity[]` + `return` ; `GraphEdge.kind: "data"|"control"` ; gardes `appendOpportunity` **ON** pour le POC ; DELETE du graphe actif **refusé** ; `parseStrategyId` lower-case les ids `custom:` ; CSS éditeur manquant ajouté.
>
> **Errata 2026-09-10 (audit 3 — bugs fantômes restants, figés)** :
> 1. **Évaluation paresseuse des ports** : l'interpréteur **n'évalue PAS** tous les ports d'un nœud avant l'op. `and`/`or`/`if` évaluent `a`/`cond` puis court-circuitent (`and` : `a` faux → pas `b` ; `or` : `a` vrai → pas `b`). Sinon `sub`/`div` du % de perte throw sur bid null, et `confirmTicks` n'est plus avant `size`.
> 2. **Horloge Phase 1 vs Phase 5** : en live/backtest, `shouldSellExpensiveEdge` tourne **avant** `findOpportunities`. Réutiliser `tickNowMs` (posé à `findOpportunities`) rendrait le timer sell **en retard d'un tick** vs le natif (`Date.now()` à l'entrée de la méthode). **Phase 1** : chaque méthode pose `GraphContext.nowMs = Date.now()` **à l'entrée** (fallback si pas d'injection). Lecteur `nowMs` = **Phase 1** (requis par `holdTrueFor`). **Phase 5** : injection `nowMs` sur `StrategyContext` / cheap / defend pour sampleWindow/inPhase — **pas** sur `EdgeSellContext` (parité sell-edge native conservée).
> 3. **`if` implicite** : tout nœud à sortie booléenne avec arêtes `then`/`else` (`inCheapBand` dans `cheapOrderAction`) se comporte comme `if` — pas seulement `op === "if"`.
> 4. **`confirmTicks`** : un seul nœud par graphe (buffer natif clé `pairId` seul). Prelude + `buffer.push(..., ctx.config)` — les ports bande/samples/maxDownTick doivent être `{kind:"config"}` des clés natives (sinon prelude ≠ push).
> 5. **`computeEdgeLeadEdgeSize` / `CheapSize`** : wrap des fonctions natives avec `ctx.config` ; le port `budget` est **ignoré** (le mode shares/pusd ne l'utilise pas).
> 6. **`pairId` sur DefendContext** : call site oublié `src/strategy/hedge-post.ts` (l.22-27) + tests (`trading-strategy.test.ts`, `edge-lead.test.ts`).
> 7. **Colonne SQL `leadsWithEdge` vs `graphJson`** : `upsert` copie les deux ; en cas d'écart à la lecture, **JSON gagne** + repair colonne.

---

## 1. Contexte et objectif

Le bot possède 3 moteurs codés en dur (`arb`, `barbell`, `edge-lead`) sous forme de classes
TypeScript implémentant l'interface `TradingStrategy`. L'objectif est de permettre de
**construire visuellement la logique d'un moteur** via un éditeur de nœuds, sans écrire de code.

Le POC prend **`edge-lead` comme base** : on doit pouvoir reproduire sa logique dans un graphe
éditable, l'activer en live (hot-swap) et la charger dans le moteur de backtest.

### Contrat à modéliser

L'interface `TradingStrategy` (**6 méthodes + 1 flag**) est le contrat que le graphe doit satisfaire
(`src/strategy/trading-strategy.ts`) :

```ts
export interface TradingStrategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly leadsWithEdge: boolean;           // flag
  findOpportunities(ctx: StrategyContext): TradeOpportunity[];
  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction;
  shouldDefend(ctx: DefendContext): boolean;
  defendShares(ctx: DefendContext): number;
  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision;
  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean;  // 6e méthode (edge-lead)
}

// EdgeSellContext (champs réels) :
//   config, tracker, pairId, expensiveBid, expensiveFillPrice,
//   expensiveSize, cheapFilled, marketAgeMs
```

Le bot appelle ces méthodes via le module bot refactoré :
`reverse-bot.ts` (orchestration / `findOpportunities` / hot-swap),
`resting-manager.ts` (`cheapOrderAction`, `shouldDefend`/`defendShares`,
`shouldSellExpensiveEdge` via `sellExpensiveEdgeIfNeeded`),
`opportunity-executor.ts` (`hedgeAtPostTime`, C2, `orderTypeFor`),
plus `backtest/runner.ts`. Le flag `leadsWithEdge` pilote des comportements câblés en dur
(tri des opportunités, gestion du GTC edge, bypass C2, défense). **Le POC garde
`leadsWithEdge` comme attribut du graphe** (décision de cadrage), pas comme nœud réimplémenté.

> **Note** : `edgeOrderAction` n'existe **pas** dans le contrat actuel — c'est une **extension
> optionnelle proposée en Phase 5** (§7.1.3 / décisions de cadrage), additive après la parité
> des 6 méthodes.

---

## 2. Décisions de cadrage (validées)

| Sujet | Décision |
|---|---|
| Objectif de validation | **Parité exacte** : le graphe doit reproduire `edge-lead` à l'identique (test de parité contre la classe native) |
| Activation | **Hot-swap live** dès le POC (via `strategyId`) **et** chargeable dans le moteur backtest |
| `leadsWithEdge` | **Attribut du graphe** (pas un nœud) |
| Conditions temporelles | **Ops dédiés** (§4.1.1 : horloge, fenêtres glissantes 5-10 s, tendance, phases) — Phase 5 **additive après** parité 6 méthodes. `edgeOrderAction` = **extension optionnelle proposée** (pas dans `TradingStrategy` actuel) |
| Persistance | **Nouvelle table SQLite** (versionnée, cohérente avec l'existant) |
| Éditeur visuel | **Canvas SVG maison** (réutiliser/adapter `frontend/src/guide/dagLayout` utilisé par guide `Diagrams` — pas déjà une page strategy-editor) |
| Parité sell-edge | **Grapher** avec primitifs compare/arithmétique + `holdTrueFor` (pas de stub, pas d'op opaque) |
| `pairId` cheap/defend | **Extension additive** des contextes natifs (bornes de fenêtre = cache `pairWindow*`, pas de champs window* sur cheap/defend) |
| Clés config custom | **Lookup graphe** (`leadsWithEdgeFor`) ; re-validate après `db.init()` |

---

## 3. Architecture cible

```
┌─────────────────────────── FRONTEND (SolidJS) ───────────────────────────┐
│  /strategy-editor  (nouvelle page)                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────┐   │
│  │ Palette      │   │ Canvas SVG   │   │ Panneau propriétés / JSON    │   │
│  │ (nœuds)      │   │ (drag&drop,  │   │ (params par nœud, validation)│   │
│  │              │   │  connexions) │   │                              │   │
│  └──────────────┘   └──────────────┘   └──────────────────────────────┘   │
│         └───────────────►  export JSON  ◄────────────────┘                │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ POST /api/strategy
┌──────────────────────────────────▼───────────────────────────────────────┐
│                          BACKEND (Node/TS)                                │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────────────┐  │
│  │ API          │   │ Interpréteur      │   │ Registre hybride         │  │
│  │ /api/strategy│──►│ GraphStrategy     │──►│ createStrategy(id, repos?)│  │
│  │ (CRUD+valid) │   │ implements        │   │  arb/barbell/edge-lead   │  │
│  └──────────────┘   │ TradingStrategy   │   │  custom:<id> → graphe    │  │
│                     └──────────────────┘   └──────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SQLite : table strategy_graphs (id, name, graphJson, version, ...)  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Principe clé** : les 3 moteurs natifs restent des classes. L'éditeur produit des moteurs
`custom:<id>` qui passent par l'interpréteur. On **ne casse rien**, on ajoute une voie.

---

## 4. Spécification du DSL (graphe sérialisable)

### 4.1 Types TypeScript

Nouveau fichier : `src/strategy/graph/types.ts`

```ts
// Identité d'un nœud dans le graphe
export type GraphNodeId = string;

// Opérations primitives disponibles (réutilisent le code existant)
export type GraphOp =
  // --- lecteurs de contexte (seule porte d'accès aux métriques marché) ---
  | "books"                 // ctx.books (TokenBook[])
  | "cheapBook"             // ctx.cheapBook (TokenBook | null)
  | "claimedOutcome"        // edgeClaimedOutcome(tracker, pairId) → string | null
  | "favoriteAsk"           // ctx.favoriteAsk (number | null)
  | "limitPrice"            // ctx.limitPrice (number)
  | "filledCheap"           // ctx.filledCheap (number)
  | "filledExpensive"       // ctx.filledExpensive (number)
  | "pairId"                // ctx.pairId (string)
  | "nowMs"                 // ctx.nowMs — Phase 1 (holdTrueFor / sell-edge), pas seulement Phase 5
  | "freshAsk"              // ctx.freshAsk (number | null)
  | "askOf"                 // token.bestAsk (number | null)
  | "bidOf"                 // token.bestBid (number | null)
  | "askSizeOf"             // token.bestAskSize (number | null)
  // --- sélection de token ---
  | "pickReverseToken"      // predicates.pickReverseToken
  | "pickFavoriteToken"     // predicates.pickFavoriteToken
  | "pickEdgeToken"         // edge-lead-strategy.pickEdgeToken (à exporter)
  | "pickTokenByOutcome"    // predicates.pickTokenByOutcome
  | "pickOtherTokenByOutcome" // books.find(b => b.outcome !== outcome) — le « cheap » d'edge-lead (native l.181-182)
  // --- prédicats / bandes ---
  | "inBand"                // ask ∈ [min, max]  (entrée : ask)
  | "inCheapBand"           // cheapAskInBand     (entrée : ask)
  | "confirmTicks"          // EdgeConfirmBuffer (stateful) — exception « tout par ports », cf. §5.1
  | "favoriteAskInBuyRange" // predicates.favoriteAskInBuyRange
  | "round2"                // predicates.round2 — parité prix cheap (native l.187 et l.265)
  // --- sizing ---
  | "computeSize"           // utils/prices.computeSize
  | "computeEdgeLeadEdgeSize"   // (entrée : edgePrice)
  | "computeEdgeLeadCheapSize"  // (entrée : cheapPrice)
  // --- contrôle (option A validée : court-circuit) ---
  | "if"                    // décision booléenne : 2 sorties (then / else)
  | "switch"                // décision multi-branches (par valeur)
  | "gate"                  // laisse passer ou bloque selon une condition
  | "return"                // stoppe l'évaluation, retourne le résultat courant
  // --- décisions ---
  | "const"                 // valeur constante
  | "and" | "or" | "not"    // logique
  | "eq" | "lt" | "gt" | "lte" | "gte"  // comparaison (null → throw, guard `isNull` amont)
  | "add" | "sub" | "mul" | "div"       // arithmétique (`div` par 0 → throw)
  | "holdTrueFor"           // timer stateful (clé pairId) : cond faux → reset+false ; cond vrai → elapsed >= durationMs
  | "isNull"                // teste si une valeur est null/undefined
  | "postEdge"              // émet une opportunité "expensive"
  | "postCheap"             // émet une opportunité "cheap"
  | "skip"                  // pas d'opportunité
  | "keep" | "cancel-lock" | "take-ask"   // cheapOrderAction
  | "defend" | "no-defend"  // shouldDefend / defendShares
  | "hedge-skip" | "hedge-post" | "hedge-defend"  // hedgeAtPostTime
  | "sell-edge" | "no-sell-edge"  // shouldSellExpensiveEdge (bool → décision)
  | "expensiveBid" | "expensiveFillPrice" | "expensiveSize" | "cheapFilled" | "marketAgeMs"
                            // lecteurs EdgeSellContext
  | "hasEdgeFill"           // tracker.getFilledExpensiveSizeForPair > 0  (bool, findOpportunities)
  | "hasCheapFill"          // tracker.getFilledCheapSizeForPair > 0     (bool, findOpportunities)
  | "edgePosted" | "cheapPosted"  // tracker.getPostedOrdersForPair
  | "countOpenPerSide"      // garde maxOpenPositionsPerSide
  | "countLegsByKind"       // garde countLegsByKind
  | "hasTradeKey"           // tracker.has
  | "makeTradeKey";         // tracker.makeKey

/**
 * Contexte général : union de tous les champs des 5 contextes natifs
 * (StrategyContext, RestingCheapContext, DefendContext, HedgePostContext,
 * EdgeSellContext). Chaque méthode remplit les champs qu'elle possède, le reste
 * est `null`. Les lecteurs de contexte lisent ici ; la validation vérifie la
 * disponibilité des champs par méthode (voir §5.2).
 *
 * Corrections audit :
 * - `config` : présent dans les contextes natifs — omis de la v1 du plan.
 *   Les ops dépendant d'un mode de sizing (computeEdgeLeadEdgeSize/CheapSize
 *   lisent edgeSizingMode/edgeSharesEdge/edgeSharesCheap/maxShareEdge en
 *   interne) le lisent ici ; les scalaires (bandes, budgets) restent des
 *   GraphParam { kind: "config" }.
 * - `pairId` : rempli pour findOpportunities (dérivé de event), hedge, sell-edge,
 *   **et** cheapOrderAction / shouldDefend / defendShares (contexte natif étendu
 *   audit 2). Table §5.2 mise à jour.
 * - `cheapFilled` (nombre, EdgeSellContext) ≠ `hasCheapFill` (bool tracker,
 *   findOpportunities) ≠ `filledCheap` (nombre, DefendContext).
 * - `cheapBook` natif est `TokenBook | undefined` (RestingCheapContext) :
 *   l'interpréteur normalise `undefined` → `null`.
 * - Errata 2026-09-10 : ajouter `EdgeSellContext` (6e méthode
 *   `shouldSellExpensiveEdge`) — champs expensiveBid / expensiveFillPrice /
 *   expensiveSize / cheapFilled / marketAgeMs.
 */
export interface GraphContext {
  // présent dans les contextes natifs (dont EdgeSellContext)
  config: BotConfig | null;
  // findOpportunities
  books: TokenBook[] | null;
  event: UpDownEvent | null;
  tracker: TradeTracker | null;
  // findOpportunities (dérivé de event) + cheapOrderAction + shouldDefend/defendShares
  // + hedgeAtPostTime + shouldSellExpensiveEdge
  // cheap/defend : pairId passé par le caller (contexte natif étendu, décision audit 2)
  pairId: string | null;
  // cheapOrderAction
  cheapBook: TokenBook | null;
  favoriteAsk: number | null;
  limitPrice: number | null;
  // defend
  filledCheap: number | null;
  filledExpensive: number | null;
  // hedge
  freshAsk: number | null;
  // shouldSellExpensiveEdge (EdgeSellContext)
  expensiveBid: number | null;
  expensiveFillPrice: number | null;
  expensiveSize: number | null;
  cheapFilled: number | null;       // EdgeSell : shares cheap fillées (0 = favori nu)
  marketAgeMs: number | null;
  // horloge (§4.1.1/§7.1.2) — remplie pour TOUTES les méthodes : Date.now() live / ctx.nowMs backtest
  nowMs: number | null;
}
```

#### 4.1.1 Ops temporels (nouveaux — §5.3, §7.1.2)

```ts
// Ajouts à GraphOp (§4.1) — ops temporels (§4.1.1) :
export type GraphOp =
  // ... ops existants ...
  // --- temps / fenêtre (nouveaux) ---
  | "nowMs"                    // déjà dans §4.1 Phase 1 — rappel
  | "windowStartSec"           // ctx.event.windowStart → number (findOpportunities)
  | "windowEndSec"             // ctx.event.windowEnd → number (findOpportunities)
  | "minutesLeft"              // (windowEndSec − nowMs/1000) / 60
  | "secondsElapsed"           // (nowMs/1000 − windowStartSec)
  | "inPhase"                  // floor(elapsed / phaseDurationSec) ∈ [phaseMin, phaseMax]
  | "windowRange"              // secondsElapsed ∈ [startSec, endSec] (offsets depuis windowStart)
  | "sampleWindow"             // série de samples {ts, ask} par pairId (stateful, §5.3)
  | "trendUp"                  // slope(samples) > minSlope sur la fenêtre maxAgeMs
  | "trendDown"                // slope(samples) < −minSlope
  | "trendNeutral"             // |slope| <= minSlope
  | "pairWindowStart"          // pairId → windowStart (lecture stateful apprise en findOpportunities)
  | "pairWindowEnd";           // pairId → windowEnd
```

**Sémantique des ops temporels** — tous reçoivent l'horloge et les bornes de fenêtre **par ports**
(réf. aux lecteurs `nowMs` / `windowStartSec` / `windowEndSec` / `pairWindowStart` / `pairWindowEnd`),
comme les ops métier reçoivent l'ask. Seule exception : le **store interne** de `sampleWindow`
(clé `nodeId × pairId`, §5.3).

| Op | Ports d'entrée | Sortie | Stateful |
|---|---|---|---|
| `nowMs` | aucun (lecteur ctx) | `number \| null` | non |
| `windowStartSec` / `windowEndSec` | aucun (lecteurs ctx.event) | `number \| null` | non |
| `pairWindowStart` / `pairWindowEnd` | `pairId` | `number \| null` | oui (cache appris) |
| `minutesLeft` | `windowEndSec`, `nowMs` | `number \| null` | non |
| `secondsElapsed` | `windowStartSec`, `nowMs` | `number \| null` | non |
| `inPhase` | `windowStartSec`, `nowMs`, `phaseDurationSec`, `phaseMin`, `phaseMax` | `boolean` | non |
| `windowRange` | `windowStartSec`, `nowMs`, `startSec`, `endSec` (offsets s. depuis windowStart) | `boolean` | non |
| `sampleWindow` | `pairId`, `ask`, `nowMs`, `maxAgeMs` | `SampleState` (`{ samples: Array<{ ts: number; ask: number }> }`) | **oui** |
| `trendUp` | `samples`, `nowMs`, `maxAgeMs`, `minSlope` | `boolean` | non |
| `trendDown` | `samples`, `nowMs`, `maxAgeMs`, `minSlope` | `boolean` | non |
| `trendNeutral` | `samples`, `nowMs`, `maxAgeMs`, `minSlope` | `boolean` | non |

> **Correction audit (horloge, audit 3)** : `nowMs` est rempli à **l'entrée de chaque méthode**.
> Phase 1 live : `Date.now()` par appel (parité sell-edge). Jamais `Date.now()` **dans** les ops
> (ils lisent le port / `GraphContext.nowMs`). Phase 5 : injection snapshot sur findOpp/cheap/defend
> seulement — pas `EdgeSellContext`. `tickNowMs` unique par tick **abandonné** : il cassait le
> timer sell (resting avant findOpp).

> **Correction audit (trend)** : `trendUp`/`trendDown` demandent **≥ 2 samples récents** (`maxAgeMs`) et un `minSlope` (> 0). Un `ask` null n'entre PAS dans la série (le natif skip le tick, il ne postule pas). Un `trendUp` avec < 2 samples récents ou slope insuffisant → **false** (pas d'erreur, pas de throw) : le market-making exige la prudence par défaut.

> **Correction audit (parité v1→temporal)** : le natif `edge-lead` utilise `buffer.push(pairId, ask, edgeOutcome, config)` — un état stateful par pairId. `sampleWindow` suit exactement le même pattern : clé de store = `pairId` (nœud-id × pairId), entrée `ask`, maxAgeMs purge auto. La parité native (confirmTicks) reste inchangée : **confirmTicks garde sa propre implémentation native** (EdgeConfirmBuffer), les ops temporels sont un ADDITIF pour de nouveaux graphes.

**Exemple d'usage** (illustratif, pas parité) :

```json
{ "id": "pair-id", "op": "pairId", "params": {} },
{ "id": "cheap-token", "op": "pickOtherTokenByOutcome", "params": { "books": { "kind": "ref", "node": "books" }, "outcome": { "kind": "ref", "node": "claimed-outcome" } } },
{ "id": "cheap-ask", "op": "askOf", "params": { "token": { "kind": "ref", "node": "cheap-token" } } },
{ "id": "now", "op": "nowMs", "params": {} },
{ "id": "ws", "op": "windowStartSec", "params": {} },
{ "id": "sample-10s", "op": "sampleWindow", "params": { "pairId": { "kind": "ref", "node": "pair-id" }, "ask": { "kind": "ref", "node": "cheap-ask" }, "nowMs": { "kind": "ref", "node": "now" }, "maxAgeMs": { "kind": "literal", "value": 10000 } } },
{ "id": "trend-up", "op": "trendUp", "params": { "samples": { "kind": "ref", "node": "sample-10s" }, "nowMs": { "kind": "ref", "node": "now" }, "maxAgeMs": { "kind": "literal", "value": 10000 }, "minSlope": { "kind": "literal", "value": 0.002 } } },
{ "id": "in-phase-1", "op": "inPhase", "params": { "windowStartSec": { "kind": "ref", "node": "ws" }, "nowMs": { "kind": "ref", "node": "now" }, "phaseDurationSec": { "kind": "literal", "value": 300 }, "phaseMin": { "kind": "literal", "value": 0 }, "phaseMax": { "kind": "literal", "value": 0 } } },
{ "id": "enter-now", "op": "and", "params": { "a": { "kind": "ref", "node": "in-phase-1" }, "b": { "kind": "ref", "node": "trend-up" } } }
```

> **Évaluation des nœuds temporels** : `sampleWindow` est un **nœud d'action stateful** : son
> évaluation (side-effect : push du sample horodaté) doit se produire **une fois par tick**,
> avant que `trendUp` ne lise la série. Comme `confirmTicks` (§5.1), c'est une exception au
> « tout par ports » : l'op stocke les samples en interne (clé `nodeId × pairId`) et purge
> au-delà de `maxAgeMs`. Un `ask` null/undefined n'est PAS échantillonné (skip du tick, comme
> le natif). Règles complètes d'évaluation temporelle : §5.3.

```ts
// Paramètres d'un nœud (références à des clés de config + valeurs)
export type GraphParam =
  | { kind: "config"; key: string }        // ex. edgeBandMin
  | { kind: "literal"; value: number | string | boolean }
  | { kind: "ref"; node: GraphNodeId };    // sortie d'un autre nœud

export interface GraphNode {
  id: GraphNodeId;
  op: GraphOp;
  params: Record<string, GraphParam>;
}

export interface GraphEdge {
  from: GraphNodeId;
  to: GraphNodeId;
  // Figé audit 2 — plus de surcharge de `port` :
  // - kind: "data"    → `port` = nom du port d'ENTRÉE du nœud cible ("ask", "books", "token"…)
  // - kind: "control" → `port` = branche SORTIE du nœud source ("then"/"else" d'un `if`,
  //   ou d'un nœud booléen utilisé comme if implicite)
  kind: "data" | "control";
  port: string;
}

// Un graphe décrit les 6 méthodes + le flag
export interface StrategyGraph {
  id: string;                 // "custom:<uuid>"
  name: string;
  description?: string;
  leadsWithEdge: boolean;
  findOpportunities: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  cheapOrderAction: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  shouldDefend: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  defendShares: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  hedgeAtPostTime: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  shouldSellExpensiveEdge: { nodes: GraphNode[]; edges: GraphEdge[]; root: GraphNodeId };
  version: number;
  createdAt: number;
  updatedAt: number;
}
```

### 4.2 Exemple : graphe `edge-lead` (findOpportunities)

Reproduction fidèle de `edge-lead-strategy.ts` (machine à états à 3 phases, modélisée en
**nœuds de contrôle** — option A validée) :

```json
{
  "id": "custom:edge-lead-poc",
  "name": "Edge-lead (POC)",
  "leadsWithEdge": true,
  "findOpportunities": {
    "root": "phase-1",
    "nodes": [
      // --- lecteurs de contexte (métriques marché) ---
      { "id": "books", "op": "books", "params": {} },
      { "id": "edge-token", "op": "pickEdgeToken",
        "params": { "books": { "kind": "ref", "node": "books" } } },
      { "id": "edge-ask", "op": "askOf",
        "params": { "token": { "kind": "ref", "node": "edge-token" } } },
      { "id": "claimed-outcome", "op": "claimedOutcome", "params": {} },
      // Correction audit : l'op natif pickTokenByOutcome(books, claimedOutcome)
      // sélectionnerait le TOKEN EDGE lui-même (outcome == claimé), pas le cheap.
      // Le cheap natif est books.find(b => b.outcome !== claimedOutcome).
      // → nouvel op pickOtherTokenByOutcome (native l.181-182).
      { "id": "cheap-book", "op": "pickOtherTokenByOutcome",
        "params": { "books": { "kind": "ref", "node": "books" },
                    "outcome": { "kind": "ref", "node": "claimed-outcome" } } },
      { "id": "cheap-ask", "op": "askOf",
        "params": { "token": { "kind": "ref", "node": "cheap-book" } } },

      // --- phase 1 : edge posté, pas fillé → attendre ---
      { "id": "phase-1", "op": "if",
        "params": { "cond": { "kind": "ref", "node": "edge-posted-not-filled" } } },
      { "id": "edge-posted-not-filled", "op": "and",
        "params": { "a": { "kind": "ref", "node": "edge-posted" },
                    "b": { "kind": "ref", "node": "edge-not-filled" } } },
      { "id": "edge-posted", "op": "edgePosted", "params": {} },
      { "id": "edge-not-filled", "op": "not",
        "params": { "a": { "kind": "ref", "node": "edge-filled" } } },
      { "id": "edge-filled", "op": "hasEdgeFill", "params": {} },
      { "id": "phase-1-return", "op": "return",
        "params": { "value": { "kind": "literal", "value": [] } } },

      // --- phase 2 : edge fillé → post cheap (avec null-guards) ---
      // Correction audit : le natif post le cheap UNIQUEMENT si
      // cheapPosted||cheapFilled est FAUX — sinon il retourne [] (native l.177-179).
      // L'esquisse de la v1 reliait l'inverse (cheap-not-posted) à post-cheap
      // mais laissait cheap-posted-or-filled sans consommateur : l'op postCheap
      // doit évaluer la condition `when` et ne rien émettre sinon.
      { "id": "phase-2", "op": "if",
        "params": { "cond": { "kind": "ref", "node": "edge-filled" } } },
      { "id": "cheap-posted-or-filled", "op": "or",
        "params": { "a": { "kind": "ref", "node": "cheap-posted" },
                    "b": { "kind": "ref", "node": "cheap-filled" } } },
      { "id": "cheap-posted", "op": "cheapPosted", "params": {} },
      { "id": "cheap-filled", "op": "hasCheapFill", "params": {} },
      // null-guards : claimedOutcome null, cheapBook null, cheapAsk null
      { "id": "claimed-non-null", "op": "not",
        "params": { "a": { "kind": "ref", "node": "claimed-null" } } },
      { "id": "claimed-null", "op": "isNull",
        "params": { "value": { "kind": "ref", "node": "claimed-outcome" } } },
      { "id": "cheap-book-non-null", "op": "not",
        "params": { "a": { "kind": "ref", "node": "cheap-book-null" } } },
      { "id": "cheap-book-null", "op": "isNull",
        "params": { "value": { "kind": "ref", "node": "cheap-book" } } },
      { "id": "cheap-ask-non-null", "op": "not",
        "params": { "a": { "kind": "ref", "node": "cheap-ask-null" } } },
      { "id": "cheap-ask-null", "op": "isNull",
        "params": { "value": { "kind": "ref", "node": "cheap-ask" } } },
      { "id": "cheap-guards", "op": "and",
        "params": { "a": { "kind": "ref", "node": "claimed-non-null" },
                    "b": { "kind": "ref", "node": "cheap-book-non-null" } } },
      { "id": "cheap-guards-2", "op": "and",
        "params": { "a": { "kind": "ref", "node": "cheap-guards" },
                    "b": { "kind": "ref", "node": "cheap-ask-non-null" } } },
      { "id": "cheap-in-band", "op": "inCheapBand",
        "params": { "ask": { "kind": "ref", "node": "cheap-ask-rounded" },
                    "bandMin": { "kind": "config", "key": "edgeCheapBandMin" },
                    "bandMax": { "kind": "config", "key": "edgeCheapBandMax" } } },
      // Correction audit (round2) : le natif teste cheapAskInBand(round2(cheapAsk)) (l.187),
      // et cheapOrderAction teste round2(ask) (l.265). Sans round2, un ask 0.14166… vs
      // edgeCheapBandMax 0.14 donne des résultats divergents natif vs graphe.
      // round2 sert aussi de prix du cheap posté (cheapPrice, l.187-188).
      { "id": "cheap-ask-rounded", "op": "round2",
        "params": { "value": { "kind": "ref", "node": "cheap-ask" } } },
      { "id": "cheap-size", "op": "computeEdgeLeadCheapSize",
        "params": { "price": { "kind": "ref", "node": "cheap-ask-rounded" },
                    "budget": { "kind": "config", "key": "edgeCheapOrderUsdc" } } },
      { "id": "cheap-size-non-null", "op": "not",
        "params": { "a": { "kind": "ref", "node": "cheap-size-null" } } },
      { "id": "cheap-size-null", "op": "isNull",
        "params": { "value": { "kind": "ref", "node": "cheap-size" } } },
      { "id": "cheap-ready", "op": "and",
        "params": { "a": { "kind": "ref", "node": "cheap-posted-or-filled-not" },
                    "b": { "kind": "ref", "node": "cheap-guards-2" } } },
      { "id": "cheap-posted-or-filled-not", "op": "not",
        "params": { "a": { "kind": "ref", "node": "cheap-posted-or-filled" } } },
      { "id": "cheap-ready-2", "op": "and",
        "params": { "a": { "kind": "ref", "node": "cheap-ready" },
                    "b": { "kind": "ref", "node": "cheap-in-band" } } },
      { "id": "cheap-ready-3", "op": "and",
        "params": { "a": { "kind": "ref", "node": "cheap-ready-2" },
                    "b": { "kind": "ref", "node": "cheap-size-non-null" } } },
      { "id": "post-cheap", "op": "postCheap", "params": {} },

      // --- phase 3 : rien de posté/fillé → confirmation → post edge ---
      // Correction audit : le natif a un else implicite « return [] » en fin de
      // findOpportunities (l.258). Le nœud if "phase-3" doit donc avoir une
      // branche else connectée (return []) pour être structurellement complet,
      // sinon la validation rejetterait le graphe (§5.2 : chaque branche then/else
      // connectée ou feuille légitime). L'esquisse v1 avait un if à branche else
      // implicite inexistante — ghost bug de validation.
      { "id": "phase-3", "op": "if",
        "params": { "cond": { "kind": "ref", "node": "edge-ready" } } },
      // Correction audit (contradiction v1) : le plan §5.1 disait « confirmTicks reçoit
      // l'ask en entrée via port » MAIS les resets <2 books / pas de token edge /
      // pas d'ask nécessitent books+edgeToken en interne (option « re-dériver dans
      // ops.ts » retenue) → confirmTicks lit l'ask sur son port `ask` ET re-dérive
      // books/edgeToken/outcome en interne (exception documentée, cf. §5.1).
      { "id": "edge-confirm", "op": "confirmTicks",
        "params": { "ask": { "kind": "ref", "node": "edge-ask" },
                    "samples": { "kind": "config", "key": "edgeConfirmSamples" },
                    "bandMin": { "kind": "config", "key": "edgeBandMin" },
                    "bandMax": { "kind": "config", "key": "edgeBandMax" },
                    "maxDownTick": { "kind": "config", "key": "edgeMaxDownTick" } } },
      { "id": "edge-size", "op": "computeEdgeLeadEdgeSize",
        "params": { "price": { "kind": "ref", "node": "edge-ask" },
                    "budget": { "kind": "config", "key": "edgeOrderUsdc" } } },
      { "id": "edge-size-null", "op": "isNull",
        "params": { "value": { "kind": "ref", "node": "edge-size" } } },
      { "id": "edge-size-non-null", "op": "not",
        "params": { "a": { "kind": "ref", "node": "edge-size-null" } } },
      // Correction audit (ordonnancement du buffer stateful) : le push du buffer
      // (side-effect) doit se produire APRÈS le check de bande interne et AVANT
      // le check de size (native l.227-240), sinon la parité casse :
      // - si edge-ready = and(edge-in-band, edge-confirm) : quand inBand est faux,
      //   le court-circuit `and` empêche l'évaluation de edge-confirm → le reset
      //   hors-bande du buffer natif (l.228) ne se produit JAMAIS.
      // → confirmTicks implémente en interne TOUT le prélude natif (checks <2 books,
      //   token edge, bande → reset + false ; sinon push → ready), et edge-ready =
      //   and(a: edge-confirm, b: edge-size-non-null). L'ORDRE des ports du `and`
      //   est significatif (a puis b, court-circuit).
      // Note : le nœud edge-in-band séparé est retiré (redondant avec le check
      // de bande interne de confirmTicks).
      { "id": "edge-ready", "op": "and",
        "params": { "a": { "kind": "ref", "node": "edge-confirm" },
                    "b": { "kind": "ref", "node": "edge-size-non-null" } } },
      { "id": "post-edge", "op": "postEdge",
        "params": { "price": { "kind": "ref", "node": "edge-ask" },
                    "size": { "kind": "ref", "node": "edge-size" } } },
      // Correction audit : le natif utilise `edgeToken.bestAsk` comme prix posté
      // (l.254, PAS de round2 sur l'edge). postEdge doit donc recevoir son prix
      // en entrée (port price) — l'esquisse v1 ne passait que token+size.
      // Branche else de phase-3 : rien à poster (return [] implicite).
      { "id": "phase-3-else", "op": "return",
        "params": { "value": { "kind": "literal", "value": [] } } }
    ],
    "edges": [
      // lecteurs de contexte
      { "from": "books", "to": "edge-token", "port": "books" },
      { "from": "edge-token", "to": "edge-ask", "port": "token" },
      { "from": "books", "to": "cheap-book", "port": "books" },
      { "from": "claimed-outcome", "to": "cheap-book", "port": "outcome" },
      { "from": "cheap-book", "to": "cheap-ask", "port": "token" },
      { "from": "cheap-ask", "to": "cheap-ask-rounded", "port": "value" },

      // phase 1
      { "from": "edge-posted", "to": "edge-posted-not-filled", "port": "a" },
      { "from": "edge-not-filled", "to": "edge-posted-not-filled", "port": "b" },
      { "from": "edge-filled", "to": "edge-not-filled", "port": "a" },
      { "from": "edge-posted-not-filled", "to": "phase-1", "port": "cond" },
      { "from": "phase-1", "to": "phase-1-return", "port": "then" },
      { "from": "phase-1", "to": "phase-2", "port": "else" },

      // phase 2
      { "from": "edge-filled", "to": "phase-2", "port": "cond" },
      { "from": "cheap-posted", "to": "cheap-posted-or-filled", "port": "a" },
      { "from": "cheap-filled", "to": "cheap-posted-or-filled", "port": "b" },
      { "from": "cheap-posted-or-filled", "to": "cheap-posted-or-filled-not", "port": "a" },
      { "from": "claimed-outcome", "to": "claimed-null", "port": "value" },
      { "from": "claimed-null", "to": "claimed-non-null", "port": "a" },
      { "from": "cheap-book", "to": "cheap-book-null", "port": "value" },
      { "from": "cheap-book-null", "to": "cheap-book-non-null", "port": "a" },
      { "from": "cheap-ask", "to": "cheap-ask-null", "port": "value" },
      { "from": "cheap-ask-null", "to": "cheap-ask-non-null", "port": "a" },
      { "from": "claimed-non-null", "to": "cheap-guards", "port": "a" },
      { "from": "cheap-book-non-null", "to": "cheap-guards", "port": "b" },
      { "from": "cheap-guards", "to": "cheap-guards-2", "port": "a" },
      { "from": "cheap-ask-non-null", "to": "cheap-guards-2", "port": "b" },
      { "from": "cheap-posted-or-filled-not", "to": "cheap-ready", "port": "a" },
      { "from": "cheap-guards-2", "to": "cheap-ready", "port": "b" },
      { "from": "cheap-ready", "to": "cheap-ready-2", "port": "a" },
      { "from": "cheap-in-band", "to": "cheap-ready-2", "port": "b" },
      { "from": "cheap-ready-2", "to": "cheap-ready-3", "port": "a" },
      { "from": "cheap-size-non-null", "to": "cheap-ready-3", "port": "b" },
      // Correction audit : les nœuds d'émission postEdge/postCheap ont une sémantique
      // à deux niveaux : (1) une arête de CONTRÔLE depuis une branche then/else d'un
      // `if` détermine QUAND le nœud est évalué (branches mutuellement exclusives,
      // reproduisant les `return` anticipés du natif) ; (2) le port `when` (booléen)
      // conditionne l'émission : nœud atteint mais `when` faux → rien n'est émis
      // (équivalent du `return opportunities` vide du natif l.212). Les ports
      // token/price/size sont des arêtes de données.
      { "from": "phase-2", "to": "post-cheap", "port": "then" },
      { "from": "phase-2", "to": "phase-3", "port": "else" },
      { "from": "cheap-ready-3", "to": "post-cheap", "port": "when" },
      { "from": "cheap-book", "to": "post-cheap", "port": "token" },
      // Correction audit : le natif poste le cheap à cheapPrice = round2(cheapAsk)
      // (l.187-189), pas au raw ask.
      { "from": "cheap-ask-rounded", "to": "post-cheap", "port": "price" },
      { "from": "cheap-size", "to": "post-cheap", "port": "size" },

      // phase 3
      { "from": "edge-ask", "to": "edge-confirm", "port": "ask" },
      { "from": "edge-ask", "to": "edge-size", "port": "price" },
      { "from": "edge-size", "to": "edge-size-null", "port": "value" },
      { "from": "edge-size-null", "to": "edge-size-non-null", "port": "a" },
      { "from": "edge-confirm", "to": "edge-ready", "port": "a" },
      { "from": "edge-size-non-null", "to": "edge-ready", "port": "b" },
      { "from": "edge-ready", "to": "phase-3", "port": "cond" },
      { "from": "phase-3", "to": "post-edge", "port": "then" },
      { "from": "phase-3", "to": "phase-3-else", "port": "else" },
      { "from": "edge-ready", "to": "post-edge", "port": "when" },
      { "from": "edge-token", "to": "post-edge", "port": "token" },
      { "from": "edge-ask", "to": "post-edge", "port": "price" },
      { "from": "edge-size", "to": "post-edge", "port": "size" }
    ]
  },
  "cheapOrderAction": { "root": "cheap-action", "nodes": [
    { "id": "cheap-book", "op": "cheapBook", "params": {} },
    { "id": "cheap-ask", "op": "askOf",
      "params": { "token": { "kind": "ref", "node": "cheap-book" } } },
    // Ghost bug (parité) : ask null/undefined → "keep" AVANT le test de bande.
    { "id": "ask-null", "op": "isNull",
      "params": { "value": { "kind": "ref", "node": "cheap-ask" } } },
    { "id": "cheap-action", "op": "if",
      "params": { "cond": { "kind": "ref", "node": "ask-null" } } },
    // Correction audit (round2) : le natif teste cheapAskInBand(round2(ask)) (l.265).
    { "id": "ask-rounded", "op": "round2",
      "params": { "value": { "kind": "ref", "node": "cheap-ask" } } },
    { "id": "cheap-in-band", "op": "inCheapBand",
      "params": { "ask": { "kind": "ref", "node": "ask-rounded" },
                  "bandMin": { "kind": "config", "key": "edgeCheapBandMin" },
                  "bandMax": { "kind": "config", "key": "edgeCheapBandMax" } } },
    { "id": "keep", "op": "const", "params": { "value": { "kind": "literal", "value": "keep" } } },
    { "id": "cancel-lock", "op": "const", "params": { "value": { "kind": "literal", "value": "cancel-lock" } } }
  ], "edges": [
    { "from": "cheap-book", "to": "cheap-ask", "port": "token" },
    { "from": "cheap-ask", "to": "ask-null", "port": "value" },
    { "from": "cheap-ask", "to": "ask-rounded", "port": "value" },
    { "from": "ask-null", "to": "cheap-action", "port": "cond" },
    { "from": "cheap-action", "to": "keep", "port": "then" },
    { "from": "cheap-action", "to": "cheap-in-band", "port": "else" },
    { "from": "cheap-in-band", "to": "keep", "port": "then" },
    { "from": "cheap-in-band", "to": "cancel-lock", "port": "else" }
  ] },
  "shouldDefend": { "root": "no-defend", "nodes": [
    { "id": "no-defend", "op": "const", "params": { "value": { "kind": "literal", "value": false } } }
  ], "edges": [] },
  "defendShares": { "root": "zero", "nodes": [
    { "id": "zero", "op": "const", "params": { "value": { "kind": "literal", "value": 0 } } }
  ], "edges": [] },
  "hedgeAtPostTime": { "root": "hedge-skip", "nodes": [
    { "id": "hedge-skip", "op": "hedge-skip",
      "params": { "reason": { "kind": "literal", "value": "edge-lead-managed-in-bot" } } }
  ], "edges": [] },
  "shouldSellExpensiveEdge": { "root": "hold-loss", "nodes": [
    { "id": "pair-id", "op": "pairId", "params": {} },
    { "id": "now", "op": "nowMs", "params": {} },
    { "id": "enabled", "op": "const",
      "params": { "value": { "kind": "config", "key": "edgeSellExpensiveEnabled" } } },
    { "id": "cheap-filled", "op": "cheapFilled", "params": {} },
    { "id": "cheap-gt0", "op": "gt",
      "params": { "a": { "kind": "ref", "node": "cheap-filled" },
                  "b": { "kind": "literal", "value": 0 } } },
    { "id": "cheap-zero", "op": "not",
      "params": { "a": { "kind": "ref", "node": "cheap-gt0" } } },
    { "id": "age", "op": "marketAgeMs", "params": {} },
    { "id": "after-min", "op": "const",
      "params": { "value": { "kind": "config", "key": "edgeSellExpensiveAfterMin" } } },
    { "id": "after-ms", "op": "mul",
      "params": { "a": { "kind": "ref", "node": "after-min" },
                  "b": { "kind": "literal", "value": 60000 } } },
    { "id": "age-ok", "op": "gte",
      "params": { "a": { "kind": "ref", "node": "age" },
                  "b": { "kind": "ref", "node": "after-ms" } } },
    { "id": "bid", "op": "expensiveBid", "params": {} },
    { "id": "fill", "op": "expensiveFillPrice", "params": {} },
    { "id": "bid-null", "op": "isNull",
      "params": { "value": { "kind": "ref", "node": "bid" } } },
    { "id": "bid-ok", "op": "not",
      "params": { "a": { "kind": "ref", "node": "bid-null" } } },
    { "id": "fill-ok", "op": "gt",
      "params": { "a": { "kind": "ref", "node": "fill" },
                  "b": { "kind": "literal", "value": 0 } } },
    { "id": "diff", "op": "sub",
      "params": { "a": { "kind": "ref", "node": "bid" },
                  "b": { "kind": "ref", "node": "fill" } } },
    { "id": "ratio", "op": "div",
      "params": { "a": { "kind": "ref", "node": "diff" },
                  "b": { "kind": "ref", "node": "fill" } } },
    { "id": "loss-pct", "op": "mul",
      "params": { "a": { "kind": "ref", "node": "ratio" },
                  "b": { "kind": "literal", "value": 100 } } },
    { "id": "thresh", "op": "const",
      "params": { "value": { "kind": "config", "key": "edgeSellExpensiveLossPct" } } },
    { "id": "neg-thresh", "op": "sub",
      "params": { "a": { "kind": "literal", "value": 0 },
                  "b": { "kind": "ref", "node": "thresh" } } },
    { "id": "in-loss", "op": "lte",
      "params": { "a": { "kind": "ref", "node": "loss-pct" },
                  "b": { "kind": "ref", "node": "neg-thresh" } } },
    { "id": "window-ms", "op": "const",
      "params": { "value": { "kind": "config", "key": "edgeSellExpensiveLossWindowMs" } } },
    { "id": "g1", "op": "and",
      "params": { "a": { "kind": "ref", "node": "enabled" },
                  "b": { "kind": "ref", "node": "cheap-zero" } } },
    { "id": "g2", "op": "and",
      "params": { "a": { "kind": "ref", "node": "g1" },
                  "b": { "kind": "ref", "node": "age-ok" } } },
    { "id": "g3", "op": "and",
      "params": { "a": { "kind": "ref", "node": "g2" },
                  "b": { "kind": "ref", "node": "bid-ok" } } },
    { "id": "g4", "op": "and",
      "params": { "a": { "kind": "ref", "node": "g3" },
                  "b": { "kind": "ref", "node": "fill-ok" } } },
    { "id": "g5", "op": "and",
      "params": { "a": { "kind": "ref", "node": "g4" },
                  "b": { "kind": "ref", "node": "in-loss" } } },
    { "id": "hold-loss", "op": "holdTrueFor",
      "params": { "cond": { "kind": "ref", "node": "g5" },
                  "durationMs": { "kind": "ref", "node": "window-ms" },
                  "pairId": { "kind": "ref", "node": "pair-id" },
                  "nowMs": { "kind": "ref", "node": "now" } } }
  ], "edges": [
    { "kind": "data", "from": "cheap-filled", "to": "cheap-gt0", "port": "a" },
    { "kind": "data", "from": "cheap-gt0", "to": "cheap-zero", "port": "a" },
    { "kind": "data", "from": "after-min", "to": "after-ms", "port": "a" },
    { "kind": "data", "from": "age", "to": "age-ok", "port": "a" },
    { "kind": "data", "from": "after-ms", "to": "age-ok", "port": "b" },
    { "kind": "data", "from": "bid", "to": "bid-null", "port": "value" },
    { "kind": "data", "from": "bid-null", "to": "bid-ok", "port": "a" },
    { "kind": "data", "from": "fill", "to": "fill-ok", "port": "a" },
    { "kind": "data", "from": "bid", "to": "diff", "port": "a" },
    { "kind": "data", "from": "fill", "to": "diff", "port": "b" },
    { "kind": "data", "from": "diff", "to": "ratio", "port": "a" },
    { "kind": "data", "from": "fill", "to": "ratio", "port": "b" },
    { "kind": "data", "from": "ratio", "to": "loss-pct", "port": "a" },
    { "kind": "data", "from": "thresh", "to": "neg-thresh", "port": "b" },
    { "kind": "data", "from": "loss-pct", "to": "in-loss", "port": "a" },
    { "kind": "data", "from": "neg-thresh", "to": "in-loss", "port": "b" },
    { "kind": "data", "from": "enabled", "to": "g1", "port": "a" },
    { "kind": "data", "from": "cheap-zero", "to": "g1", "port": "b" },
    { "kind": "data", "from": "g1", "to": "g2", "port": "a" },
    { "kind": "data", "from": "age-ok", "to": "g2", "port": "b" },
    { "kind": "data", "from": "g2", "to": "g3", "port": "a" },
    { "kind": "data", "from": "bid-ok", "to": "g3", "port": "b" },
    { "kind": "data", "from": "g3", "to": "g4", "port": "a" },
    { "kind": "data", "from": "fill-ok", "to": "g4", "port": "b" },
    { "kind": "data", "from": "g4", "to": "g5", "port": "a" },
    { "kind": "data", "from": "in-loss", "to": "g5", "port": "b" },
    { "kind": "data", "from": "g5", "to": "hold-loss", "port": "cond" },
    { "kind": "data", "from": "window-ms", "to": "hold-loss", "port": "durationMs" },
    { "kind": "data", "from": "pair-id", "to": "hold-loss", "port": "pairId" },
    { "kind": "data", "from": "now", "to": "hold-loss", "port": "nowMs" }
  ] }
}
```

> **Note (option A + contexte général)** : le graphe ci-dessus est une **esquisse** de la structure.
> La correspondance exacte nœud ↔ code sera figée à l'étape 1 (voir plan) par le test de parité.
> Le nœud `if` a deux sorties (`then` / `else`) ; le nœud `return` stoppe l'évaluation et retourne
> le résultat courant.
>
> **Arêtes `kind`** : l'esquisse `findOpportunities` / `cheapOrderAction` omet `kind` pour la lisibilité.
> Inférence Phase 1 si `kind` absent : `port ∈ {then, else}` → `"control"`, sinon `"data"`.
> L'éditeur et le sous-graphe `shouldSellExpensiveEdge` **écrivent toujours** `kind` explicitement.
>
> **`shouldSellExpensiveEdge` (parité native, plus un stub)** : le sous-graphe reproduit
> `EdgeLeadStrategy.shouldSellExpensiveEdge` (l.293-326) :
> gardes `enabled` / `cheapFilled > 0` / `marketAgeMs` / bid null / `fillPrice <= 0` /
> `lossPct > −threshold` → reset timer + false ; sinon `holdTrueFor` (Map `pairId` ≡ `lossStart`).
> L'ordre des `and` (port `a` puis `b`, court-circuit) garantit que `sub`/`div` du % de perte
> ne s'évaluent **pas** si bid null ou fill ≤ 0 (sinon throw). `holdTrueFor` : cond faux →
> delete+false ; cond vrai → `start = map.get(pairId) ?? nowMs`, `nowMs - start >= durationMs`.
>
> **Accès aux métriques marché** : les nœuds `books`, `edge-token`, `cheap-book`, `claimed-outcome`
> sont des **lecteurs de contexte** (voir §4.1 `GraphContext`). Les ops métier (`inBand`,
> `inCheapBand`, `computeEdgeLeadCheapSize`) reçoivent leur **ask/prix en entrée**
> via des ports (`ask`, `price`), pas en lisant le contexte directement — **à l'exception
> documentée de `confirmTicks`** (§5.1), qui re-dérive books/edgeToken en interne pour
> reproduire les resets natifs du buffer. C'est ce qui rend le graphe
> **explicite et composable** : le même `askOf` sert pour l'edge et le cheap.
>
> **La structure reproduit le `if/else if/else` du code :
> - **Phase 1** : `edgePosted && !edgeFilled` → `return []` (attendre le fill).
> - **Phase 2** : `edgeFilled` → post cheap si `!(cheapPosted || cheapFilled)` et gardes
>   `claimedOutcome` non-null, `cheapBook` non-null, `cheapAsk` non-null, `round2(cheapAsk)`
>   en bande, `size` non-null — sinon `return []`. Les null-guards sont modélisés par des
>   nœuds `isNull`/`not` combinés en `and` (`cheap-ready*`).
> - **Phase 3** : sinon → confirmation N ticks (`confirmTicks`, exception §5.1) → post edge
>   à `edgeAsk` avec garde `size` non-null — sinon `return []` (phase-3-else).
> Les nœuds `edge-posted`/`hasEdgeFill`/`cheap-posted`/`hasCheapFill` sont **connectés** comme
> conditions des `if`/`and`/`or`/`not`, ce qui reproduit le court-circuit des 3 phases.
>
> **Nouveaux ops ajoutés** : `isNull` (teste si une valeur est null/undefined), `books`,
> `claimedOutcome`, `cheapBook`, `favoriteAsk`, `limitPrice`, `filledCheap`, `filledExpensive`,
> `pairId`, `freshAsk`, `askOf`, `bidOf`, `askSizeOf` (lecteurs de contexte) ; `round2`,
> `pickOtherTokenByOutcome` (corrections parité audit).

---

## 5. Spécification de l'interpréteur

Nouveau fichier : `src/strategy/graph/interpreter.ts`

```ts
export class GraphStrategy implements TradingStrategy {
  readonly id: StrategyId;          // "custom:<id>"
  readonly label: string;
  readonly leadsWithEdge: boolean;

  constructor(private readonly graph: StrategyGraph) {}

  findOpportunities(ctx: StrategyContext): TradeOpportunity[] {
    return interpret(this.graph.findOpportunities, ctx, this.state);
  }
  cheapOrderAction(ctx: RestingCheapContext): CheapOrderAction { /* ... */ }
  shouldDefend(ctx: DefendContext): boolean { /* ... */ }
  defendShares(ctx: DefendContext): number { /* ... */ }
  hedgeAtPostTime(ctx: HedgePostContext): HedgePostDecision { /* ... */ }
  /** Obligatoire pour parité TradingStrategy — câblé par resting-manager.sellExpensiveEdgeIfNeeded */
  shouldSellExpensiveEdge(ctx: EdgeSellContext): boolean { /* ... */ }
}
```

### 5.1 Règles d'exécution

- **Modèle de retour (figé audit 2)** :
  - `findOpportunities` : accumulateur `TradeOpportunity[]` muté par `postEdge`/`postCheap`.
    Un nœud `return` stoppe et retourne l'accumulateur (éventuellement vide si `value: []`).
    Si l'évaluation se termine sur une feuille d'émission (post-*) sans `return`, on retourne
    l'accumulateur. Valeur par défaut si rien n'a été émis : `[]`.
  - Autres méthodes : pas d'accumulateur. La valeur retournée est celle de la branche
    de contrôle prise (ou du `root` si pas de contrôle). `return` stoppe et rend `value`.
- **Évaluation paresseuse (critique parité)** : un nœud n'évalue un port **que s'il en a
  besoin**. Interdit : résoudre tous les `params`/`edges` puis appeler l'op (topo globale
  « eval all »). Court-circuit figé :
  - `and` : port `a` puis, seulement si `a === true`, port `b`.
  - `or` : port `a` puis, seulement si `a === false`, port `b`.
  - `if` / booléen à sorties `then`/`else` : `cond` puis **une** branche.
  Sans cette règle, le sous-graphe sell-edge **throw** (`div` sur bid null) et
  `confirmTicks` n'est plus avant `size`.
  Dualité `params.kind:"ref"` **et** arêtes : les deux décrivent le même câblage. Si les deux
  sont présents, ils **doivent matcher** (sinon erreur de validation). L'éditeur écrit les deux.
  Cycles → erreur de validation (tri topo **sans** évaluer).
- **Court-circuit (option A validée)** : les nœuds de contrôle (`if`, `switch`, `gate`, `return`)
  pilotent le flux. Un nœud `if` n'évalue que la branche `then` ou `else` selon sa condition.
  **Tout nœud à sortie booléenne** avec arêtes `kind:"control"` `then`/`else` se comporte comme
  un `if` implicite (valeur retournée = valeur de la branche, pas le booléen). Ne **pas**
  special-caser uniquement `op === "if"` — le `cheapOrderAction` POC pilote `keep`/`cancel-lock`
  depuis `inCheapBand`. Un nœud `return` stoppe l'évaluation. Pour `findOpportunities`,
  `return` avec `value: []` rend `[]` (l'accumulateur est encore vide dans ces branches
  natives). C'est ce qui reproduit la machine à 3 phases d'edge-lead.
  > **Ghost bug (parité, figé par l'audit)** : dans le natif, les retours anticipés l.165-188
  > (phase 1 `return opportunities` ; phase 2 `cheapPosted || cheapFilled` → `return`, 
  > `claimedOutcome` null → `return`, `cheapBook` null → `return`, `cheapAsk` null → `return`,
  > hors bande → `return`, `size` null → `return`) sont des **retours de MÉTHODE**, pas des
  > « skip du nœud ». Si le DSL les modélise comme des branche `else` silencieuses d'un `if`
  > sans nœud `return` explicite, l'évaluation continuerait vers la phase suivante au lieu de
  > stopper. **Règle figée** : chaque `return opportunities` natif correspond à un nœud
  > `return` explicite du graphe (ou à une branche else menant à un `return`), jamais à une
  > absence d'arête.
- **Contexte d'exécution** : chaque méthode construit un **`GraphContext` général** (union des
  champs des 5 contextes natifs, voir §4.1) en remplissant les champs qu'elle possède et en
  laissant le reste à `null`. Les **lecteurs de contexte** (`books`, `cheapBook`, `favoriteAsk`,
  `claimedOutcome`, `askOf`, …) sont la **seule porte d'accès** aux métriques marché ; les ops
  métier reçoivent leurs valeurs via des ports d'entrée. Plus un **état par paire** pour les
  nœuds stateful (`confirmTicks` → `EdgeConfirmBuffer`).
- **Nœuds stateful** : `confirmTicks` utilise `EdgeConfirmBuffer` (réutilisé tel quel).
  L'état est conservé dans l'instance `GraphStrategy` (comme `EdgeLeadStrategy` le fait déjà).
  > **Ghost bug (parité)** : dans `edge-lead-strategy.ts`, le buffer est **réinitialisé** dans
  > plusieurs branches : <2 books (l.215), pas de token edge (l.222), edge hors bande (l.228).
  > Le nœud `confirmTicks` du graphe doit reproduire ces `reset(pairId)`, sinon la parité échoue
  > sur les scénarios où l'edge sort de bande puis y revient. À figer dans `ops.ts` + test de parité.
  >
  > **Décision audit (contradiction §4.2 vs §5.1 tranchée)** : le nœud `confirmTicks` est une
  > **exception documentée au « tout par ports »**. Pour reproduire les resets natifs du buffer
  > (l.215/222/228), il re-dérive en interne `books`/`edgeToken`/`edgeOutcome` depuis le contexte
  > (fidèle au code natif), et reçoit uniquement l'`ask` (port `ask`) et les scalaires de config
  > (bande, samples, maxDownTick) par ports. Il encapsule le prélude complet du natif :
  > `<2 books → reset + false` ; `!edgeToken || !edgeToken.bestAsk → reset + false` ;
  > `hors bande → reset + false` ; sinon `buffer.push(pairId, ask, edgeOutcome, config)`.
  > **Un seul `confirmTicks` par graphe** (buffer natif clé `pairId`, pas `nodeId×pairId`).
  > Prelude **et** `push` lisent **`ctx.config`** (comme le natif). Les ports bande/samples/
  > maxDownTick, s'ils sont présents, **doivent** être `{ kind: "config" }` des clés
  > `edgeBandMin` / `edgeBandMax` / `edgeConfirmSamples` / `edgeMaxDownTick` — sinon
  > prelude (ports) ≠ `push` (config).
  > **Ordre d'évaluation critique** : l'évaluation de `confirmTicks` (avec son side-effect
  > push/reset) doit se produire AVANT le test de `size` (native l.237-239) — le nœud
  > `edge-ready = and(a: edge-confirm, b: edge-size-non-null)` du graphe exemple garantit
  > cet ordre par court-circuit du `and` (port `a` évalué en premier).
  > Si `confirmTicks` n'est PAS évalué (court-circuité), le buffer ne progresse pas ce tick,
  > mais ne doit pas non plus être reset — fidèle au natif où l'entrée dans la phase 3
  > implique que ni edge ni cheap ne sont postés/fillés.
- **Nœuds d'émission** (`postEdge`, `postCheap`) : construisent une `TradeOpportunity` et
  l'ajoutent au tableau résultat.
  > **Correction audit** : `appendOpportunity` (edge-lead-strategy.ts l.93) et
  > `appendLimitOrderForSide` (orchestrate.ts l.24) sont des fonctions **privées** (non exportées).
  > Le plan doit soit les **exporter**, soit **dupliquer** leur logique dans `ops.ts`.
  > Recommandation : exporter `appendOpportunity` depuis `edge-lead-strategy.ts` (elle est déjà
  > générique : kind/price/size/maxOpenPerSide) et la réutiliser dans le nœud `postEdge`/`postCheap`.
  >
  > **Ports des nœuds d'émission (figés par l'audit)** : `postEdge`/`postCheap` ont
  > `when` (contrôle booléen), `token`, `price`, `size`. Le prix du cheap posté est
  > **`round2(cheapAsk)`** (native l.187-188) ; le prix edge est **`edgeToken.bestAsk`**
  > (native l.254, sans round2). L'esquisse v1 ne passait pas `price` aux nœuds d'émission :
  > à corriger dans `ops.ts` + schema de ports.
  >
  > **Gardes mémoire (POC = ON)** : les gardes internes d'`appendOpportunity`
  > (maxOpenPerSide, countLegsByKind, hasTradeKey) **s'appliquent** dans le nœud
  > d'émission du POC (appel `appendOpportunity` tel quel → parité). Paramètre
  > `applyGuards` défaut `true`. Un futur graphe qui les déplace en nœuds explicites
  > (`countOpenPerSide` / `countLegsByKind` / `hasTradeKey` / `makeTradeKey`) passe
  > `applyGuards: false` pour ne pas double-compter. La phrase v1 « annulés par défaut »
  > était contradictoire avec le POC — **corrigée**.
- **Comparaison / arithmétique / timer (Phase 1, parité sell-edge)** :
  - `eq`/`lt`/`gt`/`lte`/`gte` : deux ports `a`,`b` numériques (ou bool pour `eq`). Un
    opérande `null`/`undefined` → **throw** (guard `isNull` amont obligatoire, même règle
    que `inCheapBand`).
  - `add`/`sub`/`mul`/`div` : idem ; `div` par 0 → throw.
  - `holdTrueFor` (stateful, clé `pairId`, exception store interne comme `confirmTicks`) :
    ports `cond` (bool), `durationMs`, `pairId`, `nowMs`. `cond === false` →
    `map.delete(pairId)` + `false`. `cond === true` → `start = map.get(pairId) ?? nowMs`,
    `map.set(pairId, start)`, retourne `nowMs - start >= durationMs`. Once-per-interpret()
    (une eval par appel de méthode, pas « skip jusqu'au prochain findOpportunities »).
    `nowMs` vient du **port** (= lecteur `nowMs` = `GraphContext.nowMs` posé **à l'entrée
    de `shouldSellExpensiveEdge`** à `Date.now()`, comme le natif). **Ne pas** réutiliser
    un `tickNowMs` capturé au `findOpportunities` précédent : cette méthode tourne *après*
    le sell dans le tick (`processEvent` : resting puis findOpp) → timer en retard.
  - `const` : le port `value` est un `GraphParam` (literal **ou** `{kind:"config"}`).
    C'est ainsi que `enabled` lit `edgeSellExpensiveEnabled` dans le sous-graphe sell-edge.
  - `computeEdgeLeadEdgeSize` / `computeEdgeLeadCheapSize` : appellent les fonctions
    natives avec `(ctx.config, price)`. Le port `budget` du graphe POC est **ignoré**
    (mode shares/pusd lit `edgeShares*` / `maxShareEdge`, pas le budget).
- **Garde mémoire** : les nœuds `countOpenPerSide`, `countLegsByKind`, `hasTradeKey` sont
  fournis pour reproduire les gardes d'appendOpportunity.
  > **Ghost bug (cheapOrderAction)** : dans `edge-lead-strategy.ts` (l.263-266), `cheapOrderAction`
  > retourne `"keep"` quand `ask === null || ask === undefined`, **avant** le test de bande
  > (`round2(ask)` puis `cheapAskInBand`). Le graphe exemple modélise ce guard par le nœud
  > `isNull` → `if` en amont (ordre natif respecté). **Contradiction v1 corrigée** : la v1
  > demandait à `inCheapBand` de retourner `true` sur un ask null — incompatible avec la
  > phase 2 de findOpportunities, où un ask null doit donner `[]` (pas de post), pas « en
  > bande ». **Règle figée** : l'op `inCheapBand` ne voit JAMAIS null dans un graphe valide —
  > la validation §5.2 exige un guard `isNull` en amont quand la source est nullable
  > (`cheapBook`/`askOf` sont `| null`) ; à défaut, `inCheapBand(null)` **throw** en exécution
  > (jamais de `false` silencieux → `cancel-lock`, jamais de `true` silencieux → post).
  > À figer dans `ops.ts` + test de parité (scénario 15).

### 5.2 Validation du graphe

Nouveau fichier : `src/strategy/graph/validate.ts`

- Schéma : chaque `op` a un schéma de ports (entrées/sorties) et de params obligatoires.
- Connexions : chaque port d'entrée a exactement une source ; pas de port inconnu.
- **Contrôle (option A)** : un nœud `if` doit avoir exactement 2 sorties (`then` / `else`) ;
  un nœud `return` doit être une feuille (aucune sortie) ; un nœud `gate` doit avoir une sortie
  conditionnelle. Vérifier que chaque branche `then`/`else` est connectée (ou est une feuille
  légitime comme `return`).
- Cycles : détection via tri topologique.
- Types : cohérence des types de sortie (token / number / boolean / decision / string).
- **Disponibilité des champs par méthode** : chaque lecteur de contexte est valide **seulement**
  dans les méthodes où son champ est non-null. Table de disponibilité :

  | Lecteur | `findOpportunities` | `cheapOrderAction` | `shouldDefend`/`defendShares` | `hedgeAtPostTime` | `shouldSellExpensiveEdge` |
  |---|---|---|---|---|---|
  | `config` | ✅ | ✅ | ✅ | ✅ | ✅ |
  | `nowMs` (horloge, §4.1.1) | ✅ | ✅ | ✅ | ✅ | ✅ |
  | `books` | ✅ | ❌ | ❌ | ❌ | ❌ |
  | `event` | ✅ | ❌ | ❌ | ❌ | ❌ |
  | `tracker` | ✅ | ❌ | ❌ | ✅ | ✅ |
  | `pairId` | ✅ (dérivé : `${event.slug}:${event.windowEnd}`) | ✅ (contexte natif étendu) | ✅ (contexte natif étendu) | ✅ | ✅ |
  | `cheapBook` | ❌ | ✅ | ❌ | ❌ | ❌ |
  | `favoriteAsk` | ❌ | ✅ | ✅ | ❌ | ❌ |
  | `limitPrice` | ❌ | ✅ | ❌ | ❌ | ❌ |
  | `filledCheap` / `filledExpensive` | ❌ | ❌ | ✅ | ❌ | ❌ |
  | `freshAsk` | ❌ | ❌ | ❌ | ✅ | ❌ |
  | `expensiveBid` / `expensiveFillPrice` / `expensiveSize` / `cheapFilled` / `marketAgeMs` | ❌ | ❌ | ❌ | ❌ | ✅ |

  > **Correction audit (table v1 fausse)** : la v1 marquait `pairId` ❌ pour
  > `findOpportunities`, mais les ops `claimedOutcome`, `edgePosted`, `hasEdgeFill`,
  > `cheapPosted`, `hasCheapFill`, `confirmTicks` (via `buffer.push(pairId, …)` et
  > `reset(pairId)`) en ont BESOIN dans `findOpportunities`. Le `GraphContext.pairId`
  > est donc rempli pour `findOpportunities` en le dérivant de `event`
  > (native : `const pairId = \`${event.slug}:${event.windowEnd}\``).
  > `config` était absent de la table alors qu'il est présent dans les contextes natifs.
  > Errata 2026-09-10 : colonne `shouldSellExpensiveEdge` + champs `EdgeSellContext`.

  Un graphe qui lit un champ **toujours null** dans une méthode est rejeté (erreur humaine
  explicite). C'est la garde clé du contexte général : elle empêche de lire une métrique
  indisponible dans la méthode courante.
- `leadsWithEdge` : booléen obligatoire.
- **Ops autorisés par méthode (validation)** :
  - `postEdge` / `postCheap` / `skip` : `findOpportunities` uniquement.
  - `keep` / `cancel-lock` / `take-ask` : `cheapOrderAction` uniquement.
  - `defend` / `no-defend` : `shouldDefend` / `defendShares`.
  - `hedge-skip` / `hedge-post` / `hedge-defend` : `hedgeAtPostTime` uniquement.
  - `sell-edge` / `no-sell-edge` / `holdTrueFor` : `shouldSellExpensiveEdge` (holdTrueFor
    aussi autorisé ailleurs si un graphe custom veut un timer).
- **Nœuds d'émission (validation)** : `postEdge`/`postCheap` exigent les ports `when`,
  `token`, `price`, `size` (cf. §5.1). Un port `price` manquant → erreur de validation.
- **Arêtes de contrôle vs de données (validation)** : une arête de contrôle (port `then`/`else`)
  peut partir soit d'un nœud `if`/`switch`, soit de **tout nœud à sortie booléenne**
  (`inCheapBand`, `and`, `isNull`, … — cf. sous-graphe `cheapOrderAction` où `cheap-in-band`
  pilote directement `keep`/`cancel-lock`). Toute autre valeur de `port` désigne un port
  d'entrée de données du nœud cible. Les deux sémantiques coexistent dans un même graphe
  (cf. §4.1 `GraphEdge.port`) : chaque branche `then`/`else` d'un même nœud source ne peut
  avoir qu'une seule cible ; un nœud booléen avec des sorties then/else ne peut PAS aussi
  alimenter un port de données `cond` (sinon double sémantique ambiguë).
- Retourne une liste d'erreurs humaines (pour l'éditeur et l'API).

- **Validation temporelle (§4.1.1)** :
  - `inPhase` : `phaseDurationSec` > 0 ; bornes `phaseMin` ≤ `phaseMax` ≥ 0 (littéraux).
  - `windowRange` : `startSec` < `endSec` (offsets en secondes depuis windowStart).
  - `sampleWindow` : `maxAgeMs` ≥ 2× `pollIntervalMs`. Sans config sous la main (POST
    `/validate` éditeur), défaut `pollIntervalMs = 2000` ; à l'activation, re-check avec
    la config live.
  - `trendUp`/`trendDown`/`trendNeutral` : `minSlope` > 0 (littéral) ; `samples` doit référencer
    un nœud `sampleWindow`.
  - `nowMs` : lecteur `ctx` **valide dans les 6 méthodes** (table §5.2).
  - `windowStartSec` / `windowEndSec` : uniquement `findOpportunities` (`ctx.event`).
  - `minutesLeft` / `secondsElapsed` / `inPhase` / `windowRange` : autorisés dans
    `findOpportunities` (lecteurs `window*Sec`) **et** dans `cheapOrderAction` /
    `shouldDefend` / `defendShares` / `shouldSellExpensiveEdge` **s'ils** prennent
    `pairWindowStart` / `pairWindowEnd` (pas `ctx.event`, absent). Interdit dans
    `hedgeAtPostTime` tant que le cache n'est pas alimenté pour cette paire (même règle
    pairWindow* : null → false).
  - Comparaisons / arithmétique : valides dans toute méthode (ports typés number).

---

### 5.3 Règles d'exécution temporelle (§4.1.1)

- **Cache `pairWindowStart` / `pairWindowEnd`** : peuplé **au début de chaque**
  `findOpportunities`, par l'interpréteur (pas par un nœud) : si `ctx.event` est
  présent, `map.set(pairId, { windowStart, windowEnd })`. Indispensable : le graphe
  POC edge-lead **n'a aucun nœud** `windowStartSec` — sans ce side-effect méthode,
  le cache resterait vide pour cheap/defend. Les ops `pairWindow*` ne font que lire.
  **Ordre du tick** (`reverse-bot.processEvent` l.228-236 et `backtest/runner.ts`
  `manageRestingPolicy` **avant** `findOpportunities`) : pendant cheap/defend du tick T,
  le cache est celui du tick T−1 (ou d'un `findOpportunities` antérieur sur la même paire).
  Premier tick d'une paire → cache miss → `null` → `inPhase`/`windowRange`/`minutesLeft` →
  `false` (prudence). Documenté dans l'éditeur.
- **Horloge (Phase 1 vs Phase 5)** : **Phase 1** — `GraphContext.nowMs` est posé à
  **l'entrée de chaque méthode** (`Date.now()` live). Pas une capture unique par tick :
  `shouldSellExpensiveEdge` précède `findOpportunities` dans `processEvent`. **Phase 5** —
  pour `findOpportunities` / cheap / defend seulement, `ctx.nowMs` injecté (backtest
  snapshot) afin que `sampleWindow`/`inPhase` rejouent l'historique. `shouldSellExpensiveEdge`
  reste sur `Date.now()` à l'entrée (parité native). Les gates natifs
  (`minutesBeforeCloseMin/Max`, `minMinutesBeforeCloseToBuy`) restent **hors graphe**.
- **Nœuds d'action stateful** (`sampleWindow`, `confirmTicks`, `holdTrueFor`) : le side-effect (push du
  sample) se produit **au plus une fois par tick** — l'interpréteur marque le nœud « évalué
  pour ce tick » et toute ré-évaluation dans le même tick retourne le même résultat sans
  re-pusher. Ordre d'évaluation : l'évaluation paresseuse résout `trendUp.samples` → le nœud
  `sampleWindow` est donc évalué (push inclus) **avant** `trendUp`, garantissant que le
  sample du tick courant participe au calcul de slope (fidèle au pattern natif : le buffer
  est pushé au tick T puis testé au même tick T).
- **Séries temporelles** : store clé `nodeId × pairId` dans l'instance `GraphStrategy`
  (même cycle de vie que `EdgeConfirmBuffer` natif : in-memory, perdu au restart — documenté).
  Purge des samples plus vieux que `maxAgeMs` **à chaque push** (amortie, pas de fuite).
  Un `ask` null/undefined **n'est pas échantillonné** (skip du tick, fidèle au natif).
- **Tendance** : `slope = (lastAsk − firstAsk) / (lastTs − firstTs)` sur les samples de la
  fenêtre `maxAgeMs`. `< 2 samples` → **false** (prudence par défaut, pas d'erreur).
  `trendUp` : slope > `minSlope` ; `trendDown` : slope < −`minSlope` ; `trendNeutral` :
  |slope| ≤ `minSlope`. Unités : slope en **prix/seconde** (ex. `minSlope: 0.002` = le prix
  monte de ≥ 0.2 ¢/s ≈ 1 point de pourcentage par 5 s — à calibrer en backtest).
- **Phases (marché 15 min → 4 phases de 5 min)** : `inPhase` découpe la fenêtre
  `[windowStart, windowEnd]` en segments égaux de `phaseDurationSec` : phase index =
  `floor(secondsElapsed / phaseDurationSec)`. Ex. : fenêtre 900 s, `phaseDurationSec: 300`
  → phases 0-3 (0-5 min, 5-10 min, 10-15 min). `phaseMin`/`phaseMax` sélectionnent la
  plage de phases active. Cas limite : `secondsElapsed` négatif (tick avant windowStart,
  snapshot résiduel) → phase −1 → toujours hors plage → false.
- **Compatibilité hot-swap / backtest** : les nœuds stateful conservent leur état à travers
  le hot-swap ? **Non** — `onRuntimeSettingsChanged` (`reverse-bot.ts`) recrée l'instance
  stratégie puis propage via `lifecycle.setStrategy` / `resting.setStrategy` /
  `executor.setStrategy` (comme le natif recrée `EdgeLeadStrategy` et perd
  `EdgeConfirmBuffer`) : le graphe re-part à zéro (samples vides). Comportement fidèle au
  natif, documenté pour l'éditeur. Le backtest instancie une `GraphStrategy` par run
  (`backtest/runner.ts` → `createStrategy`) — état isolé par run, pas de fuite cross-run.
- **Non-buts temporels (POC)** : pas de persistance des séries en DB (in-memory comme
  `EdgeConfirmBuffer`), pas de séries > 1 fenêtre (purge à `windowEnd`), pas d'op de vente
  « sell-position » (§7.1.3 couvre la sortie par cancel/re-post et défense natifs).

---

## 6. Spécification de la persistance (SQLite)

### 6.1 Table

Dans `src/db/database.ts` (méthode `init()`), ajouter :

```sql
CREATE TABLE IF NOT EXISTS strategy_graphs (
  id TEXT PRIMARY KEY,          -- "custom:<uuid>"
  name TEXT NOT NULL,
  description TEXT,
  leadsWithEdge INTEGER NOT NULL DEFAULT 0,
  graphJson TEXT NOT NULL,      -- StrategyGraph sérialisé
  version INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

`leadsWithEdge` colonne **et** `graphJson.leadsWithEdge` doivent rester alignés :
`upsert` écrit les deux depuis `StrategyGraph` ; `get()` / `leadsWithEdgeFor()` lisent
le JSON en priorité ; si la colonne diverge, JSON gagne et la colonne est réparée.

### 6.2 Repository

Nouveau fichier : `src/db/strategy-graph-repo.ts`

- `list()` → tous les graphes (métadonnées, sans le JSON lourd si besoin)
- `get(id)` → graphe complet
- `upsert(graph)` → insert ou update
- `remove(id)`
- `getActive()` → le graphe actuellement référencé par `strategyId` (si `custom:<id>`).
  > **Complétude** : `getActive()` n'a pas de consommateur identifié dans le POC. Soit on l'utilise
  > dans `GET /api/strategy` (pour marquer le graphe actif), soit on le retire. Recommandation :
  > l'utiliser dans `GET /api/strategy` pour afficher le graphe actif dans l'éditeur.

> **Wiring obligatoire (complétude)** : ajouter `strategyGraphs: StrategyGraphRepository` à
> l'interface `Repositories` (`src/db/index.ts`) **et** à la factory `createRepositories()`.
> Sans cela, `createStrategy(id, repos)` ne peut pas accéder au graphe.

> **`asStrategyId`** : `repositories.ts` (l.66) et `trade-tracker.ts` (l.159) utilisent
> `asStrategyId(row.strategyId)` pour relire les `strategyId` persistés. Il faut étendre
> `asStrategyId` pour accepter `custom:<id>` (sinon les positions d'un graphe custom seraient
> relues comme `undefined`). **Complétude (validation asStrategyId)** : `asStrategyId` est
> aussi utilisée dans le parse du settings JSON au restart — un `strategyId: "custom:abc"`
> sauvegardé doit survivre au redémarrage (`readRuntimeSettingsSync` → `sanitizePatch` →
> `parseStrategyId`). Le type `StrategyId` étendu `custom:${string}` est le mécanisme.

> **Reset (décision audit validée)** : `strategy_graphs` **n'est PAS purgée** dans `reset()`
> (`database.ts`). Les graphes sont des définitions de stratégie, pas des données de trading.
> Ne pas ajouter de `DELETE FROM strategy_graphs` dans `reset()`.

> **Zones d'ombre trouvées par l'audit (backend, à traiter en Phase 2)** — sans ces
> correctifs, activer un graphe custom **casse silencieusement la config** du moteur :
>
> 1. **`keysForStrategy` (runtime-settings.ts l.347-353)** perd les clés edge-lead pour un
>    custom** : `strategyId === "edge-lead" ? EDGE_LEAD_KEYS : ARB_BARBELL_KEYS` → un
>    custom:xxx retombe sur ARB_BARBELL_KEYS. Conséquence en cascade : `snapshotEditableSettings`
>    (l.355) n'écrit que les clés arb/barbell dans `data/bot-settings.json` → au restart
>    ou au prochain PATCH, les bandes/budgets edge du graphe sont perdus/écrasés par défauts.
>    → **Fix (audit 2)** : 2e arg `leadsWithEdge?: boolean` + getter graphe, pas une simple
>    comparaison de string. Détail ci-dessous.
> 2. **`validateConfigCoherence` (config.ts l.347+, branche edge l.372)** saute la validation edge pour un
>    custom : `if (config.strategyId === "edge-lead")` → un custom edge-lead avec des bandes
>    incohérentes passerait la validation. → **Fix** : même condition étendue aux customs
>    `leadsWithEdge` (alignée sur keysForStrategy).
> 3. **`STRATEGIES: Record<StrategyId, () => TradingStrategy>` (registry.ts l.7-11)** :
>    `StrategyId` devient une union ouverte `custom:${string}` → `Record<StrategyId, …>`
>    n'est plus assignable (erreur TS). → **Fix** : changer en `Partial<Record<…>>` ou en
>    `Map` natifs + branche `custom:` dans `createStrategy`. À figer Phase 2.
> 4. **`dashboard/server.ts` l.105-108 (routing SPA)** : le serveur sert explicitement
>    `/`, `/index.html`, `/guide`, `/backtest` → il faut ajouter `/strategy-editor` à cette
>    liste sinon la page 404. À traiter Phase 3.
> 5. **`resting-manager.ts` (message de log cancel-lock)** : `this.strategy.id === "arb" ? … :
>    "edge-lead" ? … : …` → un custom afficherait le message barbell (« favorite left the hedge
>    band ») au lieu du message edge-lead. Cosmétique mais trompeur en prod. → Fix léger :
>    utiliser `this.strategy.leadsWithEdge` (ou un label graphe) pour choisir le libellé.
> 6. **Tests frontend (`BacktestRunList.tsx` `ENGINE_SHORT: Record<StrategyId, string>`)** :
>    même problème `Record<StrategyId, …>` que le registry. → Fix : `Partial<Record>` ou
>    default label "Custom".
>
> Ces points 1-3 sont **bloquants pour l'activation live** d'un graphe custom ; 4-6 sont
> requis pour la complétude UI. Ils sont ajoutés aux checklists Phase 2/Phase 3 ci-dessous.
>
> **Décision audit 2 (lookup graphe)** — `keysForStrategy` / `validateConfigCoherence` ne
> restent pas pures :
> - Signature : `keysForStrategy(strategyId, leadsWithEdge?: boolean)` et
>   `validateConfigCoherence(config, opts?: { leadsWithEdge?: boolean })`.
>   `leadsWithEdge === true` (ou `strategyId === "edge-lead"`) → clés + validation edge.
> - Getter : `leadsWithEdgeFor(id, repos) → boolean | undefined` (lit
>   `repos.strategyGraphs.get(id)?.leadsWithEdge`).
> - **Boot (`index.ts`)** : `loadConfig()` s'exécute **avant** `db.init()`. Pour un
>   `strategyId: "custom:…"` dans `bot-settings.json`, `validateConfigCoherence` au parse
>   **saute** la branche edge (pas de graphe). Après `db.init()` + `createRepositories()`,
>   **re-valider** avec le getter. Échec → ne pas démarrer le bot (erreur explicite
>   « custom strategy <id> not found / incoherent edge config »).
> - `applyRuntimeSettings` : ajouter un paramètre optionnel `leadsWithEdge?: boolean`
>   (le dashboard le calcule via repos avant d'appeler). `snapshotEditableSettings` idem.
> - `DashboardServer.handleGetConfig` : `keysForStrategy(id, leadsWithEdgeFor(id, this.repos))`.
> - Tests `runtime-settings.test.ts` / `config.test.ts` : le 2e arg reste optionnel
>   (natifs inchangés).
>
> **DELETE graphe actif** : `DELETE /api/strategy/:id` refuse (409) si
> `config.strategyId === id`. Désactiver d'abord (revenir à un natif).
>
> **`parseStrategyId`** : `trim().toLowerCase()` existant s'applique aux ids `custom:`
> (UUIDs hex OK). L'éditeur génère des ids déjà lower-case.

---

## 7. Spécification de l'API

Dans `src/dashboard/server.ts`, ajouter les routes (avec `isAllowedOrigin` comme les autres) :

| Méthode | Route | Rôle |
|---|---|---|
| `GET` | `/api/strategy` | Liste les moteurs (natifs + custom) |
| `GET` | `/api/strategy/:id` | Détail d'un graphe custom |
| `POST` | `/api/strategy` | Créer / valider un graphe (body = `StrategyGraph`) |
| `PUT` | `/api/strategy/:id` | Mettre à jour un graphe |
| `DELETE` | `/api/strategy/:id` | Supprimer un graphe |
| `POST` | `/api/strategy/:id/activate` | Activer le graphe (écrit `strategyId = custom:<id>` dans les settings) |
| `POST` | `/api/strategy/validate` | Valider un graphe sans le persister (pour l'éditeur) |

**Activation** : `POST /api/strategy/:id/activate` appelle `applyRuntimeSettings(config, { strategyId: "custom:<id>" })`,
ce qui déclenche le hot-swap existant dans `ReverseBot.onRuntimeSettingsChanged`.

### 7.1 Extension de `strategyId`

`src/strategy/ids.ts` : `StrategyId` devient `"arb" | "barbell" | "edge-lead" | \`custom:${string}\``.

- `parseStrategyId` : accepte `custom:<id>` **syntaxiquement** (ne vérifie pas l'existence).
- `createStrategy(id, repos?)` : si `custom:<id>`, charge le graphe depuis `repos.strategyGraphs`
  et retourne `new GraphStrategy(graph)`.
> **Décision audit (validée)** : `createStrategy` reçoit le repo en paramètre optionnel.
> Sites d'appel actuels : `reverse-bot.ts` (ctor + `onRuntimeSettingsChanged`) et
> `backtest/runner.ts` — on y passe `repos`. `src/bot.ts` n'est qu'un re-export
> (`export { ReverseBot } from "./bot/reverse-bot.js"`).
> `tests/trading-strategy.test.ts` appelle `createStrategy("arb")` sans repo : le paramètre
> doit rester **optionnel** pour ne pas casser les appels natifs.
>
> **Complétude (charge du graphe au hot-swap et au boot)** : `createStrategy("custom:<id>")`
> doit aussi être appelé au **démarrage** quand `data/bot-settings.json` contient un
> `strategyId: "custom:abc"` survécu au restart (config → `createStrategy` via
> `reverse-bot` ctor) : le chemin existe déjà puisque `loadConfig()` applique l'overlay
> settings (runtime-settings.ts `readRuntimeSettingsSync` → `sanitizePatch` →
> `parseStrategyId` accepte custom).
> La vérification d'existence du graphe se fait dans `createStrategy` (throw si absent) —
> le bot démarre avec le graphe persisté.
>
> **Zéro-repo (persistence désactivée / tests)** : si `repos` est `undefined` (PERSISTENCE_ENABLED=false
> ou tests sans DB), `createStrategy("custom:…")` doit **thrower** une erreur explicite
> (« custom strategy <id> requires persistence »), pas retourner undefined ni crasher en
> lisant `repos?.strategyGraphs?.get()` silencieusement. Un graphe custom est une donnée DB.

> **Attention** : `parseStrategyId` est utilisé dans `runtime-settings.ts` (l.230) et
> `strategy-presets.ts` (l.28) **sans accès au repo**. On garde `parseStrategyId` purement
> syntaxique (accepte `custom:<id>`). La vérification d'existence se fait dans `createStrategy`
> (qui a le repo) et dans le handler d'activation `/api/strategy/:id/activate`.

### 7.1.2 Injection de l'horloge (condition préalable §4.1.1)

Les contextes natifs n'exposent **aucune horloge** — le natif lit `Date.now()` en dur
(ex. `reverse-bot` / `opportunity-executor` / `resting-manager`) et le runner backtest a
`nowMs` mais ne le transmet pas à la stratégie. Sans injection, les ops temporels
liraient l'heure réelle en backtest et rejoueraient mal l'historique. Wiring obligatoire :

1. **Interface `TradingStrategy`** (`trading-strategy.ts`) : **aucun changement d'horloge** —
   l'horloge est fournie au DSL via le `GraphContext` interne de l'interpréteur, pas via les
   contextes natifs (les moteurs natifs restent inchangés). *(Le contrat a déjà 6 méthodes ;
   ne pas confondre avec l'extension optionnelle `edgeOrderAction` Phase 5.)*
2. **Interpréteur Phase 1** : **chaque** méthode pose `GraphContext.nowMs = Date.now()`
   **à l'entrée de l'appel** (pas un `tickNowMs` partagé). Raison : `processEvent` appelle
   `manageLiveResting` (`shouldSellExpensiveEdge`, `cheapOrderAction`) **puis**
   `findOpportunities`. Un `tickNowMs` rafraîchi seulement dans `findOpportunities`
   ferait tourner le timer sell sur l'horloge du tick **précédent** ≠ natif
   (`Date.now()` dans `shouldSellExpensiveEdge`). Le lecteur `nowMs` est donc **Phase 1**.
3. **Phase 5 (ops temporels findOpp/cheap/defend)** : injection optionnelle
   `nowMs?: number` sur `StrategyContext`, `RestingCheapContext`, `DefendContext`
   (pas `EdgeSellContext`). Backtest : `findOpportunities` / `cheapOrderAction` /
   `shouldDefend` / `defendShares` reçoivent `nowMs: ctx.nowMs` du snapshot.
   `shouldSellExpensiveEdge` **reste** sur `Date.now()` à l'entrée (parité native).
   Live : champs `nowMs` absents → `Date.now()` à chaque entrée de méthode.
4. **Tests 10b/10c** : horloge murale, comme `tests/edge-lead.test.ts`. Les scénarios
   17-20 sont des **tests unitaires du graphe** (le natif n'a pas d'ops temporels) —
   ne pas « passer nowMs aux deux stratégies » en espérant une parité native.

> **Note** : Phase 5 — `manageRestingPolicy` → `cheapOrderAction` (runner.ts l.367) reçoit
> `nowMs: ctx.nowMs` du snapshot (cheap/defend temporels). Phase 1 : pas d'injection,
> `Date.now()` à l'entrée. `manageRestingPolicy` tourne **avant** `findOpportunities`.

### 7.1.3 Sorties temporelles sur ordres resting (cancel / re-post)

Les conditions temporelles d'entrée (§4.1.1) contrôlent `findOpportunities` — elles décident
**quand poster**. Les **sorties** (dé-poster) passent par les méthodes existantes, déjà
appelées à chaque tick par le bot, qu'il faut pouvoir piloter temporellement :

| Sortie natif | Mécanisme | Extension temporelle |
|---|---|---|
| Annuler GTC edge resting | `manageRestingEdgeLead` (`resting-manager.ts`, câblé hors stratégie : annule si hors bande) | **POC : pas étendu** — hors graphe ; le graphe peut le piloter via l'op `cancelEdgeIf` (Phase 5, optionnel) |
| Annuler GTC cheap resting | `cheapOrderAction` → `"cancel-lock"` (`resting-manager.ts`) | **Pilotable dans le graphe** : condition temporelle → `and` → `cancel-lock` (le nœud `cancel-lock` existe déjà §4.1) |
| Re-post cheap | `cheapOrderAction` → `"take-ask"` ou re-post au tick suivant | Idem — condition temporelle sur l'entrée (re-post au tick où la condition redevient vraie) |
| Vendre cheap (defend) | `shouldDefend` + `defendShares` | **Pilotable** : condition temporelle → `and` → `no-defend`/`defend` |
| Vendre edge (favori nu) | `shouldSellExpensiveEdge` → `resting-manager.sellExpensiveEdgeIfNeeded` | **Dans le contrat actuel (6e méthode)** — le graphe doit la modéliser pour la parité ; ops temporels Phase 5 peuvent la conditionner davantage |

- `cheapOrderAction` et `shouldDefend`/`defendShares` reçoivent un `GraphContext` avec
  `nowMs` (§7.1.2) et **`pairId` via extension additive des contextes natifs**
  (`RestingCheapContext.pairId`, `DefendContext.pairId` — décision audit 2).
  Les 3 moteurs natifs ignorent le champ. Call sites à mettre à jour :
  `resting-manager.replaceMarketableCheap` (l.59+ : `pairId` déjà local),
  `resting-manager` défense (l.234+), `backtest/runner.ts` `manageRestingPolicy`
  (l.347+ / `cheapOrderAction` l.367) et `defendCheapLegs`.
  Les bornes de fenêtre **ne sont pas** sur ces contextes : lecteurs `pairWindowStart` /
  `pairWindowEnd` (cache appris en `findOpportunities`). **§7.1.3 v1 disait
  « pairId déjà disponible nativement » — faux** (`RestingCheapContext` n'avait pas
  `pairId`). Corrigé par l'extension.
- Un graphe peut exprimer « annule le cheap resting si on est en phase 4 et que l'ask remonte »
  sans nouvelle méthode : nœuds `pairId` → `pairWindowStart` → `inPhase` + `trendUp` + `and` → `cancel-lock`.
  Caveat ordre du tick (§5.3) : cache T−1.
- **Décision de cadrage (Phase 5 optionnelle)** : un op dédié `cancelEdgeIf` (piloter le GTC
  edge resting depuis le graphe) nécessiterait de modifier `manageRestingEdgeLead`
  (`resting-manager.ts`) — hors périmètre POC ; documenté comme extension possible.
  De même, une éventuelle méthode `edgeOrderAction` serait une **extension de contrat
  additive** (pas dans `TradingStrategy` actuel) — ne pas la confondre avec
  `shouldSellExpensiveEdge` déjà requis.
- **Pas de nouvelle action « sell-position » générique** (décision conservée) : les ops
  temporels pilotent les portes existantes (`postEdge`/`postCheap` pour l'entrée,
  `cancel-lock`/`keep`/`take-ask` pour la sortie cheap, `shouldDefend`/`defendShares` pour
  la défense, `shouldSellExpensiveEdge` pour la vente de l'edge nu, `hedge-skip` pour le
  hedge). Le hedge post-fill ne se déclenche **que** sur fill détecté
  (`live-order-lifecycle` / `opportunity-executor` → `hedgeAtPostTime`), pas sur condition
  temporelle — invariant de sécurité natif (C2 : jamais de hedge sur cheap resting).

---

## 8. Spécification de l'éditeur visuel (frontend)

### 8.1 Nouvelle page

- Route : `/strategy-editor`.
- **Correction audit (routing réel)** : le routing n'est pas dans `router.ts` mais dans
  `frontend/src/main.tsx` (signal `route` + `Show`). Il faut :
  1. Ajouter `"strategy-editor"` à `AppRoute` dans `frontend/src/router.ts` et à `currentRoute()`.
  2. Ajouter un cas dans le `Show` de `main.tsx` (comme `guide` / `backtest`).
  3. Ajouter un lien dans `frontend/src/components/layout/Header.tsx` (comme les liens Guide/Backtest —
     ce sont des `<a href="/strategy-editor" class="btn guide-nav-link">` simples).
  4. **`navigate()` (router.ts l.11)** : signature actuelle fermée `"/" | "/guide" | "/backtest"`
     → étendre à `"/strategy-editor"` si un bouton du dashboard doit naviguer par JS
     (les `<a href>` du Header n'en ont pas besoin).
  5. **Serveur statique (dashboard/server.ts l.105-108)** : ajouter `/strategy-editor` à la liste
     des chemins qui servent `index.html` (sinon refresh sur /strategy-editor → 404).
- Fichier : `frontend/src/pages/StrategyEditorPage.tsx`.

### 8.2 Composants

| Composant | Fichier | Rôle |
|---|---|---|
| `NodePalette` | `frontend/src/strategy-editor/NodePalette.tsx` | Liste des opérations disponibles (groupées : lecteurs, prédicats, temps §4.1.1, actions, contrôle) |
| `GraphCanvas` | `frontend/src/strategy-editor/GraphCanvas.tsx` | Canvas SVG : drag & drop, connexions, sélection |
| `NodeView` | `frontend/src/strategy-editor/NodeView.tsx` | Rendu d'un nœud (ports, params) |
| `PropertyPanel` | `frontend/src/strategy-editor/PropertyPanel.tsx` | Édition des params du nœud sélectionné |
| `GraphToolbar` | `frontend/src/strategy-editor/GraphToolbar.tsx` | Sauvegarder, valider, activer, exporter JSON |
| `MethodTabs` | `frontend/src/strategy-editor/MethodTabs.tsx` | Basculer entre les **6 méthodes** + flag |

### 8.3 Canvas SVG maison

- Réutiliser/adapter `frontend/src/guide/dagLayout` (module guide déjà consommé par
  `Diagrams.tsx`) pour le **layout automatique** (bouton « auto-layout ») de
  strategy-editor — ce n'est **pas** déjà une page éditeur.
- **Drag & drop** : pointer events sur SVG (mousedown/mousemove/mouseup), pas de lib externe.
- **Connexions** : clic sur un port de sortie → clic sur un port d'entrée. Rendu des arêtes en
  courbes de Bézier (comme `Diagrams.tsx`).
- **État** : store SolidJS (`frontend/src/stores/strategyEditorStore.ts`) contenant le graphe
  en cours d'édition + sélection + historique undo/redo (optionnel au POC).

### 8.4 Validation en direct

- Appel `POST /api/strategy/validate` à chaque modification (debounce) ou validation locale
  (schéma des ports) pour un retour immédiat.
- Afficher les erreurs sous le canvas et sur les nœuds concernés.

---

## 9. Plan d'implémentation par phases

### Phase 0 — Préparation (0,5 j)
- [ ] Lire `edge-lead-strategy.ts`, `edge-confirm.ts`, `predicates.ts`, `utils/prices.ts` en détail.
- [ ] Lister précisément les primitives réutilisables et leurs signatures.
- [ ] Écrire le schéma des ports pour chaque `GraphOp` (dans `graph/ops.ts`).
      Phase 1 **requis** : `if`/`return`/`and`/`or`/`not` + primitifs compare/arithmétique +
      `holdTrueFor` + `nowMs`. `switch`/`gate` : schéma + sémantique minimale (`gate` = if
      sans else qui bloque ; `switch` = dispatch sur valeur) — **non utilisés** par le graphe
      POC, pas de test de parité dessus.

### Phase 1 — DSL + interpréteur + test de parité (2-3 j) ⭐ cœur du POC
- [ ] `src/strategy/graph/types.ts` : types du graphe.
- [ ] `src/strategy/graph/ops.ts` : registre des opérations (implémentation de chaque `GraphOp`).
      Inclut : `round2`, `pickOtherTokenByOutcome`, `pickEdgeToken` (export),
      `appendOpportunity` (export), sémantique `when`/`price` des nœuds d'émission (§5.1),
      primitifs `eq`/`lt`/`gt`/`lte`/`gte`/`add`/`sub`/`mul`/`div`, `holdTrueFor`,
      `nowMs` (lecteur Phase 1), `hasEdgeFill`/`hasCheapFill`.
      `computeEdgeLead*` = wrap natif `(config, price)` (port `budget` ignoré).
      `confirmTicks` : 1 nœud/graphe, bande via `ctx.config`.
- [ ] `src/strategy/graph/interpreter.ts` : accumulateur + `GraphEdge.kind` + **ports
      paresseux** (`and`/`or`/`if` court-circuit) + `nowMs = Date.now()` **à l'entrée
      de chaque méthode** (pas `tickNowMs` partagé) + `if` implicite pour tout booléen
      à sorties `then`/`else` + cache `pairWindow*` au début de `findOpportunities`.
- [ ] `src/strategy/graph/validate.ts` : validation de schéma/cycles/types + arêtes
      `kind: data|control` + branches then/else + ops autorisés par méthode + un seul
      `confirmTicks` + ports bande `confirmTicks` = `{kind:"config"}`.
- [ ] **Extension additive contextes** : `RestingCheapContext.pairId` + `DefendContext.pairId`
      (`trading-strategy.ts`) ; passer `pairId` depuis `resting-manager`, `backtest/runner`,
      **`hedge-post.ts`**. Tests : `trading-strategy.test.ts`, `edge-lead.test.ts`.
- [ ] Sous-graphe `shouldSellExpensiveEdge` (§4.2) figé dans le JSON POC (pas de stub `false`).
- [ ] **Test de parité** : `tests/strategy-graph-parity.test.ts` — rejouer `edge-lead` natif vs
      `GraphStrategy` sur des scénarios (books synthétiques) et comparer les sorties des
      **6 méthodes** (dont `shouldSellExpensiveEdge`).
      Doit couvrir les cas de parité difficiles : resets du buffer (edge sort de bande puis
      revient), round2 du cheap (ask non arrondi en limite de bande), gardes appendOpportunity
      (maxOpenPerSide atteint, tradeKey déjà marqué), ask null/undefined dans cheapOrderAction,
      sell edge — **rejouer les cas de `tests/edge-lead.test.ts`** (disabled, cheapFilled>0,
      marketAge, bid null, perte sous seuil, 1er tick window, window écoulée, reset si
      la perte disparaît). Horloge murale (pas d'injection `nowMs`).
- [ ] Critère de sortie : **parité exacte** sur un jeu de scénarios représentatif.

### Phase 2 — Persistance + registre + API (1-2 j)
- [ ] Table `strategy_graphs` + repository.
- [ ] Étendre `StrategyId` à `custom:<id>` + `createStrategy(id, repos?)` hybride.
- [ ] Fix `Record<StrategyId, …>` registry.ts (Partial<Map> — sinon TS refuse l'assignation).
- [ ] Passer `repos` à `createStrategy` dans `reverse-bot.ts` (ctor + `onRuntimeSettingsChanged`) et `backtest/runner.ts`.
- [ ] **`keysForStrategy` (runtime-settings.ts l.347)** + getter graphe `leadsWithEdgeFor`
      (2e arg `leadsWithEdge?: boolean`). `applyRuntimeSettings` / `snapshotEditableSettings`
      reçoivent le flag (dashboard via repos).
- [ ] **`validateConfigCoherence` (config.ts l.372)** : 2e arg `opts.leadsWithEdge`.
      **Boot** : `loadConfig()` saute l'edge custom ; `index.ts` re-valide après `db.init()`.
- [ ] `asStrategyId` étendu (relire les positions strategyId=custom depuis la DB).
- [ ] Routes API CRUD + validate + activate. **DELETE** du graphe actif → 409.
- [ ] Hot-swap live vérifié (activer un graphe → `onRuntimeSettingsChanged`).
- [ ] Backtest : `createStrategy(id, repos)` retourne le `GraphStrategy` → le backtest le charge automatiquement.
      **Attention** : `dashboard/server.ts` (l.822) parse `body.strategyId` **avant**
      `BacktestJob.buildConfig`. Dans `job.ts`, `useCurrentConfig` (l.230) copie
      `body.strategyId` sans re-parse (OK si déjà parsé) ; le `else` l.240 appelle
      `parseStrategyId`. Avec parse syntaxique, `custom:<id>` passe.
      Le backtest doit aussi recevoir `repos` (il l'a déjà via `BacktestJob`).
- [ ] **Erreur explicite `createStrategy("custom:…")` sans repos** (persistence off / tests).

### Phase 3 — Éditeur visuel (2-3 j)
- [ ] Route `/strategy-editor` + navigation (+ serveur statique `/strategy-editor` + `navigate()` si besoin).
      `main.tsx` : 3e branche `Show` (aujourd'hui imbrication guide/backtest uniquement) +
      import `./styles/strategy-editor.css`.
- [ ] `NodePalette`, `GraphCanvas`, `NodeView`, `PropertyPanel`, `MethodTabs`.
- [ ] Drag & drop + connexions + auto-layout (réutiliser/adapter `frontend/src/guide/dagLayout`).
- [ ] Validation en direct + export/import JSON.
- [ ] Bouton « Activer » (appelle `/api/strategy/:id/activate`).
- [ ] **SettingsModal** : afficher les graphes custom dans le sélecteur de moteur
      (actuellement fermé sur STRATEGY_ENGINE_OPTIONS / presetsForStrategy — un custom
      n'a pas de presets ; champ `strategyId` type à étendre dans configForm.ts).
- [ ] **BacktestRunList.tsx** : `ENGINE_SHORT: Record<StrategyId, string>` → Partial + label custom.

### Phase 4 — Intégration & guide (1 j)
- [ ] Charger le graphe `edge-lead` par défaut dans l'éditeur (bouton « charger edge-lead »).
- [ ] Mettre à jour la page `/guide` (règle `strategy-guide-sync.mdc`) : mentionner l'éditeur.
- [ ] `npm run build` frontend + backend OK.
- [ ] Tests de non-régression des 3 moteurs natifs.

### Phase 5 — Conditions temporelles (§4.1.1, §5.3, §7.1.2, §7.1.3) (2-3 j)
> **Additive AFTER** la parité des **6 méthodes** (Phase 1). Ne pas confondre avec
> `shouldSellExpensiveEdge` (déjà dans le contrat) ni traiter `edgeOrderAction` comme
> déjà implémenté.
- [ ] **Wiring horloge (§7.1.2)** — prérequis bloquant **sans casser la parité sell-edge** :
  - Phase 1 déjà : `GraphContext.nowMs = Date.now()` à **chaque** entrée de méthode ;
    op lecteur `nowMs` déjà dans le DSL (holdTrueFor).
  - Phase 5 : `nowMs?: number` **seulement** sur `StrategyContext`, `RestingCheapContext`,
    `DefendContext` — **pas** `EdgeSellContext`. Runner : injecter dans findOpp / cheap /
    defend / defendShares. **Ne pas** injecter dans `shouldSellExpensiveEdge`.
  - `sampleWindow` / `inPhase` lisent cette horloge injectée (backtest déterministe).
  - Live : `ctx.nowMs ?? Date.now()` à l'entrée de la méthode (jamais `Date.now()` dans l'op).
- [ ] **Ops temporels (§4.1.1)** dans `graph/ops.ts` : `windowStartSec`,
      `windowEndSec`, `minutesLeft`, `secondsElapsed`, `inPhase`, `windowRange`,
      `sampleWindow` (store stateful `nodeId × pairId`), `trendUp`, `trendDown`,
      `trendNeutral`, `pairWindowStart`, `pairWindowEnd`. (`nowMs` déjà Phase 1.)
- [ ] **Interpréteur (§5.3)** : évaluation once-per-tick des nœuds stateful (marquage
      `évalué ce tick`), purge `maxAgeMs` au push, ask null non échantillonné,
      throw explicite si op temporel sans horloge fournie en backtest sans wiring.
- [ ] **Éditeur (§8)** : palette « Temps » (catégorie) : nodes `sampleWindow`, `trendUp/Down/Neutral`,
      `inPhase` (avec mini-UI de phases : « 15 min → 4 phases de 5 min » prérempli), `windowRange`,
      `minutesLeft`, `nowMs`. PropertyPanel : champs `maxAgeMs` (5 000-10 000 ms par défaut),
      `minSlope` (0.002 défaut, aide « prix/s ; 0.002 = +1 pt/5 s »), `phaseDurationSec` +
      `phaseMin`/`phaseMax` (sélecteur de phase visuel : P1-P4), `startSec`/`endSec`.
- [ ] **Validation temporelle (§5.2)** : `maxAgeMs ≥ 2× pollIntervalMs`, `minSlope > 0`,
      `phaseDurationSec > 0`, `phaseMin ≤ phaseMax`, refs `samples → sampleWindow`,
      `nowMs` autorisé partout ; `windowStartSec`/`windowEndSec` seulement `findOpportunities` ;
      `inPhase`/`windowRange`/`minutesLeft` ailleurs via `pairWindow*` uniquement
      (`pairId` déjà sur cheap/defend depuis Phase 1). Cache pairWindow : side-effect
      **méthode** `findOpportunities` (pas un nœud) — le POC edge-lead n'a pas de nœud window.
- [ ] **Tests de parité temporelle (§10.1 n°17-20)** : horloge explicite passée aux deux
      stratégies ; scénarios trend (montée/descente/plateau), phases (phase 1 seule,
      transitoires de phase), purge fenêtre, ask null skip, backtest replay (samples
      horodatés au temps snapshot, pas temps réel).
- [ ] **Sorties temporelles (§7.1.3)** : documenter dans l'éditeur les recettes : « cancel
      cheap si phase 4 + trend down », « minutesLeft < 2 → hedge-skip », « trendDown →
      cancel-lock ». Pas de sell-position ; pas d'op cancelEdgeIf en POC.
- [ ] Critère de sortie : parité Phase 1 **inchangée** (le graphe edge-lead POC n'utilise
      aucun op temporel) ; backtest d'un graphe temporel rejoue l'horloge des snapshots.

---

## 10. Tests de parité (détail)

Objectif : prouver que `GraphStrategy(edge-lead-graph)` == `EdgeLeadStrategy` sur les **6 méthodes**.

### 10.1 Scénarios (books synthétiques)

| # | Scénario | Méthodes testées |
|---|---|---|
| 1 | Aucun book (1 seul côté) | `findOpportunities` → [] (et **reset buffer**) |
| 2 | Edge dans la bande, < N ticks | `findOpportunities` → [] |
| 3 | Edge dans la bande, N ticks croissants | `findOpportunities` → post edge |
| 4 | Edge posté, pas fillé | `findOpportunities` → [] (pas de cheap) |
| 5 | Edge fillé, cheap dans la bande | `findOpportunities` → post cheap |
| 6 | Edge fillé, cheap hors bande | `findOpportunities` → [] |
| 7 | Cheap resting, ask dans la bande | `cheapOrderAction` → keep |
| 8 | Cheap resting, ask hors bande | `cheapOrderAction` → cancel-lock |
| 9 | Défense | `shouldDefend` → false, `defendShares` → 0 |
| 10 | Hedge au post | `hedgeAtPostTime` → skip |
| 10b | Sell edge désactivé / cheapFilled > 0 / marketAge trop jeune / bid null / perte sous seuil / 1er tick de fenêtre | `shouldSellExpensiveEdge` → false |
| 10c | Sell edge : perte soutenue après `edgeSellExpensiveLossWindowMs` ; reset du timer si la perte disparaît | `shouldSellExpensiveEdge` → true puis false (parité `tests/edge-lead.test.ts`) |

**Scénarios à ajouter (audit — parité difficile)** :
| # | Scénario | Ce qu'il prouve |
|---|---|---|
| 11 | Edge confirme N ticks, sort de bande 1 tick, revient N ticks | Le reset du buffer hors-bande (l.228) est bien reproduit par le nœud `confirmTicks` (sinon le signal serait prêt trop tôt au retour) |
| 12 | Cheap ask non arrondi en limite de bande (ex. 0.14166 vs edgeCheapBandMax=0.14) | `round2` est appliqué AVANT le test de bande et comme prix posté (l.187-188) |
| 13 | `maxOpenPositionsPerSide` atteint (position open sur le side) | Les gardes `appendOpportunity` (countOpenPerSide/countLegsByKind) s'appliquent bien au nœud d'émission |
| 14 | `tradeKey` déjà marqué (tracker.has) | Idem — garde hasTradeKey |
| 15 | `cheapBook` undefined (contexte natif) vs null (graphe) | La normalisation undefined→null de l'interpréteur ne change pas le comportement |
| 16 | Séquence multi-ticks sur la même paire (état persiste) | L'état `confirmTicks` vit bien dans l'instance `GraphStrategy`, pas réinitialisé à chaque tick |

**Scénarios temporels (audit — Phase 5, §4.1.1/§5.3)** — parité **native vs graphe** sur les
méthodes temporelles uniquement si le natif utilise les mêmes données ; sinon tests
**unitaires du comportement spécifié** (le natif n'a pas d'ops temporels) :
| # | Scénario | Ce qu'il prouve |
|---|---|---|
| 17 | Fenêtre 5 s : ask 0.50 → 0.50 → 0.51 → 0.52 avec ticks de 5 s (samples horodatés) ; `trendUp` `minSlope=0.002` | `sampleWindow` échantillonne une fois par tick, `trendUp` calcule la slope sur la fenêtre et respecte `minSlope` |
| 18 | Same series + `trendDown`/`trendNeutral` ; série plate (0.50 ×3) ; série avec < 2 samples | Les trois trends sont mutuellement exclusifs ; plateau → neutral ; < 2 samples → false (prudence) |
| 19 | Marché 15 min, ticks aux phases 0-3 ; `inPhase` `phaseDurationSec=300`, phaseMin=0, phaseMax=1 | `inPhase` découpe correctement (phaseIdx=floor(elapsed/300)) ; tick à elapsed=301 s → phase 1 → true ; elapsed=601 s → phase 2 → false ; elapsed négatif (avant windowStart) → false |
| 20 | Backtest replay : 2 snapshots espacés de 5 s à t=t₀ et t₀+5s, horloge=temps snapshot ; puis same run avec horloge=Date.now() | **Les samples sont horodatés au temps du snapshot rejoué** : avec l'horloge injectée, trendUp(t) == trendUp(snapshot) ; sans injection (Date.now()), la fenêtre 10 s serait remplie instantanément par 2 ticks replayés en < 1 s → détection de fausse tendance → **preuve que le wiring §7.1.2 est obligatoire** |

Les scénarios 11-16 sont nécessaires au critère de sortie « parité exacte » de la Phase 1.
Les scénarios 17-20 sont le critère de sortie de la Phase 5.

### 10.2 Méthode

- Instancier les deux stratégies avec la même config.
- Pour chaque scénario, construire `StrategyContext` / `RestingCheapContext` / etc. identiques.
- Comparer les sorties (tableaux d'opportunités, actions, décisions) **à l'identique**.
- Le buffer de confirmation doit être **réinitialisé entre les scénarios qui testent des
  états différents** (via `buffer.reset(pairId)` / une nouvelle paire par scénario), mais
  **PAS entre les ticks successifs d'un même scénario** (les scénarios 2→3 et « edge sort
  de bande puis revient » sont des séquences multi-ticks où l'état doit persister pour
  prouver les resets natifs). Clarification audit : la v1 disait « réinitialisé entre
  scénarios » sans distinguer — il faut les deux types de scénarios.

---

## 11. Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Parité non atteinte (graphe ≠ natif) | Bloquant | Phase 1 dédiée au test de parité avant tout UI |
| Ops temporels en backtest datés au temps réel (wiring horloge manquant §7.1.2) | Fausse tendance, backtest invalide | Wiring `nowMs` obligatoire en Phase 5 ; scénario 20 prouve le besoin ; throw si horloge absente |
| Séries `sampleWindow` croissent sans borne (fuite mémoire live) | Instabilité prod | Purge `maxAgeMs` à chaque push (§5.3) ; séries purgées à `windowEnd` |
| `minSlope` mal calibré (trop bas → faux positifs trend) | Signaux pourris | Défaut 0.002 + aide unités dans l'éditeur ; calibrage par backtest (Phase 5) |
| `EdgeConfirmBuffer` stateful | Complexité | Réutiliser la classe telle quelle, état par instance |
| `parseStrategyId` sans accès repo | Erreur d'activation | Vérifier l'existence dans `createStrategy` + handler d'activation |
| `orchestrate` partagé arb/barbell | Non réutilisable tel quel | Le POC ne couvre que `edge-lead` ; arb/barbell restent natifs |
| Logique séquentielle (3 phases) | Complexité DSL | **Option A validée** : nœuds de contrôle (`if`/`return`) avec court-circuit, fidèle à la machine à états |
| Drag & drop SVG maison | Effort UI | Réutiliser/adapter `frontend/src/guide/dagLayout` ; POC minimal (pas d'undo/redo) |
| Hot-swap live casse le bot | Risque prod | **Décision audit (validée)** : activation live autorisée dès le POC. Mitigation : valider le graphe à l'activation, garder les 3 natifs intacts, et pouvoir revenir à un moteur natif via le SettingsModal. |
| Backtest charge un graphe invalide | Erreur runtime | Valider le graphe à l'activation et au chargement |

---

## 12. Hors périmètre (POC)

- Éditeur de logique pour `arb` / `barbell` (reste natif).
- Réimplémentation de `leadsWithEdge` en nœuds.
- Undo/redo complet, zoom/pan avancé, copier-coller de sous-graphes.
- Exécution de code arbitraire dans les nœuds (sécurité : whitelist d'opérations uniquement).
- Multi-utilisateurs / permissions.

---

## 13. Récapitulatif des fichiers

### Nouveaux (backend)
- `src/strategy/graph/types.ts`
- `src/strategy/graph/ops.ts`
- `src/strategy/graph/interpreter.ts`
- `src/strategy/graph/validate.ts`
- `src/db/strategy-graph-repo.ts`
- `tests/strategy-graph-parity.test.ts`

### Modifiés (backend)
- `src/strategy/trading-strategy.ts` (`RestingCheapContext.pairId` + `DefendContext.pairId` — audit 2)
- `src/strategy/hedge-post.ts` (`DefendContext.pairId` dans le `defendCtx` l.22-27)
- `src/strategy/ids.ts` (StrategyId étendu)
- `src/strategy/registry.ts` (createStrategy hybride + fix Record<StrategyId,…> → Partial)
- `src/strategy/edge-lead-strategy.ts` (export pickEdgeToken + appendOpportunity — audit)
- `src/index.ts` (re-validate custom après `db.init()` — audit 2)
- `src/db/database.ts` (table ; **pas** de DELETE dans `reset()`)
- `src/db/index.ts` (interface Repositories + factory createRepositories)
- `src/db/repositories.ts` (asStrategyId custom — lecture positions)
- `src/runtime-settings.ts` (`keysForStrategy(id, leadsWithEdge?)` + `applyRuntimeSettings` getter — audit 2)
- `src/config.ts` (`validateConfigCoherence(config, opts?)` — audit 2)
- `src/backtest/runner.ts` (createStrategy(id, repos) + passer `pairId` cheap/defend)
- `src/bot/reverse-bot.ts` (createStrategy(id, repos?) ctor + onRuntimeSettingsChanged ; hot-swap → setStrategy sur lifecycle/resting/executor)
- `src/bot/resting-manager.ts` (passer `pairId` à cheapOrderAction/defend ; log cancel via `leadsWithEdge`)
- `src/bot/opportunity-executor.ts` (hedgeAtPostTime / C2 / orderTypeFor)
- `src/bot/live-order-lifecycle.ts` (lifecycle fills ; setStrategy)
- `src/bot.ts` (re-export uniquement : `export { ReverseBot } from "./bot/reverse-bot.js"`)
- `src/dashboard/server.ts` (routes API + route statique /strategy-editor + keysForStrategy getter)
- tests construisant `RestingCheapContext` / `DefendContext` (`pairId` obligatoire) :
  `tests/trading-strategy.test.ts`, `tests/edge-lead.test.ts`

### Nouveaux (frontend)
- `src/pages/StrategyEditorPage.tsx`
- `src/strategy-editor/NodePalette.tsx`
- `src/strategy-editor/GraphCanvas.tsx`
- `src/strategy-editor/NodeView.tsx`
- `src/strategy-editor/PropertyPanel.tsx`
- `src/strategy-editor/GraphToolbar.tsx`
- `src/strategy-editor/MethodTabs.tsx`
- `src/stores/strategyEditorStore.ts`
- `src/styles/strategy-editor.css`

### Modifiés (frontend)
- `src/router.ts` (AppRoute + currentRoute + **navigate() signature étendue** — audit)
- `src/main.tsx` (3e cas de route + import CSS)
- `src/components/layout/Header.tsx` (nav)
- `src/types/index.ts` (StrategyId étendu à `custom:<id>` — l.417 ; usages l.478, l.498)
- `src/config/strategyPresets.ts` (StrategyId étendu + STRATEGY_ENGINE_OPTIONS)
- `src/utils/configForm.ts` (ConfigFormState.strategyId étendu — l.11)
- `src/components/modals/SettingsModal.tsx` (sélecteur de moteur : afficher les graphes custom + clés edge visibles)
- `src/components/backtest/BacktestRunList.tsx` (ENGINE_SHORT Partial + label custom — audit)
- `src/api/client.ts` (appels API)
- `src/guide/data.ts` + `GuideTabs.tsx` (mention de l'éditeur, règle guide-sync)
