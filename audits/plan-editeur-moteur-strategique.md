# Plan — Éditeur graphique de moteur stratégique (POC edge-lead)

> Date : 2026-09-10
> Statut : **Proposition — à valider avant implémentation**
> Périmètre : POC basé sur `edge-lead`, éditeur visuel node-based, activation live + backtest.

---

## 1. Contexte et objectif

Le bot possède 3 moteurs codés en dur (`arb`, `barbell`, `edge-lead`) sous forme de classes
TypeScript implémentant l'interface `TradingStrategy`. L'objectif est de permettre de
**construire visuellement la logique d'un moteur** via un éditeur de nœuds, sans écrire de code.

Le POC prend **`edge-lead` comme base** : on doit pouvoir reproduire sa logique dans un graphe
éditable, l'activer en live (hot-swap) et la charger dans le moteur de backtest.

### Contrat à modéliser

L'interface `TradingStrategy` (5 méthodes + 1 flag) est le contrat que le graphe doit satisfaire :

```startLine:44:58
src/strategy/trading-strategy.ts
```

Le bot appelle ces méthodes à plusieurs endroits (`bot.ts`, `backtest/runner.ts`), et le flag
`leadsWithEdge` pilote des comportements câblés en dur (tri des opportunités, gestion du GTC
edge, bypass C2, défense). **Le POC garde `leadsWithEdge` comme attribut du graphe** (décision
de cadrage), pas comme nœud réimplémenté.

---

## 2. Décisions de cadrage (validées)

| Sujet | Décision |
|---|---|
| Objectif de validation | **Parité exacte** : le graphe doit reproduire `edge-lead` à l'identique (test de parité contre la classe native) |
| Activation | **Hot-swap live** dès le POC (via `strategyId`) **et** chargeable dans le moteur backtest |
| `leadsWithEdge` | **Attribut du graphe** (pas un nœud) |
| Persistance | **Nouvelle table SQLite** (versionnée, cohérente avec l'existant) |
| Éditeur visuel | **Canvas SVG maison** (réutiliser `dagLayout.ts` + drag & drop) |

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
  | "isNull"                // teste si une valeur est null/undefined
  | "postEdge"              // émet une opportunité "expensive"
  | "postCheap"             // émet une opportunité "cheap"
  | "skip"                  // pas d'opportunité
  | "keep" | "cancel-lock" | "take-ask"   // cheapOrderAction
  | "defend" | "no-defend"  // shouldDefend / defendShares
  | "hedge-skip" | "hedge-post" | "hedge-defend"  // hedgeAtPostTime
  | "edgeFilled"            // tracker.getFilledExpensiveSizeForPair > 0
  | "cheapFilled"           // tracker.getFilledCheapSizeForPair > 0
  | "edgePosted" | "cheapPosted"  // tracker.getPostedOrdersForPair
  | "countOpenPerSide"      // garde maxOpenPositionsPerSide
  | "countLegsByKind"       // garde countLegsByKind
  | "hasTradeKey"           // tracker.has
  | "makeTradeKey";         // tracker.makeKey

/**
 * Contexte général : union de tous les champs des 4 contextes natifs
 * (StrategyContext, RestingCheapContext, DefendContext, HedgePostContext).
 * Chaque méthode remplit les champs qu'elle possède, le reste est `null`.
 * Les lecteurs de contexte lisent ici ; la validation vérifie la
 * disponibilité des champs par méthode (voir §5.2).
 *
 * Corrections audit :
 * - `config` : présent dans les 4 contextes natifs — omis de la v1 du plan.
 *   Les ops dépendant d'un mode de sizing (computeEdgeLeadEdgeSize/CheapSize
 *   lisent edgeSizingMode/edgeSharesEdge/edgeSharesCheap/maxShareEdge en
 *   interne) le lisent ici ; les scalaires (bandes, budgets) restent des
 *   GraphParam { kind: "config" }.
 * - `pairId` : rempli AUSSI pour findOpportunities (dérivé de event :
 *   `${event.slug}:${event.windowEnd}`) — edgeClaimedOutcome,
 *   getPosted/FilledOrdersForPair et le buffer de confirmation en ont
 *   besoin. Table de disponibilité §5.2 mise à jour en conséquence.
 * - `cheapBook` natif est `TokenBook | undefined` (RestingCheapContext) :
 *   l'interpréteur normalise `undefined` → `null`.
 */
export interface GraphContext {
  // présent dans les 4 contextes natifs
  config: BotConfig | null;
  // findOpportunities
  books: TokenBook[] | null;
  event: UpDownEvent | null;
  tracker: TradeTracker | null;
  // findOpportunities (dérivé de event) + hedgeAtPostTime (natif)
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
}

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
  // Correction audit — deux sémantiques coexistent dans les exemples, à figer en Phase 1 :
  // - arête de DONNÉE : `port` = nom du port d'ENTRÉE du nœud cible ("ask", "books", "token"…)
  // - arête de CONTRÔLE : `port` = branche SORTE du nœud source ("then"/"else" d'un `if`,
  //   ou activation directe) ; la cible est alors évaluée conditionnellement.
  // La validation (§5.2) doit distinguer les deux kinds.
  port: string;
}

// Un graphe décrit les 5 méthodes + le flag
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
      { "id": "edge-filled", "op": "edgeFilled", "params": {} },
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
      { "id": "cheap-filled", "op": "cheapFilled", "params": {} },
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
  ], "edges": [] }
}
```

> **Note (option A + contexte général)** : le graphe ci-dessus est une **esquisse** de la structure.
> La correspondance exacte nœud ↔ code sera figée à l'étape 1 (voir plan) par le test de parité.
> Le nœud `if` a deux sorties (`then` / `else`) ; le nœud `return` stoppe l'évaluation et retourne
> le résultat courant.
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
> Les nœuds `edge-posted`/`edge-filled`/`cheap-posted`/`cheap-filled` sont **connectés** comme
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
}
```

### 5.1 Règles d'exécution

- **Évaluation paresseuse** : chaque nœud est évalué à la demande, en résolvant ses ports
  d'entrée (topologique). Détection de cycle → erreur de validation.
- **Court-circuit (option A validée)** : les nœuds de contrôle (`if`, `switch`, `gate`, `return`)
  pilotent le flux. Un nœud `if` n'évalue que la branche `then` ou `else` selon sa condition.
  Un nœud `return` stoppe l'évaluation et retourne le résultat courant. C'est ce qui reproduit
  la machine à états à 3 phases d'edge-lead (edge posté → return [] ; edge fillé → post cheap ;
  sinon → confirmation → post edge).
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
  champs des 4 contextes natifs, voir §4.1) en remplissant les champs qu'elle possède et en
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
  > **Gardes mémoire (annulés par défaut)** : les gardes internes d'`appendOpportunity`
  > (maxOpenPerSide, countLegsByKind, hasTradeKey) doivent être **désactivées dans le nœud
  > d'émission** pour la parité — elles sont implémentées par des nœuds séparés
  > `countOpenPerSide`/`countLegsByKind`/`hasTradeKey`/`makeTradeKey` quand le graphe le veut.
  > ⚠️ Dans le POC edge-lead, ces gardes ne sont PAS dans le graphe (le natif les déportant
  > à `appendOpportunity`) : si le nœud postEdge/postCheap de l'ops appelle `appendOpportunity`
  > tel quel, elles s'appliquent par défaut et la parité est préservée ; si un futur graphe
  > les déplace en nœuds explicites, l'op doit pouvoir les désactiver (param `applyGuards: false`).
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

  | Lecteur | `findOpportunities` | `cheapOrderAction` | `shouldDefend`/`defendShares` | `hedgeAtPostTime` |
  |---|---|---|---|---|
  | `config` | ✅ | ✅ | ✅ | ✅ |
  | `books` | ✅ | ❌ | ❌ | ❌ |
  | `event` | ✅ | ❌ | ❌ | ❌ |
  | `tracker` | ✅ | ❌ | ❌ | ✅ |
  | `pairId` | ✅ (dérivé : `${event.slug}:${event.windowEnd}`) | ❌ | ❌ | ✅ |
  | `cheapBook` | ❌ | ✅ | ❌ | ❌ |
  | `favoriteAsk` | ❌ | ✅ | ✅ | ❌ |
  | `limitPrice` | ❌ | ✅ | ❌ | ❌ |
  | `filledCheap` / `filledExpensive` | ❌ | ❌ | ✅ | ❌ |
  | `freshAsk` | ❌ | ❌ | ❌ | ✅ |

  > **Correction audit (table v1 fausse)** : la v1 marquait `pairId` ❌ pour
  > `findOpportunities`, mais les ops `claimedOutcome`, `edgePosted`, `edgeFilled`,
  > `cheapPosted`, `cheapFilled`, `confirmTicks` (via `buffer.push(pairId, …)` et
  > `reset(pairId)`) en ont BESOIN dans `findOpportunities`. Le `GraphContext.pairId`
  > est donc rempli pour `findOpportunities` en le dérivant de `event`
  > (native l.157 : `const pairId = \`${event.slug}:${event.windowEnd}\``).
  > `config` était absent de la table alors qu'il est présent dans les 4 contextes natifs.

  Un graphe qui lit un champ **toujours null** dans une méthode est rejeté (erreur humaine
  explicite). C'est la garde clé du contexte général : elle empêche de lire une métrique
  indisponible dans la méthode courante.
- `leadsWithEdge` : booléen obligatoire.
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
> 1. **`keysForStrategy` (runtime-settings.ts l.331-337) perd les clés edge-lead pour un
>    custom** : `strategyId === "edge-lead" ? EDGE_LEAD_KEYS : ARB_BARBELL_KEYS` → un
>    custom:xxx retombe sur ARB_BARBELL_KEYS. Conséquence en cascade : `snapshotEditableSettings`
>    (l.341) n'écrit que les clés arb/barbell dans `data/bot-settings.json` → au restart
>    ou au prochain PATCH, les bandes/budgets edge du graphe sont perdus/écrasés par défauts.
>    → **Fix** : condition `strategyId === "edge-lead" || (strategyId.startsWith("custom:") &&
>    graphe.leadsWithEdge)` — ou plus simple : exposer les clés edge quand `leadsWithEdge`
>    est porté par le graphe custom (l'info est dans le graphe chargé). À figer Phase 2.
> 2. **`validateConfigCoherence` (config.ts l.360-394) saute la validation edge** pour un
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
> 5. **`bot.ts` l.771-773 (message de log)** : `this.strategy.id === "arb" ? … : "edge-lead" ? … : …`
>    → un custom afficherait le message barbell (« favorite left the hedge band ») au lieu du
>    message edge-lead. Cosmétique mais trompeur en prod. → Fix léger : utiliser
>    `this.strategy.leadsWithEdge` pour choisir le libellé.
> 6. **Tests frontend (`BacktestRunList.tsx` `ENGINE_SHORT: Record<StrategyId, string>`)** :
>    même problème `Record<StrategyId, …>` que le registry. → Fix : `Partial<Record>` ou
>    default label "Custom".
>
> Ces points 1-3 sont **bloquants pour l'activation live** d'un graphe custom ; 4-6 sont
> requis pour la complétude UI. Ils sont ajoutés aux checklists Phase 2/Phase 3 ci-dessous.

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
> `bot.ts` (l.67, l.144) et `backtest/runner.ts` (l.54) ont déjà accès à `repos` — on le passe.
> `tests/trading-strategy.test.ts` (l.86) appelle `createStrategy("arb")` sans repo : le paramètre
> doit rester **optionnel** pour ne pas casser les appels natifs.
>
> **Complétude (charge du graphe au hot-swap et au boot)** : `createStrategy("custom:<id>")`
> doit aussi être appelé au **démarrage** quand `data/bot-settings.json` contient un
> `strategyId: "custom:abc"` survécu au restart (config → `createStrategy` via bot.ts l.67) :
> le chemin existe déjà puisque `loadConfig()` applique l'overlay settings (runtime-settings.ts
> `readRuntimeSettingsSync` l.362 → `sanitizePatch` → `parseStrategyId` accepte custom).
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
| `NodePalette` | `frontend/src/strategy-editor/NodePalette.tsx` | Liste des opérations disponibles (groupées) |
| `GraphCanvas` | `frontend/src/strategy-editor/GraphCanvas.tsx` | Canvas SVG : drag & drop, connexions, sélection |
| `NodeView` | `frontend/src/strategy-editor/NodeView.tsx` | Rendu d'un nœud (ports, params) |
| `PropertyPanel` | `frontend/src/strategy-editor/PropertyPanel.tsx` | Édition des params du nœud sélectionné |
| `GraphToolbar` | `frontend/src/strategy-editor/GraphToolbar.tsx` | Sauvegarder, valider, activer, exporter JSON |
| `MethodTabs` | `frontend/src/strategy-editor/MethodTabs.tsx` | Basculer entre les 5 méthodes + flag |

### 8.3 Canvas SVG maison

- Réutiliser `frontend/src/guide/dagLayout.ts` pour le **layout automatique** (bouton « auto-layout »).
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

### Phase 1 — DSL + interpréteur + test de parité (2-3 j) ⭐ cœur du POC
- [ ] `src/strategy/graph/types.ts` : types du graphe.
- [ ] `src/strategy/graph/ops.ts` : registre des opérations (implémentation de chaque `GraphOp`).
      Inclut : `round2`, `pickOtherTokenByOutcome` (nouveaux ops parité), `pickEdgeToken`
      (export depuis edge-lead-strategy.ts), export d'`appendOpportunity`, sémantique
      `when`/`price` des nœuds d'émission (§5.1).
- [ ] `src/strategy/graph/interpreter.ts` : `GraphStrategy` + évaluateur.
- [ ] `src/strategy/graph/validate.ts` : validation de schéma/cycles/types + arêtes de
      contrôle vs données + branches then/else complètes.
- [ ] **Test de parité** : `tests/strategy-graph-parity.test.ts` — rejouer `edge-lead` natif vs
      `GraphStrategy` sur des scénarios (books synthétiques) et comparer les sorties des 5 méthodes.
      Doit couvrir les cas de parité difficiles : resets du buffer (edge sort de bande puis
      revient), round2 du cheap (ask non arrondi en limite de bande), gardes appendOpportunity
      (maxOpenPerSide atteint, tradeKey déjà marqué), ask null/undefined dans cheapOrderAction.
- [ ] Critère de sortie : **parité exacte** sur un jeu de scénarios représentatif.

### Phase 2 — Persistance + registre + API (1-2 j)
- [ ] Table `strategy_graphs` + repository.
- [ ] Étendre `StrategyId` à `custom:<id>` + `createStrategy(id, repos?)` hybride.
- [ ] Fix `Record<StrategyId, …>` registry.ts (Partial<Map> — sinon TS refuse l'assignation).
- [ ] Passer `repos` à `createStrategy` dans `bot.ts` (l.67, l.144) et `backtest/runner.ts` (l.54).
- [ ] **`keysForStrategy` (runtime-settings.ts l.331)** : exposer les clés edge pour les customs
      `leadsWithEdge` (sinon snapshotEditableSettings perd la config edge au restart/PATCH).
- [ ] **`validateConfigCoherence` (config.ts l.360)** : étendre la validation edge aux customs
      `leadsWithEdge`.
- [ ] `asStrategyId` étendu (relire les positions strategyId=custom depuis la DB).
- [ ] Routes API CRUD + validate + activate.
- [ ] Hot-swap live vérifié (activer un graphe → `onRuntimeSettingsChanged`).
- [ ] Backtest : `createStrategy(id, repos)` retourne le `GraphStrategy` → le backtest le charge automatiquement.
      **Attention** : `backtest/job.ts` (l.240) et `dashboard/server.ts` (l.822) appellent
      `parseStrategyId(body.strategyId)` — avec `parseStrategyId` syntaxique, `custom:<id>` passe.
      Le backtest doit aussi recevoir `repos` (il l'a déjà via `BacktestJob` l.42 → l.167).
- [ ] **Erreur explicite `createStrategy("custom:…")` sans repos** (persistence off / tests).

### Phase 3 — Éditeur visuel (2-3 j)
- [ ] Route `/strategy-editor` + navigation (+ serveur statique `/strategy-editor` + `navigate()` si besoin).
- [ ] `NodePalette`, `GraphCanvas`, `NodeView`, `PropertyPanel`, `MethodTabs`.
- [ ] Drag & drop + connexions + auto-layout (`dagLayout.ts`).
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

---

## 10. Tests de parité (détail)

Objectif : prouver que `GraphStrategy(edge-lead-graph)` == `EdgeLeadStrategy` sur les 5 méthodes.

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

**Scénarios à ajouter (audit — parité difficile)** :
| # | Scénario | Ce qu'il prouve |
|---|---|---|
| 11 | Edge confirme N ticks, sort de bande 1 tick, revient N ticks | Le reset du buffer hors-bande (l.228) est bien reproduit par le nœud `confirmTicks` (sinon le signal serait prêt trop tôt au retour) |
| 12 | Cheap ask non arrondi en limite de bande (ex. 0.14166 vs edgeCheapBandMax=0.14) | `round2` est appliqué AVANT le test de bande et comme prix posté (l.187-188) |
| 13 | `maxOpenPositionsPerSide` atteint (position open sur le side) | Les gardes `appendOpportunity` (countOpenPerSide/countLegsByKind) s'appliquent bien au nœud d'émission |
| 14 | `tradeKey` déjà marqué (tracker.has) | Idem — garde hasTradeKey |
| 15 | `cheapBook` undefined (contexte natif) vs null (graphe) | La normalisation undefined→null de l'interpréteur ne change pas le comportement |
| 16 | Séquence multi-ticks sur la même paire (état persiste) | L'état `confirmTicks` vit bien dans l'instance `GraphStrategy`, pas réinitialisé à chaque tick |

Les scénarios 11-16 sont nécessaires au critère de sortie « parité exacte » de la Phase 1.

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
| `EdgeConfirmBuffer` stateful | Complexité | Réutiliser la classe telle quelle, état par instance |
| `parseStrategyId` sans accès repo | Erreur d'activation | Vérifier l'existence dans `createStrategy` + handler d'activation |
| `orchestrate` partagé arb/barbell | Non réutilisable tel quel | Le POC ne couvre que `edge-lead` ; arb/barbell restent natifs |
| Logique séquentielle (3 phases) | Complexité DSL | **Option A validée** : nœuds de contrôle (`if`/`return`) avec court-circuit, fidèle à la machine à états |
| Drag & drop SVG maison | Effort UI | Réutiliser `dagLayout.ts` ; POC minimal (pas d'undo/redo) |
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
- `src/strategy/ids.ts` (StrategyId étendu)
- `src/strategy/registry.ts` (createStrategy hybride + fix Record<StrategyId,…> → Partial)
- `src/strategy/edge-lead-strategy.ts` (export pickEdgeToken + appendOpportunity — audit)
- `src/db/database.ts` (table)
- `src/db/index.ts` (interface Repositories + factory createRepositories — **corrigé audit** : la v1 citait repositories.ts)
- `src/db/repositories.ts` (asStrategyId custom — lecture positions)
- `src/runtime-settings.ts` (keysForStrategy étendu aux customs leadsWithEdge — audit)
- `src/config.ts` (validateConfigCoherence étendu aux customs leadsWithEdge — audit)
- `src/backtest/runner.ts` (createStrategy(id, repos))
- `src/bot.ts` (createStrategy(id, repos) ×2 + message log l.771 via leadsWithEdge — audit)
- `src/dashboard/server.ts` (routes API + route statique /strategy-editor)

### Nouveaux (frontend)
- `src/pages/StrategyEditorPage.tsx`
- `src/strategy-editor/NodePalette.tsx`
- `src/strategy-editor/GraphCanvas.tsx`
- `src/strategy-editor/NodeView.tsx`
- `src/strategy-editor/PropertyPanel.tsx`
- `src/strategy-editor/GraphToolbar.tsx`
- `src/strategy-editor/MethodTabs.tsx`
- `src/stores/strategyEditorStore.ts`

### Modifiés (frontend)
- `src/router.ts` (AppRoute + currentRoute + **navigate() signature étendue** — audit)
- `src/main.tsx` (cas de route)
- `src/components/layout/Header.tsx` (nav)
- `src/types/index.ts` (StrategyId étendu à `custom:<id>` — l.409, l.102, l.150, l.376)
- `src/config/strategyPresets.ts` (StrategyId étendu + STRATEGY_ENGINE_OPTIONS)
- `src/utils/configForm.ts` (ConfigFormState.strategyId étendu — l.11)
- `src/components/modals/SettingsModal.tsx` (sélecteur de moteur : afficher les graphes custom + clés edge visibles)
- `src/components/backtest/BacktestRunList.tsx` (ENGINE_SHORT Partial + label custom — audit)
- `src/api/client.ts` (appels API)
- `src/guide/data.ts` + `GuideTabs.tsx` (mention de l'éditeur, règle guide-sync)
