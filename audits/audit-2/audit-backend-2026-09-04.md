# Audit backend — polymarket-reverse-arbitrage-bot v2.0.0 (audit-2)

**Date** : 2026-09-04
**Périmètre** : 21 fichiers TS (`src/`), 2 bases SQLite réelles (`data/bot.db`, `data/bot-live.db`), `.env` actif, consommation frontend (SolidJS), builds.
**Méthode** : lecture complète du code source, requêtes SQL sur les deux bases, appel API Gamma/Data-API réel, recherche d'usages (grep), `npm run build` ✅ vert.
**Note** : le bot tourne en live au moment de l'audit (port 3105) — les compteurs SQL ont pu évoluer entre les relevés.

---

## 1. Verdict sur la séparation simulé/live

**La séparation est globalement bien conçue, mais il existe 3 fuites de mélange réelles, dont une déjà matérialisée dans la DB (395 lignes `source:"live"` dans la base de simulation).**

### Ce qui est bien séparé (vérifié)

| Mécanisme | Preuve |
|---|---|
| Deux bases SQLite distinctes | `config.ts:134-136` — `DB_PATH` (dry) vs `DB_PATH_LIVE` (live) |
| Ledger/broker simulés **jamais instanciés en live** | `bot.ts:41-44` — `this.ledger = config.dryRun ? new SimulatedLedger(...) : null` |
| `Trader.placeBuy` stub en dryRun, ne touche pas au CLOB | `trader.ts:34-42` |
| Résolution crédite le ledger simulé seulement s'il existe | `position-resolver.ts:76-78` |
| **DB live propre** : 0 ligne ledger, 0 event `simulatedBalance`, 0 ordre `dryRun:true`, 13 positions toutes `fillReason:"marketable"` | vérifié SQL sur `bot-live.db` |
| DB dry-run : positions simulées avec `probabilistic`/`marketable` | vérifié SQL sur `bot.db` |

### 🔴 Fuite 1 — Snapshots `source:"live"` dans la DB dry-run (mélange avéré)

**395 lignes `source:"live"` dans `data/bot.db`** (la base de simulation), à côté de 2367 lignes `source:"simulated"`.

Cause : le fix 2.3 du plan de remédiation précédent (`audits/plan-remediation-2026-09-04.md`) a changé la condition de démarrage du `BalanceTracker` de `!config.dryRun` vers `config.funderAddress` (`index.ts:28`), et `balance.ts:34` écrit `source: "live"` **inconditionnellement**. La « zone d'ombre » documentée dans le plan est maintenant matérialisée dans les données : le tracker de balance on-chain (pUSD réel + positions Polymarket du wallet) écrit ses snapshots dans la base de simulation.

### 🟠 Fuite 2 — `simulatedStats` émis en mode live

**6442 events `simulatedStats` dans `bot-live.db`.**

`resolveAndEmitStats` (`bot.ts:85-102`) tourne aussi en live (le resolver est instancié avec `ledger: null`, `bot.ts:45`). Le panneau Performance du frontend affiche donc des stats live sous un type d'event nommé « simulated ». Les chiffres sont réels (le tracker contient les positions live), mais le nommage est trompeur et le frontend ne distingue pas.

### 🟠 Fuite 3 — Reset en live écrit le ledger simulé dans la DB live (risque latent)

`bot.reset()` (`bot.ts:54-62`) exécute `repos.ledger.setBalance(this.config.simulatedCapital)` **même en live**. Un clic sur « Réinitialiser la DB » (bouton affiché en live, `Header.tsx:53-62`) :
- efface **tout l'historique de trading réel** (`database.ts:160-174` — DELETE sur toutes les tables),
- crée une ligne `ledger` avec le capital simulé (50 USDC) dans la DB live.

Le message du modal (« Le capital simulé revient à sa valeur initiale ») est incohérent en mode live.
**Non matérialisé** : la DB live a 0 ligne ledger (le reset n'a pas été déclenché en live) — danger latent, pas fuite avérée.

### 🟠 Risque connexe — Résolution probabiliste en live

Le `.env` actif est **en live réel** (`DRY_RUN=false`, `READONLY_LIVE=false`) avec **`SIM_RESOLVE_FALLBACK=probabilistic`** — exactement ce que `.env.example:62-64` déconseille en live. Si l'API Gamma échoue après 5 retries, une position réelle est résolue **au tirage aléatoire** (`position-resolver.ts:128-138`).

Les logs de fallback ne sont pas persistés (`events.ts:58-66` exclut `log`), donc **aucune preuve** d'utilisation réelle — c'est un risque de configuration, pas un fait avéré. La DB live montre 13 positions réelles résolues (2 won / 11 lost).

---

## 2. Garde-fous CLOB manquants — le bot spamme des ordres rejetés

La DB live contient **4031 events d'erreur** (relevé : 3428 au premier passage, 4031 au second — le bot tourne) :

| Erreur | Volume | Cause racine |
|---|---|---|
| `not enough balance / allowance` | **3172** (+ 45 variante) | `getAvailableCollateral` existe (`trader.ts:26-31`) mais n'est **jamais vérifié** avant `placeBuy`. Le bot retente 20× par niveau sans regarder le solde. |
| `invalid tick size (0.001), minimum for the market is 0.01` | **345** | `tickSizeFromMarket` (`utils/market.ts:14-19`) retourne `"0.001"` quand `tick < 0.01`, mais le CLOB rejette. L'API Gamma renvoie bien `orderPriceMinTickSize: 0.001` pour certains marchés (sol/hype/bnb) — le CLOB exige 0.01. |
| `Size (3.52) lower than the minimum: 5` | **90** | `computeSize` (`utils/prices.ts:9-13`) plancher à 1 share, mais le CLOB exige ≥ 5. Avec `EXPENSIVE_ORDER_USDC=3` et prix 0.85 → 3.52 shares → rejet. |
| `invalid amount for a marketable BUY order ($0.9996), min size: $1` | **20** | même famille : coût < $1. |
| `fetch failed` / `getaddrinfo ENOTFOUND clob.polymarket.com` | **351** | pannes réseau CLOB (52 erreurs de balance en plus). |
| divers (ECONNRESET, terminated) | 3 | résidu. |

**Correctifs proposés** : (1) vérifier le solde disponible avant de poster (ou stopper après N rejets « balance » consécutifs) ; (2) `computeSize` avec plancher `max(5, ...)` et coût ≥ $1 ; (3) `tickSizeFromMarket` ne jamais retourner `"0.001"` pour ces marchés.

---

## 3. Croissance illimitée des tables

| Table | Lignes (bot-live.db) | Rythme | Prune ? |
|---|---|---|---|
| `events` | 13 910 | ~1/s en live | ❌ jamais |
| `balance_snapshots` | 1 050 | 1/30s = 2 880/jour | ❌ jamais |
| `trade_keys` | 143 | croît à chaque ordre | ❌ jamais |
| `retry_counts` | — | croît à chaque retry | ❌ jamais |

Seuls `posted_orders` et `window_claims` sont prunés (`trade-tracker.ts:307-327`). Il faut un prune périodique (ex. events > 7 jours, snapshots > 30 jours, keys/retries > 24 h).

---

## 4. Chargement complet de `positions` au démarrage

Le fix 3.2 du plan précédent a limité la **rétention** mémoire à 500 résolues (`MAX_RESOLVED_IN_MEMORY`, `trade-tracker.ts:43`), mais `loadFromDb` (`trade-tracker.ts:69`) appelle toujours `positionsRepo.all()` — **toute** la table est chargée en SQL pour reconstruire les paires (`repositories.ts:106-110`, `SELECT * FROM positions` sans LIMIT). C'est le pattern « slice-after-load » : la RAM est bornée, pas le chargement. Sur une DB qui grossit, le démarrage ralentit. Correctif : `SELECT ... WHERE status='open'` + reconstruction des paires par requête ciblée.

---

## 5. Endpoint mort et divers

- **`/api/history` mort côté serveur** (`server.ts:215-232`) — le frontend ne l'appelle plus (0 occurrence de `history` dans `frontend/src`, `api.history` supprimé au fix 3.3). `EventRepository.recent` et `BalanceSnapshotRepository.recent` ne servent qu'à lui. À supprimer ou à réactiver.
- **`readonlyLive` exige quand même `PRIVATE_KEY`** (`config.ts:178-187`) — en lecture seule on ne trade pas, mais la clé est requise et le client CLOB authentifié est créé (`trader.ts:21-24`).
- **`readBody` sans limite de taille** (`server.ts:302-309`) — un POST `/api/redeem` avec un gros body gonfle la mémoire.
- **Logs non persistés** — impossible d'auditer a posteriori les fallbacks de résolution, les rejets, les retries. Persister au moins les `error`/`log` critiques (les `error` le sont déjà, `events.ts:58-66`).
- **Divergences config réelle vs docs** :
  - `EXPENSIVE_BUY_MIN=0.85` dans `.env` vs **0.90** documenté (`.env.example:14`, README) — le bot achète des hedges à 0.85, marge d'arb plus fine.
  - `SIGNATURE_TYPE=3` (deposit wallet) dans `.env` vs **2** documenté (`.env.example:71`) — cohérent avec le relayer V2 mais non documenté.
  - Par ailleurs : `CHEAP_ORDER_USDC=1` (vs 10), `EXPENSIVE_ORDER_USDC=3` (vs 50), `MAX_SHARES_PER_ORDER=20` (vs 90), `SIMULATED_CAPITAL=50` (vs 500), `MAX_EXPOSURE_USDC=45` (vs 500) — petits paramètres cohérents entre eux mais très loin des defaults documentés.

---

## 6. Vérification point par point (seconde passe)

Chaque point de l'audit a été re-vérifié contre le code et les données. **1 point sur 15 est faux.**

| # | Point | Verdict | Preuve |
|---|---|---|---|
| Fuite 1 | Snapshots `source:"live"` dans la DB dry-run | ✅ VRAI (amplifié) | `data/bot.db` : 395 lignes `live` + 2367 `simulated`. Cause : `index.ts:28` + `balance.ts:34` |
| Fuite 2 | `simulatedStats` émis en live | ✅ VRAI (amplifié) | `bot-live.db` : 6442 events. `bot.ts:81` + `bot.ts:85-102` |
| Fuite 3 | Reset en live écrit le ledger simulé | ✅ VRAI (latent) | `bot.ts:54-62` sans condition `dryRun`. Non matérialisé : 0 ligne ledger en live |
| Risque | `SIM_RESOLVE_FALLBACK=probabilistic` en live | ✅ VRAI (config) | `.env` : `DRY_RUN=false` + `SIM_RESOLVE_FALLBACK=probabilistic`. Utilisation non prouvable |
| A | Garde-fous CLOB manquants | ✅ VRAI (amplifié) | 3172 « balance », 345 « tick size », 90 « size < 5 », 20 « < $1 ». `getAvailableCollateral` non utilisé avant `placeBuy` |
| B | Croissance illimitée | ✅ VRAI | seuls `posted_orders`/`window_claims` prunés |
| C | Chargement complet au démarrage | ✅ VRAI | `trade-tracker.ts:69` + `repositories.ts:106-110` sans LIMIT |
| D | Stats arb/directional tronquées après restart | ❌ **FAUX** | voir détail ci-dessous |
| E | `/api/history` mort | ✅ VRAI | 0 usage frontend, endpoint serveur présent |
| F1 | `readonlyLive` exige `PRIVATE_KEY` | ✅ VRAI | `config.ts:178-187`, `trader.ts:21-24` |
| F2 | `readBody` sans limite | ✅ VRAI | `server.ts:302-309` |
| F3 | Logs non persistés | ✅ VRAI | `PERSISTED_EVENT_TYPES` exclut `log` (`events.ts:58-66`) |
| F4 | `EXPENSIVE_BUY_MIN` 0.85 vs 0.90 doc | ✅ VRAI | `.env` vs `.env.example:14`/README |
| F5 | `SIGNATURE_TYPE` 3 vs 2 doc | ✅ VRAI | `.env` vs `.env.example:71` |

### Point D infirmé — stats arb/directional complètes après redémarrage

L'audit affirmait que `arbRealizedPnl`/`directionalRealizedPnl` (`trade-tracker.ts:403-415`) ne sommaient que les paires résolues en mémoire (max 500), donc tronquées après redémarrage.

**Incorrect.** `loadFromDb` (`trade-tracker.ts:82-91`) charge **toutes** les paires sans limite :

```
const pairs = this.pairsRepo.all();          // SELECT * FROM arb_pairs, sans LIMIT
for (const pair of pairs) {
  pair.cheapLegs = allPositions.filter(...); // legs rattachés depuis TOUTES les positions
  ...
}
```

`getResolvedPairs()` contient donc toutes les paires résolues avec leurs legs complets, et les deux getters sont **complets** après redémarrage. `MAX_RESOLVED_IN_MEMORY` (500) ne borne que la liste `resolvedPositions` (panneau « Positions résolues » du dashboard), pas les paires. Le point C reste vrai (performance), mais l'incohérence de stats n'existe pas. **À retirer du plan d'action.**

---

## 7. Actions prioritaires (ordre recommandé)

| # | Action | Sévérité | Statut |
|---|---|---|---|
| 1 | `.env` : `SIM_RESOLVE_FALLBACK=none` (bot en live) | 🔴 argent réel | à faire |
| 2 | Vérifier le solde avant `placeBuy` + stopper après rejets « balance » | 🔴 spam 3200+ erreurs | à faire |
| 3 | `computeSize` plancher ≥ 5 shares / ≥ $1 ; `tickSizeFromMarket` jamais `"0.001"` | 🟠 rejets systématiques | à faire |
| 4 | `balance.ts:34` : `source` = mode réel ; purger les 395 lignes polluées | 🟠 mélange avéré | à faire |
| 5 | Reset : désactiver en live + ne pas écrire le ledger simulé | 🟠 perte d'historique réel | à faire |
| 6 | `simulatedStats` → `stats` (ou conditionné) en live | 🟠 nommage trompeur | à faire |
| 7 | Prune des tables `events`/`balance_snapshots`/`trade_keys`/`retry_counts` | 🟡 croissance | à faire |
| 8 | `loadFromDb` : requêtes ciblées au lieu de `all()` | 🟡 démarrage | à faire |
| ~~9~~ | ~~Stats arb/directional via SQL~~ | — | **annulé (point D faux)** |
| 9 | README : aligner 0.85/1/3/20/50/45 + `SIGNATURE_TYPE=3` | 🟡 doc drift | à faire |
| 10 | Déclarer/retirer endpoint mort `/api/history` | 🟡 code mort | à faire |

## 8. Scores et conclusion

**Séparation sim/live : 7/10** — architecture saine (2 bases, ledger jamais instancié en live, DB live propre), mais 3 fuites dont une déjà dans les données.
**Logique : 7/10** — garde-fous CLOB incomplets (soldes, tick size, tailles minimales), fallback probabiliste autorisé en live.
**Propreté : 7/10** — tables sans prune, endpoint mort, divergences `.env`/docs.

Le cœur du trading (gestion des ordres GTC, idempotence, résolution via outcomePrices) est sain et bien commenté. Les problèmes sont concentrés sur : (1) l'absence de garde-fous CLOB côté exécution, (2) le nommage/source des données croisées sim/live, (3) la croissance des tables et le chargement complet au boot. Le fix 1 (fallback probabiliste en live) est le plus urgent — il touche de l'argent réel.
