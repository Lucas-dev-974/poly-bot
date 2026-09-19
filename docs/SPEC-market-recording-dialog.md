# SPEC — Dialog « Enregistrements » (marchés : enregistrement / trading par slug)

Statut : plan d'implémentation (non implémenté).
Périmètre : dashboard feature pass — dialog + routes API + table DB. **Aucune clé runtime-settings**, aucun moteur de stratégie touché.

---

## 1. Objectif

Un dialog dédié permettant, par **famille de marchés (préfixe de slug)** :

1. activer / désactiver **l'enregistrement** des données marché (`market_snapshots` + `book_snapshots`),
2. activer / désactiver **le trading** sur cette famille (nouveaux entries uniquement),
3. **ajouter une famille** de marchés (ex. `sol-updown-15m`) à l'univers scanné.

### Décision de conception : préfixe, pas slug exact

Les slugs sont éphémères (`btc-updown-15m-1758…` → fenêtre de 15 min). Des toggles par slug exact mourraient en quelques minutes. La granularité retenue est le **préfixe de famille**, identique à `marketSlugPrefixes` (découverte : le slug se termine toujours par `-<windowStart epoch-sec>` à 10 chiffres, cf. `parseWindowStart`, `src/utils/market.ts:5`). Utilitaire inverse ajouté :

```ts
// src/utils/market.ts
export function prefixOfSlug(slug: string): string {
  return slug.replace(/-\d{10}$/, "");
}
```

### Décision : pas de nouvelle clé runtime-settings

`marketSlugPrefixes` reste la source de vérité de l'**univers scanné** (hot-apply + persistance `data/bot-settings.json` + intégration backtest existante). Les toggles par famille vivent dans une **table SQLite dédiée** (`market_rules`), pattern `withdrawals`/`strategy_graphs` : table = source de vérité, pas d'événement persisté, pas de clé dans `EDITABLE_CONFIG_KEYS` (un ajout dans `sanitizePatch` serait un second chemin de persistance redondant).

---

## 2. Modèle de données

### 2.1 Table `market_rules` (`src/db/database.ts`)

```sql
CREATE TABLE IF NOT EXISTS market_rules (
  prefix            TEXT PRIMARY KEY,
  recordingEnabled  INTEGER NOT NULL DEFAULT 1,
  tradingEnabled    INTEGER NOT NULL DEFAULT 1,
  addedBy           TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'default'
  createdAt         INTEGER NOT NULL,
  updatedAt         INTEGER NOT NULL
);
```

- Ajouter au `CREATE TABLE IF NOT EXISTS` bloc de `Database.init()`.
- Ajouter `DELETE FROM market_rules;` dans `reset()` (liste existante).
- Aucune colonne ajoutée aux tables existantes. Pas de nouvel index (clé primaire suffit).

### 2.2 Repository (`src/db/repositories.ts`)

```ts
export interface MarketRuleRow {
  prefix: string;
  recordingEnabled: number; // 0|1
  tradingEnabled: number;   // 0|1
  addedBy: string;
  createdAt: number;
  updatedAt: number;
}

export class MarketRuleRepository {
  constructor(private readonly db: Database) {}
  list(): MarketRuleRow[];                       // ORDER BY prefix
  get(prefix: string): MarketRuleRow | undefined;
  setFlags(prefix: string, patch: { recordingEnabled?: boolean; tradingEnabled?: boolean }, addedBy?: string): void; // INSERT OR REPLACE, updatedAt=now ; created conserve via COALESCE
  ensureDefaults(prefixes: string[]): void;      // INSERT OR IGNORE recording=1, trading=1, addedBy='default'
}
```

- Brancher aux **TROIS spots** habituels de `src/db/index.ts` : import, champ `marketRules: MarketRuleRepository` de l'interface `Repositories`, instanciation dans `createRepositories`.

### 2.3 Seed / migration au bootstrap

Dans `src/index.ts`, après `createRepositories(db)` et avant la construction du bot :

```ts
repos.marketRules.ensureDefaults(config.marketSlugPrefixes);
```

Idempotent (`INSERT OR IGNORE`) : au premier démarrage les familles existantes (`btc-updown-15m`, `eth-updown-15m`) apparaissent `recording=1 / trading=1 / addedBy='default'` → **zéro changement de comportement** à la migration.

---

## 3. Module règles : `src/market-rules.ts` (nouveau)

Cache processus + logique pure testable. Bot et dashboard sont **dans le même process** (`src/index.ts`) et partagent `repos` — le handler API écrit la DB puis met à jour le cache ; le bot lit le cache au tick.

```ts
export type MarketFlags = { recording: boolean; trading: boolean };

export class MarketRuleStore {
  private flags = new Map<string, MarketFlags>();

  static defaultFlags: MarketFlags = { recording: true, trading: true };

  loadFromDb(repos: Repositories): void;          // remplit depuis marketRules.list()
  get(prefix: string): MarketFlags;               // fallback = defaultFlags (famille inconnue = enregistrée + tradable, compat)
  setFlags(prefix: string, patch: {...}, repos): void; // écrit DB + cache
  addPrefix(prefix: string, repos): void;         // INSERT OR IGNORE + cache
}

/** Logique pure, unit-testable sans DB ni tick loop. */
export function splitEventsByRules(
  events: UpDownEvent[],
  getFlags: (prefix: string) => MarketFlags,
): Array<{ event: UpDownEvent; recording: boolean; trading: boolean }>;
```

Règles de filtrage (appliquées par `splitEventsByRules`) :

| recording | trading | Comportement |
|---|---|---|
| 1 | 1 | flux actuel inchangé |
| 1 | 0 | books fetchés + enregistrés, `resting` géré, **aucun** `findOpportunities`, **aucun** executor |
| 0 | 1 | books fetchés (nécessaires au trading) mais **pas** de snapshots insérés ; `market_snapshots` non insérés |
| 0 | 0 | event **entièrement sauté** : pas de fetch CLOB `getTokenBooks` (économie réseau), aucun insert |

Cas limite documenté : `recording=0 && trading=0` alors qu'un GTC reposé existe encore sur la famille → l'ordre n'est plus géré jusqu'à réactivation. Mitigé par le garde API (§4.2) qui refuse de désactiver le trading s'il existe une exposition ouverte sur la famille.

---

## 4. Backend — intégration & routes

### 4.1 Intégration tick (`src/bot/reverse-bot.ts`)

Points exacts, minimalisme :

```ts
// constructor : this.rules = new MarketRuleStore() (partagé, injecté depuis index.ts ou créé ici + hydraté)
// init() : this.rules.loadFromDb(this.repos)  (après tracker.loadFromDb())

private async tick(): Promise<void> {
  ...
  const scanned = await this.scanner.scan();
  this.assertTickActive(session);
  const flagged = splitEventsByRules(scanned, (p) => this.rules.get(p));
  const events = flagged.filter((f) => f.recording).map((f) => f.event);
  // ^ insertMarketSnapshots ne voit que les familles recording=1
  ...
  eventCount = events.length; // (nb enregistré ; garder scanned.length dans le log de scan)

  for (const { event, recording, trading } of flagged) {
    if (!recording && !trading) continue;            // skip total, pas de fetch CLOB
    this.assertTickActive(session);
    await this.processEvent(event, tickTs, session, { recording, trading });
  }
}

private async processEvent(event, tickTs, session, flags: { recording: boolean; trading: boolean }) {
  const books = await this.scanner.getTokenBooks(event);
  this.assertTickActive(session);
  if (flags.recording) this.snapshots.insertBooks(event, books, tickTs);
  if (!this.paused) { await this.resting.manageLiveResting(event, books); ... }
  bus.emit({ type: "watching", event, books });     // inchangé
  if (!flags.trading) return;                        // trading off : stop AVANT la fenêtre de trading
  if (!this.scanner.inTradingWindow(event, nowMs / 1000)) return;
  if (this.paused) return;
  ... findOpportunities / insertOpportunities / executor (inchangés)
}
```

- `market-scanner.ts` **non modifié** (reste pure config `marketSlugPrefixes`).
- Le resolver, `manageLiveResting`, la pause globale, le watchdog : inchangés (le toggle par famille ne remplace ni la pause ni le mode readonly).
- Hydrater aussi le cache au démarrage du `DashboardServer` n'est pas nécessaire : l'API passe par le store partagé.

### 4.2 Routes API (`src/dashboard/server.ts`, toutes derrière `isAllowedOrigin`)

| Route | Méthode | Body | Effet |
|---|---|---|---|
| `/api/market-rules` | GET | — | `{ rules: MarketRuleRow[], configPrefixes: string[], discovered: Array<{prefix, lastSeenTs, slugCount}> }` |
| `/api/market-rules/add` | POST | `{ prefix }` | Ajoute la famille : validation + `marketRules.setFlags(..., addedBy:'user')` + PATCH `marketSlugPrefixes` (append) via `applyRuntimeSettings` |
| `/api/market-rules/toggle` | POST | `{ prefix, field: "recording"\|"trading", enabled: boolean }` | Garde de sécurité puis `marketRules.setFlags` |

**GET** — `discovered` : familles vues dans `market_snapshots` (90 derniers jours, `SELECT prefix ...` via SQL sur slug : `substr(eventSlug, 1, length(eventSlug) - 11)`, groupé, `MAX(ts)`) **absentes** de `configPrefixes`. Sert de suggestion pour l'ajout. Le scan live lui-même est un appel Gamma partagé — pas de découverte on-demand dans v1 (limite annoncée).

**POST /add** — validation :
- format : `^[a-z0-9]+(-[a-z0-9]+)*-updown-15m$` (famille 15m uniquement — le scanner hardcode `tag_slug=15M` et `WINDOW_SECONDS=900` ; un préfixe 5m serait enregistré avec de mauvaises bornes de fenêtre → **rejeté** en v1, cf. §8) ;
- anti-doublon (PK) + déjà présent dans `marketSlugPrefixes` → idempotent OK ;
- mutation de l'univers via le chemin existant : construire `nextPrefixes = [...config.marketSlugPrefixes, prefix]` puis `applyRuntimeSettings(this.config, { marketSlugPrefixes: nextPrefixes }, undefined, leadsWithEdge)` + `this.configHandler?.(changed)` → persistance `bot-settings.json` + événement `config` SSE + hot-apply immédiat (le tick suivant scanne la nouvelle famille). Réutiliser la sémantique d'erreur 400 de `handlePatchConfig`.
- `ensureDefaults([prefix])` pour la ligne de règle (recording=1, trading=1) — l'ajout n'active que la scan ; les toggles restent ensuite l'état de la table.

**POST /toggle** — garde de sécurité **avant** mutation :
- `tradingEnabled=false` refusé (HTTP 409) si la famille porte une exposition vivante : positions `open` ou ordres `resting` dont `prefixOfSlug(eventSlug) === prefix` (requêtes sur `positions` / `posted_orders` déjà exposées par le tracker ; ajouter deux méthodes de comptage ciblées dans les repos plutôt qu'un full-scan JS si trivial — sinon full-scan sur tables petites, acceptable).
- `recording=false` autorisé même avec exposition (l'enregistrement n'est pas requis pour la gestion des ordres) mais la réponse porte un `warning` : « la fenêtre ne sera plus complète pour le backtest ».
- Écrit DB + cache + réponse `{ ok, rule }`.

**Erreurs** : 400 (format), 404 (famille inconnue au toggle), 409 (exposition ouverte). Même shape `{ ok: false, error }` que le reste du serveur.

### 4.3 Événements SSE

**Aucun nouveau type** — pas d'entrée dans l'union `BotEvent`, pas de `PERSISTED_EVENT_TYPES` : la table est la source de vérité et le dialog refetch au montage + après chaque action (même choix que `withdrawals`).

---

## 5. Frontend

### 5.1 API client (`frontend/src/api/client.ts`)

```ts
export interface MarketRuleRow { prefix: string; recordingEnabled: number; tradingEnabled: number; addedBy: string; createdAt: number; updatedAt: number; }
export interface DiscoveredPrefix { prefix: string; lastSeenTs: number; slugCount: number; }

// dans api :
marketRules: () => request<MarketRulesResponse>("/api/market-rules"),
addMarketRule: (body: { prefix: string }) =>
  request<{ ok: boolean; rule?: MarketRuleRow; error?: string }>("/api/market-rules/add", { method: "POST", ... }),
toggleMarketRule: (body: { prefix: string; field: "recording" | "trading"; enabled: boolean }) =>
  request<{ ok: boolean; rule?: MarketRuleRow; warning?: string; error?: string }>("/api/market-rules/toggle", { method: "POST", ... }),
```

### 5.2 Modal `frontend/src/components/modals/MarketRecordingModal.tsx`

Pattern `WalletModal` : `.modal-overlay` / `.modal` + petit append CSS dans `components.css` (palette exclusivement `frontend/src/styles/variables.css` : `--bg, --panel, --border, --text, --muted, --accent, --green, --red, --amber` ; miroir des inputs `.cfg-input` pour les selects/inputs).

Contenu :

```
┌─ Enregistrements ────────────────────────────────────────────────┐
│ Ajouter une famille : [ sol-updown-15m____________ ] [ Ajouter ] │
│   suggestions (vues récemment, non configurées) : • sol-updown-15m │
│ ──────────────────────────────────────────────────────────────── │
│ FAMILLE        LIVE   ENREGISTREMENT   TRADING   AJOUTÉ          │
│ btc-updown-15m   ●    [toggle ON ]   [toggle ON]   default       │
│ eth-updown-15m   ●    [toggle ON ]   [toggle OFF]  user          │
│ ──────────────────────────────────────────────────────────────── │
│ ℹ Désactiver l'enregistrement rend la fenêtre incomplète pour le │
│   backtest. Désactiver le trading n'arrête pas la gestion des    │
│   ordres reposés ni la résolution des positions.                 │
└──────────────────────────────────────────────────────────────────┘
```

- Badge « LIVE » = famille présente dans `configPrefixes` ET vue dans le dernier scan (`lastSeenTs` < 2 min) — sinon grise « hors scan ».
- Toggle = bouton 2 états (comme le switch bot du Header) avec état optimiste + rollback sur erreur, **`notifyError` sur le chemin catch** en plus d'`addLog` (règle projet : toute action dashboard notifie, même onglet focus).
- Toggle `trading` désactivé (grisé, tooltip) tant que l'exposition est ouverte → l'erreur 409 explique le refus de toute façon.
- Champ d'ajout : validation côté client (même regex), désactivé pendant le POST.
- Données : `createEffect` sur `props.open` → `api.marketRules()` (la modale reste montée, `onMount` ne rejoue pas à la réouverture) ; refetch après chaque action.
- Persister le champ libre : `localStorage.setItem("market-recording.lastPrefix", ...)` (pattern Wallet).

### 5.3 Wiring

- `App.tsx` : signal `recordingOpen` + `<MarketRecordingModal open={recordingOpen()} onClose={...} />` (après WalletModal).
- `Header.tsx` : bouton « Enregistrements » à côté du bouton Wallet (même style).
- `frontend/src/types/index.ts` : les types ci-dessus (le fichier est le miroir frontend des types backend).

---

## 6. Tests

Nouveau fichier `tests/market-rules.test.ts` (ajouté au script `test` de `package.json` **via round-trip node JSON.parse/stringify**, jamais par patch de la ligne) :

1. **Repo roundtrip** : mkdtempSync → `Database` + `createRepositories` → `ensureDefaults` idempotent (2 appels → 2 lignes, pas de doublon) → `setFlags` mutation → `get`/`list` reflètent les flags et `updatedAt` → `db.close()` **avant** `rmSync` (règle EBUSY Windows / WAL).
2. **`splitEventsByRules` (pur)** : les 4 combinaisons recording/trading → classes attendues ; famille inconnue → flags par défaut ; préfixe extrait correctement d'un vrai slug (`btc-updown-15m-1758000000` → `btc-updown-15m`).
3. **Garde toggle** : tracker temp-DB avec 1 position `open` sur la famille → la logique de garde (fonction pure exportée, ex. `assertToggleAllowed`) jette ; famille sans exposition → OK. Probe e2e one-off optionnelle (`scripts/research/<topic>/`, supprimée après run) : full tick sur work-DB, `recording=0` → zéro nouvelle ligne `book_snapshots` pour la famille, `trading=0` → zéro `opportunity_snapshots`, famille 0/0 → zéro fetch (mock scanner).

Existants à relancer : `npx tsx tests/presets.test.ts` (aucune clé preset touchée → doit rester vert ; sert de classification si échec préexistant), suite DB existante.

---

## 7. Ordre d'implémentation

1. `src/utils/market.ts` : `prefixOfSlug` (+ test unitaire dans le fichier tests ci-dessus).
2. `src/db/database.ts` : table + `reset()` ; `src/db/repositories.ts` : `MarketRuleRepository` ; `src/db/index.ts` : 3 spots.
3. `src/market-rules.ts` : store + `splitEventsByRules` + garde pure.
4. `src/index.ts` : seed `ensureDefaults(config.marketSlugPrefixes)` au bootstrap.
5. `src/bot/reverse-bot.ts` : intégration tick (§4.1).
6. `src/dashboard/server.ts` : 3 routes (§4.2).
7. `tests/market-rules.test.ts` + ajout au script `test`.
8. Frontend : types → `api/client.ts` → modal + CSS → Header + App.
9. Vérification : `npm run build` → `npx tsx tests/market-rules.test.ts` → suite complète → `npm --prefix frontend run build`.

Commits ciblés (convention repo) : un commit backend (1-7), un commit frontend (8) — jamais les fichiers d'autres tâches.

---

## 8. Limites annoncées (à dire au user, pas à cacher)

- **15m uniquement** : le scanner hardcode `tag_slug=15M` (et `WINDOW_SECONDS=900`) ; un préfixe d'un autre timeframe est rejeté par validation tant que le pass multi-timeframe n'a pas débranché ces ancres.
- **Pas de suppression de famille** en v1 (seul l'ajout est demandé) ; une famille reste dans `marketSlugPrefixes` et dans la table même désactivée.
- `opportunity_snapshots` reste naturellement vide pour `trading=0` (aucune opportunité générée) — ce n'est pas un bug.
- Désactiver l'enregistrement casse la complétude des fenêtres futures de cette famille pour le backtest (warning affiché).
- `orders` ne porte pas `strategyId` (limite existante) — hors scope ici.

## 9. Critères d'acceptation

- [ ] Toggle recording off → plus aucune ligne `market_snapshots`/`book_snapshots` pour la famille, trading inchangé.
- [ ] Toggle trading off → plus aucune opportunité/entry pour la famille ; ordres reposés et résolution continuent.
- [ ] Recording+trading off → événement entièrement sauté (pas de fetch CLOB).
- [ ] Ajout d'une famille → visible au tick suivant (scan Gamma), persistée dans `bot-settings.json` ET `market_rules`, recording/trading par défaut ON.
- [ ] Toggle trading refusé (409) avec exposition ouverte ; message explicite.
- [ ] Redémarrage : règles et préfixes conservés (SQLite + bot-settings.json), seed idempotent.
- [ ] `npm run build`, suite de tests complète, `npm --prefix frontend run build` verts.