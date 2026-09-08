# Plan de remédiation — audit-2 (patch.md)

> Plan détaillé pour corriger chaque point de `audits/audit-2/audit-backend-2026-09-04.md`.
> Chaque fix : problème, fichier(s), changement exact (diff), vérification.
> Ordre d'application = ordre des phases (dépendances respectées).
>
> ⚠️ Le bot tourne actuellement en **live** (port 3105). Les fixes backend nécessitent un **redémarrage**. Le fix F1 (`.env`) touche la config d'argent réel — **à appliquer explicitement par l'utilisateur**.

---

## Statut d'implémentation

| # | Fix | Statut | Vérification |
|---|---|---|---|
| F1 | `.env` : `SIM_RESOLVE_FALLBACK=none` (live) | ⬜ **à faire (manu, utilisateur)** | `.env` non modifié — action volontaire requise |
| F2 | Garde-fous CLOB : solde avant `placeBuy` + backoff | ✅ Implémenté | `bot.ts` : cache 30s + backoff 60s ; build ✅ ; runtime live sain |
| F3 | `computeSize` plancher ≥ 5 shares / ≥ $1 ; `tickSizeFromMarket` ≥ 0.01 | ✅ Implémenté | `prices.ts` + `market.ts` ; build ✅ |
| F4 | `balance.ts` : `source` = mode réel + purge des lignes polluées | ✅ Implémenté | 565 lignes `live` purgées de `data/bot.db` ; plus que `simulated` |
| F5 | Reset : plus d'écriture ledger simulé en live + 403 + bouton masqué | ✅ Implémenté | `POST /api/reset` en live → 403 « Reset désactivé en mode live » (testé) |
| F6 | `simulatedStats` → `stats` en live (+ frontend) | ✅ Implémenté | 7 events `stats` dans `bot-live.db` après redémarrage ; frontend dispatcher mis à jour |
| F7 | Prune `events` / `balance_snapshots` / `trade_keys` / `retry_counts` | ✅ Implémenté | colonne `updatedAt` ajoutée à `retry_counts` (vérifié PRAGMA) ; prune horaire dans `bot.ts` |
| F8+F9 | `loadFromDb` requêtes ciblées + suppression `/api/history` et code mort | ✅ Implémenté | `GET /api/history` → 404 (testé) ; `all()`/`recent()` supprimés |
| F10 | `readBody` avec limite de taille | ✅ Implémenté | body > 64 Ko → connexion fermée (testé : fetch failed) |
| F11 | `readonlyLive` sans `PRIVATE_KEY` | ✅ Implémenté | `config.ts` + `trader.ts` ; build ✅ |
| F12 | Persistance des décisions de résolution (event `resolution`) | ✅ Implémenté | `position-resolver.ts` + `events.ts` + frontend ; build ✅ |
| F13 | Alignement docs (README + .env.example) | ✅ Implémenté | valeurs 0.85/1/3/20/45/50/true/3 alignées ; Safety guards + Redemption documentés |

**Note runtime** : le bot tournait sous `tsx watch` (PID 2724) — les redémarrages successifs pendant l'implémentation l'ont arrêté. Relancé via `npm run dev:all` (proc_e417731f4900), dashboard :3105 + Vite :5173, scan live normal, aucune erreur dans les logs. Le frontend buildé (`index-zM2b1xxD.js`) a été synchronisé dans `src/dashboard/public/` (servi en dev tsx) et l'ancien hash supprimé.

---

## Phase 1 — Sécurité / argent réel

### F1 — `SIM_RESOLVE_FALLBACK=none` en mode live

**Problème** : le `.env` actif est en live (`DRY_RUN=false`) avec `SIM_RESOLVE_FALLBACK=probabilistic`. Après 5 retries API Gamma, une position réelle serait résolue au tirage aléatoire (`position-resolver.ts:128-138`).

**Fichier** : `.env`

**Changement** :
```bash
SIM_RESOLVE_FALLBACK=none
```

**⚠️ Action manuelle utilisateur** : modification de config d'argent réel + redémarrage du bot requis. Vérifier aussi que `READONLY_LIVE=false` reste cohérent (le bot doit trader).

**Vérification** :
1. Redémarrer le bot, observer le log de démarrage (`resolveFallback` absent de la config publique — champ non exposé, mais comportement = laisser les positions open après échec de résolution).
2. Optionnel : `grep -c "SIM_RESOLVE_FALLBACK" .env` → `none`.

---

### F2 — Garde-fous CLOB : vérifier le solde avant `placeBuy` + backoff sur rejets « balance »

**Problème** : 3172 erreurs « not enough balance / allowance » dans `bot-live.db`. `getAvailableCollateral` (`trader.ts:26-31`) n'est utilisé que par le dashboard (`index.ts:30`), jamais avant `placeBuy`.

**Fichiers** : `src/bot.ts`

**Changement 2a — champs de classe** (après `private totalAttempts = 0;`, `bot.ts:24`) :
```ts
private consecutiveBalanceRejections = 0;
private balanceBackoffUntil = 0;
```

**Changement 2b — vérification proactive du solde (cachée 30s)** dans `executeOpportunity`, après le calcul de `estimatedCost` (`bot.ts:334`) et avant la vérification `not-a-favorite` :

> ⚠️ `getAvailableCollateral` (`trader.ts:26-31`) est **async et fait un appel réseau CLOB**. L'appeler par opportunity à chaque tick (5s) ajouterait une latence réseau par opportunity. On cache donc le solde avec un TTL de 30s (aligné sur le `BalanceTracker` qui poll déjà à 30s, `balance.ts:18`).

```ts
// Garde-fou balance : ne pas poster si le solde CLOB disponible est
// insuffisant pour couvrir le coût estimé. Le solde est caché 30s pour
// éviter un appel réseau par opportunity (getAvailableCollateral est async).
// En dry-run / client non initialisé → available reste null → on saute.
const available = await this.getCachedAvailableCollateral();
if (available !== null && estimatedCost > available) {
  this.tracker.incrementRetry(opportunity.tradeKey);
  bus.emit({ type: "order", result: {
    dryRun: false, tokenId: opportunity.token.tokenId, side: "BUY",
    price: opportunity.price, size: opportunity.size, filled: false,
    reason: "insufficient-balance",
  }, opportunity });
  log("Live order skipped - insufficient balance", {
    kind: opportunity.kind,
    market: opportunity.event.title,
    outcome: opportunity.token.outcome,
    estimatedCost,
    available,
  });
  return;
}
```

**Changement 2b' — méthode de cache du solde** (nouvelle méthode privée dans `ReverseBot`, après `executeOpportunity`) :
```ts
private cachedBalance: number | null = null;
private cachedBalanceAt = 0;
private static readonly BALANCE_CACHE_MS = 30_000;

private async getCachedAvailableCollateral(): Promise<number | null> {
  const now = Date.now();
  if (now - this.cachedBalanceAt < ReverseBot.BALANCE_CACHE_MS) {
    return this.cachedBalance;
  }
  this.cachedBalance = await this.trader.getAvailableCollateral();
  this.cachedBalanceAt = now;
  return this.cachedBalance;
}
```
> Note : sémantique exacte de `balance` (sous réserve — non vérifiée) : le CLOB expose le solde disponible (collateral total − montants bloqués par les ordres en carnet). Le backoff 2c reste le filet de sécurité dur. En cas d'erreur réseau du CLOB, `getAvailableCollateral` lève — le catch de `placeBuy` (2c) gère déjà ce cas ; pour le cache, wrappper dans un try/catch qui retourne le cache précédent en cas d'échec :
```ts
private async getCachedAvailableCollateral(): Promise<number | null> {
  const now = Date.now();
  if (now - this.cachedBalanceAt < ReverseBot.BALANCE_CACHE_MS) {
    return this.cachedBalance;
  }
  try {
    this.cachedBalance = await this.trader.getAvailableCollateral();
    this.cachedBalanceAt = now;
  } catch {
    // Erreur réseau CLOB : garder le cache précédent (ou null si jamais fetché).
  }
  return this.cachedBalance;
}
```

**Changement 2c — backoff sur rejets consécutifs « balance »** dans le `catch` de `placeBuy` (`bot.ts:379-401`), après `const message = ...` :
```ts
if (/not enough balance|insufficient balance/i.test(message)) {
  this.consecutiveBalanceRejections++;
  if (this.consecutiveBalanceRejections >= 3) {
    this.balanceBackoffUntil = Date.now() + 60_000;
    this.consecutiveBalanceRejections = 0;
    log("Live trading paused 60s - repeated balance rejections");
  }
}
```

**Changement 2d — court-circuit pendant le backoff** en tête de `executeOpportunity`, juste après le log « Placing limit order » (`bot.ts:304-312`) :
```ts
if (Date.now() < this.balanceBackoffUntil) {
  log("Live order skipped - balance backoff active");
  return;
}
```

**Vérification** :
1. `npm run build` ✅.
2. Mode live : observer en log que les ordres « insufficient balance » cessent après 3 rejets.
3. Aucun impact dry-run (le check 2b est no-op car `available === null`).

---

### F3 — Tailles minimales CLOB : `computeSize` ≥ 5 shares / ≥ $1 ; `tickSizeFromMarket` ≥ 0.01

**Problème** : 345 erreurs « invalid tick size (0.001) » et 90 « Size lower than the minimum: 5 » + 20 « min size: $1 » dans `bot-live.db`.

**Fichiers** : `src/utils/prices.ts`, `src/utils/market.ts`

**Changement 3a — `computeSize`** (`prices.ts:9-13`) :
```ts
// Minimum CLOB observé sur les marchés 15m Up/Down : 5 shares et 1$ de notionnel.
const MIN_CLOB_SHARES = 5;
const MIN_CLOB_NOTIONAL_USD = 1;

export function computeSize(usdcBudget: number, price: number, maxShares: number): number {
  const shares = usdcBudget / Math.max(price, 0.01);
  let size = Math.min(shares, maxShares);
  size = Math.floor(size * 100) / 100;
  if (size < MIN_CLOB_SHARES) size = MIN_CLOB_SHARES;
  if (size * price < MIN_CLOB_NOTIONAL_USD) size = Math.ceil(MIN_CLOB_NOTIONAL_USD / price * 100) / 100;
  return Math.max(1, size);
}
```
> Impact : un order expensive à 0.85 avec budget 3 USDC passe de 3.52 → 5 shares (coût 4.25 USDC). Le plancher peut dépasser le budget d'ordre — c'est la réalité du CLOB ; le garde-fou `MAX_EXPOSURE_USDC` reste l'autorité globale. **Assumption : le min CLOB est uniformément 5 shares** (non vérifié marché par marché).

**Changement 3b — `tickSizeFromMarket`** (`market.ts:14-19`) :
```ts
export function tickSizeFromMarket(market: GammaMarket): string {
  const tick = market.orderPriceMinTickSize ?? 0.01;
  if (tick >= 0.1) return "0.1";
  // Le CLOB rejette 0.001 pour les marchés 15m Up/Down ("minimum for the
  // market is 0.01") même quand Gamma expose orderPriceMinTickSize=0.001.
  return "0.01";
}
```

**Vérification** :
1. `npm run build` ✅.
2. Vérifier dans le log live : plus d'erreurs « invalid tick size » / « Size lower than the minimum ».

---

## Phase 2 — Séparation simulé/live

### F4 — `balance.ts` : `source` = mode réel + purge des 395 lignes polluées

**Problème** : `BalanceTracker` démarre en dry-run (fix 2.3 du plan précédent) mais écrit `source: "live"` inconditionnellement (`balance.ts:34`) → **395 lignes `live` dans `data/bot.db`** (la DB de simulation).

**Fichier** : `src/dashboard/balance.ts`

**Changement 4a — ne persister qu'en live, émettre dans tous les cas** :
```ts
this.repos?.balanceSnapshots.insert({ ...snapshot, source: this.config.dryRun ? "simulated" : "live" });
```
devient :
```ts
// La donnée affichée (SSE) est toujours émise ; la persistance n'a de sens
// que pour l'historique réel en mode live. En dry-run on ne pollue pas la DB
// de simulation avec des snapshots du wallet réel.
if (!this.config.dryRun) {
  this.repos?.balanceSnapshots.insert({ ...snapshot, source: "live" });
}
```

**Changement 4b — purge one-shot des lignes polluées** (uniquement sur `data/bot.db`, la DB de simulation, une seule fois après redémarrage avec le fix) :
```sql
DELETE FROM balance_snapshots WHERE source = 'live';
```

**Vérification** :
1. `npm run build` ✅.
2. Avant : `SELECT source, COUNT(*) FROM balance_snapshots GROUP BY source` → 395 `live` / 2367 `simulated` (chiffres mobiles — le bot tourne).
3. Après fix + purge : plus aucune ligne `source='live'` dans `data/bot.db`, et `data/bot-live.db` continue d'avoir `source='live'`.

---

### F5 — Reset : ne plus écrire le ledger simulé en live + masquer le bouton en non-dry

**Problème** : `bot.reset()` (`bot.ts:58`) exécute `this.repos?.ledger.setBalance(this.config.simulatedCapital)` même en live ; le reset efface tout l'historique réel (`database.ts:160-174`) et créérait une ligne ledger simulée dans la DB live. Le bouton « Réinitialiser la DB » est affiché en live (`Header.tsx:53-62`).

**Fichiers** : `src/bot.ts`, `src/dashboard/server.ts`, `frontend/src/components/layout/Header.tsx`

**Changement 5a — `bot.ts` `reset()`** : supprimer la ligne 58 (`this.repos?.ledger.setBalance(...)`) — `this.ledger.reset()` appelle déjà `ledgerRepo.setBalance` quand le ledger existe (`simulated-ledger.ts:34-38`) :
```ts
  reset(): void {
    this.tracker.reset();
    this.totalAttempts = 0;
    this.repos?.botState.set(TOTAL_ATTEMPTS_KEY, 0);
    if (this.ledger) {
      this.ledger.reset(this.config.simulatedCapital);
    }
  }
```

**Changement 5b — `dashboard/server.ts` `handleReset`** : refuser en non-dry, après le check origin (`server.ts:246-264`) :
```ts
if (!this.config.dryRun) {
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Reset désactivé en mode live" }));
  return;
}
```

**Changement 5c — `Header.tsx`** : n'afficher le bouton reset qu'en mode dry :
```tsx
<Show when={config() !== null && mode() === "dry"}>
```
> Note : `config()` retourne `BotConfig | null` et `mode()` retourne `"dry" | "readonly" | "live"`. L'expression `config() && mode() === "dry"` retournerait `BotConfig | false` (pas un booléen) — on utilise `config() !== null` pour un type propre.

**Vérification** :
1. `npm run build` + `npm --prefix frontend run build` ✅.
2. En live : `POST /api/reset` → 403 ; bouton absent du dashboard.

---

### F6 — `simulatedStats` → `stats` en mode live

**Problème** : 6442 events `simulatedStats` dans `bot-live.db` — stats réelles sous un nom trompeur, non distinguées par le frontend.

**Fichiers** : `src/bot.ts`, `src/dashboard/events.ts`, `frontend/src/types/index.ts`, `frontend/src/stores/dispatcher.ts`

**Changement 6a — `bot.ts` `resolveAndEmitStats`** (`bot.ts:89`) :
```ts
bus.emit({ type: "simulatedStats", stats });
```
devient :
```ts
const statsType = this.config.dryRun ? "simulatedStats" : "stats";
bus.emit({ type: statsType, stats });
```

**Changement 6b — `events.ts`** : ajouter au type union (`BotEvent`) et à `PERSISTED_EVENT_TYPES` :
```ts
| { type: "stats"; stats: SimulatedStats }
```
```ts
const PERSISTED_EVENT_TYPES = new Set([
  "openedPosition",
  "resolvedPosition",
  "order",
  "simulatedStats",
  "stats",
  "balance",
  "simulatedBalance",
  "error",
]);
```

**Changement 6c — frontend** :
- `frontend/src/types/index.ts` : ajouter `| { type: "stats"; stats: SimulatedStats }` à `BotEvent`.
- `frontend/src/stores/dispatcher.ts` :
```ts
case "stats":
  setSimStats(event.stats);
  break;
```

**Vérification** :
1. `npm run build` + `npm --prefix frontend run build` ✅.
2. Après redémarrage live : plus de nouveaux events `simulatedStats` dans `bot-live.db`, des events `stats` à la place (le panneau Performance fonctionne toujours).

---

## Phase 3 — Données / performance

### F7 — Prune périodique des tables sans rétention

**Problème** : seuls `posted_orders` et `window_claims` sont prunés (`trade-tracker.ts:307-327`). `events` (13 910 lignes), `balance_snapshots` (2 880/jour), `trade_keys`, `retry_counts` croissent sans limite.

**Fichiers** : `src/db/database.ts`, `src/db/repositories.ts`, `src/bot.ts`

**Changement 7a — migration SQLite** dans `init()` (`database.ts`, après les migrations `posted_orders`) :
```ts
// Migration : timestamp pour pouvoir pruner retry_counts.
try {
  this.conn.exec("ALTER TABLE retry_counts ADD COLUMN updatedAt INTEGER");
} catch {
  /* column already exists */
}
```

**Changement 7b — `RetryRepository.increment`** (`repositories.ts:267-275`) :
```ts
increment(key: string): number {
  const next = this.get(key) + 1;
  this.db.run(
    `INSERT INTO retry_counts (key, count, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = excluded.count, updatedAt = excluded.updatedAt`,
    [key, next, Date.now()],
  );
  return next;
}
```

**Changement 7c — méthodes `prune`** dans les repositories :
```ts
// EventRepository
prune(beforeTs: number): void {
  this.db.run("DELETE FROM events WHERE ts < ?", [beforeTs]);
}

// BalanceSnapshotRepository
prune(beforeTs: number): void {
  this.db.run("DELETE FROM balance_snapshots WHERE ts < ?", [beforeTs]);
}

// KeyRepository
prune(beforeTs: number): void {
  this.db.run("DELETE FROM trade_keys WHERE createdAt < ?", [beforeTs]);
}

// RetryRepository
prune(beforeTs: number): void {
  this.db.run("DELETE FROM retry_counts WHERE updatedAt IS NULL OR updatedAt < ?", [beforeTs]);
}
```

**Changement 7d — horaire de prune** dans `ReverseBot.run()` (`bot.ts:64-83`), à côté de l'interval de résolution :
```ts
this.pruneData();
setInterval(() => this.pruneData(), 3600_000); // 1h
```
avec :
```ts
private pruneData(): void {
  const now = Date.now();
  this.repos?.events.prune(now - 7 * 24 * 3600_000);          // events > 7 j
  this.repos?.balanceSnapshots.prune(now - 30 * 24 * 3600_000); // snapshots > 30 j
  this.repos?.keys.prune(now - 24 * 3600_000);                 // trade_keys > 24 h
  this.repos?.retries.prune(now - 24 * 3600_000);              // retry_counts > 24 h
}
```

**Vérification** :
1. `npm run build` ✅.
2. `ALTER TABLE` idempotent (try/catch) — démarrage sans erreur sur les DB existantes.
3. Après un cycle : `SELECT COUNT(*) FROM events` décroît sur les données > 7 j.

---

### F8+F9 — `loadFromDb` en requêtes ciblées + suppression de `/api/history` et de son code mort

**Problème** : `loadFromDb` charge **toutes** les positions (`positionsRepo.all()`, `trade-tracker.ts:69`) pour reconstruire les paires ; `/api/history` (`server.ts:215-232`) n'est consommé nulle part et est le seul autre utilisateur de `all()`, `EventRepository.recent`, `BalanceSnapshotRepository.recent`.

**Fichiers** : `src/db/repositories.ts`, `src/trade-tracker.ts`, `src/dashboard/server.ts`

**Changement 8a — nouveaux repo `PositionRepository`** (remplacer `all()` par deux méthodes ciblées ; `recentResolved` et `getAggregateStats` inchangés) :
```ts
open(): SimulatedPosition[] {
  return this.db
    .all<PositionRow>("SELECT * FROM positions WHERE status = 'open' ORDER BY createdAt ASC")
    .map(toPosition);
}

byPairIds(ids: string[]): SimulatedPosition[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return this.db
    .all<PositionRow>(
      `SELECT * FROM positions WHERE pairId IN (${placeholders}) ORDER BY createdAt ASC`,
      ids,
    )
    .map(toPosition);
}
```

**Changement 8b — `trade-tracker.ts` `loadFromDb`** : ne charger que l'ouvert + les legs des paires non résolues (les paires résolues ont `realizedPnl`/`directional` persistés — les legs ne servent plus après finalisation ; vérifié : aucune lecture de legs sur paires résolues après reload) :
```ts
const openPositions = this.positionsRepo.open();
this.openPositions.push(...openPositions);

const recentResolved = this.positionsRepo.recentResolved(MAX_RESOLVED_IN_MEMORY);
this.resolvedPositions.push(...recentResolved);

const stats = this.positionsRepo.getAggregateStats();
this.cumulativeRealizedPnl = stats.pnl;
this.cumulativeWins = stats.wins;
this.cumulativeLosses = stats.losses;

const pairs = this.pairsRepo.all();
const openPairIds = pairs
  .filter((pair) => pair.status !== "resolved")
  .map((pair) => pair.id);
const legs = openPairIds.length > 0 ? this.positionsRepo.byPairIds(openPairIds) : [];
for (const pair of pairs) {
  pair.cheapLegs = legs.filter((p) => p.pairId === pair.id && p.kind === "cheap");
  pair.expensiveLegs = legs.filter((p) => p.pairId === pair.id && p.kind === "expensive");
  this.pairs.set(pair.id, pair);
}
```
(la suite — keys/retries/windowClaims/postedOrders — inchangée)

**Changement 8c — `server.ts`** : supprimer la route `/api/history` (lignes 80-83) et `handleHistory` (lignes 215-232).

**Changement 8d — `repositories.ts`** : supprimer `PositionRepository.all()`, `EventRepository.recent`, `BalanceSnapshotRepository.recent` (plus aucun usage après 8c — vérifié par recherche d'usages à l'implémentation).

> ⚠️ 8b et 8c/8d doivent être appliqués **ensemble** (même build) : `all()` est utilisé par les deux jusqu'à leur suppression simultanée.

**Vérification** :
1. `npm run build` ✅.
2. Redémarrer : les positions ouvertes et l'exposition (couverte / non couverte) s'affichent identiques en dry-run et en live (comparer avec avant).
3. Le démarrage ne charge plus la totalité de `positions` (vérifier mémoire/rapidité sur la DB live).
4. `GET /api/history` → 404.

---

## Phase 4 — Nettoyage divers

### F10 — `readBody` avec limite de taille

**Fichier** : `src/dashboard/server.ts` (`readBody`, lignes 302-309)

**Changement** :
```ts
private readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
```

**Vérification** : `POST /api/redeem` avec un body > 64 Ko → 500 (et connexion fermée), body normal fonctionne.

---

### F11 — `readonlyLive` sans `PRIVATE_KEY`

**Problème** : `validateTradingConfig` exige `PRIVATE_KEY` + `FUNDER_ADDRESS` dès que `DRY_RUN=false`, et `trader.init()` crée le client CLOB authentifié — inutile en mode lecture seule.

**Fichiers** : `src/config.ts`, `src/trader.ts`

**Changement 11a — `config.ts` `validateTradingConfig`** (`config.ts:178-187`) :
```ts
export function validateTradingConfig(config: BotConfig): void {
  if (config.dryRun) return;

  if (config.readonlyLive) {
    if (!config.funderAddress) {
      throw new Error("FUNDER_ADDRESS is required for READONLY_LIVE balance display");
    }
    return;
  }

  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  }
  if (!config.funderAddress) {
    throw new Error("FUNDER_ADDRESS is required when DRY_RUN=false");
  }
}
```

**Changement 11b — `trader.ts` `init`** (`trader.ts:21-24`) :
```ts
async init(): Promise<void> {
  if (this.config.dryRun || this.config.readonlyLive) return;
  this.client = await createTradingClient(this.config);
}
```
> Conséquence assumée : en readonly, `getAvailableCollateral` renvoie `null` (client non créé) → le Header affiche uniquement la valeur des positions (API publique), pas le cash. Documenté dans le README.

**Vérification** : `DRY_RUN=false READONLY_LIVE=true` sans `PRIVATE_KEY` démarre sans erreur ; le dashboard affiche les positions Polymarket ; aucun ordre n'est posté.

---

### F12 — Persistance des décisions de résolution (fallback / retries épuisés)

**Problème** : les logs de fallback probabiliste (`position-resolver.ts:135-138`) et de positions laissées open (`:66-72`) ne sont pas persistés — impossible d'auditer a posteriori les décisions d'argent réel.

**Fichiers** : `src/position-resolver.ts`, `src/dashboard/events.ts`, `frontend/src/types/index.ts`, `frontend/src/stores/dispatcher.ts`

**Changement 12a — `events.ts`** : ajouter au type union et à `PERSISTED_EVENT_TYPES` :
```ts
| { type: "resolution"; message: string; data?: Record<string, unknown> }
```
(seul type `log` reste non persisté pour éviter le flood — les `log` ordinaires sont émis à chaque tick « Watching market ».)

**Changement 12b — `position-resolver.ts`** : remplacer les deux `log(...)` critiques par une émission persistée (garder le `log` console) :
```ts
bus.emit({
  type: "resolution",
  message: "Resolution fallback (probabilistic) after retries exhausted",
  data: { market: position.eventTitle, outcome: position.outcome },
});
```
et :
```ts
bus.emit({
  type: "resolution",
  message: "Position left open - no winner could be determined (fallback=none)",
  data: { market: position.eventTitle, outcome: position.outcome },
});
```

**Changement 12c — frontend** : types + dispatcher :
```ts
case "resolution":
  addLog(event.message, event.data, true);
  break;
```

**Vérification** : en simulant un échec de résolution (ou en live), un event `resolution` apparaît dans `events` de la DB et dans le log du dashboard.

---

### F13 — Alignement docs (README + .env.example) sur la config réelle

**Problème** : divergences documentées (section 5 de l'audit) entre les valeurs réelles du `.env` et les docs : `EXPENSIVE_BUY_MIN=0.85` (doc 0.90), `CHEAP_ORDER_USDC=1` (doc 10), `EXPENSIVE_ORDER_USDC=3` (doc 50), `MAX_SHARES_PER_ORDER=20` (doc 90), `SIMULATED_CAPITAL=50` (doc 500), `MAX_EXPOSURE_USDC=45` (doc 500), `SIM_REQUIRE_COVERED_PAIR=true` (doc false), `SIGNATURE_TYPE=3` (doc 2).

**Fichiers** : `README.md`, `.env.example`

**Changement** : aligner les valeurs documentées sur le profil validé qui tourne, avec commentaires :

| Endroit | Ancienne valeur | Nouvelle valeur |
|---|---|---|
| README « Configuration » / `.env.example` | `CHEAP_ORDER_USDC=10` | `CHEAP_ORDER_USDC=1` (`# petit budget : ~14 shares à 0.07`) |
| README / `.env.example` | `EXPENSIVE_BUY_MIN=0.90` | `EXPENSIVE_BUY_MIN=0.85` |
| README / `.env.example` | `EXPENSIVE_ORDER_USDC=50` | `EXPENSIVE_ORDER_USDC=3` |
| README / `.env.example` | `MAX_SHARES_PER_ORDER=90` | `MAX_SHARES_PER_ORDER=20` |
| README / `.env.example` | `MAX_EXPOSURE_USDC=500` | `MAX_EXPOSURE_USDC=45` |
| README / `.env.example` | `SIMULATED_CAPITAL=500` | `SIMULATED_CAPITAL=50` |
| README / `.env.example` | `SIM_REQUIRE_COVERED_PAIR=false` | `SIM_REQUIRE_COVERED_PAIR=true` (`# exigence hedge au claim — paire à 1 jambe = directional`) |
| `.env.example` | `SIGNATURE_TYPE=2` | `SIGNATURE_TYPE=3` (`# deposit wallet POLY_1271 (V2)`) |
| README « Safety guards » §6 | « realistic fill cost ... sum < $1.00 » | ajouter : plancher CLOB 5 shares / $1 (F3) |
| README Redemption | — | ajouter : `READONLY_LIVE` ne requiert pas `PRIVATE_KEY` |

**Vérification** : relire README/.env.example — plus aucune valeur contredisant `.env` ; `grep` des valeurs aligné.

---

## Vérification globale après implémentation

1. `npm run build` (backend) et `npm --prefix frontend run build` (frontend) ✅.
2. Redémarrer le bot (il tourne en live sur :3105 — planifier la coupure).
3. `/api/state` : pas de secrets, `config.dryRun=false`, pas de `simulatedStats` dans les nouveaux events.
4. DB dry : `SELECT source, COUNT(*) FROM balance_snapshots GROUP BY source` → plus de `live`.
5. DB live : pas de `ledger`, event `stats` (pas `simulatedStats`) pour les nouvelles stats.
6. Logs : plus d'erreurs « not enough balance » / « invalid tick size » / « Size lower than the minimum » après les 5 premières minutes.
7. `GET /api/history` → 404 ; `POST /api/reset` en live → 403.
8. `PRAGMA integrity_check` sur les deux DB (après purge) → `ok`.
