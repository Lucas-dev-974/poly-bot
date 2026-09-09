# Plan — `strategyId` sur les positions

Lier chaque position au moteur qui l'a créée (`arb` | `barbell` | `edge-lead`).
Aujourd'hui `config.strategyId` existe et le bot hot-swap le moteur, mais
`SimulatedPosition` / table SQLite `positions` n'ont pas ce champ : au fill,
l'attribution est perdue.

## Objectif

- Toute position **nouvellement ouverte** porte `strategyId`.
- Le champ survit au restart (SQLite) et au SSE dashboard.
- Les tables UI (ouvertes, résolues, Polymarket) l'affichent.
- Les positions déjà en DB restent lisibles (`NULL` → UI `—`).

## Non-objectifs

- Pas de `strategyId` sur `arb_pairs` : une paire peut théoriquement avoir
  des jambes de moteurs différents après un hot-swap mid-window. L'attribution
  est **par jambe**.
- Pas de `strategyId` sur la table `orders` (hors périmètre). Les ordres
  récents restent typés par `orderType` seulement. À ajouter plus tard si le
  panneau Ordres doit filtrer par moteur.
- Pas de backfill des lignes existantes (on ne peut pas deviner le moteur).
- Pas de filtre / stats P&L par stratégie (affichage seulement).
- Pas de changement de politique des moteurs.

## Décisions figées

| Sujet | Choix | Pourquoi |
|---|---|---|
| Nom de colonne | `strategyId` (camelCase) | Schéma existant : `eventSlug`, `pairId`, `orderType`. Pas `strategie_id`. |
| Type TS | `strategyId?: StrategyId` | Même pattern que `orderType` : lignes anciennes + fixtures de tests. |
| Type SQL | `TEXT` nullable | `CREATE TABLE` + `addColumnIfMissing` pour les DB existantes. |
| Source de vérité au fill GTC | `PostedOrderContext.strategyId` (stampé au POST) | Un GTC peut fill **après** un hot-swap `strategyId`. Lire `this.strategy.id` au fill attribuerait le **nouveau** moteur. |
| Fallback GTC | `this.strategy.id` si le posted order n'a pas le champ | Lignes `posted_orders` antérieures à la migration. |
| Source FOK / SIM | `this.strategy.id` / `this.config.strategyId` | Fill synchrone, même tick. |
| Paires | inchangées | Attribution par position, pas par paire. |

## Data flow

```
POST GTC
  ReverseBot.recordPostedOrder(..., { ..., strategyId: this.strategy.id })
    → TradeTracker.postedOrders Map
    → posted_orders.strategyId (SQLite)
  … plus tard, fill …
  createLivePosition(order) → position.strategyId = order.strategyId ?? this.strategy.id
    → tracker.addOpenPosition → positions.strategyId
    → bus.emit(openedPosition) → SSE → frontend stores

FOK live
  executeLive FOK fill → position.strategyId = this.strategy.id

SIM (dry-run)
  SimulatedBroker.attemptFill → position.strategyId = this.config.strategyId

Defense SELL (closePairCheapAsSold)
  spread `...position` → strategyId copié sur le split "sold" (aucun extra work)

Restart
  PositionRepository.open() / recentResolved() / byPairIds()
    → toPosition() mappe row.strategyId ?? undefined
```

---

## Surface — fichiers à modifier

### 1. Types backend — `src/types.ts`

Ajouter sur `SimulatedPosition` (après `orderType`) :

```ts
import type { StrategyId } from "./strategy/ids.js";
// ...
strategyId?: StrategyId;
```

`src/types.ts` n'a aujourd'hui **aucun import**. Ajouter
`import type { StrategyId } from "./strategy/ids.js"` (type-only, pas de
cycle : `ids.ts` n'importe pas `types.ts`).

### 1b. Helper non-throwing — `src/strategy/ids.ts`

`parseStrategyId` throw. Le load DB ne doit pas throw. Ajouter :

```ts
export function asStrategyId(value: unknown): StrategyId | undefined {
  if (value == null || value === "") return undefined;
  const raw = String(value).trim().toLowerCase();
  return STRATEGY_IDS.find((id) => id === raw);
}
```

Utilisé par `toPosition()` et par `TradeTracker.loadFromDb` (posted orders).
Ne pas refactorer `parseStrategyId` pour s'en servir (hors périmètre).

### 2. Schéma SQLite — `src/db/database.ts`

**CREATE TABLE `positions`** (l.22–43) : ajouter `strategyId TEXT` (nullable),
à côté de `orderType TEXT`.

**CREATE TABLE `posted_orders`** (l.88–95) : le CREATE actuel est minimal
(colonnes métier ajoutées uniquement via `postedOrdersCols` +
`addColumnIfMissing`, l.204–217). Ne pas enrichir le CREATE (inefficace :
`IF NOT EXISTS` ne recrée pas une table existante).

**Migration** :

- `positions` : après l.219 (`orderType`),
  `this.addColumnIfMissing("positions", "strategyId", "TEXT")`.
- `posted_orders` : ajouter `["strategyId", "TEXT"]` au tableau
  `postedOrdersCols` (l.204–214), pas un `addColumnIfMissing` isolé —
  c'est le pattern de toutes les autres colonnes métier de cette table.

`reset()` (DELETE FROM positions / posted_orders) : **aucun changement** —
pas de nouvelle table.

Index : pas d'index `strategyId` (pas de query filtrante prévue).

### 3. Repository positions — `src/db/repositories.ts`

- `PositionRow` : `strategyId: string | null`
- `toPosition()` : passer par `asStrategyId(row.strategyId)` (voir §1b).
  **Ne pas** caster `as StrategyId` ni appeler `parseStrategyId` (throw).
  `null` / `""` / valeur hors `STRATEGY_IDS` → `undefined`.
- `insert()` : ajouter `strategyId` dans le `INSERT OR REPLACE`.
  Compte actuel = **20 colonnes / 20 `?`** (id … createdAt), pas 21.
  Après : 21 colonnes / 21 placeholders. Valeur : `position.strategyId ?? null`.

`updateStatus()` : ne touche pas `strategyId` (correct, le champ est immuable
après insert).

### 4. Repository posted_orders — `src/db/repositories.ts`

- `PostedOrderRow` : `strategyId?: string | null` (SQLite TEXT → `null`
  possible, pas `undefined`).
- `insert()` : colonne + placeholder dans le SQL (**15 colonnes / 15 `?`**
  actuellement → 16). Valeur : `order.strategyId ?? null`.
- `all()` : `SELECT *` → le champ arrive ; le mapping typé se fait au load.

### 5. Tracker — `src/trade-tracker.ts`

`PostedOrderContext` (l.25–37) : `strategyId?: StrategyId`.

**Piège :** `recordPostedOrder` et `loadFromDb` **copient les champs un par
un** (pas de `...context`). Oublier `strategyId` dans l'un des deux objets
littéraux = GTC fill sans moteur après restart. Ajouter explicitement :

- Map `this.postedOrders.set(...)` (l.368–382)
- `PostedOrderRow` (l.383–399)
- reconstruction `loadFromDb` (l.143–157) :
  `strategyId: asStrategyId(order.strategyId)`

`toContext()` (l.428–431) : destructure `{ cost, orderId, ...context }` —
OK dès que le champ est sur l'entry.

`closePairCheapAsSold` (l.683–691) : `...position` copie `strategyId`. Rien à faire.

`addOpenPosition` : insert tel quel. Rien à faire.

### 6. Création live GTC — `src/bot.ts` `createLivePosition` (~l.582)

Aujourd'hui construit `SimulatedPosition` sans `strategyId` (l.582–600).

```ts
strategyId: order.strategyId ?? this.strategy.id,
```

`createLivePosition` reçoit `{ key, orderId } & PostedOrderContext` → le
champ sera sur `order` après l'étape 5.

### 7. Création live FOK — `src/bot.ts` ~l.1240

Le bloc `const position: SimulatedPosition = { ... orderType: "FOK" }` :

```ts
strategyId: this.strategy.id,
```

### 8. Enregistrement GTC au POST — `src/bot.ts` `recordPostedOrder` ~l.1313

Ajouter dans le contexte :

```ts
strategyId: this.strategy.id,
```

C'est **le** stamp qui survit au hot-swap (bot.ts l.164–167 recreate
`this.strategy` si `changed.has("strategyId")`).

### 9. Dry-run — `src/simulated-broker.ts` ~l.108

```ts
strategyId: this.config.strategyId,
```

`SimulatedBroker` a déjà `this.config`. `executeSimulated` (bot.ts l.1654)
passe `result.position` tel quel → le champ arrive au tracker / SSE.

### 10. Types frontend — `frontend/src/types/index.ts`

Sur `SimulatedPosition` (miroir, l.64–85) :

```ts
strategyId?: "arb" | "barbell" | "edge-lead";
```

Même union que `BotConfig.strategyId` (l.132). Le frontend ne peut pas
importer `src/strategy/ids.ts`.

### 11. UI positions ouvertes — `frontend/src/components/panels/OpenPositions.tsx`

Ajouter une colonne **Moteur** dans le `<thead>` / `<tbody>` (après Type) :

```tsx
<th>Moteur</th>
// ...
<td>{p.strategyId ?? "—"}</td>
```

Affichage texte brut (pas de nouveau `BadgeVariant`) pour rester minimal.

### 12. UI positions résolues — `frontend/src/components/panels/ResolvedPositions.tsx`

Même colonne **Moteur** après Type.

### 13. UI positions Polymarket — `frontend/src/components/panels/PolymarketPositions.tsx`

`positionMeta()` (l.64–125) a **5 returns**. Tous doivent inclure
`strategyId` (sinon TS + colonne vide selon le chemin) :

| Return | Ligne | `strategyId` |
|---|---|---|
| Match token + kind connu | 90 | `byToken.strategyId ?? null` (même si `orderType` est venu du store orders) |
| Match titre | 103 | `byTitle.strategyId ?? null` |
| Heuristique siblings avgPrice | 115–116 | `null` |
| Heuristique 0.50 | 123 | `null` |
| Aucun match | 125 | `null` |

**Ghost :** le `if (kind) return { kind, orderType }` l.90 oublié = le
chemin autoritatif (tokenId) n'affiche jamais le moteur.

Capturer `strategyId` dès le match `byToken` (l.75–78), à côté de `kind` /
`orderType`. Colonne **Moteur** dans le tableau (après Type, ~l.300).

`PolymarketPosition` (data-api) **n'a pas** et **n'aura pas** `strategyId` :
l'exchange ne connaît pas nos moteurs. Jointure locale uniquement.

### 14. Tests — stampers + round-trip DB

**À mettre à jour seulement si le type devient obligatoire.** Avec
`strategyId?`, les fixtures actuelles compilent.

**À ajouter :**

- `tests/tracker.test.ts` : insert position + `loadFromDb` conserve
  `strategyId: "barbell"`.
- `tests/tracker.test.ts` : insert sans `strategyId` → load `undefined`
  (lignes legacy).
- `tests/tracker.test.ts` : `recordPostedOrder` avec `strategyId: "edge-lead"`
  + nouveau `TradeTracker.loadFromDb` → `getPostedOrdersWithOrderId()`
  (ou lecture Map via getPostedOrdersForPair) expose `strategyId: "edge-lead"`.
  Sans ce test, le stamp GTC régresse au restart sans qu'on le voie.
- Optionnel : pas de nouveau test SimulatedBroker (fill synchrone, même
  objet `config` muté in-place par `applyRuntimeSettings`).

Fixtures `pos()` / `cheapLeg()` / `filledCheap()` / `addFill()` : **ne pas**
forcer `strategyId` (optionnel). Les tests de stratégie n'en ont pas besoin.

`tests/edge-lead.test.ts` `recordPostedOrder({...})` : le champ est optionnel
sur le contexte → les 2 appels (l.142, l.184) compilent sans changement.
Pas obligatoire de les toucher (ces tests vérifient `findOpportunities`,
pas le fill).

### 15. Guide — `frontend/src/guide/data.ts` (+ éventuellement `GuideTabs.tsx`)

Règle `.cursor/rules/strategy-guide-sync.mdc` : UI liée aux moteurs.

Ajouter un livrable `positions.strategyId persisté + colonne Moteur` (done
après implémentation). Une phrase dans l'onglet UI : les positions portent
le `strategyId` du moteur au moment du **POST** (GTC) / du **fill** (FOK/SIM),
pas le moteur courant après hot-swap.

Pas de changement de diagrammes SVG.

### 16. Scripts lecture SQL

`scripts/compare-positions.ts` (l.150–152), `scripts/diagnose-size.ts` (l.95),
`scripts/verify-audit.ts` (l.101) : SELECT nominaux, **pas de mapping TS
`SimulatedPosition`**. Hors périmètre sauf si on veut afficher le moteur
dans le rapport (non demandé).

### 17. Chemins qui n'ont **rien** à changer (vérifiés)

| Fichier | Pourquoi |
|---|---|
| `src/dashboard/server.ts` `/api/open-positions` `/api/resolved-positions` | Renvoie `tracker.getOpenPositions()` / `getResolvedPositions()` — le JSON inclut tout champ de `SimulatedPosition`. |
| `src/dashboard/events.ts` `openedPosition` | Payload = `SimulatedPosition`. Persistence JSON blob. |
| `frontend/src/stores/positionStore.ts` | Stocke l'objet entier. |
| `frontend/src/stores/dispatcher.ts` `openedPosition` | Passe `event.position` tel quel. |
| `frontend/src/api/client.ts` | `PositionsResponse { positions: SimulatedPosition[] }`. |
| `src/position-resolver.ts` | Mutate `status` / `pnl`, pas le shape. |
| `src/db/index.ts` | Pas de nouvelle table / repo. |
| `src/auto-redeemer.ts` | Travaille sur `PolymarketPosition` (data-api). |
| Table `orders` / `OrderRepository.markFilled` | Marque filled par `orderId` / tokenId, ignore le nouveau champ. |

---

## Insertion points (lignes actuelles, re-vérifier à l'implémentation)

| Fichier | Lignes | Action |
|---|---|---|
| `src/strategy/ids.ts` | après `parseStrategyId` | + `asStrategyId` |
| `src/types.ts` | 85–86 | + `strategyId?: StrategyId` |
| `src/db/database.ts` | 41 (`orderType TEXT`) | + `strategyId TEXT` dans CREATE positions |
| `src/db/database.ts` | 204–219 | `postedOrdersCols` + `addColumnIfMissing` positions |
| `src/db/repositories.ts` | 9–30, 43–64, 70–99 | PositionRow / toPosition / insert |
| `src/db/repositories.ts` | 369–415 | PostedOrderRow / insert |
| `src/trade-tracker.ts` | 25–37, 143–157, 360–401 | PostedOrderContext + persist/load |
| `src/bot.ts` | 582–600 | createLivePosition |
| `src/bot.ts` | 1240–1258 | FOK position |
| `src/bot.ts` | 1313–1331 | recordPostedOrder context |
| `src/simulated-broker.ts` | 108–126 | SIM position |
| `frontend/src/types/index.ts` | 64–85 | miroir |
| `frontend/src/components/panels/OpenPositions.tsx` | 108–127 | colonne |
| `frontend/src/components/panels/ResolvedPositions.tsx` | 18–42 | colonne |
| `frontend/src/components/panels/PolymarketPositions.tsx` | 64–125, 300–406 | meta + colonne |
| `tests/tracker.test.ts` | nouveau it | round-trip |
| `frontend/src/guide/data.ts` | livrables | 1 ligne |

---

## Edge cases (confirmés)

| Cas | Comportement |
|---|---|
| `PERSISTENCE_ENABLED=false` | `this.repos` undefined, insert no-op via `?.`. Le champ vit en mémoire + SSE. |
| DB existante sans colonne | `addColumnIfMissing` ALTER TABLE. Lignes old → `NULL`. |
| Posted order legacy (pas de strategyId) + fill GTC | Fallback `this.strategy.id` (moteur **courant**, pas historique). Documenté. |
| Dry-run | `execute*` return early si `this.broker` (l.1028–1030). Jamais `recordPostedOrder`. Fill synchrone via SimulatedBroker. |
| Hot-swap + dry-run | `applyRuntimeSettings` mute `config` in-place (même référence que `SimulatedBroker.config`). `this.config.strategyId` est à jour. |
| Hot-swap strategyId pendant qu'un GTC repose | Position fillée avec le `strategyId` stampé au POST. Correct. |
| Split defense `id:sold-…` | Hérite du `strategyId` parent via spread. |
| `INSERT OR REPLACE` (même id, resize) | Réécrit toute la row y compris `strategyId` (inchangé sur l'objet). |
| Valeur SQL inconnue / corrompue | `toPosition` ignore → `undefined`, le bot ne crash pas au load. |
| API failure mid-tick | Pas de position → pas de row. OK. |
| Volume writes | 1 TEXT nullable de plus par insert existant. Pas de write supplémentaire. |
| PK | `id TEXT PRIMARY KEY`, pas de UNIQUE sur ts. Inchangé. |

---

## Ordre d'implémentation

1. Types (`src/types.ts` + frontend miroir).
2. DB schema + migration + repository (positions + posted_orders).
3. Tracker context (PostedOrderContext).
4. Writers : bot createLivePosition / FOK / recordPostedOrder, SimulatedBroker.
5. UI trois panneaux + positionMeta.
6. Test round-trip tracker.
7. Guide livrable.
8. `npx tsc --noEmit` + `npm run build` dans `frontend/` + `node --test`.

## Vérification

- Backend : `npx tsc --noEmit`
- Tests : `npm test` (ou le script du `package.json`)
- Frontend : `npm run build` dans `frontend/`
- Manuel : ouvrir une position dry-run, vérifier colonne Moteur + row SQLite
  `SELECT id, kind, strategyId FROM positions ORDER BY createdAt DESC LIMIT 5`

---

## Audit du plan (check-plan)

### Assumptions vérifiées contre le code

- Table `positions` : `src/db/database.ts` l.22–43, `orderType TEXT` déjà
  nullable + `addColumnIfMissing("positions", "orderType", "TEXT")` l.219.
  Pattern de migration identique.
- `PositionRepository.insert` : 20 colonnes listées explicitement (pas
  `SELECT *` en write). Oublier `strategyId` dans l'INSERT = colonne toujours
  NULL. Le plan l'inclut.
- `SimulatedPosition` dupliqué backend (`src/types.ts` l.66) et frontend
  (`frontend/src/types/index.ts` l.64). Les deux doivent bouger.
- 3 writers de positions : `bot.ts` createLivePosition (GTC), FOK ~l.1240,
  `simulated-broker.ts` attemptFill. Pas d'autre `const position: SimulatedPosition`.
- `closePairCheapAsSold` spread : vérifié l.683.
- Hot-swap : `bot.ts` l.164–167 `if (changed.has("strategyId")) this.strategy = createStrategy(...)`.
- `PostedOrderContext` est le seul véhicule GTC fill → **doit** porter
  `strategyId`. Sinon ghost bug hot-swap.
- APIs dashboard : pas de DTO intermédiaire, JSON = objet tracker.
- `PolymarketPosition` vient de data-api : pas de strategyId natif ;
  jointure via `positionMeta` comme pour `orderType`.

### Corrections d'assumptions (re-audit /check-plan)

- Placeholder `positions.insert` : le plan disait 21 `?` → **20** (id …
  createdAt). Corrigé.
- `toPosition` : le plan mélangeait un cast `as StrategyId` et un filtre
  `STRATEGY_IDS`. Tranché : helper `asStrategyId` (pas de throw).
- `recordPostedOrder` / `loadFromDb` ne spreadent pas le contexte — copie
  champ par champ. Rendu explicite (sinon GTC restart perd le stamp).
- `positionMeta` a 5 returns ; le `return` l.90 sans `strategyId` est un
  ghost UI. Tous les chemins listés.
- Dry-run ne passe jamais par `posted_orders` (`this.broker` short-circuit
  l.1028). SIM = `config.strategyId` sur l'objet muté in-place. Confirmé.
- Test manquant : round-trip `posted_orders.strategyId` via `loadFromDb`.
  Ajouté (le stamp GTC est le cœur du ghost hot-swap).

### Complétude

- Producer → consumer : writers → repo insert → toPosition → tracker →
  API/SSE → stores → 3 panneaux. Tous listés.
- Migration ALTER pour DB existantes : oui.
- `reset()` : pas de nouvelle table, rien à ajouter.
- Interface `Repositories` / factory : pas de nouveau repo.
- Config / env : aucun nouveau champ.
- Prune : table `positions` n'est pas prunée par rétention snapshot (hors
  `Database.reset()` utilisateur). Pas de nouveau job.

### Ghost bugs évités

1. **Stamp au fill GTC avec le moteur courant** → faux après hot-swap.
   Fix : stamp au POST dans `PostedOrderContext`.
2. **Type `strategyId: StrategyId` required** → casse toutes les fixtures
   et le load des NULL. Fix : optionnel, comme `orderType`.
3. **`parseStrategyId` dans `toPosition`** → throw au restart. Fix : ignore.
4. **Oublier posted_orders** → GTC fill n'a pas le champ, fallback moteur
   courant (réintroduit le ghost 1). Le plan l'inclut comme **requis**.
5. **Oublier SimulatedBroker** → dry-run sans moteur (le mode le plus
   utilisé en dev). Inclus.
6. **Miroir frontend oublié** → TS frontend compile (excess property? non,
   le champ serait juste absent du type et l'UI ne pourrait pas le lire
   proprement). Inclus.

### Scope

Aucun goal ajouté au-delà de : persister + afficher `strategyId` sur une
position, avec stamp correct au POST pour les GTC.

Hors scope explicite (flag, pas silencieux) : table `orders`, stats par
moteur, backfill, filtre UI.
