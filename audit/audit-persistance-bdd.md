# Audit de Persistance BDD — Polymarket Reverse Arbitrage Bot

**Date** : 2026-09-06
**Portée** : Codebase complète (`src/` backend + `frontend/src/` dashboard)
**Objectif** : Identifier les données non persistées en base SQLite qui devraient l'être, en partant de la question utilisateur : *"Les ordres listés dans "Ordres récents" ne sont-ils pas persistés en BDD ?"*

---

## 1. Réponse directe : les "Ordres récents" sont-ils persistés ?

**Non.** Le panel "Ordres récents" (`RecentOrders.tsx`) affiche des données **purement éphémères, en mémoire frontend uniquement**.

### Flux de données

```
bot.ts: executeOpportunity()
  │
  ├─ bus.emit({ type: "order", result, opportunity })   ← event SSE
  │
  ▼
dashboard/server.ts: handleEvents() → SSE /events
  │
  ▼
frontend: useEventSource.ts → onEvent()
  │
  ▼
dispatcher.ts: case "order" → addOrder({ ... })
  │
  ▼
orderStore.ts: createStore<OrderView[]>([])   ← MAX 100, en mémoire SolidJS
  │
  ▼
RecentOrders.tsx: <For each={orders}>         ← affichage
```

**Aucune écriture BDD n'est effectuée pour les ordres au moment du `addOrder()`.**

### Ce qui existe en BDD mais ne correspond PAS à "Ordres récents"

| Table BDD       | Ce qu'elle stocke                                          | Rapport avec "Ordres récents"                     |
|-----------------|-----------------------------------------------------------|---------------------------------------------------|
| `posted_orders` | Ordres GTC **resting** sur le carnet (en attente de fill) | Partiel — seulement les GTC live, pas les FOK/sim |
| `positions`     | Positions **ouvertes ou résolues** (après fill)           | Différent — c'est le résultat d'un ordre rempli   |
| `events`        | Journal d'événements brut (JSON sérialisé, ring buffer)   | Contient les events `order` mais non queryable    |

### Conséquences

1. **Au refresh du navigateur** : les ordres récents disparaissent (le store SolidJS est reset). Seuls les `posted_orders` GTC resting sont rechargés via `/api/state` → `bus.replay()`, mais le replay SSE renvoie l'historique d'events (ring buffer 500), pas une reconstruction de l'`orderStore`.

2. **Au restart du bot** (crash, `tsx watch`) : le ring buffer d'events est perdu. Les ordres FOK remplis et les ordres sim remplis n'ont **aucune trace** en BDD — seules les positions qu'ils ont créées subsistent dans `positions`.

3. **Ordres rejetés** (reason: `insufficient-balance`, `too-close-to-close`, `readonly-live`, `not-a-favorite`, `killed-fok`, `no-fill`) : **totalement perdus** au restart. Aucune trace nulle part.

---

## 2. Tables BDD existantes (schéma actuel)

Source : `src/db/database.ts`

| Table               | Rôle                                          | Persistance |
|---------------------|-----------------------------------------------|-------------|
| `positions`         | Positions ouvertes + résolues (jambes d'arb)  | ✅ Complète  |
| `arb_pairs`         | Paires d'arbitrage (cheap + expensive legs)   | ✅ Complète  |
| `ledger`            | Solde du ledger simulé (1 ligne, singleton)   | ✅ Complète  |
| `balance_snapshots` | Snapshots périodiques de balance (live/sim)   | ✅ Complète  |
| `events`            | Journal d'événements (JSON sérialisé brut)    | ⚠️ Voir §3.4 |
| `trade_keys`        | Déduplication des trade keys (déjà tentés)    | ✅ Complète  |
| `retry_counts`      | Compteur de retries par trade key             | ✅ Complète  |
| `posted_orders`     | Ordres GTC resting sur le carnet              | ⚠️ Voir §3.1 |
| `window_claims`     | Claim d'outcomes par paire (anti-doublon)     | ✅ Complète  |
| `bot_state`         | État global du bot (key-value, ex: totalAttempts) | ✅ Complète  |

---

## 3. Données non persistées qui devraient l'être

### 3.1. 🔴 CRITIQUE — Historique complet des ordres (table `orders` inexistante)

**Problème** : Aucune table dédiée aux ordres. Le panel "Ordres récents" est alimenté par un store SolidJS en mémoire (`orderStore.ts`, max 100 entrées).

**Données perdues au restart/refresh** :

| Type d'ordre                     | Persisté en BDD ? | Trace après restart ? |
|----------------------------------|-------------------|----------------------|
| Ordre GTC live → resting         | ✅ `posted_orders` | ✅ Rechargé          |
| Ordre GTC live → rempli          | ✅ `positions`     | ✅ Rechargé          |
| Ordre GTC live → annulé (stale)  | ❌ Non             | ❌ Perdu             |
| Ordre FOK live → rempli          | ✅ `positions`     | ✅ Rechargé          |
| Ordre FOK live → killed          | ❌ Non             | ❌ Perdu             |
| Ordre sim → rempli               | ✅ `positions`     | ✅ Rechargé          |
| Ordre sim → rejeté               | ❌ Non             | ❌ Perdu             |
| Ordre rejeté (garde-fou)         | ❌ Non             | ❌ Perdu             |
| Ordre échoué (exception réseau) | ❌ Non             | ❌ Perdu             |

**Impact** :
- Impossible d'auditer rétrospectivement pourquoi un ordre a été rejeté
- Les statistiques de fill rate (`fillRate = totalFilled / totalAttempted`) reposent sur `bot_state.totalAttempts` (un simple compteur), pas sur un historique queryable
- Le dashboard perd tout son historique d'ordres au moindre refresh

**Recommandation** : Créer une table `orders` avec :

```sql
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tradeKey TEXT NOT NULL,
  eventSlug TEXT NOT NULL,
  eventTitle TEXT NOT NULL,
  tokenId TEXT NOT NULL,
  outcome TEXT NOT NULL,
  outcomeIndex INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- 'cheap' | 'expensive'
  orderType TEXT NOT NULL,         -- 'GTC' | 'FOK' | 'SIM'
  side TEXT NOT NULL DEFAULT 'BUY',
  limitPrice REAL NOT NULL,
  fillPrice REAL,
  size REAL NOT NULL,
  cost REAL,
  filled INTEGER NOT NULL,         -- 0 = non rempli, 1 = rempli
  reason TEXT,                     -- 'marketable' | 'killed-fok' | 'insufficient-balance' | etc.
  dryRun INTEGER NOT NULL,         -- 0 = live, 1 = sim
  orderId TEXT,                    -- Polymarket orderID (GTC/FOK live)
  pairId TEXT,
  windowEnd INTEGER NOT NULL
);
```

**Lieu d'insertion** : `bot.ts:executeOpportunity()` — après chaque `bus.emit({ type: "order", ... })`, insérer une ligne dans `orders`. Cela capture tous les chemins (FOK, GTC, sim, rejets).

---

### 3.2. 🟠 ÉLEVÉ — Transactions de redeem (auto et manuel)

**Problème** : Les redeems de positions gagnantes ne sont **pas persistés en BDD**.

**Flux actuel** :

```
AutoRedeemer.processPositions()
  └─ trader.redeemPosition() → redeemViaRelayer() → txHash
     └─ bus.emit({ type: "resolution", message: "Auto-redeemed..." })
        └─ EventRepository.insert() → table events (JSON brut, non queryable)
```

```
Dashboard manuel: POST /api/redeem
  └─ trader.redeemPosition() → txHash
     └─ réponse HTTP → frontend logStore.addLog()
```

**Données perdues** :
- `conditionId` redeemé
- `txHash` de la transaction on-chain
- Timestamp du redeem
- Montant récupéré (pUSD)
- Origine (auto vs manuel)
- Succès/échec

**Impact** :
- Impossible de savoir quelles positions ont été redeemées sans requêter la data API Polymarket
- Le `Set<string> redeemed` dans `AutoRedeemer` est en mémoire → au restart, un redeem déjà soumis peut être re-soumis (le relayer le rejettera, mais c'est un appel réseau inutile)
- Pas d'audit trail fiscal/comptable

**Recommandation** : Créer une table `redeems` :

```sql
CREATE TABLE IF NOT EXISTS redeems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  conditionId TEXT NOT NULL,
  outcomeIndex INTEGER NOT NULL,
  negRisk INTEGER NOT NULL,
  title TEXT,
  outcome TEXT,
  size REAL,
  txHash TEXT,
  source TEXT NOT NULL,            -- 'auto' | 'manual'
  success INTEGER NOT NULL,        -- 0 = échec, 1 = succès
  errorMessage TEXT
);
```

**Lieu d'insertion** :
- `auto-redeemer.ts:processPositions()` — après `trader.redeemPosition()` (succès ET échec)
- `dashboard/server.ts:handleRedeem()` — après `trader.redeemPosition()` (succès ET échec)

---

### 3.3. 🟠 ÉLEVÉ — État de déduplication du AutoRedeemer

**Problème** : `AutoRedeemer.redeemed: Set<string>` est en mémoire uniquement.

**Impact** : Au restart du bot, le Set est vide. Si la data API Polymarket n'a pas encore mis à jour le statut de la position (délai d'indexation on-chain), le bot tente de re-redeem la même position.

**Recommandation** : La table `redeems` (§3.2) résout ce problème — au démarrage, `AutoRedeemer` charge les `conditionId:outcomeIndex` déjà redeemés avec `success=1` depuis les dernières 24h.

---

### 3.4. 🟡 MOYEN — Table `events` : blobs JSON non queryable

**Problème** : La table `events` stocke les événements comme `(ts, type, payload TEXT)` où `payload` est `JSON.stringify(event)`. C'est un journal append-only non queryable par champ.

**Events persistés** (PERSISTED_EVENT_TYPES dans `events.ts:60`) :
- `openedPosition`, `resolvedPosition`, `order`, `simulatedStats`, `stats`, `resolution`, `balance`, `simulatedBalance`, `error`

**Events non persistés** (volontairement exclus) :
- `config`, `scan`, `watching`, `opportunity`, `log`, `polymarketPositions`

**Impact** :
- Les events `order` sont dans `events` mais sous forme de blob JSON — impossible de faire `SELECT WHERE reason = 'killed-fok'` sans parser le JSON en SQLite (`json_extract`)
- Les events `opportunity` (découverte d'opportunité) ne sont pas persistés du tout

**Recommandation** : La table `orders` (§3.1) rend les events `order` queryable. Garder `events` comme journal brut pour debugging, mais ne pas s'appuyer dessus pour des requêtes métier. Envisager d'ajouter des colonnes indexées (`type`, `eventSlug`) à la table `events` si des requêtes ad-hoc sont nécessaires.

---

### 3.5. 🟡 MOYEN — `polymarketPositions` non persistées

**Problème** : Les positions Polymarket réelles (récupérées via la data API toutes les 30s par `BalanceTracker`) ne sont pas stockées en BDD. Elles alimentent le panel "Positions Polymarket" du dashboard via SSE, en mémoire frontend uniquement.

**Données** : `title, slug, outcome, size, avgPrice, currentValue, cashPnl, curPrice, redeemable, conditionId, negRisk`

**Impact** :
- Pas d'historique de l'évolution des positions réelles (prix courant, PnL non réalisé)
- Impossible de reconstruire l'historique après restart

**Recommandation** : Faible priorité. Ces données sont disponibles via la data API Polymarket à la demande. Une persistance serait utile uniquement pour des analytics temporels (évolution du PnL non réalisé). Si désiré, créer une table `poly_positions_snapshot` avec timestamp.

---

### 3.6. 🟡 MOYEN — Marchés actifs scannés (`watching` events)

**Problème** : Les marchés scannés à chaque tick (`bus.emit({ type: "watching", event, books })`) ne sont pas persistés.

**Données** : `UpDownEvent` (title, slug, windowStart, windowEnd) + `TokenBook[]` (bestBid, bestAsk, bestAskSize)

**Impact** :
- Pas d'historique des carnet d'ordres observés
- Impossible de rejouer une stratégie a posteriori ("qu'aurait-on dû faire sur ce marché ?")

**Recommandation** : Faible priorité pour le fonctionnement du bot. Utile pour backtesting/analyse. Si désiré, créer une table `market_snapshots` avec `(ts, eventSlug, tokenId, bestBid, bestAsk, bestAskSize)`.

---

### 3.7. 🟢 FAIBLE — Logs applicatifs (`log` events)

**Problème** : Les logs émis via `log()` (logger.ts) sont diffusés via `bus.emit({ type: "log", ... })` mais ne sont pas persistés en BDD (exclus de `PERSISTED_EVENT_TYPES`).

**Impact** : Les logs ne survivent qu'en mémoire frontend (`logStore.ts`, max 500). Au restart, tout l'historique de log est perdu.

**Recommandation** : Si une persistance des logs est désirée pour debug post-mortem, envisager d'écrire dans un fichier de log (ex: `data/bot.log`) via un transport fichier, plutôt qu'en BDD (volume élevé, requêtes rares). C'est le pattern standard — la BDD est pour les données métier queryable, pas pour les logs.

---

### 3.8. 🟢 FAIBLE — `totalAttempts` : compteur sans détail

**Problème** : `bot_state.totalAttempts` est un simple compteur incrémenté à chaque tentative d'ordre. Il ne capture pas quel ordre, sur quel marché, à quel prix, avec quel résultat.

**Impact** : Le `fillRate` calculé (`totalFilled / totalAttempted`) est correct agrégé, mais impossible de décomposer par marché, par kind, par reason d'échec.

**Recommandation** : La table `orders` (§3.1) remplace ce compteur par des données queryable. `totalAttempts` peut être conservé comme cache ou dérivé via `SELECT COUNT(*) FROM orders`.

---

## 4. Résumé — Matrice de persistance

| Donnée                    | En BDD ? | En mémoire backend ? | En mémoire frontend ? | Recommandation       |
|---------------------------|----------|----------------------|-----------------------|----------------------|
| Positions ouvertes        | ✅       | ✅ (tracker)         | ✅ (positionStore)    | OK                   |
| Positions résolues        | ✅       | ✅ (tracker, 500 max)| ✅ (positionStore, 100 max) | OK          |
| Paires d'arb              | ✅       | ✅ (tracker)         | —                     | OK                   |
| Ordres GTC resting        | ✅       | ✅ (tracker)         | ✅ (orderStore)       | OK                   |
| **Ordres (tous types)**   | **❌**   | ❌                   | ✅ (orderStore, 100)  | **CRÉER table orders** |
| **Redeems**               | **❌**   | ✅ (AutoRedeemer Set)| ✅ (polyStore)        | **CRÉER table redeems** |
| Balance snapshots         | ✅       | —                    | ✅ (signal)           | OK                   |
| Events (brut)             | ⚠️ blob  | ✅ (ring buffer 500) | ✅ (via SSE)          | Garder + table orders|
| Trade keys (dédup)        | ✅       | ✅ (tracker)         | —                     | OK                   |
| Retry counts              | ✅       | ✅ (tracker)         | —                     | OK                   |
| Window claims             | ✅       | ✅ (tracker)         | —                     | OK                   |
| totalAttempts             | ✅ (k-v) | ✅ (compteur)        | —                     | Dériver de orders    |
| Poly positions (réelles)  | ❌       | —                    | ✅ (polyStore)        | Faible prio          |
| Marchés scannés + books   | ❌       | —                    | ✅ (marketStore)      | Faible prio          |
| Logs applicatifs          | ❌       | —                    | ✅ (logStore, 500)    | Fichier log          |
| Opportunités détectées    | ❌       | —                    | ✅ (marketStore)      | Faible prio          |

---

## 5. Priorité d'action

| # | Priorité | Action                                         | Effort | Fichiers touchés                    |
|---|----------|------------------------------------------------|--------|-------------------------------------|
| 1 | 🔴 CRITIQUE | Créer table `orders` + repository + insertion dans bot.ts | ~2h | database.ts, repositories.ts, bot.ts, index.ts (new repo) |
| 2 | 🟠 ÉLEVÉ    | Créer table `redeems` + repository + insertion dans auto-redeemer.ts et server.ts | ~1h | database.ts, repositories.ts, auto-redeemer.ts, server.ts |
| 3 | 🟠 ÉLEVÉ    | AutoRedeemer : charger `redeems` au démarrage pour la dédup | ~30min | auto-redeemer.ts |
| 4 | 🟡 MOYEN    | Ajouter colonnes indexées à `events` (type, eventSlug) pour requêtes ad-hoc | ~30min | database.ts |
| 5 | 🟡 MOYEN    | Persister poly_positions snapshots (optionnel, analytics) | ~1h | database.ts, repositories.ts, balance.ts |
| 6 | 🟡 MOYEN    | Persister market_snapshots (optionnel, backtest) | ~1h | database.ts, repositories.ts, bot.ts |
| 7 | 🟢 FAIBLE   | Logger vers fichier (transport fichier) | ~30min | logger.ts |
| 8 | 🟢 FAIBLE   | Dériver totalAttempts de `orders` (après création table) | ~15min | bot.ts, computeStats() |

---

## 6. Architecture cible (proposée)

```
┌─────────────────────────────────────────────────────┐
│ bot.ts: executeOpportunity()                        │
│   ├─ bus.emit({ type: "order", ... })    ← SSE live │
│   └─ ordersRepo.insert({ ... })          ← BDD NEW  │
├─────────────────────────────────────────────────────┤
│ auto-redeemer.ts: processPositions()                │
│   ├─ trader.redeemPosition()                        │
│   ├─ bus.emit({ type: "resolution", ... })          │
│   └─ redeemsRepo.insert({ ... })        ← BDD NEW  │
├─────────────────────────────────────────────────────┤
│ server.ts: handleRedeem()                           │
│   ├─ trader.redeemPosition()                        │
│   └─ redeemsRepo.insert({ ... })        ← BDD NEW  │
├─────────────────────────────────────────────────────┤
│ Dashboard au refresh:                               │
│   GET /api/orders → ordersRepo.recent(100)  ← NEW  │
│   →重建 orderStore au lieu de perdre l'historique   │
└─────────────────────────────────────────────────────┘
```

### Endpoint API à ajouter

```
GET /api/orders → { orders: OrderRow[] }   ← pour reconstruction au refresh
```

Le `orderStore.ts` se peuplerait alors via cet endpoint au montage du frontend (`App.tsx:loadInitialState()`), comme `positionStore` le fait déjà avec `/api/open-positions` et `/api/resolved-positions`.

---

## 7. Note sur le `posted_orders` existant

La table `posted_orders` **ne doit pas être confondue** avec une table d'ordres. Elle sert uniquement à tracker les ordres GTC **resting** sur le carnet pour :
- Le polling de fill (`pollOrderFills()`)
- L'annulation des ordres stale (`cancelStaleOrders()`)
- Le calcul d'exposition resting (`getRestingExposure()`)

Une fois l'ordre rempli ou annulé, il est **supprimé** de `posted_orders` (`removePostedOrder()`). La table `orders` proposée est un **journal append-only** qui conserve l'historique complet, indépendamment du cycle de vie de l'ordre sur le carnet.