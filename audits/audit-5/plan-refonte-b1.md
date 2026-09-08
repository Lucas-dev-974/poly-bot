# Plan de refonte B1 — Arbitrage 1:1 avec verrou de profit

**Date** : 2026-09-08
**Auteur** : suite à l'audit 5 ([audit-intelligence-2026-09-08.md](audit-intelligence-2026-09-08.md))
**Stratégie cible** : B1 — vrai arbitrage (paires 1:1 à coût < 1 $, profit verrouillé quel que soit le résultat)
**Périmètre** : Séquences 1 (sécuriser le live) + 2 (refonte du dimensionnement)
**Horizon B2** : ce plan est conçu pour que le passage vers B2 (barbell assumé) soit une **évolution**, pas une réécriture — voir §7

---

## 0. Objectif

Transformer le bot d'« hybride involontaire à espérance négative » en **arbitrageur honnête** :

- Chaque paire remplie verrouille un profit `(1 − coût) × taille`, quel que soit le résultat de la fenêtre.
- Le hedge est dimensionné **1:1** avec le cheap rempli (plus de budget asymétrique 6:1).
- Le coût de paire est **revalidé au moment du fill**, pas seulement à la génération.
- Une paire n'est postée que si `prixCheap + prixHedge < 1.00` (verrou profit), pas `≤ 1.02` (perte autorisée).
- Un favori nu (hedge sans cheap rempli) est **impossible** par construction.
- Le bot live ne peut plus poster un ordre sans vérifier le solde, ni se figer sur un CLOB pendu.

**Ce qu'on ne fait pas dans ce plan** : l'oracle de prix spot (Séquence 3, futur), les circuit breakers avancés (Séquence 4), le WS CLOB, la diversification ETH/SOL. Ces axes sont documentés §7 pour le passage B2.

---

## 1. État actuel vs cible

| Aspect | Actuel (hybride) | Cible B1 (ce plan) |
|---|---|---|
| Dimensionnement hedge | `computeSize(EXPENSIVE_ORDER_USDC, …)` — budget, 6:1 | `filledCheapSize` — 1:1, budget = plafond secondaire |
| Coût de paire max | `PAIR_COST_MAX=1.02` (autorise une perte) | `PAIR_LOCK_MAX < 1.00` (ex. 0.98) — verrou profit |
| Revalidation au fill | ❌ non (génération seulement) | ✅ avant chaque hedge, sur book frais |
| Hedge marketable sur cheap resting | ✅ autorisé (C2) | ❌ interdit — hedge exige `filledCheapSize > 0` |
| Garde balance | fail-open (`null` → skip garde) | fail-closed (`null` → skip ordre) |
| Timeout d'exécution | ❌ aucun | ✅ 8 s applicatif |
| Config source de vérité | `.env` + overlay silencieux | fail-loud sur divergence / overlay invalide |
| Support SELL | ❌ (`TradeSide = "BUY"` seulement) | ✅ `placeSell` FOK (coupe de secours) |
| `disablePairTargetCost` | toggle actif (trompeur) | supprimé (n'a plus de sens en 1:1) |
| Statut `covered` en DB | fiction (budget sizing) | honnête (1:1 réel) |
| Tests cycle de vie ordres | ❌ aucun | ✅ mock ClobClient |

---

## 2. Architecture cible — préserver pour B2

Le cœur décisionnel est refactorisé pour que le **modèle de dimensionnement** soit une stratégie interchangeable, sans toucher l'architecture technique (scanner, tracker, DB, dashboard, exécution CLOB, relayer — conservés).

```
strategy.ts
├── findOpportunities()        ← orchestrateur (conservé, signatures stables)
├── pickReverseToken()         ← conservé
├── pickFavoriteToken()        ← conservé
└── sizing/                    ← NOUVEAU — stratégie de dimensionnement interchangeable
    ├── sizing.ts              ← interface SizingStrategy
    ├── arb-sizing.ts          ← B1 : hedgeSize = filledCheapSize, verrou profit
    └── barbell-sizing.ts      ← B2 (futur) : ratio explicite, Kelly fractionné
```

L'interface `SizingStrategy` (§5.2) est le point d'extension pour B2 : même signature, même orchestrateur, seule l'implémentation change. Les guards d'exécution (§5.3) sont **communs** aux deux stratégies.

---

## 3. Séquence 1 — Sécuriser le live (P0, ~2 jours)

**Objectif** : arrêter de perdre de l'argent par des bugs de guards, avant toute refonte du dimensionnement. Indépendant du choix B1/B2 — ces guards protègent le capital dans toutes les configurations.

### 3.1 Fail-loud sur la config (constat 7.20, C8)

**Problème** : `config.ts` applique l'overlay `data/bot-settings.json` par-dessus `.env` via `Object.assign`. Si l'overlay est invalide (JSON corrompu, clé inconnue), `sanitizePatch` throw → le catch de `loadConfig` warn en console et **ignore tout l'overlay** → le bot repasse silencieusement sur les valeurs `.env` (hedge 20 USDC au lieu de 6, etc.).

**Fichiers** : `src/config.ts`, `src/runtime-settings.ts`, `src/index.ts`

**Changements** :

1. `loadConfig()` : après application de l'overlay, logguer explicitement chaque clé où `overlay[key] !== envValue[key]` au boot (niveau `warn`, pas `info`). En mode live (`DRY_RUN=false`), émettre un event `bus.emit({ type: "config", config: toPublicConfig(config), divergences: [...] })` pour le dashboard.

2. `loadConfig()` en mode live : si `readRuntimeSettingsSync` throw (autre que `ENOENT`), **ne pas ignorer** — rethrow avec un message clair :
   ```
   [config] Runtime settings file is invalid and DRY_RUN=false.
   Refusing to start with potentially wrong settings.
   Fix or remove data/bot-settings.json, or set DRY_RUN=true to bypass.
   ```
   En dry-run, conserver le comportement actuel (warn + ignore) pour permettre le développement.

3. Dashboard `ConfigBar.tsx` : ajouter un indicateur visuel (badge ⚠) quand `disablePairTargetCost=true` et `pairTargetCost` est affiché — signaler que la cible est inactive. (Ce point est partiellement résolu par la suppression du toggle en S2, mais le badge protège la période intermédiaire.)

**Tests** : `tests/config.test.ts` — ajouter :
- `loadConfig` avec overlay invalide en live → throw.
- `loadConfig` avec overlay invalide en dry-run → warn + fallback `.env`.
- `loadConfig` avec overlay valide → overlay appliqué + divergences logguées.

### 3.2 Garde balance fail-closed (constat 7.2)

**Problème** : `getCachedAvailableCollateral()` retourne `null` si le fetch CLOB échoue. `executeOpportunity` teste `if (available !== null && estimatedCost > available)` → si `null`, la garde est **complètement sautée** et l'ordre part.

**Fichier** : `src/bot.ts` (`executeOpportunity`, lignes ~720-730)

**Changement** :

```ts
// Avant (fail-open) :
const available = await this.getCachedAvailableCollateral();
if (available !== null && estimatedCost > available) {
  this.rejectLiveWithRetry(opportunity, "insufficient-balance", { … });
  return;
}

// Après (fail-closed) :
const available = await this.getCachedAvailableCollateral();
if (available === null) {
  if (!this.config.dryRun) {
    log("Live order skipped - balance unknown (fail-closed)", {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
    });
    this.rejectLiveWithRetry(opportunity, "balance-unknown", { … });
    return;
  }
  // Dry-run : pas de client CLOB, available est toujours null — autoriser.
} else if (estimatedCost > available) {
  this.rejectLiveWithRetry(opportunity, "insufficient-balance", { … });
  return;
}
```

**Note** : `rejectLiveWithRetry` marque la clé après `SIM_MAX_RETRY_ATTEMPTS` — un CLOB durablement indisponible arrête les ordres proprement après 20 tentatives, au lieu de poster à l'aveugle.

**Tests** : mock `getCachedAvailableCollateral` → `null` en live → ordre rejeté avec `reason: "balance-unknown"`.

### 3.3 Timeout applicatif sur les appels trading (constat 7.3)

**Problème** : `placeBuy`, `placeBuyFOK`, `cancelOrder` n'ont aucun timeout applicatif. Un POST CLOB qui pend bloque toute la boucle de tick (le guard `ticking` supprime les ticks suivants).

**Fichier** : `src/trader.ts`

**Changement** : ajouter un wrapper `withTimeout` :

```ts
private static readonly TRADING_TIMEOUT_MS = 8_000;

private async withTimeout<T>(label: string, op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Trader.TRADING_TIMEOUT_MS}ms`)),
      Trader.TRADING_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Appliquer à chaque appel :
async placeBuy(opportunity: TradeOpportunity): Promise<OrderResult> {
  if (!this.client) throw new Error("Trading client not initialized");
  return this.withTimeout("placeBuy", this.client.createAndPostOrder(…).then(…));
}
```

Appliquer à : `placeBuy`, `placeBuyFOK`, `cancelOrder`, `getOrderStatus`, `getAvailableCollateral` (ce dernier avec 10 s, déjà partiellement couvert par le scanner mais pas par le client trading).

**Tests** : mock ClobClient dont `createAndPostOrder` ne résout jamais → `placeBuy` throw après 8 s.

### 3.4 Interdire le hedge marketable sur cheap resting (constat C2)

**Problème** : en GTC, `cheapCommitted = getCheapSizeForPair(pairId)` inclut les ordres **resting** (pas remplis). Le hedge GTC à `min(ask, expensiveBuyMax)` est marketable dès que `ask ≤ expensiveBuyMax` → fill instantané sans cheap rempli = favori nu.

**Fichier** : `src/bot.ts` (`executeOpportunity`, lignes ~677-693)

**Changement** : exiger un cheap **rempli** pour **tous** les types d'ordre, pas seulement FOK :

```ts
// Avant :
const cheapCommitted =
  opportunity.kind === "expensive" &&
  this.config.expensiveOrderType === "FOK"
    ? this.tracker.getFilledCheapSizeForPair(opportunity.pairId)
    : this.tracker.getCheapSizeForPair(opportunity.pairId);

// Après : toujours exiger un fill réel, quel que soit le type d'ordre.
// Un hedge sur cheap resting est un favori nu (C2).
const cheapCommitted =
  opportunity.kind === "expensive"
    ? this.tracker.getFilledCheapSizeForPair(opportunity.pairId)
    : this.tracker.getCheapSizeForPair(opportunity.pairId);
```

**Conséquence** : le hedge GTC n'est plus posté tant que le cheap resting n'est pas rempli. Le cheap reste sur le carnet, et quand il se remplit (tick suivant ou plus tard), `pollOrderFills` détecte le fill → `createLivePosition` → `getFilledCheapSizeForPair > 0` → le hedge est autorisé au tick suivant. C'est le bon ordre : cheap d'abord, hedge ensuite.

**Note** : cela change le timing du hedge (il peut arriver un tick plus tard), mais c'est le comportement correct pour un arbitrage — on ne couvre que ce qu'on possède déjà.

**Tests** :
- cheap resting (pas de fill) + hedge GTC → hedge rejeté avec `reason: "no-committed-cheap-leg"`.
- cheap rempli + hedge GTC → hedge posté.
- cheap rempli + hedge FOK → hedge posté (comportement inchangé).

### 3.5 Git init + tag de version

**Action** : figer l'état actuel avant toute modification.

```bash
git init
git add -A
git commit -m "pre-refonte-b1: état actuel (audit 5 v2)"
git tag pre-refonte-b1
```

Le `.gitignore` existant couvre déjà `.env`, `data/`, `node_modules/`, `dist/`. Vérifier qu'aucun secret n'est stagé : `git diff --cached -- .env` doit être vide (le fichier est ignoré).

Après chaque sous-étape de la Séquence 2, committer avec un message explicite pour permettre le rollback granulaire.

---

## 4. Séquence 2 — Refonte du dimensionnement (cœur B1, ~1 semaine)

**Objectif** : rendre la stratégie honnête — vrai arbitrage 1:1 avec verrou de profit.

### 4.1 Interface `SizingStrategy` (préserver pour B2)

**Nouveau fichier** : `src/strategy/sizing.ts`

```ts
export interface SizingContext {
  config: BotConfig;
  pairId: string;
  tracker: TradeTracker;
  cheapToken: TokenBook;
  expensiveToken: TokenBook | null;
  hedgePrice: number;
  thisTickCheapSize: number;
}

export interface SizingResult {
  cheapPrice: number;
  cheapSize: number | null;
  hedgePrice: number;
  hedgeSize: number | null;
  pairCost: number;          // coût total par share-paire (cheapPrice + hedgePrice)
  pairLockOk: boolean;       // pairCost ≤ PAIR_LOCK_MAX
  reason: string;            // pour logging
}

export interface SizingStrategy {
  /** Nom de la stratégie (pour logging + dashboard). */
  readonly name: "arb" | "barbell";
  /** Calcule les tailles et prix pour une opportunité donnée. */
  compute(ctx: SizingContext): SizingResult;
}
```

**Pourquoi une interface** : en B2 (futur), on implémente `BarbellSizing` avec un ratio explicite et Kelly fractionné, même signature. `findOpportunities` reçoit la stratégie par injection (config ou constructeur), et le reste du pipeline (guards, exécution, tracker) est inchangé. Le passage B1→B2 est un changement d'implémentation + un renommage d'accounting, pas une réécriture.

### 4.2 `ArbSizing` — dimensionnement 1:1 (B1)

**Nouveau fichier** : `src/strategy/arb-sizing.ts`

Logique :

```ts
export class ArbSizing implements SizingStrategy {
  readonly name = "arb";

  compute(ctx: SizingContext): SizingResult {
    const { config, tracker, pairId, cheapToken, expensiveToken, hedgePrice } = ctx;

    // 1. Prix cheap : min(ask, cheapBuyMax), borné par pairLockMax
    //    (pas de pairTargetCost en B1 — la formule target-hedge est supprimée)
    const cheapPrice = Math.round(
      Math.min(cheapToken.bestAsk ?? config.cheapBuyMax, config.cheapBuyMax) * 100,
    ) / 100;

    // 2. Coût de paire par share-paire
    const pairCost = Math.round((cheapPrice + hedgePrice) * 100) / 100;
    const pairLockOk = pairCost <= config.pairLockMax;  // ex. 0.98

    // 3. Taille cheap : budget / prix, plafonné par maxShares, minimums CLOB
    const cheapSize = pairLockOk
      ? computeSize(config.cheapOrderUsdc, cheapPrice, config.maxSharesPerOrder)
      : null;

    // 4. Taille hedge : 1:1 avec le cheap REMPLI (pas le budget)
    //    Le budget expensiveOrderUsdc devient un plafond secondaire.
    const filledCheap = tracker.getFilledCheapSizeForPair(pairId);
    if (filledCheap <= 0) {
      return {
        cheapPrice, cheapSize, hedgePrice,
        hedgeSize: null,
        pairCost, pairLockOk,
        reason: "no-filled-cheap",
      };
    }
    // Plafond budget : si le budget est insuffisant pour les minimums CLOB,
    // computeSize retourne null → le hedge est limité au budget disponible,
    // PAS à filledCheap (sinon le plafond est silencieusement ignoré).
    const budgetMax = computeSize(config.expensiveOrderUsdc, hedgePrice, config.maxSharesPerOrder);
    const hedgeSize = budgetMax !== null
      ? Math.min(filledCheap, budgetMax)
      : 0;  // budget insuffisant → hedge bloqué, cheap excédentaire à couper via SELL (§4.4)

    let reason = pairLockOk ? "arb-pair" : "pair-cost-exceeds-lock";
    if (pairLockOk && hedgeSize < filledCheap) {
      reason = "arb-pair-budget-capped";  // hedge limité par le budget, cheap excédentaire
    } else if (pairLockOk && hedgeSize === 0) {
      reason = "arb-pair-budget-insufficient";
    }

    return {
      cheapPrice, cheapSize, hedgePrice, hedgeSize,
      pairCost, pairLockOk,
      reason,
    };
  }
}
```

**Points clés** :
- `hedgeSize = filledCheapSize` (1:1) — le hedge couvre **exactement** la position cheap acquise.
- `EXPENSIVE_ORDER_USDC` devient un **plafond** (`Math.min(filledCheap, budgetMax)`) — si le cheap se remplit pour 15 shares mais le budget ne couvre que 10, le hedge est limité à 10 et les 5 shares cheap excédentaires restent nues (à couper via SELL §4.4 ou à porter en directionnel assumé).
- `pairLockOk` vérifie `pairCost ≤ pairLockMax < 1.00` — **aucune paire à perte n'est postée**.

### 4.3 Revalidation du coût de paire au moment du fill (constat 7.1, C6)

**Problème** : `pairCostOk` est vérifié à la génération de l'opportunité (sur le book du tick courant). Les fills sont asynchrones — le cheap peut se remplir plus tard à un prix différent, et le hedge à un ask différent.

**Fichier** : `src/bot.ts` (`executeOpportunity`, avant le dispatch GTC/FOK)

**Changement** : avant de poster le hedge, **re-fetcher le book** du token favori et revalider :

```ts
// Avant de poster le hedge (kind === "expensive") :
if (opportunity.kind === "expensive" && !this.config.dryRun) {
  const freshBook = await this.scanner.getTokenBook(opportunity.token.tokenId);
  const freshAsk = freshBook?.bestAsk ?? null;
  if (freshAsk === null || freshAsk > config.expensiveBuyMax) {
    log("Hedge skipped - favorite ask left the band since generation", { … });
    return;  // ne pas poster un hedge hors bande
  }
  const freshHedgePrice = Math.min(freshAsk, config.expensiveBuyMax);
  const cheapFillPrice = this.tracker.getCheapFillPriceForPair(opportunity.pairId);
  if (cheapFillPrice !== null && cheapFillPrice + freshHedgePrice > config.pairLockMax) {
    log("Hedge skipped - pair cost exceeds lock at fill time", {
      cheapFillPrice, freshHedgePrice, pairLockMax: config.pairLockMax,
    });
    // Option : couper le cheap via SELL (§4.4) si la paire n'est plus couvrable
    await this.defendPair(opportunity.pairId);
    return;
  }
  // Revalider la taille : filledCheap peut avoir changé depuis la génération
  opportunity = { ...opportunity, price: freshHedgePrice };
  // Recalculer le coût estimé pour la garde d'exposition (sinon l'ancien
  // prix périmé est utilisé, et le cap MAX_EXPOSURE_USDC peut être dépassé).
  estimatedCost = freshHedgePrice * opportunity.size;
}
```

**Nouvelle méthode `TradeTracker.getCheapFillPriceForPair`** : retourne le `fillPrice` moyen pondéré des jambes cheap remplies d'une paire (pour la revalidation du coût). À ajouter dans `trade-tracker.ts`.

**Nouvelle méthode `scanner.getTokenBook(tokenId)`** : récupère un seul book (pas les deux tokens). Extraire de `getTokenBooks` existant.

### 4.4 Support SELL — coupe de secours (constat 9.3-3)

**Problème** : si le cheap se remplit mais le favori a dépassé la bande (ask > `expensiveBuyMax`), la paire ne peut plus se couvrir. Aujourd'hui, le cheap est porté jusqu'à la résolution (perte probable de 100 %). En B1, on veut le **couper** pour limiter la perte.

**Fichiers** : `src/types.ts`, `src/trader.ts`, `src/bot.ts`

**Changements** :

1. `types.ts` : `TradeSide` est déjà `"BUY"` — l'élargir à `"BUY" | "SELL"` (le type prévoit déjà `"SELL"` mais ne l'utilise pas).

2. `trader.ts` : ajouter `placeSell` :
   ```ts
   async placeSell(opportunity: TradeOpportunity): Promise<OrderResult> {
     if (!this.client) throw new Error("Trading client not initialized");
     // Le bestBid de l'opportunité peut être périmé (généré il y a plusieurs
     // ticks) — le caller (defendPair) doit passer un bestBid frais obtenu
     // via scanner.getTokenBook() juste avant l'appel.
     const fokPrice = Math.max(opportunity.token.bestBid ?? 0, 0.01);
     const usdcAmount = fokPrice * opportunity.size;
     const response = await this.withTimeout(
       "placeSell",
       this.client.createAndPostMarketOrder(
         { tokenID: opportunity.token.tokenId, price: fokPrice, amount: usdcAmount, side: Side.SELL, orderType: OrderType.FOK },
         { tickSize: opportunity.tickSize as …, negRisk: opportunity.negRisk },
         OrderType.FOK,
       ),
     );
     // … même parsing que placeBuyFOK mais side SELL
   }
   ```
   **Note** : `defendPair` (§4.4) est responsable du refresh du book du cheap **avant** de construire l'opportunité de SELL — `placeSell` ne fait pas de fetch réseau, elle exécute seulement.

3. `bot.ts` : nouvelle méthode `defendPair(pairId)` :
   - Récupérer le **token cheap** de la paire depuis le tracker (`tracker.getCheapTokenForPair(pairId)` — nouvelle méthode à ajouter, ou via `tracker.getPair(pairId)` qui expose déjà les token IDs). L'opportunité dans ce contexte est le hedge (`kind="expensive"`, token = favori), **pas** l'underdog — il ne faut pas vendre le token de l'opportunité, mais le cheap.
   - Si le cheap est rempli mais le hedge est impossible (favori > band) et le coût de paire > `pairLockMax` :
     - **Re-fetcher le book du cheap** (`scanner.getTokenBook(cheapTokenId)`) pour obtenir un `bestBid` frais.
     - Vendre le cheap au `bestBid` frais (FOK market) pour limiter la perte.
     - Si le FOK SELL ne remplit pas (bid trop bas), porter le cheap en directionnel assumé et logger.
   - Émettre un event `order` avec `side: "SELL"`, `reason: "pair-defense"`.

**Pour B2** : `defendPair` est aussi utilisée pour couper un cheap dont le modèle a effondré la proba après fill (Séquence 3 future). La méthode est **commune** aux deux stratégies.

### 4.5 Suppression de `disablePairTargetCost` (constat L1, L5, L16)

**Problème** : le toggle `disablePairTargetCost` est trompeur — il ne désactive pas la paire couverte, seulement la formule de prix cheap. En B1 (1:1), la formule `pairTargetCost − hedge` n'a plus de sens (le prix cheap est `min(ask, cheapBuyMax)` borné par `pairLockMax`).

**Fichiers** : `src/config.ts`, `src/strategy.ts`, `src/runtime-settings.ts`, `frontend/src/`, `tests/`

**Changements** :
1. `config.ts` : supprimer `disablePairTargetCost` de `BotConfig`. Supprimer `pairTargetCost` également (la cible est remplacée par `pairLockMax`).
2. Ajouter `pairLockMax: number` (défaut 0.98) à `BotConfig`. Validation : `0.90 ≤ pairLockMax < 1.00`.
3. `config.ts` `validateConfigCoherence` : supprimer les validations `pairCostMax` (lignes ~258) et `pairTargetCost` (lignes ~261-264). Ajouter validation `pairLockMax` (`0.90 ≤ pairLockMax < 1.00`). Sans cette mise à jour, le code ne compile plus (référence à des champs supprimés).
4. `runtime-settings.ts` : remplacer `disablePairTargetCost` et `pairTargetCost` par `pairLockMax` dans `EDITABLE_CONFIG_KEYS` et `parseField` (section `case "pairCostMax": case "pairTargetCost":` → `case "pairLockMax":`).
5. `strategy.ts` : supprimer la branche `usePairTarget` (lignes 227-231). Le prix cheap est toujours `min(ask, cheapBuyMax)` borné par `pairLockMax`. Supprimer la référence à `config.pairCostMax` (ligne 217) — remplacer par `config.pairLockMax`.
6. `frontend/` : supprimer le toggle du `SettingsModal`, remplacer le champ `pairTargetCost` par `pairLockMax`. Mettre à jour la `ConfigBar` (supprimer « cible 0.95 »).
7. `data/bot-settings.json` : migration — supprimer `disablePairTargetCost` et `pairTargetCost`, ajouter `pairLockMax: 0.98`.
8. `tests/` : mettre à jour `strategy.test.ts` (supprimer les tests `disablePairTargetCost`, ajouter tests `pairLockMax`). Mettre à jour tout test qui référence `pairCostMax` ou `pairTargetCost`.

**Migration DB** : pas nécessaire (les clés invalides dans `bot-settings.json` sont rejetées par `sanitizePatch` → throw → fail-loud de la S1 3.1). L'opérateur doit éditer le dashboard une fois après déploiement pour saisir `pairLockMax`.

### 4.6 Aligner README/STRATEGY/docs (constats C1, L3, L5, L14, 7.19)

**Fichiers** : `README.md`, `STRATEGY.md`, `.env.example`

**Changements** :
1. `README.md` : corriger l'exemple « hedge 1:1 with cheap » → c'est maintenant **vrai**. Supprimer la mention « `EXPENSIVE_ORDER_USDC` — not 1:1 cheap shares ». Documenter `PAIR_LOCK_MAX` (remplace `PAIR_COST_MAX` et `PAIR_TARGET_COST`).
2. `STRATEGY.md` : réécrire §2.2 « hedge 1:1 » pour refléter le code réel (1:1 en parts, budget = plafond). Documenter la revalidation au fill et la coupe SELL.
3. `.env.example` : remplacer `PAIR_COST_MAX` et `PAIR_TARGET_COST` par `PAIR_LOCK_MAX=0.98`. Supprimer `DISABLE_PAIR_TARGET_COST`. Documenter `EXPENSIVE_ORDER_USDC` comme « plafond secondaire du hedge, le dimensionnement principal est 1:1 avec le cheap rempli ».

### 4.7 Tests du cycle de vie ordres (constat 7.16)

**Nouveau fichier** : `tests/mock-clob-client.ts` + `tests/order-lifecycle.test.ts`

**Mock ClobClient** :
```ts
export class MockClobClient {
  public orders = new Map<string, { status: string; sizeMatched: number; originalSize: number }>();
  public postedOrders: any[] = [];
  public shouldFail = false;

  async createAndPostOrder(req: any): Promise<{ orderID: string; success: boolean }> {
    if (this.shouldFail) throw new Error("network error");
    const orderID = `mock-${Date.now()}-${Math.random()}`;
    this.postedOrders.push({ ...req, orderID });
    this.orders.set(orderID, { status: "live", sizeMatched: 0, originalSize: req.size });
    return { orderID, success: true };
  }
  async cancelOrder(req: { orderID: string }): Promise<void> {
    const o = this.orders.get(req.orderID);
    if (o) o.status = "canceled";
  }
  async getOrder(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error("404 not found");
    return { ...o, size_matched: String(o.sizeMatched), original_size: String(o.originalSize) };
  }
  // simulateFill(orderId, size) : helper de test pour déclencher un fill partiel/total
  simulateFill(orderId: string, size: number) {
    const o = this.orders.get(orderId);
    if (o) { o.sizeMatched = size; o.status = size >= o.originalSize ? "matched" : "live"; }
  }
}
```

**Tests** (couvrir les chemins qui manipulent de l'argent réel) :
- `cancelStaleOrders` : ordre stale sans orderId → emit cancelled + remove.
- `cancelStaleOrders` : ordre stale avec orderId + fill partiel → finalizeLiveOrder (crée position pour la portion remplie) + cancel.
- `pollOrderFills` : ordre rempli → finalizeLiveOrder.
- `pollOrderFills` : ordre annulé sans fill → emit cancelled + remove + `cancelOrphanHedgesIfNeeded`.
- `cancelOrphanHedgesIfNeeded` : cheap annulé sans fill → hedge annulé.
- `cancelOrphanHedgesIfNeeded` : cheap annulé **avec** fill → hedge **non** annulé.
- `replaceMarketableCheap` : ask descend sous le limit → cancel + unmark.
- `defendPair` (nouveau S2) : cheap rempli + favori hors bande → SELL FOK.

---

## 5. Détails d'implémentation

### 5.1 Nouveaux paramètres de config

| Paramètre | Type | Défaut | Rôle |
|---|---|---|---|
| `PAIR_LOCK_MAX` | number (0.90-1.00) | 0.98 | Verrou profit : `prixCheap + prixHedge ≤ PAIR_LOCK_MAX`. Remplace `PAIR_COST_MAX` et `PAIR_TARGET_COST`. |
| `EXPENSIVE_ORDER_USDC` | number | 6 (config effective actuelle) | **Plafond secondaire** du hedge. Le hedge est 1:1 avec le cheap rempli, plafonné par ce budget. |

**Supprimés** : `PAIR_COST_MAX`, `PAIR_TARGET_COST`, `DISABLE_PAIR_TARGET_COST`.

### 5.2 Modifications par fichier (récapitulatif)

| Fichier | Séquence | Changement |
|---|---|---|
| `src/config.ts` | S1 3.1 | Fail-loud sur overlay invalide en live ; log divergences |
| `src/config.ts` | S2 4.5 | Supprimer `pairCostMax`, `pairTargetCost`, `disablePairTargetCost` ; ajouter `pairLockMax` ; mettre à jour `validateConfigCoherence` |
| `src/runtime-settings.ts` | S2 4.5 | Mettre à jour `EDITABLE_CONFIG_KEYS` et `parseField` |
| `src/bot.ts` | S1 3.2 | Garde balance fail-closed |
| `src/bot.ts` | S1 3.4 | Exiger `getFilledCheapSizeForPair > 0` pour tout hedge |
| `src/bot.ts` | S2 4.3 | Revalidation du coût de paire au fill + refresh book |
| `src/bot.ts` | S2 4.4 | `defendPair` — coupe SELL du cheap si paire non couvrable |
| `src/trader.ts` | S1 3.3 | `withTimeout` sur tous les appels trading |
| `src/trader.ts` | S2 4.4 | `placeSell` FOK |
| `src/strategy.ts` | S2 4.1-4.2 | Extraire `ArbSizing` ; supprimer branche `usePairTarget` ; utiliser `SizingStrategy` |
| `src/strategy/sizing.ts` | S2 4.1 | Interface `SizingStrategy` (nouveau) |
| `src/strategy/arb-sizing.ts` | S2 4.2 | `ArbSizing` 1:1 (nouveau) |
| `src/trade-tracker.ts` | S2 4.3 | `getCheapFillPriceForPair` + `getCheapTokenForPair` (nouveaux) |
| `src/market-scanner.ts` | S2 4.3 | `getTokenBook(tokenId)` — single book fetch (nouveau) |
| `src/types.ts` | S2 4.4 | `TradeSide = "BUY" \| "SELL"` |
| `frontend/…/SettingsModal.tsx` | S2 4.5 | Supprimer toggle `disablePairTargetCost` + champ `pairTargetCost` ; ajouter `pairLockMax` |
| `frontend/…/ConfigBar.tsx` | S2 4.5 | Supprimer « cible 0.95 » ; afficher `pairLockMax` |
| `frontend/src/utils/configForm.ts` | S2 4.5 | Mettre à jour les champs du formulaire |
| `data/bot-settings.json` | S2 4.5 | Migration : supprimer clés obsolètes, ajouter `pairLockMax` |
| `README.md` | S2 4.6 | Corriger 1:1 (maintenant vrai), documenter `PAIR_LOCK_MAX` |
| `STRATEGY.md` | S2 4.6 | Réécrire §2.2, documenter revalidation + SELL |
| `.env.example` | S2 4.6 | Remplacer `PAIR_COST_MAX`/`PAIR_TARGET_COST` par `PAIR_LOCK_MAX` |
| `tests/config.test.ts` | S1 3.1 | Tests fail-loud + divergences |
| `tests/strategy.test.ts` | S2 4.5 | Mettre à jour pour `pairLockMax` + 1:1 |
| `tests/mock-clob-client.ts` | S2 4.7 | Mock ClobClient (nouveau) |
| `tests/order-lifecycle.test.ts` | S2 4.7 | Tests cycle de vie ordres (nouveau) |

### 5.3 Ordre d'implémentation recommandé

```
S1.5  git init + tag pre-refonte-b1
S1.1  fail-loud config           → tests config
S1.2  balance fail-closed        → tests bot
S1.3  timeout trading            → tests trader
S1.4  anti favori nu             → tests bot
      commit "S1: sécuriser le live"
      ── le bot live est sécurisé, indépendant de B1/B2 ──

S2.1  SizingStrategy interface   → (pas de test, interface seule)
S2.5  supprimer disablePairTargetCost + ajouter pairLockMax à BotConfig
      → tests config + strategy
      (⚠ AVANT S2.2 : ArbSizing référence config.pairLockMax — sans
       ce paramètre, S2.2 ne compile pas)
S2.2  ArbSizing 1:1              → tests sizing
S2.3  revalidation au fill       → tests bot
S2.4  placeSell + defendPair     → tests trader + bot
S2.7  mock ClobClient + tests cycle de vie
S2.6  aligner README/STRATEGY/.env.example
      commit "S2: refonte dimensionnement B1"
      ── le bot fait du vrai arbitrage 1:1 ──
```

---

## 6. Validation et critères d'acceptation

### 6.1 Critères S1 (sécuriser le live)

- [ ] `loadConfig` avec overlay invalide en live → throw (pas de démarrage).
- [ ] `loadConfig` loggue les divergences overlay ↔ `.env`.
- [ ] `executeOpportunity` avec `available === null` en live → ordre rejeté (`balance-unknown`).
- [ ] `placeBuy` / `placeBuyFOK` / `cancelOrder` → timeout après 8 s si pas de réponse.
- [ ] Hedge GTC avec cheap **resting** (pas rempli) → rejeté (`no-committed-cheap-leg`).
- [ ] Hedge GTC avec cheap **rempli** → posté.
- [ ] `tsc --noEmit` → 0 erreur.
- [ ] `npm test` → tous les tests passent.

### 6.2 Critères S2 (refonte B1)

- [ ] `hedgeSize === filledCheapSize` (à epsilon près) pour toute paire couverte.
- [ ] Aucune paire postée si `prixCheap + prixHedge > pairLockMax` (0.98).
- [ ] Revalidation au fill : hedge rejeté si `prixCheapFill + askFavoriFrais > pairLockMax`.
- [ ] `defendPair` : cheap rempli + favori hors bande → SELL FOK tenté.
- [ ] `placeSell` fonctionne (FOK market sell au bestBid).
- [ ] `disablePairTargetCost` supprimé du code, du dashboard, de `bot-settings.json`.
- [ ] `pairLockMax` editable dans le dashboard (remplace `pairTargetCost` + `pairCostMax`).
- [ ] README/STRATEGY/.env.example alignés sur le 1:1.
- [ ] Mock ClobClient + 8 tests du cycle de vie ordres passent.
- [ ] `tsc --noEmit` → 0 erreur (backend + frontend).
- [ ] `npm test` → tous les tests passent.

### 6.3 Vérification live (après déploiement)

- [ ] Démarrer en `READONLY_LIVE=true` : aucune erreur, config logguée, divergences affichées.
- [ ] Basculer en live : première fenêtre avec favori dans la bande → cheap posté, **pas de hedge** tant que cheap non rempli.
- [ ] Cheap rempli → hedge 1:1 posté au tick suivant, coût de paire ≤ 0.98.
- [ ] Vérifier en DB : `positions` où `kind="expensive"` → `size` ≈ `size` du cheap de la même paire (± arrondi CLOB).
- [ ] Vérifier `arb_pairs` : `realizedPnl` d'une paire résolue = `(1 − coût) × taille` > 0 **dans tous les cas** (favori gagne ou underdog gagne).

---

## 7. Passage vers B2 (futur) — comment ce plan le prépare

Ce plan est conçu pour que le basculement vers B2 (barbell assumé) soit une **évolution**, pas une réécriture. Voici ce qui est réutilisable et ce qui change :

### 7.1 Réutilisable tel quel (commun B1/B2)

| Élément | Pourquoi c'est commun |
|---|---|
| **S1 entière** (guards P0) | Fail-loud config, balance fail-closed, timeout, anti favori nu — protégent le capital dans toutes les stratégies. |
| `SizingStrategy` interface (S2.1) | B2 implémente `BarbellSizing` avec la même signature. |
| `defendPair` + `placeSell` (S2.4) | Coupe de secours : en B2, utilisé pour couper un cheap dont le modèle a effondré la proba. |
| Revalidation au fill (S2.3) | En B2, revalider l'edge du modèle (pas le coût de paire), même mécanisme de refresh book. |
| Mock ClobClient + tests cycle de vie (S2.7) | Les chemins d'ordres sont les mêmes, seul le dimensionnement change. |
| Scanner, tracker, DB, dashboard, relayer | Architecture technique inchangée. |

### 7.2 Ce qui change pour B2 (futur)

| Élément | B1 (ce plan) | B2 (futur) |
|---|---|---|
| `SizingStrategy` implémentation | `ArbSizing` (1:1, verrou profit) | `BarbellSizing` (ratio explicite, Kelly fractionné) |
| Condition d'entrée | `pairCost < pairLockMax` (inefficience de prix) | `edge ≥ EDGE_MIN` (oracle + modèle probabiliste) |
| `pairLockMax` | Verrou profit (< 1.00) | Inutile (pas de verrou, on parie sur la prédiction) |
| Accounting | `covered` / `directional` (honnête en 1:1) | Deux jambes séparées, PnL par jambe, plus de `covered` |
| Oracle de prix | Non requis (filtre optionnel future) | **Obligatoire** (Séquence 3 : `MarketOracle` + `EdgeModel`) |
| Circuit breakers | Non critiques (variance faible) | **Obligatoires** (Séquence 4 : daily loss, pertes consécutives) |
| `EXPENSIVE_ORDER_USDC` | Plafond secondaire du hedge | Budget de la jambe favori (dimensionnement Kelly) |

### 7.3 Point d'extension unique

Le passage B1→B2 se fait en :
1. Implémenter `BarbellSizing` (nouveau fichier `src/strategy/barbell-sizing.ts`).
2. Implémenter `MarketOracle` + `EdgeModel` (Séquence 3 de l'audit).
3. Changer la condition d'entrée dans `findOpportunities` : `pairCost < pairLockMax` → `edge ≥ EDGE_MIN`.
4. Ajouter les circuit breakers (Séquence 4).
5. Renommer l'accounting (`covered`/`directional` → PnL par jambe).

**Aucune réécriture** des guards, de l'exécution, du tracker, du scanner, de la DB, du dashboard. L'interface `SizingStrategy` est le point d'extension unique.

---

## 8. Risques et mitigations

| Risque | Mitigation |
|---|---|
| Le hedge 1:1 arrive un tick après le cheap fill → le favori a pu monter entre-temps | Revalidation au fill (S2.3) : si `pairCost > pairLockMax` au moment du hedge, skip + `defendPair` (couper le cheap). Le risque résiduel est un tick de glissement (~2 s), acceptable. |
| `defendPair` vend le cheap à perte (bestBid < fillPrice) | C'est intentionnel : limiter la perte à `(fillPrice − bestBid) × size` plutôt que `fillPrice × size` (perte totale à résolution). Logger le PnL de la coupe pour suivi. |
| Le volume de paires < 1.00 est insuffisant → peu de trades | C'est attendu et **acceptable** en B1. Mesurer le volume sur 3-5 jours ; si insuffisant, c'est le signal pour envisager B2 (avec oracle). |
| Suppression de `disablePairTargetCost` casse les `bot-settings.json` existants | `sanitizePatch` rejette les clés inconnues → throw → fail-loud de S1 3.1. L'opérateur doit éditer le dashboard une fois (saisir `pairLockMax`). Documenté dans le CHANGELOG. |
| `EXPENSIVE_ORDER_USDC` comme plafond secondaire peut limiter le hedge en dessous du 1:1 | Documenter : si `filledCheap × hedgePrice > expensiveOrderUsdc`, le hedge est limité et le cheap excédentaire est directionnel. Pour un vrai 1:1 complet, augmenter `EXPENSIVE_ORDER_USDC`. |
| Tests du cycle de vie ordres ne couvrent pas le CLOB réel | Les tests valident la **logique d'orchestration** (cancel, fill, orphan, finalize), pas la connexion CLOB. La connexion est validée en `READONLY_LIVE` puis live avec petit capital. |

---

## 9. Critère de succès global

Après S1 + S2, le bot doit satisfaire :

> **Toute paire `arb_pairs` résolue avec `status="covered"` a un `realizedPnl > 0`, quel que soit le résultat de la fenêtre (favori gagne ou underdog gagne).**

C'est le test de cohérence fondamental : si une paire « couverte » perd, ce n'est pas un arbitrage. Si toutes les paires couvertes gagnent (petit, mais certain), la stratégie B1 est honnête et opérationnelle.

---

*Plan de refonte B1 — Séquences 1 + 2. Généré le 2026-09-08 suite à l'audit 5.*