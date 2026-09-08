# Audit code approfondi — logique, incohérences, bugs, bugs fantômes, code mort (audit-4)

**Date** : 2026-09-06, 08:32–09:00 UTC+2
**Périmètre** : `src/` (16 fichiers), `frontend/src/` (30 fichiers), `scripts/`, `README.md`, `STRATEGY.md`, `.env.example`, `.env` (clés non secrètes uniquement), snapshot de `data/bot-live.db` et `data/bot.db`.
**Méthode** : lecture intégrale du code, `tsc --noEmit` backend + frontend (0 erreur), requêtes SQL sur une **copie** des DB pour confirmer les hypothèses (« bugs fantômes » = suspectés par lecture puis vérifiés ou infirmés par les données), inspection du process live.
**Contexte** : le code a été fortement remanié ce matin entre 07:56 et 08:28 (hedge unique 1:1, table `orders`, table `redeems`, refonte `posted_orders`, stats live renommées). Le process live (PID 29980, `tsx src/index.ts`, sans watch) a redémarré à 08:29:48 avec ce code. Cet audit porte donc sur le **code actuellement en production**.

---

## 0. Verdict

Le projet est **globalement sain et cohérent** : il compile strictement, les garde-fous financiers principaux (cap d'exposition, balance CLOB, favori strict, claim de fenêtre, anti-empilement mémoire + DB) sont en place et fonctionnent, et les correctifs des audits 1 à 3 tiennent (0 paire bloquée, 0 doublon post-fix, 0 fill > `EXPENSIVE_BUY_MAX` depuis le clamp).

Mais l'audit met au jour :

- **1 faille de sécurité latente** dans la validation live (`SIM_RESOLVE_FALLBACK` contournable par casse/typo → résolution RNG de positions réelles).
- **1 bug d'intégrité confirmé par les données** : les paires restaurées après un restart ne sont jamais finalisées au runtime (instances dupliquées), seul le catch-up du restart suivant les répare — 6 paires en DB portent la signature (gap 468 s → 10 h entre dernière jambe et finalisation).
- **1 fuite d'ordre CLOB** possible (ordre partiellement rempli + échec de cancel → jamais réessayé).
- **Une dizaine de bugs moyens/faibles** (double replay au chargement du dashboard, modal de redeem vide, spam d'events live infini sur `not-a-favorite`/`insufficient-balance`, snapshot balance à 0 au boot, AutoRedeemer silencieusement inactif sans dashboard, etc.).
- **Une dette documentaire notable** : README/STRATEGY/.env.example décrivent une stratégie (ladder hedge, `EXPENSIVE_ORDER_USDC`) qui n'existe plus dans le code ; les valeurs par défaut de `config.ts` divergent de `.env.example` d'un facteur 10.
- **Du code mort** identifié précisément (config, types, branches, table SQL orpheline, dossier vide).

Aucun de ces points n'a causé de perte constatée sur le live actuel. Les deux premiers points de la section 2 méritent un correctif rapide car ils touchent à de l'argent réel ou à la fiabilité des stats qui pilotent les décisions.

---

## 1. Santé générale

| Contrôle | Résultat |
|---|---|
| `tsc --noEmit` backend (`strict: true`) | ✅ 0 erreur |
| `tsc --noEmit` frontend | ✅ 0 erreur |
| Node | v22.14.0 (`node:sqlite` expérimental, warning au boot) |
| Tests automatisés | ❌ **aucun** (ni unitaires, ni intégration, pas de script `test`) |
| Contrôle de version | ❌ **le dossier n'est pas un dépôt git** (`.gitignore` présent mais `git status` échoue) |
| Process live | PID 29980, `tsx src/index.ts` (pas de `watch`), démarré 08:29:48 |
| Paires non résolues avec toutes jambes résolues | 0 (snapshot 08:33) |
| Doublons `pairId+kind` postérieurs au fix anti-empilement | 0 (3 doublons historiques du 09-04, ère `tsx watch`) |
| Fills expensive > `EXPENSIVE_BUY_MAX` depuis le clamp | 0 |

---

## 2. Bugs par sévérité

### 🔴 Élevé

#### 2.1 `SIM_RESOLVE_FALLBACK` : la garde live est contournable (sécurité, argent réel)

- `src/config.ts:142-144` : `envString("SIM_RESOLVE_FALLBACK", "none") as "probabilistic" | "none"` — **aucune validation**, cast pur.
- `src/config.ts:197-201` : la garde live ne rejette que la valeur **exacte** `"probabilistic"`.
- `src/position-resolver.ts:133-138` : le résolveur teste `=== "none"` ; **toute autre valeur** bascule sur le tirage RNG.

Conséquence : `SIM_RESOLVE_FALLBACK=Probabilistic`, `=PROBABILISTIC`, `=random`, `=proba`, ou un simple caractère parasite, passe la validation live et fait résoudre des **positions réelles au hasard** (`probabilisticWinner`, `src/position-resolver.ts:226-229`). Latent (la `.env` actuelle vaut `none`), mais c'est exactement le risque que l'audit-2 voulait éliminer.

Même famille : `EXPENSIVE_ORDER_TYPE` (`config.ts:114`) n'est pas validé — toute valeur ≠ `FOK` est traitée comme GTC partout (`=== "FOK"`) ; `cheapBuyMin > cheapBuyMax` produit un ladder vide et un bot silencieusement inactif.

**Fix** : valider strictement les enums (`if (!["none","probabilistic"].includes(v)) throw`), valider `min ≤ max`, et rendre la garde live `!== "none"` plutôt que `=== "probabilistic"`.

#### 2.2 Paires restaurées après restart : jamais finalisées au runtime (intégrité des stats) — **confirmé par les données**

- `src/trade-tracker.ts:70-71` : `openPositions` chargées via `positionsRepo.open()` → instances A.
- `src/trade-tracker.ts:90-99` : les jambes des paires chargées via `positionsRepo.byPairIds()` → **instances B distinctes** (nouvel objet par `toPosition()`).
- `src/position-resolver.ts:85-100` : `resolvePosition` mute `position.status` sur l'instance A, puis teste `pair.cheapLegs.every(leg => leg.status !== "open")` sur les instances **B**, toujours `"open"` → `allLegsResolved` faux → `finalizePair()` jamais appelé.

Effets tant que le process ne redémarre pas : `arbRealizedPnl`/`directionalRealizedPnl`/`coverRate` sous-comptés, `coveredExposure`/`uncoveredExposure` **gonflées** (les jambes résolues restent comptées comme ouvertes dans la paire). Le catch-up de `loadFromDb()` (`trade-tracker.ts:108-117`) masque le bug au redémarrage suivant.

**Preuve DB** (`arb_pairs.resolvedAt − MAX(positions.resolvedAt)`) :

| Paire | Dernière jambe résolue | Paire finalisée | Écart |
|---|---|---|---|
| `btc-…-1788625800:1788626700` | 09-05 16:45 | 09-06 02:53 | 10 h 08 |
| `btc-…-1788608700:1788609600` | 09-05 12:12 | 09-05 16:37 | 4 h 25 |
| `btc-…-1788617700:1788618600` | 09-05 14:30 | 09-05 16:37 | 2 h 06 |
| `btc-…-1788664500:1788665400` | 09-06 03:34 | 09-06 04:31 | 57 min |
| `btc-…-1788672600:1788673500` | 09-06 05:45 | 09-06 06:02 | 17 min |
| `btc-…-1788674400:1788675300` | 09-06 06:15 | 09-06 06:23 | 8 min |

Pour la 5e ligne : jambe cheap créée 05:35:22 UTC, restart 05:37:08, résolue 05:45:09, paire finalisée seulement au restart de 06:02. Signature exacte du bug. Les paires finalisées en temps normal ont un écart < 1 s.

**Fix** : dans `loadFromDb()`, construire les jambes à partir des **mêmes instances** que `openPositions` (index par id, fallback DB uniquement pour les jambes déjà résolues), ou faire pointer `attachLeg`/`finalizePair` sur un lookup par id plutôt que sur des références.

#### 2.3 Fuite d'ordre CLOB : ordre stale partiellement rempli + échec de cancel

`src/bot.ts:196-216` :

```
if (status.sizeMatched > 0) this.finalizeLiveOrder(order, status);  // → removePostedOrder(key)
await this.trader.cancelOrder(order.orderId);                        // si throw…
} catch { log("Live order cancel failed, will retry") }              // …plus rien à réessayer
```

`finalizeLiveOrder` retire l'ordre du tracker **avant** le cancel. Si `cancelOrder` échoue (réseau, 5xx), la portion non remplie reste **live sur le CLOB** et n'est plus suivie : le log promet un retry qui n'aura jamais lieu. Pas d'occurrence constatée (0 `posted_orders` orphelin), mais le chemin est réel avec de l'argent réel.

**Fix** : cancel d'abord, finalisation ensuite (ou ne retirer l'ordre qu'après un cancel confirmé). Au passage, la triple garde `sizeMatched > 0` (`bot.ts:198`, `303`, `313`) est redondante.

### 🟠 Moyen

#### 2.4 Spam d'events live infini sur `not-a-favorite` et `insufficient-balance`

- `src/bot.ts:475-490` (`insufficient-balance`) et `bot.ts:492-513` (`not-a-favorite`, live) : `incrementRetry()` + `bus.emit({type:"order"})` **à chaque tick**, sans jamais tester `>= simMaxRetryAttempts` ni `mark()`. Le chemin simulé équivalent (`bot.ts:809-835`) marque la clé après 20 retries ; le chemin live ne le fait pas.
- Chaque émission = 1 ligne `events` + 1 ligne `orders`. À `POLL_INTERVAL_MS=1000` : **2 005 events `insufficient-balance` en 24 h**, et 6 777 sur la période d'audit-3.

**Fix** : aligner sur le chemin sim (mark après N retries), ou ne pas émettre d'event `order` pour les rejets répétés (comme fait pour « Hedge skipped », `bot.ts:441-450`).

#### 2.5 Dashboard : double replay des events au chargement

- `frontend/src/App.tsx:42-52` : `useEventSource` reçoit le replay des 500 events du ring buffer dès la connexion SSE (`server.ts:195-197`).
- `frontend/src/App.tsx:79-107` : `loadInitialState()` récupère `/api/state` qui renvoie **le même** `bus.replay()` (`server.ts:211-219`) et le redispatch.

Les handlers idempotents (positions, marchés, stats) absorbent le doublon ; `addLog` et `addOrder` (quand `/api/orders` est vide → `hydrated=false`, cas au boot d'un process neuf comme ce matin) **dupliquent**. Résultat : logs en double et ordres en double dans « Ordres récents » après un F5.

**Fix** : ne dispatcher les events que d'une seule source (ex. `handleState` sans `events`, ou SSE sans replay quand `?noreplay=1`).

#### 2.6 Dashboard : modal de confirmation du redeem toujours vide

`frontend/src/App.tsx:179` : `const redeemPosition = polyPositions.find((x) => x.conditionId === redeemTarget());` est évalué **une seule fois** au montage (hors `createMemo`), quand `redeemTarget()` est `null` → `undefined` pour toujours. Le modal affiche `Clôturer la position "" ?` avec un message vide. Le redeem lui-même fonctionne (`confirmRedeem` relit le store).

**Fix** : `const redeemPosition = createMemo(() => polyPositions.find(...))` et `redeemPosition()?.title`.

#### 2.7 Snapshot balance à 0 au boot (ordre d'initialisation)

`src/index.ts:30-33` démarre `BalanceTracker` **avant** `bot.init()` → `trader.init()` (`index.ts:46`). Au premier poll `this.client === null` → `getAvailableCollateral()` renvoie `null` → `?? 0` (`balance.ts:23`) → snapshot **persisté** `availableCollateral: 0` en `balance_snapshots` (source `live`) et émis au dashboard. C'est la cause racine de l'anomalie §6.1 d'audit-3. 224 snapshots à 0 en DB (boots + pannes réseau).

**Fix** : `await trader.init()` avant `balance.start()`, et ne pas persister quand `fetchAvailable()` renvoie `null`.

#### 2.8 `AutoRedeemer` silencieusement inactif si `ENABLE_DASHBOARD=false`

`AutoRedeemer` ne consomme que les events `polymarketPositions` (`auto-redeemer.ts:50-53`), émis uniquement par `BalanceTracker`, lui-même créé **uniquement** dans la branche dashboard (`index.ts:30-33`). Dans la branche sans dashboard (`index.ts:51-55`), l'AutoRedeemer démarre, logue « started », et **ne fera jamais rien**. Dépendance implicite non documentée.

#### 2.9 `fillRate` : trois sémantiques différentes pour `totalAttempts`

- Sim (`bot.ts:735`) : incrémenté à **chaque tentative**, y compris les 20 retries `no-fill`/`not-a-favorite` d'un même niveau → fillRate écrasé.
- Live GTC (`bot.ts:704`) : incrémenté au **post** (rempli ou non).
- Live FOK (`bot.ts:609`) : incrémenté **seulement si rempli** → fillRate FOK = 100 % par construction.

La métrique affichée « Fill rate » n'est comparable ni entre modes ni dans le temps.

#### 2.10 Exposition couverte/non couverte : jambes résolues comptées

`trade-tracker.ts:517-539` : `getCoveredExposure`/`getUncoveredExposure` somment `leg.cost` de **toutes** les jambes des paires non résolues, y compris celles déjà `won`/`lost` (tant que l'autre jambe n'est pas résolue). Transitoire au runtime (secondes), **permanent** pour les paires touchées par 2.2.

#### 2.11 Garde `too-close-to-close` : `dryRun: false` codé en dur

`src/bot.ts:397-401` : l'event `order` est émis avec `dryRun: false` **avant** le branchement `if (this.broker && this.ledger)` (`bot.ts:452`). En mode dry-run, la table `orders` enregistre `dryRun=0`, `orderType="GTC"` pour une simulation, et le dashboard logue « LIVE order ». Données faussées quand la garde est activée en dry-run.

#### 2.12 Reset dry-run : le ring buffer d'events n'est pas vidé

`DashboardServer.handleReset` → `db.reset()` + `bot.reset()` (`index.ts:38-41`), mais `EventBus.history` (`events.ts:74`) n'a pas de `clear()`. Un F5 après reset rejoue jusqu'à 500 events fantômes (positions, ordres, stats d'avant reset) via `/api/state` et SSE.

### 🟡 Faible

| # | Fichier | Constat |
|---|---|---|
| 2.13 | `src/bot.ts:210-216` | Si `getOrderStatus` échoue (ordre 404, réseau), l'ordre stale est ré-interrogé **à chaque tick** pendant 24 h (`prunePostedOrders`, `trade-tracker.ts:393-407`). À 1 s de poll : 86 400 appels CLOB pour un ordre mort. |
| 2.14 | `src/bot.ts:314-321` | Prix de fill GTC **estimé** (`bestAskAtFill ≤ limit ? bestAsk : limit`), jamais lu depuis le CLOB. `getOrderStatus` (`trader.ts:188-201`) ne remonte pas `price`/trades. `cost`/`pnl` des positions live sont des approximations ; `fillReason: "marketable"` même pour un ordre qui a reposé. |
| 2.15 | `src/bot.ts:613-618` vs `src/trader.ts:163-168` | `filledSize`/`fillPrice` FOK re-dérivés du `response` dans `bot.ts` au lieu d'utiliser `result.fillPrice`/le size calculé par `trader.ts` → logique dupliquée. Si `takingAmount` vaut `"0"` avec `success: true`, position de **taille 0 / coût 0** créée. |
| 2.16 | `src/strategy.ts:253-258` | `hedgeSize` = taille cheap engagée, **sans** vérifier les minimums CLOB (5 shares / 1 $). Un fill cheap partiel < 5 shares génère un hedge que le CLOB rejette → 20 retries `order-failed`. |
| 2.17 | `src/bot.ts:220-247` | Un ordre **partiellement** rempli mais toujours live n'est matérialisé qu'au fill total/cancel/stale. En mode FOK, `getFilledCheapSizeForPair` voit 0 → aucun hedge tant que le cheap n'est pas 100 % rempli. |
| 2.18 | `src/db/repositories.ts:489-503`, `535-554` | `record("cancelled")` et `markFilled` matchent par `tokenId` (+`pairId`) et non par `orderId` (pourtant disponible pour les fills). Faux si `MAX_OPEN_POSITIONS_PER_SIDE > 1`. Même limite côté frontend (`orderStore.ts:12-37`). |
| 2.19 | `src/db/repositories.ts:480-487` | `cost` de la ligne `orders` utilise `result.size` (demandé) et non la taille remplie pour un FOK ; `orderType` d'un FOK qui lève une exception réseau est enregistré `"GTC"` (`reason="order-failed"` ne contient pas `fok`). |
| 2.20 | `src/index.ts:30-33` + `bot.ts:119` | En dry-run **avec** `FUNDER_ADDRESS`, deux émetteurs écrivent le même type `balance` : le wallet réel (BalanceTracker) et le ledger simulé (`resolveAndEmitStats`). Le signal `liveBalance` du dashboard alterne entre les deux (masqué par la priorité à `simulatedCash`). |
| 2.21 | `src/trade-tracker.ts:47,51` | `keys` (Set) et `retryCounts` (Map) mémoire ne sont **jamais prunés** alors que leurs tables le sont à 24 h. Fuite lente sur process longue durée. |
| 2.22 | `src/trade-tracker.ts:83` | `pairsRepo.all()` charge **toutes** les paires (aucune limite, contrairement aux positions à 500) et `getArbRealizedPnl`/`getCoveredCount` itèrent tout à chaque stats (toutes les 5 s). 78 paires aujourd'hui ; ~50/jour. |
| 2.23 | `src/db/repositories.ts:141-147` | `countLegsByKind` = `COUNT(*)` sans index sur `positions(pairId, kind)`, appelé **par niveau de prix et par tick** (jusqu'à 14 × 1/s). Table non prunée. Acceptable à 138 lignes, à surveiller. |
| 2.24 | `src/dashboard/balance.ts:56` | `fetch(url)` **sans timeout** (contrairement à `market-scanner.ts:18-30`). Un data-api qui pend bloque le poll 30 s indéfiniment. |
| 2.25 | `src/market-scanner.ts:40` | `limit=50` sur `/events?tag_slug=15M` : si Polymarket dépasse 50 events 15M actifs (BTC/ETH/SOL/XRP × fenêtres courante + suivantes), le marché ciblé peut sortir de la page. |
| 2.26 | `src/relayer.ts:97-100` vs `213-220` | Commentaire : `amounts = [yesAmount, noAmount]` ; code : **un seul** élément `[2^255]`. L'un des deux est faux. RPC public codé en dur (`relayer.ts:175`). |
| 2.27 | `src/bot.ts:103-121` | `resolveAndEmitStats` attend `resolveDue()` (jusqu'à 5 × 5 s de retry par position) avant d'émettre stats/balance → stats gelées jusqu'à 25 s+ pendant une résolution difficile. |
| 2.28 | `src/dashboard/events.ts:60-70` | `stats`/`simulatedStats` (5 s), `balance`/`simulatedBalance` (30 s) persistés dans `events` **en plus** de `balance_snapshots` ; `order` persisté dans `events` **et** `orders`. 21 552 `stats` + 4 802 `balance` = 53 % des 49 906 lignes `events`. |
| 2.29 | `src/simulated-broker.ts:69-97` | En sim, un hedge FOK dont la limite (`min(ask, max)`) est < ask peut se remplir **probabilistiquement** à la limite. En live, un FOK non marketable est tué. Divergence sim/live sur le taux de couverture. |
| 2.30 | `frontend/src/App.tsx:58-60` | `syncPositions()` **toutes les secondes** : 2 appels REST/s, puis `dispatchEvent` pour chaque position ouverte et chaque résolue (≤ 500) → `addResolved` reconstruit le tableau pour chacune (O(n²)/s) et déclenche des re-renders continus. Redondant avec le SSE. |
| 2.31 | `frontend/src/components/panels/Logs.tsx:11-14` | `createEffect` ne lit aucun signal réactif (seulement `containerRef`) → s'exécute une fois. Et la liste est newest-first : scroller en bas est contre-productif. Effet mort. |
| 2.32 | `frontend/src/utils/helpers.ts:20-44` | Labels manquants pour `insufficient-balance`, `too-close-to-close`, `killed-fok` (affichés bruts) ; label `no-cheap-leg` pour une raison **jamais émise** par le backend. |
| 2.33 | `src/dashboard/server.ts:325-329` | Branche `503 Trader not initialized` inatteignable : `setTrader` est toujours appelé (`index.ts:37`) ; en dry-run c'est `redeemPosition` qui lève → 500. |
| 2.34 | `src/trader.ts:143-145` | Regex `/couldn't be fully filled|FOC|FOK/i` : `FOK` matche aussi un message d'erreur d'auth/réseau qui contiendrait « FOK » → classé « kill normal » et non retenté. Peu probable, mais la détection devrait cibler le message exact. |
| 2.35 | `src/db/database.ts:157-191` | Les migrations `ALTER TABLE` avalent **toutes** les erreurs (pas seulement « duplicate column ») : un `SQLITE_BUSY` au boot passerait sous silence et laisserait un schéma incomplet. |

---

## 3. Décision de stratégie non résolue (rappel audit-3 P1)

`src/strategy.ts:267-270` : en mode GTC, le hedge est posté à `config.expensiveBuyMin` (0.80) alors que l'ask du favori est typiquement 0.83-0.88. Le passage à un ordre unique 1:1 (ce matin) a supprimé le ladder, mais **le prix reste le plus bas de la fourchette** : le bid ne remplit que sur un dip. C'est la recommandation P1 d'audit-3 (poster à `min(bestAsk, expensiveBuyMax)`), toujours ouverte. Rappel des chiffres : +43 $ sur les paires couvertes, −16 $ sur les directionnelles — le taux de couverture reste le levier n°1.

Corollaire GTC non couvert par le code : si le cheap resting est annulé par l'exchange (`pollOrderFills` → `cancelled`, `sizeMatched 0`), le hedge GTC qui repose à côté **n'est pas annulé** → favori nu possible. Inverse aussi : cheap rempli, hedge jamais rempli, clé marquée → aucun repost pour la fenêtre.

---

## 4. Code mort et éléments orphelins

| Élément | Où | Détail |
|---|---|---|
| `expensiveOrderUsdc` | `config.ts:55,113` ; `ConfigBar.tsx:15` | **Config morte** : plus utilisée pour dimensionner (hedge 1:1 avec le cheap, `strategy.ts:253`). Le dashboard affiche « Hedge · 5 USDC » alors qu'un hedge coûte ~11 $ (14.28 sh × 0.80). Trompeur. |
| `relayerApiKey`, `relayerApiKeyAddress` | `config.ts:90-91,155-158,174-175,187-188` | Chargés, exclus de la config publique, **jamais lus**. |
| `Database.enabled` | `db/database.ts:19-21` | Getter jamais appelé. |
| `RedeemResult.transactionId` | `relayer.ts:121,288,293` | Retourné, jamais consommé (`trader.ts:233` ne garde que `txHash`). |
| `AutoRedeemer.stop()` | `auto-redeemer.ts:58-61` | Jamais appelé (pas de shutdown propre). |
| `FillReason = "partial"` | `types.ts:61`, `repositories.ts:25`, `frontend/types:59` | Jamais produit (sim : marketable/probabilistic ; live : toujours marketable). |
| `TradeSide = "SELL"` | `types.ts:1` | Jamais utilisé. |
| `bestSize(..., "bid")` | `utils/market.ts:34-45` | Seul le mode `"ask"` est appelé. |
| Branches `if (this.config.dryRun)` | `trader.ts:37-45`, `98-106` | **Inatteignables** : `bot.ts:452-455` route le dry-run vers `executeSimulated` avant tout appel à `Trader`. |
| Branche 503 | `server.ts:325-329` | Inatteignable (cf. 2.33). |
| `reasonLabel("no-cheap-leg")` | `frontend/utils/helpers.ts:38` | Raison jamais émise. |
| Table `stats_snapshots` | DB live (3 250 lignes), DB dry (704) ; `README.md:186` | **Table orpheline** : plus aucune référence dans `src/`, jamais prunée ni droppée. Le README la documente encore. Audit-3 P2 demandait un prune ; le code a supprimé l'écriture sans nettoyer. |
| `src/dashboard/public/assets/` | dossier vide | Reliquat (le serveur préfère `dist/dashboard/public`, `server.ts:16-27`). Le README (`:172`) parle encore de « sync manuel » de ce dossier. |
| `scripts/verify-finalize-catchup.ts` | `:21-31` | Accède à `db.conn` **privé** via cast ; hors `tsconfig.include` donc jamais typé. Script one-shot du fix 09-05, plus nécessaire. |
| Scripts npm `start` / `live` | `package.json:7,9` | Strictement identiques (`tsx src/index.ts`). |
| Guard triple `sizeMatched > 0` | `bot.ts:198,303,313` | Redondance (cf. 2.3). |
| `stripCost()` | `trade-tracker.ts:361-364` | Retire aussi `orderId` ; nom trompeur. |

---

## 5. Incohérences documentation / configuration

### 5.1 Valeurs par défaut `config.ts` vs `.env.example` vs README

| Clé | `config.ts` (défaut) | `.env.example` | README |
|---|---|---|---|
| `CHEAP_ORDER_USDC` | **10** | 1 | 1 |
| `EXPENSIVE_ORDER_USDC` | **50** | 3 | 3 |
| `MAX_SHARES_PER_ORDER` | **90** | 20 | 20 |
| `MAX_EXPOSURE_USDC` | **500** | 45 | 45 |
| `SIMULATED_CAPITAL` | **500** | 50 | — |
| `EXPENSIVE_BUY_MIN/MAX` | 0.90 / 0.95 | 0.85 / 0.95 | 0.85 / 0.95 |
| `SIGNATURE_TYPE` | **2** (Gnosis Safe) | 3 (POLY_1271, cf. `relayer.ts:4`) | — |
| `SIM_RESOLVE_FALLBACK` | none | **probabilistic** | probabilistic |
| `SIM_RESOLVE_DELAY_SECONDS` | 60 | 5 | 5 |
| `SIM_REQUIRE_COVERED_PAIR` | false | true | true |

Un lancement live sans `.env` complet traderait avec des tailles **10× supérieures** à celles documentées. Le défaut `SIGNATURE_TYPE=2` est incompatible avec le deposit wallet V2 que tout le module relayer suppose.

### 5.2 Documents obsolètes

- `STRATEGY.md` (03-09) : décrit un **ladder multi-niveaux des deux côtés en GTC** et `EXPENSIVE_ORDER_USDC` comme budget hedge. Le code actuel : hedge unique 1:1, FOK/GTC configurable, clamp `expensiveBuyMax`, `not-a-favorite`, claim de fenêtre. Aucune mention de FOK.
- `.env.example:30-31` : « Laddering posts up to 4 cheap levels (x1 USDC) + 6 hedge levels (x3 USDC) » — le ladder hedge n'existe plus.
- `README.md` : exemple « Down 0.15 + Up 0.78 » (`:22-24`) impossible avec `EXPENSIVE_BUY_MIN=0.85` (garde `not-a-favorite`) ; `stats_snapshots` documentée (`:186`) mais supprimée du code ; `src/dashboard/public/` à « synchroniser manuellement » (`:172`) alors que `server.ts` préfère toujours `dist/` ; variables absentes : `EXPENSIVE_ORDER_TYPE`, `AUTO_REDEEM_WINNERS`, `MIN_MINUTES_BEFORE_CLOSE_TO_BUY`, `READONLY_LIVE`, `SIGNATURE_TYPE`, `SIM_MAX_RETRY_ATTEMPTS`, `POLL_INTERVAL_MS`.
- Nommage : `SIM_MAX_RETRY_ATTEMPTS`, `SIM_RESOLVE_*` pilotent aussi le **live** (retries d'ordres CLOB, délai/retries Gamma). Le préfixe `SIM_` induit en erreur.
- Deux dossiers d'audit : `audit/` (1 fichier) et `audits/` (le reste).

### 5.3 Fragilité `.env`

`.env:63` : `SIM_REQUIRE_COVERED_PAIR=true     # exige un hedge…` — commentaire inline. dotenv 16 le tronque correctement, mais `envBoolean` ne tolère que `true`/`1` : un espace insécable ou une version dotenv plus ancienne rendrait la garde silencieusement `false`.

---

## 6. Observations de données (snapshot live 08:33)

| Table | Lignes | Remarque |
|---|---|---|
| `events` | 49 906 | 43 % `stats`, 20 % `order`, 15 % `simulatedStats` (héritage pré-rename), 11 % `error`, 10 % `balance`. Prune 7 j. À 1 s de poll : ~25 k lignes/jour. |
| `error` events | 5 511 | 4 100+ « not enough balance » du 09-04 (portefeuille vide), 361 « invalid tick size 0.001 » du 09-04 (corrigé `utils/market.ts:17-19`), 665 « fetch failed » + 111 `ENOTFOUND clob.polymarket.com` — **panne réseau 06:27-06:28 UTC ce matin**, résorbée. |
| `orders` | 0 | Table créée 08:10, process démarré 08:29 : normal. |
| `redeems` | 1 | Idem (53 redeems historiques uniquement dans `events`). |
| `stats_snapshots` | 3 250 | Orpheline (§4). |
| `balance_snapshots` | 4 802 | 224 à `availableCollateral = 0` (boots + panne). |
| `positions` | 138 | 59 expensive : fills 0.72 → 0.95 (les > 0.90 sont pré-clamp, 09-06 05:25-06:07 UTC). |
| `arb_pairs` | 78 | 53 couvertes / 25 directionnelles, 0 bloquée. |
| `window_claims` | 2 | `expensiveOutcome: ''` sur les deux (favori pas encore émergé) — normal. |
| PnL cumulé | **+27.6 $** | cheap +18.8 (7 W / 72 L), expensive +8.8 (50 W / 9 L). |

---

## 7. Recommandations priorisées

**P0 — Sécurité live (2.1)** : validation stricte des enums de config + garde live `!== "none"`. 10 lignes, zéro risque.

**P0 — Intégrité paires (2.2)** : unifier les instances dans `loadFromDb()`. Ce bug fausse en continu les stats « Arbitrage couvert / Directionnel / Exposition couverte » qui servent à évaluer la stratégie ; le catch-up au restart n'est qu'un pansement.

**P1 — Fuite d'ordre (2.3)** : cancel avant finalisation, ou finalisation conditionnée au succès du cancel.

**P1 — Décision stratégie GTC (§3)** : trancher la P1 d'audit-3 (prix du hedge GTC = `min(bestAsk, expensiveBuyMax)`) et décider quoi faire du hedge orphelin quand le cheap disparaît.

**P2 — Bruit et volume** : marquer après N retries en live (2.4), retirer `stats`/`balance` de `PERSISTED_EVENT_TYPES` (2.28) ou les downsampler, remonter `POLL_INTERVAL_MS` à 2-5 s (audit-3 P3, toujours à 1 s), arrêter le `syncPositions` 1 s côté dashboard (2.30 — 5-10 s suffisent en fallback SSE).

**P2 — Dashboard** : double replay (2.5), modal redeem (2.6), reset ring buffer (2.12), labels (2.32), effet mort Logs (2.31).

**P2 — Boot** : `trader.init()` avant `BalanceTracker` (2.7) ; documenter ou casser la dépendance AutoRedeemer → dashboard (2.8).

**P3 — Nettoyage** : supprimer le code mort listé §4 (`expensiveOrderUsdc` ou lui redonner un rôle de **plafond** de coût hedge, `relayerApiKey*`, branches inatteignables, `stats_snapshots` → `DROP TABLE` en migration, dossier `src/dashboard/public`, script `verify-finalize-catchup`, doublon `start`/`live`), aligner les défauts de `config.ts` sur `.env.example` (ou l'inverse), corriger `SIGNATURE_TYPE` par défaut, réécrire `STRATEGY.md` et les sections README obsolètes.

**P3 — Hygiène projet** : initialiser un dépôt git (le `.gitignore` est déjà là), ajouter `"engines": {"node": ">=22.5"}` (`node:sqlite`), et poser un premier filet de tests sur les fonctions pures (`strategy.findOpportunities`, `computeSize`, `priceLevels`, `extractWinner`, `finalizePair`) — ce sont elles qui ont porté tous les bugs financiers des audits précédents et elles sont testables sans réseau.

---

## 8. Limites

- Snapshot DB pris 4 min après le restart de 08:29 : les tables `orders`/`redeems` étaient vides, leur logique (`record`, `markFilled`) n'a pu être auditée que par lecture.
- Les comportements du CLOB (statuts `getOrder` d'un ordre matché ancien, sémantique exacte de `takingAmount`) et de l'adapter neg-risk (2.26) ne sont pas vérifiables hors ligne ; ils sont signalés comme incohérences documentaires, pas comme bugs confirmés.
- Aucun test n'existant, aucune régression n'a pu être exécutée : les bugs sont confirmés par lecture croisée et, quand c'était possible, par les données (2.2, 2.4, 2.7, 2.5 partiellement).

### Compléments post-relecture (inclus au patch)

- **2.36** `READONLY_LIVE` émettait un event `order` par tick et par opportunité (clé jamais marquée).
- **2.37** Un ordre GTC posté sans `orderID` CLOB est inannulable côté exchange — documenté, non corrigeable.

---

## 9. Statut des correctifs (2026-09-06)

Patch appliqué selon le plan de remédiation (lots 0–8). Le process live `tsx` sans watch n'en bénéficie qu'après redémarrage manuel.

| Point | Statut |
|---|---|
| 2.1 enum / garde live `!== none` | corrigé |
| 2.2 instances paires au reload | corrigé + test |
| 2.3 cancel avant finalize | corrigé |
| 2.4 / 2.36 retries live + readonly | corrigé |
| 2.5 double replay SSE | corrigé (`?replay=0`) |
| 2.6 modal redeem | corrigé |
| 2.7 / 2.8 boot + AutoRedeemer | corrigé |
| 2.10 exposition jambes open | corrigé |
| 2.11 dryRun too-close | corrigé |
| 2.12 EventBus.clear | corrigé |
| 2.13 poll status borné | corrigé |
| 2.15 / 2.19 FOK filledSize + orderType | corrigé |
| 2.16 / hedge plafond CLOB | corrigé |
| 2.18 orders par orderId | corrigé |
| 2.20 / 2.24 / 2.27 balance + intervalles | corrigé |
| 2.21 / 2.22 prune mémoire + agrégats SQL | corrigé |
| 2.23 / 2.28 / 2.35 index + stats_snapshots | corrigé |
| 2.30 / 2.31 / 2.32 frontend | corrigé |
| 2.34 regex FOK | corrigé |
| §3 GTC prix + hedge orphelin | corrigé |
| §4 code mort | nettoyé |
| §5 docs / défauts config | alignés |
| Tests `node:test` | ajoutés |
| 2.14, 2.17, 2.25, 2.26, 2.29, 2.37 | volontairement non traités (approx. / doc) |
