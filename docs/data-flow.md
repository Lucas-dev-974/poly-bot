# Flux de données du dashboard (SSE → dispatcher → stores)

## Vue d'ensemble

```
Backend (Node)                          Frontend (SolidJS)
────────────────                        ──────────────────
EventBus (src/dashboard/events.ts)
  │ bus.emit(event)                     EventSource /events?replay=0
  ├─→ repo.events.insert()   persist    │   hooks/useEventSource.ts
  └─→ SSE broadcast ────────────────────→   │ markSseEvent() → sseHealthStore
                                          ↓ dispatchEvent()
                                          stores/dispatcher.ts (switch event.type)
                                          ↓
                                          stores/* (source unique par domaine)
```

## Gouvernance

1. **Un domaine = un store**. Le composant lit le store, il ne crée pas de
   copie locale de l'état serveur (sa state UI pure : saisie de formulaire,
   toggle de modale, sélection).
2. **Le SSE est la source primaire** ; le REST est le réconciliateur :
   hydratation au montage + polling adaptatif (`useAdaptiveSync`) à deux
   vitesses — 60 s si SSE vivant, 10 s si SSE perdu. Le SSE se connecte avec
   `replay=0` : les events manqués pendant une coupure ne sont **pas** rejoués,
   le REST est donc indispensable après reconnexion.
3. **Les timers globaux sont partagés** : `clockStore.useClock()` (tick 1 s,
   refcounted) pour tous les countdowns ; `useMarketRulesAutoRefresh()` (30 s)
   pour les flags trading/recording. Pas de `setInterval` local par composant
   pour ces usages.
4. **Les fetches coûteux passent par `data/query.ts`** (LRU + dédup + TTL) :
   clés `bt-series:<slug>` (séries backtest, TTL 10 min — données immuables).
   Invalidation explicite via `invalidate(prefix)`.
5. **localStorage via stores** : `userPresetsStore` hydrate au boot et
   encapsule les mutations (`commitUserPreset` / `removeUserPreset`). Ne pas
   re-parser `localStorage` dans les composants.

## Events SSE → stores

| Event                  | Store cible                        | Notes |
|------------------------|------------------------------------|-------|
| `config`               | botStore.config                    | Source unique de la config live. |
| `balance`              | balanceStore.liveBalance           | Intercepté par App avant dispatcher. |
| `simBalance`           | simStore.simBalance                | |
| `simEngineStats`       | simStore.simEngineStats            | Renommé depuis `simStats` (v2). |
| `simConfig`            | simStore.simConfigState + simEffectiveConfig | |
| `simOpenedPosition` / `simResolvedPosition` | simStore      | upsert/resolve. |
| `stats`                | statsStore.globalStats             | Stats live globales (tick-snapshots). |
| `scan` / `watching` / `opportunity` | marketStore           | |
| `order` / `openedPosition` / `resolvedPosition` | orderStore, positionStore | |
| `resolution`           | logStore                           | |
| `polymarketPositions`  | polyStore.polyPositions            | Fallback REST `/api/polymarket-positions` (cache BalanceTracker, throttle 30 s). |
| `relayerQuota`         | quotaStore.relayerQuota            | Countdown via clockStore. |
| `withdrawal`           | toastStore + logStore              | pending/success/failed. |
| `botControl`           | botStore.botEnabled                | |
| `error` / `log`        | logStore                           | |
| `strategyStatus`       | strategyStatusStore                | Renommé : émission backend inconditionnelle (5 s), countdown ancré sur `receivedAt`. |
| `wsStatus`             | wsStore                            | |

Events supprimés (v2) : `simulatedBalance`, `simulatedStats`, `simStats`
(→ `simEngineStats`). Aucun émetteur backend ; purgés de l'union `BotEvent`.

## Polling REST adaptatif

| Donnée            | Endpoint                   | Vitesse SSE vivant | Vitesse SSE perdu |
|-------------------|----------------------------|--------------------|--------------------|
| Positions live    | `/api/positions/*`         | 60 s               | 10 s               |
| Positions Poly    | `/api/polymarket-positions`| 60 s (throttle 30 s) | 10 s             |
| Sim positions/journal/resting | `/api/sim/*`   | 60 s               | 10 s               |

Le hook `useAdaptiveSync(fn, { fastMs, slowMs })` implémente la bascule
(vérifie `isSseAlive()` chaque seconde et re-programme l'intervalle).

## Endpoints REST ajoutés (v2)

- `GET /api/polymarket-positions` — cache du dernier poll BalanceTracker
  (30 s), sert de réconciliateur pour la seule liste sans fallback REST.
- `GET /api/strategy/status` — hydratation initiale du statut whipsaw
  (l'event SSE `strategyStatus` prend le relais toutes les 5 s).