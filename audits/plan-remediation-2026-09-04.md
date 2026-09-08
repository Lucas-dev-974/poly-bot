# Plan de remédiation — audit 2026-09-04

> Plan détaillé pour corriger chaque problème remonté dans `audits/audit-2026-09-04.md`.
> Chaque section : problème, fichier(s) concerné(s), changement exact, vérification.
>
> **Correction importante par rapport à l'audit** : le finding #9 (mapping `negativeRisk` vs `negRisk`) est **infirmé**. L'API data-api Polymarket renvoie bien le champ `negativeRisk` (confirmé via la doc officielle `https://polymarket-docs.copilot.markets/api-reference/core/get-current-positions-for-a-user` et le type `Position` publié par `polymarket-data.com`). Le code `balance.ts:72` (`Boolean(p.negativeRisk ?? false)`) est donc **correct**. Ce finding est retiré du plan.

---

## ✅ Statut d'implémentation — 2026-09-04

**Tous les fixes sont implémentés et vérifiés.** Builds backend (`npm run build`) et frontend (`npm --prefix frontend run build`) passent. Tests runtime effectués (dryRun + CSRF) :

| # | Fix | Statut | Vérification |
|---|---|---|---|
| 1.1 | Clé privée servie au frontend | ✅ Implémenté | `/api/state` ne contient plus `privateKey` (testé : `False`) |
| 1.2 | Secrets builder/relayer dans PublicBotConfig | ✅ Implémenté | `/api/state` ne contient plus `builderApiKey`/`relayerApiKey` (testé : `False`) |
| 1.3 | CSRF sur /api/reset et /api/redeem | ✅ Implémenté | `Origin: http://evil.com` → 403 ; `Origin: http://localhost:3199` → 200 (testé) |
| 2.1 | Déclarer builder-signing-sdk | ✅ Implémenté | `npm ls` → `@polymarket/builder-signing-sdk@0.0.8` dédupé |
| 2.2 | Supprimer stats_snapshots | ✅ Implémenté | Build passe, aucune erreur SQLite au démarrage |
| 2.3 | BalanceTracker en dryRun | ✅ Implémenté | Démarre si `funderAddress` présent (dryRun inclus) |
| 3.1 | Fill price live = bestAsk | ✅ Implémenté | `fillPrice` = `bestAskAtFill` si marketable, sinon `limitPrice` |
| 3.2 | loadFromDb + MAX_RESOLVED_IN_MEMORY | ✅ Implémenté | `recentResolved(500)` + `getAggregateStats()` SQL (COALESCE pnl) |
| 3.3+4.1 | Spam logs SSE + code mort frontend (fusion) | ✅ Implémenté | `useApi.ts`/`Button.tsx` supprimés, `connectionStatus`/`isDryRun`/`clearLogs`/`api.history`/`simulatedBaseCapital` supprimés |
| 4.2 | Code mort backend | ✅ Implémenté | `transaction`/`has`×3/`question`/`clients` supprimés |
| 5.1 | README.md | ✅ Implémenté | 4 corrections appliquées |
| 5.2 | Docs obsolètes | ✅ Implémenté | Déplacés dans `docs/archive/` |

**Note** : le fix 2.3 a été implémenté avec la condition `if (config.funderAddress)` (au lieu de `if (!config.dryRun)`), conformément au plan. La zone d'ombre documentée (snapshot `source:"live"` en dryRun) reste ouverte — correctif optionnel non appliqué.

**Note complémentaire (vérification finale)** : `src/dashboard/public/` (servi en dev tsx) contenait encore l'ancien build Vite (`index-Ku1aiAY1.js` avec `api.history` et le spam de logs SSE). Il a été **synchronisé manuellement** avec le nouveau build (`index-C2grL1NJ.js` + `index.html`) pour que `npm start`/`npm run dev` servent le code corrigé. Le bot live sur :3105 (démarré après les fixes) confirme : `/api/state` ne contient plus aucun secret.

---

## Phase 1 — Sécurité (à faire en premier)

### Fix 1.1 — Clé privée servie au frontend

**Problème** : `/api/state` renvoie `this.config` (qui contient `privateKey`) au lieu de `toPublicConfig(this.config)`.

**Fichier** : `src/dashboard/server.ts`

**Changement** :
- Ligne 5 : remplacer `import type { BotConfig } from "../config.js"` par un import fusionné : `import { type BotConfig, toPublicConfig } from "../config.js"`
- Ligne 194 : remplacer `config: this.config` par `config: toPublicConfig(this.config)`

**Diff attendu** :
```ts
// Ligne 5 — remplacer l'import type existant par un import fusionné
import { type BotConfig, toPublicConfig } from "../config.js";

// Ligne 190-198 — handleState
private handleState(res: import("node:http").ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      config: toPublicConfig(this.config),  // ← was: this.config
      events: bus.replay(),
    }),
  );
}
```

**Vérification** :
1. `npm run build` passe
2. Démarrer le bot en mode live (`DRY_RUN=false` avec une vraie clé), ouvrir `http://127.0.0.1:3105/api/state` dans un navigateur, vérifier que `privateKey` n'apparaît pas dans le JSON
3. Vérifier que le dashboard fonctionne toujours (config affichée dans ConfigBar)

---

### Fix 1.2 — Secrets Builder/Relayer dans PublicBotConfig

**Problème** : `toPublicConfig` n'omet pas les champs `builderApiKey`, `builderSecret`, `builderPassphrase`, `relayerApiKey`, `relayerApiKeyAddress`. Ils sont envoyés au frontend via l'événement SSE `config` (`bot.ts:75`).

**Fichier** : `src/config.ts`

**Changement** :
- Lignes 149-152 : étendre le `Omit` avec les 5 champs
- Lignes 154-163 : ajouter les 5 champs à la destructuration dans `toPublicConfig`

**Diff attendu** :
```ts
// Ligne 149-152
export type PublicBotConfig = Omit<
  BotConfig,
  | "privateKey" | "clobApiKey" | "clobSecret" | "clobPassphrase"
  | "builderApiKey" | "builderSecret" | "builderPassphrase"
  | "relayerApiKey" | "relayerApiKeyAddress"
>;

// Lignes 154-163
export function toPublicConfig(config: BotConfig): PublicBotConfig {
  const {
    privateKey: _privateKey,
    clobApiKey: _clobApiKey,
    clobSecret: _clobSecret,
    clobPassphrase: _clobPassphrase,
    builderApiKey: _builderApiKey,
    builderSecret: _builderSecret,
    builderPassphrase: _builderPassphrase,
    relayerApiKey: _relayerApiKey,
    relayerApiKeyAddress: _relayerApiKeyAddress,
    ...publicConfig
  } = config;
  return publicConfig;
}
```

**Impact** : Le frontend ne lit jamais ces champs (vérifié : `BotConfig` dans `frontend/src/types/index.ts` ne les déclare pas — il a un index `[key: string]: unknown`). Aucun impact fonctionnel.

**Vérification** :
1. `npm run build` passe
2. Démarrer le bot, inspecter le payload SSE `config` (via `curl http://127.0.0.1:3105/events` ou onglet Network), vérifier que `builderApiKey`, `builderSecret`, `builderPassphrase`, `relayerApiKey`, `relayerApiKeyAddress` n'apparaissent pas
3. Vérifier que `ConfigBar` affiche toujours les paramètres de stratégie

---

### Fix 1.3 — Protection CSRF sur `/api/reset` et `/api/redeem`

**Problème** : `/api/reset` accepte un POST sans vérification d'origine. Un site malveillant peut effacer la DB via un form HTML. `/api/redeem` est partiellement protégé (body JSON → preflight CORS) mais pas explicitement.

**Fichier** : `src/dashboard/server.ts`

**Approche** : Vérifier l'en-tête `Origin` pour les requêtes POST. Le serveur écoute sur `127.0.0.1` — on accepte uniquement les origines `http://127.0.0.1:<port>` et `http://localhost:<port>`. Pour le dev Vite, ajouter `http://localhost:5173`.

**Changement** : Ajouter une méthode `isAllowedOrigin(req)` et l'appeler dans `handleReset` et `handleRedeem`.

**Diff attendu** :
```ts
// Ajouter une méthode privée dans la classe DashboardServer
private isAllowedOrigin(req: import("node:http").IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = [
    `http://127.0.0.1:${this.port}`,
    `http://localhost:${this.port}`,
    "http://localhost:5173", // dev Vite
    "http://127.0.0.1:5173",
  ];
  return allowed.includes(origin);
}

// Dans handleReset (avant this.resetFn?.()) :
private handleReset(res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage): void {
  if (!this.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  // ... reste inchangé
}

// Dans handleRedeem (au début du try) :
private async handleRedeem(req, res): Promise<void> {
  if (!this.isAllowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Forbidden origin" }));
    return;
  }
  // ... reste inchangé
}
```

**Note** : La signature de `handleReset` doit recevoir `req` — modifier aussi l'appelant dans `start()` (ligne 87) :
```ts
if (url.pathname === "/api/reset" && req.method === "POST") {
  this.handleReset(res, req);  // ← was: this.handleReset(res)
  return;
}
```

**Vérification** :
1. `npm run build` passe
2. `curl -X POST http://127.0.0.1:3105/api/reset -H "Origin: http://evil.com"` → 403
3. `curl -X POST http://127.0.0.1:3105/api/reset -H "Origin: http://localhost:5173"` → 200 (en dev) ou `http://127.0.0.1:3105` → 200
4. Dashboard → bouton "Réinitialiser la DB" fonctionne toujours
5. Dashboard → bouton "Clôturer" (redeem) fonctionne toujours

---

## Phase 2 — Dépendance et stabilité

### Fix 2.1 — Déclarer `@polymarket/builder-signing-sdk`

**Problème** : `relayer.ts:16` importe `@polymarket/builder-signing-sdk` qui n'est pas dans `package.json` dependencies (présent en transitif via `builder-relayer-client`). Un `npm ci` ou une mise à jour peut casser le build.

**Fichier** : `package.json`

**Changement** : Ajouter la dépendance avec la version déjà résolue dans le lockfile (`^0.0.8`).

**Diff attendu** :
```json
"dependencies": {
  "@polymarket/builder-relayer-client": "^0.0.10",
  "@polymarket/builder-signing-sdk": "^0.0.8",
  "@polymarket/clob-client-v2": "^1.0.0",
  "dotenv": "^16.4.7",
  "viem": "^2.23.2"
},
```

**Vérification** :
1. `npm install` — pas d'erreur
2. `npm run build` passe
3. `npm ls @polymarket/builder-signing-sdk` — affiche la version, pas de "UNMET" ou "deduped"

---

### Fix 2.2 — `stats_snapshots` : exposer ou supprimer

**Problème** : `bot.ts:90` insère un snapshot toutes les 5 s (~17 280 lignes/jour) mais aucun endpoint ne les lit. `StatsSnapshotRepository` n'a que `insert()`.

**Recommandation** : Supprimer la table et le code associé. Le frontend consomme déjà `simulatedStats` via SSE — la table est un vestige de charting jamais implémenté.

**Fichiers** :
- `src/db/database.ts` : supprimer la table `stats_snapshots` (ligne 106-110) et le `DELETE FROM stats_snapshots` (ligne 191)
- `src/db/repositories.ts` : supprimer `StatsSnapshotRepository` (lignes 380-389)
- `src/db/index.ts` : supprimer l'import (ligne 12), le champ `statsSnapshots` (ligne 26) et l'instanciation (ligne 41)
- `src/bot.ts` : supprimer `this.repos?.statsSnapshots.insert(stats)` (ligne 90)

**Alternative** (si on veut garder l'historique pour du charting futur) :
- Ajouter `recent(limit: number)` à `StatsSnapshotRepository`
- Exposer dans `/api/history` : `statsSnapshots: this.repos.statsSnapshots.recent(500)`
- Ajouter un affichage chart dans le frontend

**Décision recommandée** : Suppression (moins de code mort, la persistence SSE dans `events` suffit pour l'historique).

**Vérification (suppression)** :
1. `npm run build` passe
2. Démarrer le bot, vérifier qu'aucune erreur SQLite n'apparaît
3. Vérifier que `resolveAndEmitStats` émet toujours `simulatedStats` via SSE (le dashboard reste fonctionnel)

---

### Fix 2.3 — Démarrer BalanceTracker en dryRun

**Problème** : `index.ts:28` ne démarre `BalanceTracker` que si `!config.dryRun`. Le commentaire `balance.ts:8` dit "works in DRY_RUN too". En dry-run, le panneau "Positions Polymarket" reste vide alors que l'API data-api est publique (pas d'auth requis, juste `funderAddress`).

**Fichier** : `src/index.ts`

**Changement** : Supprimer la condition `!config.dryRun` et toujours démarrer `BalanceTracker` si le dashboard est activé et que `funderAddress` est présent.

**Diff attendu** :
```ts
// Lignes 24-31 — remplacer le bloc conditionnel
if (config.enableDashboard) {
  const dashboard = new DashboardServer(config.dashboardPort, config);
  dashboard.start();

  if (config.funderAddress) {
    const balance = new BalanceTracker(config, repos);
    balance.start(() => trader.getAvailableCollateral());
  }
  // ... reste inchangé
}
```

**Note** : `trader.getAvailableCollateral()` retourne `null` en dryRun (`trader.ts:27`) — c'est géré par `BalanceTracker.poll` qui fallback à `0` (`balance.ts:23`). La partie "positions Polymarket" fonctionne car elle utilise l'API data-api publique. En dry-run sans `FUNDER_ADDRESS`, on ne démarre pas le tracker (pas de données à afficher de toute façon).

**Zone d'ombre** : En dryRun, `BalanceTracker.poll` écrit un snapshot avec `source: "live"` (`balance.ts:34`) alors que `availableCollateral` est 0. C'est incohérent — le snapshot est marqué "live" mais le collateral est simulé. Correctif optionnel : passer `source: "simulated"` quand `config.dryRun`, ou ne pas émettre l'événement `balance` en dryRun (seulement `polymarketPositions`). Le frontend gère déjà ce cas : `Header.tsx:24` priorise `simulatedCash` sur `liveBalance`, donc l'affichage n'est pas affecté.

**Vérification** :
1. `npm run build` passe
2. Démarrer en dryRun avec `FUNDER_ADDRESS` défini → le panneau "Positions Polymarket" affiche des données
3. Démarrer en dryRun sans `FUNDER_ADDRESS` → pas d'erreur, panneau vide

---

## Phase 3 — Bugs de logique

### Fix 3.1 — Fill price live : utiliser bestAsk pour les ordres marketable

**Problème** : `bot.ts:251` utilise `order.limitPrice` comme `fillPrice` pour les positions live. Pour un ordre marketable (limitPrice >= bestAsk), le fill réel se fait au bestAsk. `bestAskAtFill` est stocké mais ignoré.

**Fichier** : `src/bot.ts`

**Changement** : Utiliser `order.bestAskAtFill` s'il est disponible et <= limitPrice (marketable), sinon limitPrice.

**Diff attendu** (ligne 242-259, `createLivePosition`) :
```ts
private createLivePosition(
  order: { key: string; orderId: string } & PostedOrderContext,
  filledSize: number,
): void {
  if (filledSize <= 0) return;
  // Pour un ordre GTC marketable, le fill se fait au bestAsk (meilleur que le limit).
  // Pour un ordre non marketable, le fill se fait au limit price.
  const fillPrice =
    order.bestAskAtFill !== null &&
    order.bestAskAtFill !== undefined &&
    order.bestAskAtFill <= order.limitPrice
      ? order.bestAskAtFill
      : order.limitPrice;
  const position: SimulatedPosition = {
    id: `live:${order.orderId}`,
    // ... champs inchangés ...
    fillPrice,  // ← was: order.limitPrice
    cost: Math.round(fillPrice * filledSize * 100) / 100,  // ← was: order.limitPrice * filledSize
    // ... reste inchangé ...
  };
  // ...
}
```

**Note** : `bestAskAtFill` est capturé au moment du scan (détection d'opportunité), pas au moment du fill réel. Si le carnet a bougé entre le scan et le fill (potentiellement minutes plus tard), cette valeur peut être obsolète. C'est néanmoins une meilleure approximation que `limitPrice` : pour un ordre marketable, le fill se fait au bestAsk du moment, qui est <= limitPrice. L'approximation est conservatrice (le bestAsk réel au fill peut être encore meilleur). Le `fillReason` reste `"marketable"` car un ordre GTC dont le limit >= bestAsk est marketable par construction.

**Vérification** :
1. `npm run build` passe
2. En mode live, vérifier qu'une position remplie marketable a un `fillPrice` <= `limitPrice` (pas strictement égal)
3. Le PnL réalisé doit être >= à l'ancien calcul (plus précis, moins conservateur)

---

### Fix 3.2 — `loadFromDb` : appliquer MAX_RESOLVED_IN_MEMORY

**Problème** : `trade-tracker.ts:72` charge toutes les positions résolues en mémoire sans limite. Le runtime a `MAX_RESOLVED_IN_MEMORY=500` mais le load l'ignore.

**Fichier** : `src/trade-tracker.ts`

**Changement** : Après avoir chargé les positions résolues, tronquer à `MAX_RESOLVED_IN_MEMORY` en gardant les plus récentes (tri par `createdAt` descendant, ou par position de la liste inversée puisque la DB est ordonnée `ORDER BY createdAt ASC`).

**Diff attendu** (lignes 69-77) :
```ts
const allPositions = this.positionsRepo.all();
this.openPositions.push(...allPositions.filter((p) => p.status === "open"));
const resolved = allPositions.filter((p) => p.status !== "open");
// Garder les MAX_RESOLVED_IN_MEMORY plus récentes (la DB est triée ASC par createdAt)
const recentResolved = resolved.slice(-MAX_RESOLVED_IN_MEMORY);
this.resolvedPositions.push(...recentResolved);
for (const position of recentResolved) {
  this.cumulativeRealizedPnl += position.pnl ?? 0;
  if (position.status === "won") this.cumulativeWins++;
  if (position.status === "lost") this.cumulativeLosses++;
}
```

**Note** : Les compteurs `cumulativeRealizedPnl`, `cumulativeWins`, `cumulativeLosses` ne comptent que les positions en mémoire. Si on tronque, on perd le PnL des anciennes positions. Deux options :
- **Option A** (simple) : accepter la perte — les stats ne couvrent que les 500 dernières positions résolues
- **Option B** (correct) : ajouter une méthode `PositionRepository.getStats()` qui calcule les compteurs via SQL (`SELECT COUNT(*) FILTER, COALESCE(SUM(pnl),0)`) et les utiliser pour initialiser les cumulatifs, puis ne charger que les 500 plus récentes en mémoire pour le dashboard

**Recommandation** : Option B (SQL) pour les compteurs + slice pour la mémoire.

**Bug SQL à éviter** : `pnl` est nullable dans la DB (`database.ts:41`). La requête `SUM(CASE WHEN status != 'open' THEN pnl ELSE 0 END)` retourne `NULL` si `pnl` est `NULL`, et `SUM` ignore les `NULL`. Il faut utiliser `COALESCE(pnl, 0)` à l'intérieur du `SUM`.

**Bug de RAM à éviter** : `PositionRepository.all()` charge **toutes** les positions en mémoire (`SELECT * FROM positions`). Le `slice(-500)` tronque après le chargement — le pic de RAM au démarrage n'est pas évité. Pour résoudre vraiment le problème, ajouter une méthode `recentResolved(limit)` qui fait `SELECT * FROM positions WHERE status != 'open' ORDER BY createdAt DESC LIMIT ?` et une méthode `countOpen()` qui fait `SELECT COUNT(*) FROM positions WHERE status = 'open'`. Le `loadFromDb` ne charge alors que les positions open + les 500 plus récentes résolues.

**Diff Option B (corrigée)** :
```ts
// Dans PositionRepository, ajouter :

getAggregateStats(): { pnl: number; wins: number; losses: number } {
  const row = this.db.get<{ pnl: number; wins: number; losses: number }>(`
    SELECT
      COALESCE(SUM(CASE WHEN status != 'open' THEN COALESCE(pnl, 0) ELSE 0 END), 0) as pnl,
      COUNT(CASE WHEN status = 'won' THEN 1 END) as wins,
      COUNT(CASE WHEN status = 'lost' THEN 1 END) as losses
    FROM positions
  `);
  return row ?? { pnl: 0, wins: 0, losses: 0 };
}

recentResolved(limit: number): SimulatedPosition[] {
  return this.db
    .all<PositionRow>(
      "SELECT * FROM positions WHERE status != 'open' ORDER BY createdAt DESC LIMIT ?",
      [limit],
    )
    .map(toPosition)
    .reverse(); // remet en ordre ASC pour cohérence avec le runtime
}

// Dans TradeTracker.loadFromDb() :
const openPositions = this.positionsRepo.all().filter((p) => p.status === "open");
this.openPositions.push(...openPositions);

const recentResolved = this.positionsRepo.recentResolved(MAX_RESOLVED_IN_MEMORY);
this.resolvedPositions.push(...recentResolved);

// Compteurs globaux depuis la DB (pas seulement les 500 en mémoire)
const stats = this.positionsRepo.getAggregateStats();
this.cumulativeRealizedPnl = stats.pnl;
this.cumulativeWins = stats.wins;
this.cumulativeLosses = stats.losses;

// Les paires sont toujours rechargées depuis la DB (elles sont peu nombreuses)
// NB : la reconstruction des legs des paires (lignes 81-85 originales) utilise
// allPositions.filter(p => p.pairId === pair.id). Si on ne charge plus allPositions,
// il faut charger les positions des paires séparément. Solution : garder un appel
// à this.positionsRepo.all() pour la reconstruction des paires uniquement, OU
// ajouter une méthode PositionRepository.byPairId(pairId) qui filtre en SQL.
// Approche recommandée : charger allPositions pour les paires (elles sont peu
// nombreuses — quelques dizaines au maximum), puis filtrer en mémoire.
// Le gain de RAM vient du fait qu'on ne stocke pas allPositions dans
// resolvedPositions (qui est limité à 500), pas du fait qu'on évite le SELECT.
```

**Vérification** :
1. `npm run build` passe
2. Avec une DB de > 500 positions résolues, vérifier que `resolvedPositions.length === 500` dans le dashboard
3. Vérifier que `realizedPnl`, `wins`, `losses` dans le panneau Performance correspondent aux totaux DB (pas seulement les 500 récentes)

---

### Fix 3.3 — Spam de logs SSE en cas de déconnexion

**Problème** : `useEventSource.ts:24` log "Connexion SSE perdue" à chaque tentative de reconnexion. EventSource se reconnecte en boucle → centaines de logs.

**Fichier** : `frontend/src/hooks/useEventSource.ts`

**Interaction avec Fix 4.1** : Le Fix 4.1 propose de supprimer `connectionStatus` (jamais lu). Ce fix (3.3) utilise encore `setConnectionStatus`. **Il faut exécuter Fix 4.1 avant Fix 3.3**, ou les fusionner : la version corrigée ci-dessous supprime les appels à `setConnectionStatus` (puisqu'il sera supprimé par 4.1) ET corrige le spam de logs.

**Changement** : Logger seulement la première déconnexion, pas les retries suivants. Utiliser un flag. Supprimer l'import et les appels à `setConnectionStatus` (pris en charge par Fix 4.1).

**Diff attendu (version fusionnée avec Fix 4.1)** :
```ts
import { onCleanup, onMount } from "solid-js";
import type { BotEvent } from "../types";
import { addLog } from "../stores/logStore";

export function useEventSource(onEvent: (event: BotEvent) => void): void {
  let wasConnected = false;
  let loggedDisconnect = false;

  onMount(() => {
    const es = new EventSource("/events");

    es.onopen = () => {
      wasConnected = true;
      loggedDisconnect = false; // reset pour la prochaine déconnexion
    };

    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as BotEvent);
      } catch {
        /* ignore malformed */
      }
    };

    es.onerror = () => {
      if (wasConnected && !loggedDisconnect) {
        addLog("Connexion SSE perdue, reconnexion…", undefined, true);
        loggedDisconnect = true;
      }
    };

    onCleanup(() => es.close());
  });
}
```

**Vérification** :
1. `npm --prefix frontend run build` passe
2. Couper le backend → un seul log "Connexion SSE perdue" au lieu de dizaines
3. Relancer le backend → connexion rétablie, pas de log superflu

---

## Phase 4 — Code mort

### Fix 4.1 — Supprimer le code mort frontend

**Problème** : 7 symboles frontend sont exportés mais jamais importés/utilisés.

**Fichiers et changements** :

| Symbole | Fichier | Action |
|---|---|---|
| `useAction` | `frontend/src/hooks/useApi.ts` | **Supprimer le fichier entier** (aucun import) |
| `Button` | `frontend/src/components/ui/Button.tsx` | **Supprimer le fichier entier** (aucun import) |
| `clearLogs` | `frontend/src/stores/logStore.ts` | Supprimer la fonction (lignes 18-20) |
| `simulatedBaseCapital` | `frontend/src/App.tsx` | Supprimer la déclaration (ligne 36) et l'usage (ligne 86) |
| `isDryRun` | `frontend/src/stores/botStore.ts` | Supprimer la ligne 17 |
| `connectionStatus` | `frontend/src/stores/botStore.ts` | Supprimer les lignes 5-7 et l'import dans `useEventSource.ts` |
| `api.history` | `frontend/src/api/client.ts` | Supprimer la méthode `history` (ligne 47) et l'interface `HistoryResponse` (lignes 20-29) |

**Note sur `connectionStatus`** : `setConnectionStatus` est appelé dans `useEventSource.ts` mais la valeur n'est jamais lue. Deux options :
- **Option A** : Supprimer le signal + les appels (nettoyage complet)
- **Option B** : Garder le signal et l'afficher dans le Header (ajoute une feature)

**Recommandation** : Option A (supprimer). Si on veut afficher le statut de connexion, c'est une feature séparée à planifier.

**Note sur `api.history`** : L'endpoint `/api/history` existe côté serveur et fonctionne. Si on supprime `api.history` du client, on supprime aussi `HistoryResponse`. Si on prévoit d'ajouter un panneau d'historique, garder l'endpoint serveur.

**Vérification** :
1. `npm --prefix frontend run build` passe (le compilateur TS détectera les imports manquants)
2. Le dashboard fonctionne : ConfigBar, OpenPositions, RecentOrders, Performance, ResolvedPositions, PolymarketPositions, Logs, reset, redeem

---

### Fix 4.2 — Supprimer le code mort backend

**Problème** : 5 symboles backend sont définis mais jamais appelés.

**Fichiers et changements** :

| Symbole | Fichier | Action |
|---|---|---|
| `Database.transaction` | `src/db/database.ts:166-177` | Supprimer la méthode |
| `KeyRepository.has` | `src/db/repositories.ts:223-229` | Supprimer la méthode |
| `PostedOrderRepository.has` | `src/db/repositories.ts:294-300` | Supprimer la méthode |
| `WindowClaimRepository.get` | `src/db/repositories.ts:351-356` | Supprimer la méthode |
| `GammaMarket.question` | `src/types.ts:4` | Supprimer le champ |
| `this.clients` (Set) | `src/dashboard/server.ts:29` | Supprimer le champ + `this.clients.add(send)` (ligne 177) + `this.clients.delete(send)` (ligne 186) |

**Note sur `GammaMarket.question`** : Vérifier que le frontend ne l'utilise pas non plus → `frontend/src/types/index.ts:7` déclare `question: string` mais aucune lecture confirmée. Supprimer des deux côtés.

**Note sur `this.clients`** : Le Set est maintenu mais jamais itéré. `bus.subscribe` + `unsubscribe` suffisent pour la gestion des SSE. Supprimer le Set et les appels add/delete.

**Vérification** :
1. `npm run build` passe
2. Le dashboard SSE fonctionne (les événements arrivent toujours)

---

## Phase 5 — Documentation

### Fix 5.1 — Corriger les incohérences README.md

**Fichier** : `README.md`

| Ligne | Texte actuel | Texte corrigé |
|---|---|---|
| 42 | `# HTTP + SSE dashboard (port 3000)` | `# HTTP + SSE dashboard (port 3105)` |
| 110 | `SIM_RESOLVE_DELAY_SECONDS=5` | `SIM_RESOLVE_DELAY_SECONDS=60` |
| 172-174 | "The backend serves the built assets from `dist/dashboard/public/` (compiled) or `src/dashboard/public/` (tsx dev). The Vite build output is copied to `src/dashboard/public/` so `npm start` (tsx) serves the SolidJS dashboard too." | "The backend serves the built assets from `dist/dashboard/public/` (compiled, via `tsc`/`npm start`) or `src/dashboard/public/` (tsx dev). The Vite build outputs to `dist/dashboard/public/` (`vite.config.ts:outDir`). To serve the dashboard with `npm start` (tsx, without `tsc`), run `npm run build:dashboard` first — Vite writes to `dist/dashboard/public/`, and `src/dashboard/public/` must be manually synced." |
| 195 | "max 3 orders per outcome" | "max 1 order per outcome (configurable via `MAX_OPEN_POSITIONS_PER_SIDE`)" |

**Vérification** : Relire le README corrigé et croiser chaque valeur avec le code (`config.ts` defaults, `server.ts` port, `vite.config.ts` outDir).

---

### Fix 5.2 — Supprimer les docs obsolètes (optionnel)

**Fichiers** : `DRYRUN_PLAN.md`, `SOLIDJS_MIGRATION_PLAN.md`

Ce sont des documents de conception qui ont été implémentés. Ils ne sont plus utiles au quotidien et peuvent induire en erreur (les valeurs par défaut mentionnées diffèrent du code final). À moins de les garder pour historique, les supprimer ou les déplacer dans un dossier `docs/archive/`.

**Recommandation** : Les déplacer dans `docs/archive/` plutôt que les supprimer.

---

## Ordre d'exécution résumé

**Important** : Fix 3.3 et Fix 4.1 doivent être exécutés **ensemble** (fusion) pour éviter une contradiction sur `connectionStatus`. L'ordre ci-dessous reflète cette dépendance.

| # | Fix | Priorité | Effort | Risque | Dépendance |
|---|---|---|---|---|---|
| 1.1 | Clé privée servie au frontend | **Critique** | 2 lignes | Aucun | — |
| 1.2 | Secrets builder/relayer dans PublicBotConfig | **Critique** | 10 lignes | Aucun | — |
| 1.3 | CSRF sur /api/reset et /api/redeem | **Haute** | 15 lignes | Faible (vérifier dev Vite) | — |
| 2.1 | Déclarer builder-signing-sdk | **Haute** | 1 ligne | Aucun | — |
| 2.2 | Supprimer stats_snapshots | **Moyenne** | 4 fichiers | Faible | — |
| 2.3 | BalanceTracker en dryRun | **Moyenne** | 3 lignes | Faible (snapshot `source:"live"` en dryRun — voir note) | — |
| 3.1 | Fill price live = bestAsk | **Moyenne** | 5 lignes | Faible (conservateur → précis, bestAsk possiblement obsolète) | — |
| 3.2 | loadFromDb + MAX_RESOLVED_IN_MEMORY | **Moyenne** | 20 lignes + 2 méthodes SQL | Moyen (SQL NULL, reconstruction paires) | — |
| 3.3+4.1 | Spam logs SSE + code mort frontend (fusion) | **Basse** | 3 fichiers supprimés + éditions | Aucun | **Fusion obligatoire** — 3.3 utilise `setConnectionStatus` que 4.1 supprime |
| 4.2 | Code mort backend | **Basse** | 5 fichiers édités | Aucun | — |
| 5.1 | README.md | **Basse** | 4 corrections | Aucun | — |
| 5.2 | Docs obsolètes | **Optionnel** | déplacement | Aucun | — |

**Total** : ~12 interventions, ~70 lignes de code changées, 3 fichiers supprimés, 0 fichier créé.

---

## Vérification globale finale

Après tous les fixes :

1. `npm run build` — passe sans erreur
2. `npm --prefix frontend run build` — passe sans erreur
3. `npm run build:all` — passe sans erreur
4. Démarrer en dryRun : dashboard fonctionne, pas d'erreur SQLite, SSE arrive
5. Démarrer en live (si creds disponibles) : `curl http://127.0.0.1:3105/api/state` ne contient aucun secret
6. `curl -X POST http://127.0.0.1:3105/api/reset -H "Origin: http://evil.com"` → 403
7. Pas de log "Connexion SSE perdue" en boucle quand le backend est down
8. Panneau "Positions Polymarket" affiche des données en dryRun (si FUNDER_ADDRESS défini)
9. `npm ls @polymarket/builder-signing-sdk` — version affichée, pas de warning
10. Aucun fichier orphelin dans le frontend (`useApi.ts`, `Button.tsx` supprimés)