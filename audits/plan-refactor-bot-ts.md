# Plan détaillé — refactor `bot.ts` → `src/bot/`

> Move-only, comportement inchangé. Aligné sur `ReverseBot` actuel (~1825 lignes).
> Critère de done par phase : `npm test` + `npm run build` verts, dry-run tick OK.

## Objectif

`src/bot.ts` redevient une façade fine (`ReverseBot`). La logique live / resting / exécution sort dans des modules injectés.

## Arborescence cible

```
src/
  bot.ts                          # re-export ReverseBot (compat index.ts / tests)
  bot/
    reverse-bot.ts                # façade (~150–250 lignes)
    live-order-lifecycle.ts       # phase 1
    resting-manager.ts            # phase 2
    opportunity-executor.ts       # phase 3
    balance-guard.ts              # phase 3 (extrait de l’executor)
    tick-snapshots.ts             # phase 4 (optionnel)
    types.ts                      # types partagés du package bot/ (status, deps)
```

Compat : garder `export { ReverseBot } from "./bot/reverse-bot.js"` dans `src/bot.ts` pour ne pas casser les imports existants.

---

## Types partagés — `src/bot/types.ts`

```ts
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { MarketScanner } from "../market-scanner.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { PostedOrderContext, TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import type { SimulatedBroker } from "../simulated-broker.js";
import type { SimulatedLedger } from "../simulated-ledger.js";
import type { TradeOpportunity } from "../types.js";

/** Statut CLOB normalisé tel que renvoyé aujourd’hui par Trader.getOrderStatus. */
export type LiveOrderStatus = {
  filled: boolean;
  cancelled: boolean;
  sizeMatched: number;
};

export type FinalizeOutcome = "created" | "pending" | "ghost" | "none";

export type TrackedPostedOrder = { key: string; orderId: string } & PostedOrderContext;

export type LiveOrderLifecycleDeps = {
  config: BotConfig;
  trader: Trader;
  tracker: TradeTracker;
  strategy: TradingStrategy; // via setStrategy(); fallback strategyId createLivePosition
};

export type RestingManagerDeps = {
  config: BotConfig;
  trader: Trader;
  tracker: TradeTracker;
  strategy: TradingStrategy;
  scanner: MarketScanner;
  lifecycle: LiveOrderLifecycle;
  // defendPair -> lifecycle.clearCheapMissing(pairId) after successful SELL
};

export type BalanceGuardDeps = {
  config: BotConfig;
  trader: Trader;
};

export type OpportunityExecutorDeps = {
  config: BotConfig;
  trader: Trader;
  tracker: TradeTracker;
  strategy: TradingStrategy;
  scanner: MarketScanner; // refresh ask before hedge POST
  repos?: Repositories;
  broker: SimulatedBroker | null;
  ledger: SimulatedLedger | null;
  lifecycle: LiveOrderLifecycle;
  balance: BalanceGuard;
  // Facade injects: () => this.resting.defendPair(pairId) — needed at hedgeAtPostTime "defend"
  defendPair: (pairId: string) => Promise<void>;
  // totalAttempts++ only on execute paths, never in lifecycle
  onAttempt: () => void;
};

export type OrderType = "GTC" | "FOK";

export function orderTypeFor(
  opportunity: TradeOpportunity,
  config: BotConfig,
  strategy: Pick<TradingStrategy, "leadsWithEdge">,
): OrderType {
  // edge-lead force GTC même si expensiveOrderType=FOK (bot.ts L438-443)
  return opportunity.kind === "expensive" &&
    config.expensiveOrderType === "FOK" &&
    !strategy.leadsWithEdge
    ? "FOK"
    : "GTC";
}
```

Note : `orderTypeFor` vit mieux dans `order-type.ts`. Ne pas référencer les classes dans `types.ts` sans `import type` (sinon ne compile pas) ; préférer deps colocalisés par module.

---

## Phase 1 — `LiveOrderLifecycle`

**Fichier :** `src/bot/live-order-lifecycle.ts`  
**Source :** lignes ~282–605 + `confirmCheapTokensForHedge` (~1482–1511) + helpers cancel hedges.

### Signature

```ts
import type { PostedOrderContext } from "../trade-tracker.js";
import type {
  FinalizeOutcome,
  LiveOrderLifecycleDeps,
  LiveOrderStatus,
  TrackedPostedOrder,
} from "./types.js";

export class LiveOrderLifecycle {
  private readonly orderStatusFailures = new Map<string, number>();
  private readonly fillConfirmFailures = new Map<string, number>();
  private readonly cheapMissingFailures = new Map<string, number>();

  private static readonly ORDER_STATUS_MAX_FAILURES = 10;
  private static readonly FILL_CONFIRM_MAX_ATTEMPTS = 8;
  private static readonly CHEAP_MISSING_MAX_ATTEMPTS = 3;

  constructor(private readonly deps: LiveOrderLifecycleDeps) {}

  /** Appelé en tête de tick live (avant pause check marchés). */
  async cancelStaleOrders(nowSeconds: number): Promise<void>;

  async pollOrderFills(): Promise<void>;

  getOrderStatusTracked(
    order: TrackedPostedOrder,
  ): Promise<LiveOrderStatus | null>;

  finalizeLiveOrder(
    order: TrackedPostedOrder,
    status: LiveOrderStatus,
  ): Promise<FinalizeOutcome>;

  createLivePosition(order: TrackedPostedOrder, filledSize: number): void;

  /**
   * Confirme que le wallet détient encore les tokens cheap avant hedge.
   * `null` = échec balance (fail-closed) ; `0` = plus de tokens / sync sold.
   */
  confirmCheapTokensForHedge(pairId: string): Promise<number | null>;

  /** Appelé par RestingManager.defendPair après SELL réussi (une seule Map). */
  clearCheapMissing(pairId: string): void;

  setStrategy(strategy: TradingStrategy): void;

  cancelOrphanHedgesIfNeeded(
    order: { key: string; pairId: string; kind: "cheap" | "expensive" } & PostedOrderContext,
  ): Promise<void>;

  cancelRestingHedgesForPair(pairId: string, why: string): Promise<void>;

  emitOrderCancelled(
    order: PostedOrderContext & { key: string; orderId?: string },
    // conserver la signature exacte actuelle du private emitOrderCancelled
  ): void;

  /** Permet à RestingManager / Executor de finaliser après cancel/reprice. */
  // finalizeLiveOrder + getOrderStatusTracked déjà publics pour ça
}
```

### Dépendances internes

- `deps.trader.getOrderStatus` / `cancelOrder` / `getConditionalTokenBalance`
- `deps.tracker` : posted orders, pairs, `removePostedOrder`, `create` position path actuel
- `deps.strategy.leadsWithEdge` (skip orphan-hedge en edge-lead)
- `confirmedFillSize` depuis `utils/order-status.js`
- `bus` + `log` (même usage qu’aujourd’hui)

### Façade après phase 1

```ts
// reverse-bot.ts (extrait tick)
if (!this.config.dryRun) {
  await this.lifecycle.cancelStaleOrders(nowSeconds);
  await this.lifecycle.pollOrderFills();
}
```

### Tests

- Déplacer / adapter les tests qui touchent finalize / ghost / cancel stale : `tests/order-lifecycle.test.ts`, `tests/order-status.test.ts`, `tests/tracker.test.ts`.
- Si les tests instancient `ReverseBot`, ne rien casser via re-export.

### Risques

- Maps de failure doivent **rester une seule instance** pour toute la durée du process (ne pas les recréer par tick).
- Préserver le re-read status **après** cancel (commentaire lignes ~304–308).

---

## Phase 2 — `RestingManager`

**Fichier :** `src/bot/resting-manager.ts`  
**Source :** `replaceMarketableCheap`, `manageRestingEdgeLead`, `defendUncoveredPairs`, `sellExpensiveEdgeIfNeeded`, `defendPair`.

### Signature

```ts
import type { TokenBook, UpDownEvent } from "../types.js";
import type { RestingManagerDeps } from "./types.js";

export class RestingManager {
  constructor(private readonly deps: RestingManagerDeps) {}

  /**
   * Branche live dans processEvent :
   * - edge-lead : manageRestingEdgeLead → replaceMarketableCheap → sellExpensiveEdgeIfNeeded
   * - sinon     : replaceMarketableCheap → defendUncoveredPairs
   */
  async manageLiveResting(event: UpDownEvent, books: TokenBook[]): Promise<void> {
    const { strategy } = this.deps;
    if (strategy.leadsWithEdge) {
      await this.manageRestingEdgeLead(event, books);
      await this.replaceMarketableCheap(event, books);
      await this.sellExpensiveEdgeIfNeeded(event, books);
    } else {
      await this.replaceMarketableCheap(event, books);
      await this.defendUncoveredPairs(event, books);
    }
  }

  replaceMarketableCheap(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  manageRestingEdgeLead(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  defendUncoveredPairs(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  sellExpensiveEdgeIfNeeded(event: UpDownEvent, books: TokenBook[]): Promise<void>;
  defendPair(pairId: string): Promise<void>;

  setStrategy(strategy: TradingStrategy): void;
}
```

### Dépendances

- `strategy.cheapOrderAction` / `defendShares` / `shouldDefend` (noms exacts du code actuel)
- `lifecycle.getOrderStatusTracked` / `finalizeLiveOrder` / `cancelRestingHedgesForPair` / `emitOrderCancelled`
- `trader.cancelOrder` / `placeSell` (chemin defendPair actuel)
- `scanner.getTokenBook` pour refresh bid cheap

### Façade

```ts
if (!this.config.dryRun) {
  await this.resting.manageLiveResting(event, books);
}
```

### Tests

- `tests/trading-strategy.test.ts`, `tests/edge-lead.test.ts`, `tests/strategy.test.ts` — comportement resting inchangé.
- Ajouter un test unitaire mince sur `manageLiveResting` branch order (edge vs arb) si pas déjà couvert.

### Risques

- Ordre d’appel edge-lead est **contractuel** (doc + commentaires) : ne pas réordonner.
- `defendPair` construit une `TradeOpportunity` synthétique — garder tel quel (y compris `market: {} as never`).

---

## Phase 3 — `BalanceGuard` + `OpportunityExecutor`

### `src/bot/balance-guard.ts`

```ts
import type { BalanceGuardDeps } from "./types.js";

export class BalanceGuard {
  private consecutiveBalanceRejections = 0;
  private balanceBackoffUntil = 0;
  private cachedBalance: number | null = null;
  private cachedBalanceAt = 0;

  private static readonly BALANCE_CACHE_MS = 30_000;

  constructor(private readonly deps: BalanceGuardDeps) {}

  isInBackoff(now = Date.now()): boolean;

  getCachedAvailableCollateral(): Promise<number | null>;

  /** Incrémente ; active backoff 60s après 3 rejects. */
  noteBalanceRejection(now = Date.now()): void;

  noteBalanceOk(): void;

  /** Pour reset() de la façade. */
  reset(): void;
}
```

### `src/bot/opportunity-executor.ts`

**Source :** `executeOpportunity` (~1044–1480) + `executeSimulated` + `rejectLiveWithRetry` + usage de `orderTypeFor`.

```ts
import type { TradeOpportunity } from "../types.js";
import type { OpportunityExecutorDeps } from "./types.js";

export class OpportunityExecutor {
  constructor(private readonly deps: OpportunityExecutorDeps) {}

  executeOpportunity(opportunity: TradeOpportunity): Promise<void>;

  /** Chemin DRY_RUN uniquement. */
  executeSimulated(opportunity: TradeOpportunity): void;

  setStrategy(strategy: TradingStrategy): void;

  // privates déplacés tels quels :
  // rejectLiveWithRetry(...)
  // (helpers d’émission bus order / reason codes)
}
```

### Squelette logique (inchangé, juste découpé)

```ts
async executeOpportunity(opportunity: TradeOpportunity): Promise<void> {
  // Ordre EXACT bot.ts (ne pas réordonner — reason codes / retries) :
  // 1. minMinutesBeforeCloseToBuy
  // 2. balance.isInBackoff()
  // 3. readonlyLive
  // 4. C2 anti favori-nu (sauf leadsWithEdge)
  // 5. expensive + !leadsWithEdge → confirmCheapTokensForHedge (resize/skip)
  // 6. dryRun → executeSimulated ; return
  // 7. useFOK = orderTypeFor(...) === "FOK" ; estimatedCost
  // 8. balance + exposure (1er passage)
  // 9. expensive + !leadsWithEdge → hedgeAtPostTime ; defendPair callback | skip | reprice
  // 10. re-check balance + exposure si prix changé
  // 11. placeBuy / placeBuyFOK ; catch balance → balance.noteBalanceRejection()
  // 12. rejectLiveWithRetry / onAttempt selon chemin
}
```

### Façade `processEvent` (cible)

```ts
private async processEvent(event: UpDownEvent, tickTs: number): Promise<void> {
  const books = await this.scanner.getTokenBooks(event);
  this.snapshots?.insertBooks(event, books, tickTs); // phase 4

  if (!this.config.dryRun) {
    await this.resting.manageLiveResting(event, books);
  }

  const opportunities = this.strategy.findOpportunities({
    config: this.config,
    tracker: this.tracker,
    event,
    books,
  });
  this.snapshots?.insertOpportunities(event, opportunities, tickTs);

  bus.emit({ type: "watching", event, books });
  if (opportunities.length === 0) { /* log watching */ return; }

  opportunities.sort(/* même comparator leadsWithEdge */);
  for (const opportunity of opportunities) {
    await this.executor.executeOpportunity(opportunity);
  }
}
```

### Tests

- `tests/trader.test.ts`, lifecycle, edge-lead — golden paths cheap→hedge, skip naked, backoff.
- Vérifier que `confirmCheapTokensForHedge` reste appelé **uniquement** depuis l’executor (plus depuis bot).

---

## Phase 4 — Façade + snapshots (optionnel)

### `src/bot/tick-snapshots.ts`

```ts
import type { BotConfig } from "../config.js";
import type { Repositories } from "../db/index.js";
import type { TradeOpportunity, TokenBook, UpDownEvent } from "../types.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { SimulatedLedger } from "../simulated-ledger.js";

export type TickSnapshotsDeps = {
  config: BotConfig;
  repos?: Repositories;
  tracker: TradeTracker;
  ledger: SimulatedLedger | null;
};

export class TickSnapshots {
  private lastStatsSnapshotAt = 0;
  private static readonly STATS_SNAPSHOT_MS = 60_000;

  constructor(private readonly deps: TickSnapshotsDeps) {}

  insertMarketSnapshots(events: UpDownEvent[], tickTs: number): void;
  insertBooks(event: UpDownEvent, books: TokenBook[], tickTs: number): void;
  insertOpportunities(
    event: UpDownEvent,
    opps: TradeOpportunity[],
    tickTs: number,
  ): void;

  pruneData(): void;
  emitStats(totalAttempts: number): void;
  computeStats(totalAttempts: number): /* même shape qu’aujourd’hui */ object;
}
```

### `src/bot/reverse-bot.ts` — façade cible

```ts
export class ReverseBot {
  readonly tracker: TradeTracker;
  private strategy: TradingStrategy;
  private readonly scanner: MarketScanner;
  private readonly ledger: SimulatedLedger | null;
  private readonly broker: SimulatedBroker | null;
  private readonly resolver: PositionResolver | null;

  private readonly lifecycle: LiveOrderLifecycle;
  private readonly resting: RestingManager;
  private readonly balance: BalanceGuard;
  private readonly executor: OpportunityExecutor;
  private readonly snapshots: TickSnapshots;

  private totalAttempts = 0;
  private paused = false;
  private ticking = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: BotConfig,
    private readonly trader: Trader,
    private readonly repos?: Repositories,
  ) { /* wire deps ; createStrategy ; new LiveOrderLifecycle({ get strategy: () => this.strategy }) */ }

  async init(): Promise<void>;
  reset(): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  async run(): Promise<void>;
  onRuntimeSettingsChanged(changed: Set<EditableConfigKey>): void;

  private scheduleTick(): void;
  private async tick(): Promise<void>;
  private async processEvent(event: UpDownEvent, tickTs: number): Promise<void>;
}
```

**Astuce wiring `strategy` mutable :**  
`onRuntimeSettingsChanged` recrée `this.strategy`. Passer un getter aux deps :

```ts
type StrategyRef = { get current(): TradingStrategy };

// dans chaque module :
this.deps.strategyRef.current.findOpportunities(...)
```

ou setter `lifecycle.setStrategy(s)` / `resting.setStrategy(s)` / `executor.setStrategy(s)` appelé depuis `onRuntimeSettingsChanged`. Préférer le **setter explicite** (plus simple à lire dans ce codebase).

```ts
onRuntimeSettingsChanged(changed: Set<EditableConfigKey>): void {
  // ...
  if (changed.has("strategyId")) {
    this.strategy = createStrategy(this.config.strategyId);
    this.lifecycle.setStrategy(this.strategy);
    this.resting.setStrategy(this.strategy);
    this.executor.setStrategy(this.strategy);
  }
}
```

Ajouter `setStrategy(strategy: TradingStrategy): void` sur les 3 classes.

---

## Ordre d’implémentation (checklist)

- [ ] **P1a** Créer `src/bot/types.ts` + dossier `src/bot/`
- [ ] **P1b** Extraire `LiveOrderLifecycle` (cut-paste), brancher dans `ReverseBot`
- [ ] **P1c** `npm test` + `npm run build`
- [ ] **P2a** Extraire `RestingManager`, `manageLiveResting`
- [ ] **P2b** tests
- [ ] **P3a** `BalanceGuard`
- [ ] **P3b** `OpportunityExecutor`
- [ ] **P3c** tests (surtout C2, backoff, confirm cheap)
- [ ] **P4a** `TickSnapshots` + trim façade
- [ ] **P4b** `src/bot.ts` re-export ; maj courte `README` architecture + `STRATEGY.md` §3.1
- [ ] **P4c** commit par phase (pas un mega-commit)

## Hors scope (volontaire)

- Ne pas fusionner dry-run / live derrière une interface Broker unique.
- Ne pas déplacer `TradingStrategy` / sizing.
- Ne pas changer les reason codes bus (`too-close-to-close`, `readonly-live`, ghost, etc.).
- Ne pas toucher au frontend.

## Estimation rough

| Phase | Effort | Risque |
|-------|--------|--------|
| 1 Lifecycle | moyen | élevé (live money path) |
| 2 Resting | moyen | moyen (edge-lead order) |
| 3 Executor | moyen-élevé | élevé (toutes les gardes) |
| 4 Façade/snapshots | faible | faible |

---

## Revue de cohérence (2026-09-10)

Audit croisé plan ↔ `bot.ts`. Découpage OK ; sans les corrections ci-dessous le plan v1 aurait introduit des régressions.

### P0 — corrigé dans ce fichier

1. **`orderTypeFor`** : manquait `!strategy.leadsWithEdge` → edge-lead aurait posté l’expensive en FOK au lieu de GTC.
2. **`defendPair` depuis l’executor** : `hedgeAtPostTime` → `"defend"` appelle `defendPair` (~L1236). Injecter `defendPair` depuis la façade vers RestingManager (pas d’import cyclique Executor↔Resting).
3. **`bumpAttempts` sur Lifecycle** : API fantôme — `totalAttempts` seulement sur chemins execute. Retiré.
4. **Forward refs `types.ts`** : noter `import type` ou deps colocalisés.
5. **Ordre des gardes executeOpportunity** : balance/exposure **avant** `hedgeAtPostTime`, puis re-check — squelette P3 corrigé.

### P1 — invariants de review à chaque phase

6. **Une seule Map `cheapMissingFailures`** sur Lifecycle + `clearCheapMissing` pour `defendPair`.
7. **Wrappers de délégation** après P1 tant que Resting est encore dans ReverseBot (`this.lifecycle.finalizeLiveOrder` etc.) — jamais deux Maps de failures.
8. **`setStrategy` dès P1** (`createLivePosition` fallback `strategy.id`).
9. **`BalanceGuard.noteBalanceRejection`** aussi dans le `catch` du POST (pas seulement `rejectLiveWithRetry`).
10. **Une seule `orderTypeFor`** pour emits + `useFOK` inline (éviter drift).
11. **Référence `BotConfig` mutable** partagée (pas de copie au constructeur).
12. **Timers `run()`** (`resolveDue` / `emitStats` / `pruneData`) restent sur la façade en P1–P3.

### Verdict

### Re-revue finale — résidus acceptables (non bloquants)

13. **`types.ts` exemple** référence encore `LiveOrderLifecycle` / `BalanceGuard` sans import : à l’implémentation, deps colocalisés ou `import type` (déjà noté L108). Ne pas copier-coller le bloc tel quel.
14. **`BalanceGuard.reset()`** : le `reset()` actuel de `ReverseBot` **ne** reset **pas** backoff/cache balance. Si la façade appelle `balance.reset()`, c’est un micro-changement de comportement (plutôt souhaitable). Pour move-only strict : ne pas l’appeler depuis `reset()`, ou le documenter comme amélioration volontaire.
15. **Gate dry-run réelle** : `if (this.broker && this.ledger)` pas `if (config.dryRun)`. Le squelette P3 doit garder le gate broker/ledger.
16. **Signatures P1** : `clearCheapMissing` + `setStrategy` doivent figurer sur `LiveOrderLifecycle` dès la phase 1 (ajoutés ci-dessus) — la revue P1 §6/§8 les exigeait déjà.

### Verdict final (re-vérification)

Le plan corrigé est **cohérent et prêt à implémenter** pour un move-only, à condition de respecter les invariants P1 et les résidus 13–15. Aucune régression logique majeure restante dans les signatures critiques (`orderTypeFor`, `defendPair` injecté, ordre des gardes, une Map cheapMissing).


| Aspect | Statut |
|--------|--------|
| Découpage | OK |
| Complet pour coder | Oui après P0 + invariants P1 |
| Risque plan v1 non corrigé | Régression edge-lead FOK + défense hedge cassée + types |
| Action | Ne pas implémenter avant validation de cette revue |
