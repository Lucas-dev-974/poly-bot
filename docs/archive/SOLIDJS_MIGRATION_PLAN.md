# SolidJS Frontend Migration Plan (v2 — vérifié contre le code)

## Current State Analysis

The existing dashboard (`src/dashboard/public/index.html`) is a **single 850-line vanilla JS file** with:
- Embedded CSS (CSS custom properties for theming)
- SSE connection to `/events` endpoint
- REST calls to `/api/state`, `/api/open-positions`, `/api/resolved-positions`, `/api/history`, `/api/reset`, `/api/redeem`
- Manual DOM manipulation via `innerHTML` and `document.createElement`
- Complex state: `markets` Map, `orders` array, `openPositions`/`resolvedPositions`/`polyPositions` arrays
- 12+ render functions for different panels
- Redeem workflow with confirmation modal + loading state tracking

**Facts vérifiés dans le code :**
- Port du dashboard : **3105** (`config.ts:119`, `.env.example:43` — `DASHBOARD_PORT=3105`)
- Backend : `tsx src/index.ts` (dev), `tsx watch` (watch), `tsc` (build) — `package.json:7-9`
- Le serveur sert `src/dashboard/public/index.html` en dev (tsx) et `dist/dashboard/public/index.html` en prod (tsc) — `server.ts:10` via `import.meta.url`
- `tsc` ne copie PAS les fichiers statiques : `dist/dashboard/public/index.html` doit être produit par le build frontend (ou copié)
- 3 modes d'affichage : DRY RUN / LIVE (READONLY) / LIVE (`config.readonlyLive` existe, `config.ts:52`)
- Le tsconfig racine inclut `src/**/*` avec `module: NodeNext`, `types: ["node"]`, **sans config JSX** — tout `.tsx` placé sous `src/` casse le build backend

---

## Target Architecture

```
polymarket-reverse-arbitrage-bot/
├── src/                          # Backend (inchangé)
│   ├── dashboard/
│   │   ├── server.ts             # Sert le HTML + API (inchangé)
│   │   ├── events.ts
│   │   ├── balance.ts
│   │   └── public/
│   │       └── index.html        # REMPLACÉ par le build Vite (prod) / fallback dev
│   └── ...
├── frontend/                     # NOUVEAU — projet SolidJS isolé (hors de src/)
│   ├── index.html                # Entrée Vite
│   ├── package.json
│   ├── tsconfig.json             # Config SolidJS (jsxImportSource: solid-js)
│   ├── vite.config.ts            # outDir → ../dist/dashboard/public + proxy dev
│   └── src/
│       ├── main.tsx              # Bootstrap
│       ├── App.tsx               # Root + providers
│       ├── styles/
│       │   ├── variables.css     # CSS custom properties (repris du HTML actuel)
│       │   ├── globals.css
│       │   └── components.css
│       ├── components/
│       │   ├── ui/               # Badge, Button, Table, Panel, Loading, EmptyState
│       │   ├── layout/           # Header, Grid, MarketCard
│       │   ├── panels/           # OpenPositions, ActiveMarkets, RecentOrders,
│       │   │                     # Performance, ResolvedPositions,
│       │   │                     # PolymarketPositions, Logs
│       │   └── modals/           # ConfirmModal
│       ├── hooks/
│       │   ├── useEventSource.ts # SSE + gestion onerror (reconnexion native EventSource)
│       │   ├── useApi.ts         # Fetch typé + gestion erreurs
│       │   └── useInterval.ts    # Polling (countdowns, sync REST 1s)
│       ├── stores/
│       │   ├── botStore.ts       # config, mode (dry/live/readonly), connexion
│       │   ├── marketStore.ts    # Record<slug, MarketView> (PAS de Map — voir note)
│       │   ├── positionStore.ts  # open + resolved
│       │   ├── orderStore.ts     # ordres récents (max 100)
│       │   ├── statsStore.ts     # simulatedStats
│       │   ├── polyStore.ts     # positions Polymarket
│       │   └── logStore.ts       # logs (ring buffer 500)
│       ├── api/
│       │   ├── client.ts         # Client typé (state, open/resolved, reset, redeem)
│       │   └── types.ts          # Types miroir du backend
│       ├── utils/
│       │   ├── format.ts         # fmtPrice, fmtUsd, countdown, pct
│       │   └── helpers.ts        # marketCoverage, currentBidForPosition
│       └── types/
│           └── index.ts          # Types partagés frontend
├── package.json                  # Scripts build ajustés (voir Phase 5)
└── tsconfig.json                 # INCHANGÉ — frontend hors de src/ = aucun conflit
```

---

## Implementation Phases

### Phase 1: Project Setup & Foundation (Day 1)

**Tasks:**
1. **Créer le projet SolidJS + Vite + TS dans `frontend/`** (PAS dans `src/dashboard/` — le tsconfig racine inclut `src/**/*` et casserait le build backend avec du JSX non configuré)
   ```bash
   mkdir frontend && cd frontend
   npm create vite@latest . -- --template solid-ts
   npm install
   ```

2. **Configurer Vite** (`frontend/vite.config.ts`):
   - `build.outDir: '../dist/dashboard/public'` → le serveur compilé (`dist/dashboard/server.js`) sert le build via `HTML_PATH` (`server.ts:10`)
   - `base: '/'` (le serveur sert à la racine)
   - Dev : `server.proxy` → `/api` et `/events` vers `http://127.0.0.1:3105` (port réel du backend)

3. **Extraire le CSS** de l'actuel `index.html` → `frontend/src/styles/variables.css` + `globals.css`

4. **Créer les types partagés** (`frontend/src/types/index.ts`) en miroir de `src/types.ts` + `src/dashboard/events.ts` (BotEvent, SimulatedPosition, TradeOpportunity, TokenBook, UpDownEvent, SimulatedStats, PolymarketPosition, BalanceSnapshot, OrderResult, BotConfig)

5. **API client** (`frontend/src/api/client.ts`) : wrappers typés pour `/api/state`, `/api/open-positions`, `/api/resolved-positions`, `/api/history`, `/api/reset` (POST), `/api/redeem` (POST)

---

### Phase 2: State Management & SSE (Day 1-2)

**Core Concept:** Solid Signals/Stores = source de vérité unique. Les événements SSE mutent les stores → l'UI réagit automatiquement.

**`stores/botStore.ts` — Coordonnateur central :**
```typescript
// Signal de connexion SSE
export const connectionStatus = createSignal<'connecting' | 'connected' | 'disconnected'>('connecting')

// Mode dérivé : 'dry' | 'readonly' | 'live'  (3 modes — config.readonlyLive existe)
export const mode = createMemo(() => {
  const c = config()
  if (c.dryRun) return 'dry'
  if (c.readonlyLive) return 'readonly'
  return 'live'
})
```

**`stores/marketStore.ts` — IMPORTANT : utiliser `Record`, pas `Map` :**
```typescript
// Les stores Solid ne trackent PAS les mutations de Map (set/delete).
// Utiliser un objet indexé par slug + setMarkets(slug, view) par chemin.
export const [markets, setMarkets] = createStore<Record<string, MarketView>>({})

export function upsertMarket(event: UpDownEvent, books: TokenBook[]) {
  setMarkets(event.slug, { ...event, books, reverseTokenId: undefined })
}
export function setReverseToken(slug: string, tokenId: string) {
  setMarkets(slug, 'reverseTokenId', tokenId)
}
export function clearMarkets() { setMarkets({}) }
```

**`stores/positionStore.ts`:**
```typescript
// Positions ouvertes : Record<id, SimulatedPosition>
export const [openPositions, setOpenPositions] = createStore<Record<string, SimulatedPosition>>({})

// Résolues : tableau (ring buffer 100)
export const [resolvedPositions, setResolvedPositions] = createStore<SimulatedPosition[]>([])

// Actions : add, update, remove, resolve (avec batch() pour multi-store)
```

**`hooks/useEventSource.ts` — SSE :**
```typescript
export function useEventSource(onEvent: (event: BotEvent) => void) {
  // EventSource natif : la reconnexion est intégrée au navigateur.
  // On gère onerror → connectionStatus('disconnected') + log.
  // onopen → connectionStatus('connected').
  // Retourne le cleanup (close()).
}
```

**Intégration dans `App.tsx`:**
```tsx
function App() {
  useEventSource((event) => dispatchEvent(event))  // switch exhaustif sur event.type
  onMount(() => loadInitialState())                 // /api/state + open + resolved
  return <Layout>...</Layout>
}
```

---

### Phase 3: UI Components (Day 2-3)

**Hiérarchie :**
```
App
├── Header (badge mode 3 états, capital, bouton reset)
├── ConfigBar (paramètres stratégie)
├── Grid (2 colonnes responsive)
│   ├── Panel: OpenPositions
│   ├── Panel: ActiveMarkets
│   ├── Panel: RecentOrders
│   ├── Panel: Performance
│   ├── Panel: ResolvedPositions (full width)
│   ├── Panel: PolymarketPositions (full width)
│   └── Panel: Logs (full width)
└── ConfirmModal (portal)
```

**Composants clés :**

| Composant | Responsabilité |
|-----------|----------------|
| `Header` | Badge mode (DRY RUN / LIVE READONLY / LIVE), capital, reset DB |
| `ConfigBar` | Paramètres stratégie depuis config signal |
| `OpenPositions` | Groupement par marché, PnL latent, badge couvert/partiel, countdown |
| `ActiveMarkets` | Table : marché, fenêtre, token, bid/ask, rôle (underdog/favorite) |
| `RecentOrders` | Table avec chips statut (rempli/en attente/rejeté + raison) |
| `Performance` | Table stats : PnL réalisé, exposition, win/fill/cover rates |
| `ResolvedPositions` | Historique avec colorisation PnL |
| `PolymarketPositions` | Positions redeemable + bouton "Clôturer" + état de chargement |
| `Logs` | Ring buffer 500, auto-scroll, timestamps colorés |
| `Badge` | Réutilisable : cheap/expensive/live/dry/couvert/partiel |
| `Table` | États vide/chargement, responsive |
| `Panel` | Wrapper carte cohérent avec titre |

**Patterns SolidJS :**
- `<For each={...}>` pour les listes
- `<Show when={...}>` pour le conditionnel
- `createMemo` pour les dérivés (PnL latent, totaux)
- `createEffect` pour les effets (scroll logs, état modal)
- `batch()` pour les mises à jour multi-stores depuis un seul événement SSE
- Signal `now` mis à jour chaque seconde (useInterval) → countdowns en memos dérivés

---

### Phase 4: Feature Parity & Polish (Day 3-4)

**Comportements à reproduire depuis le vanilla JS :**
1. **Capital badge** — double mode : live (collateral + positions) vs sim (cash + coût ouvert)
2. **Chips statut ordres** — "en attente" (resting), "rempli @ $X", "rejeté · raison" (raisons : capital insuffisant, plafond exposition, pas d'ask, non rempli, lecture seule, pas un favori)
3. **Workflow redeem** — confirm → loading → succès/erreur → log. État par conditionId (redeemingConditions/redeemedConditions) pour ne pas perdre l'état au re-render SSE
4. **Market cards** — groupées par événement, badge couverture, PnL latent
5. **Countdowns** — mise à jour chaque seconde
6. **Logs** — max 500, auto-scroll
7. **Sync REST périodique** — `/api/open-positions` + `/api/resolved-positions` toutes les 1s (fallback si SSE perdu)
8. **Reset DB** — confirmation → POST `/api/reset` → vider tous les stores
9. **Badge mode 3 états** — DRY RUN / LIVE (READONLY) / LIVE (`config.readonlyLive`)

**Améliorations :**
- Typage exhaustif des événements (union discriminée sur `event.type`)
- UI optimiste pour le redeem (état "En cours…" immédiat)
- Modal accessible au clavier
- Breakpoints responsive (mobile : 1 colonne)

---

### Phase 5: Build Integration & Deploy (Day 4)

**Intégration backend :**
1. **Vite build** → `frontend/vite.config.ts` avec `outDir: '../dist/dashboard/public'` → le serveur compilé (`dist/dashboard/server.js`) sert le nouveau HTML via `HTML_PATH` (`server.ts:10`). **Résout aussi le problème actuel** : `tsc` ne copie pas les fichiers statiques, `dist/dashboard/public/index.html` devait être copié manuellement.
2. **Dev mode** : Vite dev server (5173) + proxy `/api` et `/events` → `http://127.0.0.1:3105`. Le backend tsx continue de tourner sur 3105.
3. **Mode tsx sans Vite** (optionnel) : copier le build vers `src/dashboard/public/` pour que le serveur tsx serve le nouveau HTML (`src/dashboard/server.ts` → `src/dashboard/public/index.html`).

**Scripts (NE PAS écraser le build backend existant) :**

`frontend/package.json` :
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

`package.json` racine — **garder `"build": "tsc"`** (backend seul, ne casse pas si le frontend n'est pas prêt) et ajouter :
```json
"build:dashboard": "npm --prefix frontend run build",
"build:all": "npm run build && npm run build:dashboard"
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
                            SOLIDJS FRONTEND                                   
├─────────────────────────────────────────────────────────────────────────────┤
                                                                                
   ┌──────────────┐     ┌──────────────────┐     ┌────────────────────────┐  
   │  EventSource │────▶│  Event Dispatcher │────▶│   Stores (Signals)     │  
   │  (SSE hook)  │     │  (switch on type) │     │  - markets (Record)    │  
   └──────────────┘     └──────────────────┘     │  - positions           │  
         ▲                                        │  - orders              │  
         │                                        │  - stats               │  
         │         ┌──────────────────┐          │  - polyPositions       │  
         └────────▶│  REST Polling    │─────────▶│  - logs                │  
                   │  (fallback sync) │          └───────────┬────────────┘  
                   └──────────────────┘                      │               
                                                             ▼               
   ┌──────────────┐     ┌──────────────────┐     ┌────────────────────────┐  
   │  Components  │◀───▶│  Derived Memos   │◀───▶│   UI (JSX)             │  
   │  (Panels)    │     │  (computed)      │     │  - Reactive bindings   │  
   └──────────────┘     └──────────────────┘     └────────────────────────┘  
                                                                                
   User Actions (redeem, reset) ──▶ API Client ──▶ Backend REST (3105)        
                                    │                                       
                                    ▼                                       
                             Optimistic Updates                             
                                                                                
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Type Definitions (Shared with Backend)

```typescript
// types/api.ts — miroir de src/dashboard/events.ts (union BotEvent)
export type BotEvent =
  | { type: 'config'; config: BotConfig }
  | { type: 'balance'; balance: BalanceSnapshot }
  | { type: 'simulatedBalance'; balance: number }
  | { type: 'scan'; count: number }
  | { type: 'watching'; event: UpDownEvent; books: TokenBook[] }
  | { type: 'opportunity'; opportunity: TradeOpportunity }
  | { type: 'order'; result: OrderResult; opportunity: TradeOpportunity }
  | { type: 'openedPosition'; position: SimulatedPosition }
  | { type: 'resolvedPosition'; position: SimulatedPosition }
  | { type: 'simulatedStats'; stats: SimulatedStats }
  | { type: 'polymarketPositions'; positions: PolymarketPosition[] }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string; data?: Record<string, unknown> };

// Types UI enrichis
export interface MarketView extends UpDownEvent {
  books: TokenBook[]
  reverseTokenId?: string
}

export interface OrderView {
  kind: 'cheap' | 'expensive'
  market: string
  slug: string
  tokenId: string
  outcome: string
  price: number
  fillPrice?: number
  size: number
  windowEnd: number
  filled: boolean
  reason?: string
}
```

---

## Migration Checklist

- [ ] **Phase 1**: Vite + SolidJS + TS dans `frontend/`, CSS extrait, API client, types
- [ ] **Phase 2**: Stores (Record pour markets), hook SSE, chargement initial
- [ ] **Phase 3**: Composants UI (Header, Panels, Tables, Badges, Modal)
- [ ] **Phase 4**: Parité (capital badge, chips ordres, redeem, countdowns, logs, reset, mode readonly)
- [ ] **Phase 5**: Build Vite → `dist/dashboard/public/`, scripts racine séparés, proxy dev 3105
- [ ] **Tests** : dry-run, live, reconnexion SSE, redeem, reset DB

---

## Estimated Effort

| Phase | Days | Risk |
|-------|------|------|
| 1. Setup & Foundation | 1 | Low |
| 2. State + SSE | 1.5 | Medium (SSE reconnection logic) |
| 3. Components | 2 | Low (port direct) |
| 4. Feature Parity | 1.5 | Medium (redeem workflow, edge cases) |
| 5. Build Integration | 0.5 | Low |
| **Total** | **~5-6 days** | |

---

## Notes & Decisions (vérifiées)

1. **Emplacement `frontend/` à la racine** — CRITIQUE : le tsconfig racine inclut `src/**/*` avec `module: NodeNext` et `types: ["node"]`, sans config JSX. Un projet SolidJS sous `src/dashboard/` serait compilé par `tsc` racine → erreurs de build. `frontend/` est hors de `src/` → aucun conflit.

2. **Port 3105** — le backend écoute sur `DASHBOARD_PORT=3105` (`config.ts:119`), pas 3000. Le proxy Vite doit pointer vers 3105.

3. **`createStore` avec `Record`, pas `Map`** — les stores Solid ne trackent pas les mutations de `Map` (set/delete). Utiliser un objet indexé + `setMarkets(slug, ...)` par chemin.

4. **CSS** : garder les custom properties existantes. CSS vanilla importé dans les composants — pas de CSS-in-JS.

5. **SSE** : `EventSource` natif a la reconnexion intégrée — le hook gère `onerror`/`onopen` pour l'état UI, pas de logique de reconnexion custom.

6. **Build backend préservé** : `"build": "tsc"` reste inchangé. `build:dashboard` et `build:all` sont des scripts ADDITIONNELS.

7. **`dist/dashboard/public/index.html`** : actuellement copié manuellement (tsc ne copie pas les statiques). Vite `outDir: '../dist/dashboard/public'` résout ce problème définitivement.

8. **Types partagés** : copie miroir pour l'instant (backend `src/types.ts` + `src/dashboard/events.ts`). Un package partagé est possible plus tard.

9. **Redeem** : conserver l'état par conditionId (en cours / fait) dans un store pour survivre aux re-renders SSE — même logique que le vanilla JS actuel.

10. **3 modes** : DRY RUN / LIVE (READONLY) / LIVE — `config.readonlyLive` existe et doit être affiché.

---

## Next Steps

1. **Approuver le plan v2** → je scaffolde le projet dans `frontend/`
2. **Décider du CSS** : vanilla CSS (recommandé) vs CSS Modules
3. **Décider du partage de types** : copie miroir (recommandé) vs package partagé

Prêt à démarrer la Phase 1 dès validation.
