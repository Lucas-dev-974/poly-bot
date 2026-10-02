# Chainlink-Lag Engine — Plan & Spécification

> **For Hermes:** plan d'implémentation — exécuter phase par phase, la phase recherche (2) est un PRÉREQUIS à l'implémentation du moteur (3). Checklist wiring complète : `references/new-strategy-wiring.md` du skill `polymarket-strategy-dev`.

**Goal:** Exploiter le lag **prix rapide (spot) → TWAP-60s (métrique de résolution Chainlink) → odds Polymarket** : la résolution des marchés Up/Down 15m se fait sur la TWAP-60s Chainlink Data Streams, une moyenne glissante structurellement en retard sur le spot. Quand le prix rapide bouge fort, la métrique de résolution (et donc les odds) traîne — acheter le côté favorisé à l'ask (FOK) avant reprice. Signal v1 : **projection de la TWAP de fin vs la barre `TWAP(début)`** (révision 4).

**Architecture:** Source externe **Polymarket Perps WS** (`wss://ws.perpetuals.polymarket.com`, public sans auth, ticks ~100 ms — vérifié live) en primaire, **Binance spot WS** en fallback (`FEED_SOURCE`) — prix rapide + TWAP-60s glissante reconstruite localement (proxy de la métrique de résolution, hypothèses A6/A7 à mesurer) + barre `twap60AtWindowStart` figée à l'ouverture de chaque fenêtre — enregistrés dans `feed_snapshots`, injectés dans `StrategyContext` (pattern `nowMs?`), consommés par un nouveau moteur directionnel mono-jambe `chainlink-lag` (FOK buy, hold to resolution, sans hedge). **Aucun abonnement Chainlink en v1** (Data Streams = produit credential payant, option v2).

**Tech Stack:** Node 22 / tsx, **WebSocket global de Node 22 (v22.14 installée — stable, zéro nouvelle dépendance)**, REST klines 1s Binance (gratuit, sans clé) pour le backfill, node:sqlite, SolidJS frontend. viem reste utilisé par le bot mais **plus nécessaire pour cette feature en v1**.

---

## 1. État des lieux (vérifié dans le repo)

- Aucune intégration Binance/Chainlink n'existe (`grep -i` : 0 hit dans `src/`, `scripts/`, `config/`).
- `src/strategy/probability-repricing-strategy.ts:25-28` documente déjà le trou : *"No Binance/spot feed in this bot yet → dislocation is computed vs a short rolling ask history on the CLOB (…) Documented placeholder until an external feed is wired (`repricingFeedMaxAgeMs` is accepted but unused while feed age is unavailable)"*. → **Le feed construit ici comblera aussi ce placeholder** (synergie à noter dans le guide).
- Interface stratégie : `TradingStrategy` (`src/strategy/trading-strategy.ts:85`) reçoit `StrategyContext { config, tracker, event, books, nowMs? }`. Le runner backtest (`src/backtest/runner.ts:94-115`) construit le contexte depuis le replay `book_snapshots` avec `nowMs: ts`. → Point d'extension naturel : un champ optionnel `feed?`.
- Univers : `marketSlugPrefixes` défaut `["btc-updown-15m", "eth-updown-15m"]` (`src/config.ts:495`). L'asset se déduit du préfixe slug (`btc-updown-15m-1758000000` → `btc`).
- Persistance : `book_snapshots` / `market_snapshots` enregistrées par tick quand `recording` (`src/bot/reverse-bot.ts:457-459`, `src/bot/tick-snapshots.ts`), purge par rétention (`marketSnapshotRetentionMs`). `market_resolutions.winnerOutcomeIndex` : 0=Up, 1=Down.
- 11 ids natifs dans `src/strategy/ids.ts` ; le 12e s'ajoute via la checklist wiring (11 étapes, chaque étape sautée casse build ou test).
- **Fenêtre d'opportunité du runner** : `processTick` (`src/backtest/tick-executor.ts:65-79`) n'appelle `findOpportunities` QUE dans `isWithinMinutesBeforeClose` (défauts `minutesBeforeCloseMin: 0, Max: 15` → fenêtre entière). **Toute fenêtre d'entrée moteur au-delà de `minutesBeforeCloseMax × 60` s serait silencieusement bridée** → validation de cohérence obligatoire (§3.5).
- **Paper trading a son propre chemin** : `src/paper/engine.ts:247` reconstruit le contexte `processTick` indépendamment — sans injection dédiée, un nouveau moteur est **muet en simulation** (le mode de validation principal avant live).
- Live : le contexte de `findOpportunities` est construit à `src/bot/reverse-bot.ts:484` (et les books parviennent aussi au paper engine à `reverse-bot.ts:455`).

## 2. Hypothèses à vérifier AVANT tout code moteur (Phase 0)

| # | Hypothèse | Méthode de vérification | Statut |
|---|-----------|------------------------|--------|
| A1 | Les marchés Up/Down 15m résolvent sur un prix **Chainlink** (et non Binance/autre oracle) | Lire la `description` d'un event Gamma live | ✅ **CONFIRMÉ (2026-09-25)** — description live `btc-updown-15m` : *"The resolution source for this market is information from Chainlink, specifically the BTC/USD **TWAP data stream** available at https://data.chain.link/streams/btc-usd-twap-60s-streams"* (idem ETH/XRP/DOGE ; SOL/HYPE/BNB/ZEC sur streams simples non-TWAP) |
| A2 | Quelle référence exacte ? | Idem A1 | ⚠️ **RÉVISÉ** — ce n'est PAS le feed on-chain push (aggregator Polygon) mais **Chainlink Data Streams** (off-chain, low-latency), variante **TWAP 60 s** : résolution = TWAP-60s fin de fenêtre ≥ TWAP-60s début de fenêtre (≥ → Up, tie favorable Up). Conséquence : le lag exploitable n'est pas "feed push lent" mais "**métrique de résolution = moyenne glissante 60 s, donc retard structurel vs spot**" |
| A3 | Binance klines 1s dispo en REST pour l'historique | curl sur quelques fenêtres du dataset backtest existant | **à vérifier** (non vérifié : je n'ai pas testé) |
| A4 | Source Chainlink pour le bot | ~~readContract latestRoundData~~ → **obsolète** : le feed on-chain n'est pas la source de résolution. Data Streams API = produitcredential/payant, PAS nécessaire en v1 (cf. A6) | ✅ **TRANCHÉ — v1 sans Chainlink** |
| A5 | WS Binance accessible depuis cette machine (pas de blocage geo 451) | petit script WS `btcusdt@trade` 30 s | **à vérifier** |
| A6 | **Proxy TWAP** : la TWAP-60s Binance approxime la TWAP-60s du stream Chainlink (composite multi-exchanges) assez bien pour prédire le côté de résolution | Mesurer sur fenêtres RÉSOLUES du dataset : sign(binanceTWAPend − binanceTWAPstart) vs `market_resolutions.winnerOutcomeIndex` → WR du proxy. Si ≥ ~97-98 % le proxy suffit ; sinon le signal v1 est contaminé par l'erreur de proxy | **à vérifier (nouveau, prérequis Phase 2)** — données 100 % gratuites : klines 1s Binance + résolutions déjà stockées |
| A7 | **L'index perps Polymarket (`idx` du WS tickers) appartient à la même famille que la métrique de résolution** (les perps sont adossées aux Data Streams Chainlink) — donc un proxy TWAP-60s construit sur `idx` serait PLUS fidèle que Binance | Non backfillable (mark-history limitée à 1000 pts) → mesurer sur collecte live : après ≥ 3 j de `feed_snapshots` source `polymarket-idx`, re-courir le WR proxy (même méthode que A6) et comparer aux WR Binance | **à vérifier** — si A7 > A6 → basculer la source primaire du signal sur perps idx (Binance reste fallback + backfill) |

**Décision de design prise dès maintenant** (pour lever toute ambiguïté avant fan-out) :

- **Id du moteur : `chainlink-lag`** (kebab-case, préfixe config `chainlinkLag*`).
- **⚠️ Barre de résolution capturée par le FEED, pas par la stratégie** (leçon du contre-exemple "trigger naïf" ci-dessous) : à `windowStart`, le `FeedManager` fige `twap60AtWindowStart` (la TWAP-60s à l'ouverture) et la publie dans le snapshot de contexte. Raison : le buffer glissant 60 s ne contient plus cette valeur après 60 s de fenêtre, et un restart du bot la perdrait — stockée dans `feed_snapshots` (une ligne `polymarket-twap60`/`binance-twap60` à windowStart), elle est rechargeable partout (live, sim, backtest) et le moteur n'a jamais à la dériver lui-même.
- **Signal v1 (révisé) : projection vs BARRE** — le trigger naïf `spot − TWAP-now` mesure un move local, pas la clairance de la barre de résolution ; contre-exemple : pré-fenêtre en déclin → barre élevée, petit pop spot déclenche UP alors que la barre est au-dessus du spot. Le signal fidèle projette la TWAP de fin et la compare à la barre :
  ```
  projected = spot                                    si remaining ≥ 60 s
            = (spot×remaining + twap60×(60−remaining))/60   sinon   (blend du buffer courant)
  movePct   = (projected − twap60AtWindowStart) / twap60AtWindowStart × 100
  ```
  `|movePct| ≥ chainlinkLagMoveThresholdPct` → cible Up si > 0, Down sinon. Le comparateur naïf (spot vs TWAP-now) devient le **contrôle causal** du sim Phase 2 (même bande, sans le bon comparateur) — discipline du skill.
- **Gate d'entrée** : bande d'ask + spread + profondeur FOK + fraîcheur du feed + fenêtre elapsed. **Pas de modèle EV dans la v1** — la phase recherche décide du seuil et de la famille (raw projection / projection + confirmation multi-ticks), calibrés sur données.
- **Cohérence validation ↔ exécution** : le sim Phase 2 valide d'abord sur klines Binance (backfillable) ; **avant live, le sim DOIT être re-couru sur ≥ 3-5 j de `feed_snapshots` source `polymarket-idx`** (collectés dès Phase 1) pour valider la source réellement branchée en live (A7). Un WR proxy validé sur Binance ne transfère pas automatiquement à perps idx.
- **Exit v1 : hold to resolution** (précédent early-conviction). TP / exit-on-reversal = axes de recherche (switch booléen, défaut off) — le skill a montré que les TP dégradent systématiquement sur les moteurs directionnels de ce repo.
- **Injection :** `StrategyContext.feed?: ExternalFeedSnapshot` — pas de singleton importé par la stratégie (teste en backtest, cohérent avec le pattern `nowMs`).
- **Sizing :** budget dédié `chainlinkLagOrderUsdc` — JAMAIS `cheapOrderUsdc` (incident 2026-09-14 documenté dans `src/config.ts:66-72`).

## 3. Design technique

### 3.1 Tables DB (`src/db/database.ts`)

```sql
CREATE TABLE IF NOT EXISTS feed_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,        -- 'polymarket-idx' | 'polymarket-twap60' | 'binance-spot' | 'binance-twap60' | 'chainlink-streams' (v2)
  symbol TEXT NOT NULL,        -- perps: 'BTC-USD' (iid 6) / 'ETH-USD' (iid 7) ; binance: 'BTCUSDT' / 'ETHUSDT'
  price REAL NOT NULL,
  extra TEXT                   -- JSON: { iid } perps, { tradeId } spot binance, { windowStart } pour les lignes twap60 figées à l'ouverture d'une fenêtre
);
CREATE INDEX IF NOT EXISTS idx_feed_snapshots_symbol_ts ON feed_snapshots(symbol, ts);
```

Nouveau repo `feedSnapshots` dans `src/db/repositories.ts` : `insert(row)`, `latestBefore(symbol, source, ts)`, `prune(ts)` (rétention `feedSnapshotRetentionMs`, défaut 30 j — les résolutions/labels restent la priorité dataset, ceci est du contexte auxiliaire).

### 3.2 Flux de données (v1 : SANS clé API, SANS abonnement)

> **Révision 2026-09-25 (A1/A2 vérifiées, puis découverte du feed perps)** : la source de résolution Polymarket est **Chainlink Data Streams TWAP-60s** (off-chain, produit credential), pas le feed on-chain Polygon. La v1 n'y souscrit PAS : elle reconstruit le **proxy TWAP-60s** depuis un flux de prix gratuit. **Le signal d'entrée devient : prix rapide vs TWAP-60s glissante** (déjà en retard structurel de ~30 s en moyenne) — c'est exactement le lag exploitable, sans abonnement.

**Deux sources gratuites vérifiées live (2026-09-25) — candidats pour le flux "prix rapide" :**

| Source | Endpoint (vérifié live) | Granularité | Statut |
|--------|------------------------|-------------|--------|
| **Polymarket Perps WS** (primaire recommandé) | `wss://ws.perpetuals.polymarket.com/v1/ws` — sub : `{"req":"sub","id":2,"chs":["tickers::6","tickers::7","book::6"]}` (iid 6=BTC-USD, 7=ETH-USD, mapping `/v1/info/instruments` public) | **~100 ms** : `{"ch":"tickers::6","ets":...,"data":{"idx":"84435","mark":"84389","last":"84362","mid":"84376",...}}` | ✅ testé live : `status:ok` + ticks 100 ms, **sans auth** |
| **Binance spot** (fallback) | WS `btcusdt@trade` + klines REST 1 s (backfill) | ~1 s | gratuit, sans clé ; risque geo-block (Task 0.4) |

> **Pourquoi le perps WS en primaire** : le champ `idx` est l'**index price de Polymarket elle-même** — la même famille de source que la métrique de résolution (les perps Polymarket sont adossées aux Data Streams Chainlink, hypothèse A7 à mesurer). Un seul fournisseur, latence 100 ms, zéro dépendance Binance. REST de secours : `/v1/info/tickers`, `/v1/info/mark-history` (publics, vérifiés, mais profondeur historique limitée à 1000 points ≈ 0,28 h par appel → backfill klines Binance inchangé).
> Caveat : API **non documentée officiellement** (extraite du bundle front polymarket.com) — fragile, peut changer ; le fallback Binance reste câblé. Data Streams (credentials payantes) = v2 seulement si A6/A7 montrent que le proxy tue l'edge.

- `PolymarketPerpsFeed` (`src/feed/perps-feed.ts`, primaire) : WS + reconnexion, souscription `tickers::<iid>` par asset, maintient prix idx + **TWAP-60s glissante** (fenêtre échantillons, O(1) par tick, GC) + **fige `twap60AtWindowStart` à windowStart de chaque fenêtre suivie** (persistée en DB). API : `getPrice(asset): { idx, mark, ts } | null`, `getTwap(asset)`, `getTwapAtWindowStart(asset, windowStart)`.
- `BinanceFeed` (`src/feed/binance-feed.ts`, fallback) : WS trade 1s → même interface (mêmes responsabilités TWAP + barre). Sélection : `FEED_SOURCE` = `polymarket` (défaut, **source du moteur**) | `binance` | `both` (**logging/cross-check seulement — un seul feed alimente le moteur** : le primaire sélectionné ; l'autre écrit dans `feed_snapshots` pour la mesure A6 vs A7).
- `FeedManager` : expose `getSnapshot(asset): ExternalFeedSnapshot` (prix rapide + TWAP-60s + âges), enregistre dans `feed_snapshots`, `isHealthy()`. Démarré depuis `src/index.ts` (env `FEED_ENABLED`), indépendamment du moteur sélectionné (la collecte est un actif dataset).
- Mapping asset→iid/symbole : `btc-updown-15m` → `btc` → perps iid 6 / Binance BTCUSDT. Table statique `src/feed/assets.ts` (vérifiée live : `/info/instruments` retourne iid 6=BTC-USD, 7=ETH-USD, category crypto — 40 instruments).

### 3.3 Injection dans le contexte stratégie (`src/types.ts`, `src/strategy/trading-strategy.ts`)

```ts
export interface ExternalFeedSnapshot {
  /** Prix rapide (perps idx ~100 ms, ou spot Binance 1s). null = feed absent (backtest sans données, WS down). */
  spotPrice: number | null;
  spotAgeMs: number | null;
  /** TWAP-60s glissante (réplique de la métrique de résolution Chainlink). */
  twap60: number | null;
  twap60AgeMs: number | null;
  /** ⚠️ Barre de résolution : TWAP-60s figée à windowStart par le FeedManager (stockée en DB, survit aux restarts). */
  twap60AtWindowStart: number | null;
  /** Réservé v2 : Data Streams Chainlink si abonnement (sinon null). */
  chainlinkPrice?: number | null;
  chainlinkAgeMs?: number | null;
}
// StrategyContext gagne :  feed?: ExternalFeedSnapshot;   (optionnel, comme nowMs)
```

**⚠️ Le champ `feed?` doit être ajouté à TROIS endroits** (le contexte traverse une interface intermédiaire) :
1. `StrategyContext` (`src/strategy/trading-strategy.ts`) — ce que `findOpportunities` lit ;
2. `TickExecutorBaseCtx` (`src/backtest/tick-executor.ts:44`) — le type utilisé par le runner backtest ET le paper engine ; `processTick` retransmet à `findOpportunities` (`tick-executor.ts:73-79`, ligne à ajouter) ;
3. Les 3 sites de construction de contexte : `src/bot/reverse-bot.ts:484` (live), `src/backtest/runner.ts` `tickCtx` (backtest), `src/paper/engine.ts:247` (paper).

- Live : `ReverseBot.processEvent` reçoit le `FeedManager` en dépendance (constructor injection) et remplit `feed` depuis `feedManager.getSnapshot(assetOf(event.slug))`.
- Backtest : le runner précharge `feed_snapshots` en `Map<symbol, Array<{ts, price}>>` + recherche `nearestBefore(ts)` (bissection), passe `feed` dans `processTick`. Table vide → `feed` absent → moteur inerte (comportement dégradé sûr).
- Paper : `PaperEngine` reçoit une callback `getFeed(asset) | null` branchée sur le même `FeedManager` (le paper engine tourne dans le process du bot live → il a accès au manager réel, pas de replay). C'est le mode de validation principal avant live : **sans ce 3e point, le moteur paraîtrait cassé en sim alors qu'il n'est juste jamais alimenté**.

### 3.3bis Token cible par outcomeIndex (jamais par tri d'ask)

Tous les moteurs directionnels récents résolvent le token par `books.find(b => b.outcomeIndex === 0|1)` (flip-confirm `:61`, antiflip `:100`, open-entry `:104`) — jamais par tri "favori = ask le plus haut" qui change d'identité en cours de fenêtre. Pour chainlink-lag le côté est porté par le **move spot** (Up si binance > chainlink) : cible = le token à cet outcomeIndex fixé au moment du trigger, PAS un favori recalculé par tick. Un recalcul par ask ferait changer de jambe achetée quand le carnet flippe intra-fenêtre (l'anti-stack ne protège que si la 2e émission est du même kind sur la même paire — il bloque alors tout, mais le trade pris n'est plus celui que le signal désignait).

### 3.4 Moteur `src/strategy/chainlink-lag-strategy.ts`

Copie structurelle de `early-conviction-strategy.ts` (mono-jambe FOK) avec état interne minimal :

1. **Gates de fraîcheur** : `feed` présent, `spotAgeMs ≤ chainlinkLagFeedMaxAgeMs`, `twap60AgeMs ≤ chainlinkLagFeedMaxAgeMs`, **`twap60AtWindowStart != null`** (sinon skip — sans barre, le signal est invalide). Sinon skip (compteur de raison pour debug).
2. **Fenêtre d'éligibilité** : `elapsed ∈ [chainlinkLagMinElapsedSec, chainlinkLagMaxElapsedSec]` (défauts 30 s / 600 s — pas d'entrée au-delà : zone résolution + piège du loser-ask-collapsé documenté dans le skill).
3. **Direction (projection vs barre)** : `remaining = (windowEnd×1000 − nowMs)/1000` ; `projected = spotPrice` si `remaining ≥ 60` sinon `(spotPrice×remaining + twap60×(60−remaining))/60` ; `movePct = (projected − twap60AtWindowStart)/twap60AtWindowStart × 100`. `|movePct| ≥ chainlinkLagMoveThresholdPct` → côté favorisé = Up si move > 0, Down sinon.
4. **Token cible** : `books.find(b => b.outcomeIndex === (move > 0 ? 0 : 1))` — le côté fixé par le move (cf. §3.3bis), jamais un favori recalculé par ask. Gates bande `[chainlinkLagMinAsk, chainlinkLagMaxAsk]` (défauts 0.10 / 0.80), `spread ≤ chainlinkLagMaxSpread` (0.03) sur CE token.
5. **Anti-stacking** : `tracker.getFilledCheapSizeForPair(pairId) > 0 || tracker.countLegsByKind(pairId, "cheap") > 0` → skip (jamais de flag permanent après un FOK rejeté — pitfall skill).
6. **FOK preflight profondeur** : `bestAskSize ≥ size` à l'émission, limit à l'ask brut `round2(ask)` (pitfall FOK skill : un preflight 0.8x ou un round down = rejets silencieux en masse).
7. Sizing : `computeSize(config.chainlinkLagOrderUsdc, ask, config.maxSharesPerOrder)`, min CLOB shares.
8. Émission : `kind: "cheap"`, `orderType: "FOK"`, tradeKey standard.
9. `hedgeAtPostTime` → `{ action: "skip", reason: "chainlink-lag-no-hedge" }` ; `shouldDefend` false / `defendShares` 0 (v1 hold) ; `cheapOrderAction`/`edgeOrderAction` → `"keep"`.

### 3.5 Config (`src/config.ts` + `src/runtime-settings.ts`)

| Clé | Type | Défaut | Validation |
|-----|------|--------|------------|
| `chainlinkLagOrderUsdc` | number | 5 | > 0 + `validateEngineBudget(chainlinkLagOrderUsdc, chainlinkLagMaxAsk, "chainlink-lag", maxSharesPerOrder)` — anti moteur-muet (incident 2026-09-14 : budget 1 $ sur bande 0.85 = 1.18 shares < 5 min CLOB, moteur silencieux 1h30) |
| `chainlinkLagMoveThresholdPct` | number | 0.15 | 0.01–5 (en %, ex. 0.15 = 0.15 %) |
| `chainlinkLagMinAsk` | number | 0.10 | 0.01–0.49 |
| `chainlinkLagMaxAsk` | number | 0.80 | 0.51–0.99, > minAsk |
| `chainlinkLagMaxSpread` | number | 0.03 | ≥ 0 |
| `chainlinkLagMinElapsedSec` | number | 30 | ≥ 0 |
| `chainlinkLagMaxElapsedSec` | number | 600 | > minElapsed, ≤ 899, **et ≤ `minutesBeforeCloseMax × 60`** (sinon le runner backtest bride silencieusement — cf. §1) |
| `chainlinkLagFeedMaxAgeMs` | number | 4000 | ≥ 250 |

**Coercion sticky flags** (branche `strategyId === "chainlink-lag"` dans `validateConfigCoherence`, miroir fav-band `config.ts:872-873`) : `config.arbAskLockOnly = false; config.enableExpensiveHedge = false;` — un profil arb précédent ne doit pas fuiter vers ce moteur mono-jambe sans hedge. La liste `formToSettings` côté frontend doit coercer EXACTEMENT le même ensemble.

`feedEnabled` n'est PAS une clé de config runtime : c'est une **env var de démarrage** (`FEED_ENABLED`, défaut true, lue dans `loadConfig()` via `envBoolean`) — le FeedManager est un service global (socket/RPC à ouvrir/fermer), pas un champ hot-appliable ; le retirer d'`EDITABLE_CONFIG_KEYS` évite un PATCH qui tuerait la collecte dataset sans redémarrer le service.

Checklist obligatoire (6 points de touche, pitfall documenté) : `BotConfig` + `strategyDefaults()` + `validateConfigCoherence` (ranges ci-dessus, backend ET frontend 1:1), `EDITABLE_CONFIG_KEYS` + `parseField` + `ENV_ALIASES` (Record exhaustif → erreur type si alias manquant) + `CHAINLINK_LAG_KEYS` + `keysForStrategy`, `tests/helpers.ts testConfig`, preset JSON, frontend `types/index.ts` `BotConfig` séparé, `configForm.ts` (2 surfaces de validation), `SettingsModal.tsx`.

### 3.6 Runner backtest (`src/backtest/runner.ts`)

- Précharger les feeds (si `feed_snapshots` non vide) par symbole, trié par ts.
- `tickCtx` : construire le snapshot (bissection `nearestBefore`) et le passer à `processTick` (via le nouveau champ `TickExecutorBaseCtx.feed`, cf. §3.3). Symbole déduit du préfixe slug (même mapping que live, partagé via `src/feed/assets.ts`).

## 4. Phases & tâches

### Phase 0 — Vérification des hypothèses (~2-3 h, aucune modification src/)

**Task 0.1** ✅ **FAIT (2026-09-25)** — source de résolution confirmée par les descriptions Gamma live : **Chainlink Data Streams TWAP-60s** pour BTC/ETH/XRP/DOGE (streams simples non-TWAP pour SOL/HYPE/BNB/ZEC). Rapport de source à finaliser dans `audits/chainlink-lag/SOURCE.md` avec les citations exactes.
**Task 0.2** — `01-twap-proxy.mts` : **mesure A6 (prérequise)** — sur fenêtres RÉSOLUES du dataset backtest : reconstruire TWAP-60s début/fin depuis klines 1s Binance, `sign(twapEnd − twapStart)` vs `market_resolutions.winnerOutcomeIndex` → **WR du proxy** (objectif ≥ 97-98 %). Aussi : distribution des moves spot-vs-TWAP60 ≥ 0.1/0.15/0.25 % par fenêtre (fréquence de triggers attendue). Sortie : threshold recommandé + verdict proxy.
**Task 0.3** — `02-binance-history.mts` : profondeur des klines 1 s REST (limit 1000/requête) couvrant les fenêtres du dataset backtest (~8 j). Si insuffisant → backtest limité aux fenêtres futures (collecte live dès Phase 1).
**Task 0.4** — Vérifier WS Binance non bloqué (geo 451) + client : WebSocket global Node 22 (`globalThis.WebSocket`), sinon ajouter `ws` aux deps.

> **Gate :** Phase 0 livre `audits/chainlink-lag/PHASE0.md`. **A1 est déjà tranché (Chainlink Data Streams TWAP-60s, confirmé).** Le verdict critique restant est **A6** : si le proxy TWAP Binance prédit mal le côté de résolution (< 95 %), la v1 gratuite perd sa fondation → décision : v2 avec abonnement Data Streams OU abandon. Si klines 1s insuffisantes (A3), repli collecte live.

### Phase 1 — Feed + persistance (backend, ~1 session)

**Task 1.1** TDD — `src/feed/assets.ts` : `assetOfSlug(slug)`, `binanceSymbolFor(asset)` + `tests/feed-assets.test.ts`.
**Task 1.2** — DDL `feed_snapshots` + repo `feedSnapshots` (insert/latestBefore/prune) + test repo.
**Task 1.3** TDD — `src/feed/binance-feed.ts` : classe WS (reconnexion, throttle 250 ms, `getPrice()`), **TWAP-60s glissante** (fenêtre échantillons pondérée par seconde, O(1) par trade, GC de la fenêtre) + `getTwap()`. Test avec un fake WS injecté (interface `WsLike`).
**Task 1.4** — `src/feed/feed-manager.ts` : agrégation + `getSnapshot()` (spot + twap60 + âges) + liveness; branchement aux 3 sites de contexte (§3.3) : `src/index.ts` (démarrage service, env `FEED_ENABLED`), `src/bot/reverse-bot.ts:484` (injection live), `src/paper/engine.ts` (callback `getFeed` pour la sim).
**Task 1.5** — `scripts/research/chainlink-lag/03-backfill.mts` : backfill `feed_snapshots` depuis klines 1 s Binance (spot + TWAP-60s reconstruite) pour couvrir le dataset backtest existant (~8 j BTC/ETH 15m — à condition que A3 = OK). Écriture directe dans la table dédiée (table neuve, aucune table source touchée).
**Task 1.6** — `npm run build` + suite tests verte.

### Phase 2 — Recherche signal (prérequise au wiring du moteur)

**Task 2.1** — Données : si le backfill (Task 1.5) couvre le dataset backtest existant → Phase 2 **immédiate**. Sinon (klines 1s insuffisantes) collecter ≥ 3-5 jours de `feed_snapshots` live (le bot enregistre dès Phase 1, aucun trading nécessaire).
**Task 2.2** — `04-signal-sim.mts` : sim par fenêtre **premier trigger uniquement** (pitfall per-window), univers aligné runner (`book_snapshots`, ≥2 outcomes, complétude 801/60 s, `market_resolutions` requis). Familles testées : (a) **projection vs BARRE** (famille principale, cf. décision de design), (b) contrôle causal naïf spot-vs-TWAP-now (même bande, mauvais comparateur — doit sous-performer pour valider que la projection porte le signal), (c) projection + confirmation multi-ticks (anti-pip). Contrôles causaux (même bande SANS le move), split-half (jours anciens vs récents), WR par fenêtre + t-stat + variance ratio (discipline complète du skill `polymarket-strategy-dev`).
**Task 2.3** — Rapport `audits/chainlink-lag/SIGNAL.md` : seuils retenus (ou verdict DEAD — la famille directional est déjà morte plusieurs fois sur ce dataset, un verdict négatif est un livrable valide).

> **Gate :** on ne wire le moteur que si le sim calibré survit split-half. Sinon → conclure DEAD dans le rapport et s'arrêter (économie : 0 ligne dans src/strategy).

### Phase 3 — Wiring moteur natif (~1 session, checklist `new-strategy-wiring.md` étapes 1-8)

**Task 3.1** — `src/strategy/chainlink-lag-strategy.ts` (spec § 3.4, token par outcomeIndex § 3.3bis) ; **Task 3.2** — `ids.ts` (`chainlink-lag`), `registry.ts` (factory + `leadsWithEdgeFor` false-branch) ; **Task 3.3** — `config.ts` (8 clés § 3.5 + `validateConfigCoherence` : ranges, coercion sticky flags, `validateEngineBudget`, garde `chainlinkLagMaxElapsedSec ≤ minutesBeforeCloseMax × 60`) ; **Task 3.4** — `runtime-settings.ts` (KEYS, parseField, ENV_ALIASES exhaustifs) ; **Task 3.5** — `tests/helpers.ts testConfig`, `tests/chainlink-lag.test.ts` (gates : fraîcheur feed, direction, bandes, spread, profondeur, anti-stacking, coercion validateConfigCoherence, rejet d'une fenêtre elapsed > minutesBeforeClose×60) + `package.json` test list + `tests/presets.test.ts` (liste alphabétique) ; **Task 3.6** — `config/presets/chainlink-lag.json` (`name`+`description`, jamais `label` → TS2352).
**Vérification** : `npm run build` + `npm run test` + backtest officiel ~60 fenêtres récentes avec `rejects == 0` (preuve de wiring).

### Phase 4 — Backtest officiel + rapport

**Task 4.1** — `04-official-recheck.mts` (template `dip-revert-research/recheck-official.mts`) : run officiel univers complet, WR calculé sur fenêtres **tradées + résolues** (formule corrigée du skill), PnL/notional avec base explicite.
**Task 4.2** — Rapport `audits/chainlink-lag/BACKTEST.md` + **mise à jour obligatoire `audits/backtest/index.md`** (entrée + re-check tableau "best config").
**Task 4.3** — Vérification end-to-end exit path si un switch d'exit a été câblé : `SELECT reason, COUNT(*) FROM backtest_trades WHERE runId=? AND side='SELL' GROUP BY reason` (une ligne SELL doit exister si le switch est ON).

### Phase 5 — Frontend + guide (règle `.cursor/rules/strategy-guide-sync.mdc`)

**Task 5.1** — Frontend moteur : `types/index.ts` (NativeStrategyId + BotConfig), `configForm.ts` (2 surfaces), `SettingsModal.tsx` (SectionId + guards partagés + `<Show>` équilibrés — vérifier le count open/close par section après insertion, bug fantôme documenté), `strategyPresets.ts`, `BacktestPresetPanel.tsx` (tabs + groupes + tabErrorCount), `ConfigBar.tsx` (réécrire les chaînes ternaires ENTIÈRES, jamais par patch partiel).
**Task 5.2** — Guide `/guide` : `data.ts` (EngineId + ENGINE_META/RESOLUTION_ROWS/BOT_STEPS exhaustifs + lifecycle nodes/edges), `GuideTabs.tsx` (pill + story `<Show>` + LifecycleCard — branche avant le fallback final), `STRATEGY_COMPARE_ROWS` élargi en lockstep (tuple + headers), `&gt;` dans le prose JSX.
**Task 5.3** — `STRATEGY.md` (nouveau contrat : injection feed, sémantique direction/lag) + README section guide. `npm run build` dans `frontend/`.

## 5. Garde-fous d'implémentation (pitfalls du skill, non négociables)

1. Un seul trigger par fenêtre (premier trigger), jamais par tick.
2. FOK : profondeur full-size à l'émission, limit à l'ask brut ; ne jamais marquer la paire "entered" sur un FOK rejeté.
3. État sliding-window borné par la config + GC des Maps par paire (purge à 2× lookback) — ici l'état est minime (cooldown direction), mais même discipline.
4. Mémoriser les mesures canoniques par paire (move au moment du trigger), ne pas re-dériver par tick.
5. Jamais de signal près du close (loser ask collapsé → WR artificiellement 0) : `MaxElapsedSec ≤ 899`.
6. PnL% : base explicite (notional), WR sur fenêtres tradées+résolues uniquement.
7. `VACUUM INTO` : supprimer workDb + -wal/-shm avant la copie.
8. Paper trading est un site d'injection à part entière : après toute modification du chemin de contexte, vérifier le moteur en sim (sinon on découvre la mutité au premier jour de live).
9. `feed?` optionnel partout : tout test unitaire du moteur DOIT couvrir le cas `feed` absent (inertie silencieuse attendue, pas de crash).

## 6. Risques & tradeoffs

- **A1 = CONFIRMÉ (2026-09-25)** : la résolution est bien Chainlink — mais **Data Streams TWAP-60s**, pas le feed on-chain. Le "lag" exploitable est le retard structurel de la moyenne glissante 60 s sur le spot.
- **Qualité du proxy TWAP (A6, risque principal)** : la TWAP-60s Binance (un seul exchange) ≠ TWAP-60s Chainlink (composite multi-exchanges). Si le WR du proxy sur fenêtres résolues < ~95 %, la v1 gratuite perd sa fondation → v2 avec abonnement Data Streams, ou abandon. Mesuré en Task 0.2 AVANT tout code moteur.
- **Lag exploitable trop court** : si les makers Polymarket pricent sur le spot Binance (et non sur la TWAP), le carnet suit le spot aussi vite que notre signal → pas d'edge. Le sim (Task 0.2/2.2) le mesure ; verdict DEAD possible (comme 6 familles directionnelles déjà testées). NB : les odds portent sur la métrique de RÉSOLUTION (TWAP fin vs TWAP début), et la TWAP est par construction lente — le reprice complet du carnet prend structurellement ~60 s après un move net, c'est la fenêtre d'edge visée.
- **Qualité du backtest historique** : klines 1 s Binance (A3) ; repli collecte live 3-5 j (Phase 2 décalée).
- **WS Binance bloqué (geo 451)** : vérifié en Task 0.4 ; repli = klines polling 1 s (plus lourd, acceptable en v1 si WS indisponible).
- **Croissance DB** : ~20 Mo/j (borne haute throttle 250 ms, 2 symboles) purgeable à 30 j — négligeable vs la politique dataset (bot-live.db ~100 Mo/j accepté).
- **Le moteur achète "le côté favorisé par le move" à un ask potentiellement haut** : bande MaxAsk 0.80 + fenêtre ≤ 600 s bornent l'exposition. Attention : à l'inverse des moteurs "favori", ici le token acheté peut être le sous-dog du carnet (move contre le favori établi) — la bande MinAsk 0.10 et le gate de fraîcheur du feed sont les seules protections contre l'achat d'un token déjà condamné par le marché ; c'est exactement ce que la Phase 2 doit mesurer (WR de l'anti-favori vs du favori).

## 7. Questions ouvertes (décisions à prendre avant Phase 3, ne bloquent pas 0-2)

1. **Écart proxy vs stream réel** : si A6 montre un WR proxy correct mais non excellent (95-97 %), faut-il souscrire Data Streams (payant) dès la v1, ou vivre avec l'erreur proxy ? → décision après Task 0.2 (l'edge mesuré en sim doit dépasser la dégradation proxy pour justifier l'abonnement).
2. **Exit-on-reversal** : v1 hold-only (recommandé, précédent early-conviction/dip-revert) ou switch d'exit dès la v1 ? → recommandation : hold v1, axis en Phase 4.
3. **Budget** : `chainlinkLagOrderUsdc` défaut 5 $ comme les autres moteurs ? Valider avec capital sim généreux d'abord (pitfall saturation).
4. **Nom public UI** : "Chainlink-Lag" (anglais, cohérent avec les autres ids) — à confirmer pour le guide.

---

## 8. Journal de révision

- **2026-09-26 (Phase 2 exécutée — Task 2.2, `04-signal-sim.mts`)** — **verdict DEAD selon les critères pré-enregistrés** :
  - Univers aligné runner : 827 fenêtres résolues (>= 801 ticks, gap <= 60 s) ; feed simulé = klines 1s Binance (cache data.binance.vision) ; barre BACKWARD (validée A6) ; gates §3.4 ; FOK sur carnets réels ; hold to resolution.
  - Meilleure famille principale : A-proj @ 0.1% → n=415, WR 74.9%, +4.88%/trade, **t=1.61 < 2** ; @ 0.15% → n=171, +5.26%/trade, t=1.18, **split-half instable** (ancienne −0.35% / récente +10.81%) → ne survit PAS au gate.
  - Contrôle causal (favori sans move, même bande) : +2.08%/trade (n=794) — baseline déjà positive sur la période ; l'edge net du signal au-dessus du baseline est modeste et non significatif.
  - Validation causale partielle : B-naïf sous-performe A aux seuils >= 0.15% (conforme), mais reste positif à 0.1% (n=128, +6.70%, t=0.81 — bruit).
  - Rejets dominés par la bande d'ask (0.81-0.99) : au moment du trigger, le carnet a déjà repricé (ask moyen 0.71-0.73 vs breakeven ~0.71) — le risque "makers pricent sur le spot" (§6) semble se confirmer.
  - **Décision : 0 ligne dans src/strategy.** Options ouvertes (aucune ne bloque) : (a) prolonger la collecte de book_snapshots 1-2 semaines puis re-courir le sim (ETH n'a que 4 j de données) ; (b) mesurer A7 (perps idx) sur feed_snapshots live — un proxy plus fidèle réduirait l'erreur qui noie les petits moves ; (c) explorer des axes sim alternatifs (exit-on-reversal, asymétrie Up/Down, seuil par asset) avant verdict final.

- **2026-09-25 (révision 4 — audit logique de la stratégie)** — **1 bug de signal corrigé** :
  - Le trigger naïf `spot − TWAP-now` mesurait un move LOCAL, pas la clairance de la barre de résolution. Contre-exemple : pré-fenêtre en déclin → `TWAP(début)` élevée ; un pop spot ≥ seuil déclenche UP alors que la barre est encore au-dessus du spot (et si la fenêtre est proche de la fin, le blend TWAP peut finir sous la barre → Down gagne malgré le signal). **Signal révisé** : projection de la TWAP de fin (`spot` si remaining ≥ 60 s, sinon blend buffer) comparée à `twap60AtWindowStart` (barre figée à l'ouverture, capturée par le FeedManager, persistée en DB, exposée dans le snapshot). Le comparateur naïf devient le contrôle causal (b) du sim Phase 2.
  - Corrections d'accompagnement : DDL `source` étendu (`polymarket-idx`/`polymarket-twap60`/`binance-*`), `symbol` perps `BTC-USD` (iid) ; hypothèse A7 ajoutée à la table ; `FEED_SOURCE=both` clarifié (logging/cross-check seulement, un seul feed alimente le moteur) ; règle de cohérence validation↔exécution ajoutée (re-courir le sim sur données perps idx avant live) ; gate moteur `twap60AtWindowStart != null`.
- **2026-09-25 (révision 3 — question "prix crypto via WS/SSE Polymarket ?")** — **OUI, découvert et vérifié live** :
  - Polymarket expose un **WS perps public sans auth** : `wss://ws.perpetuals.polymarket.com/v1/ws`, souscription `{"req":"sub","id":2,"chs":["tickers::6","book::6"]}` (format extrait du bundle front polymarket.com, handler `033aysi7tcggl.js`).
  - Test live réussi : `{"status":"ok"}` puis ticks **~100 ms** `tickers::6` → `{"iid":6,"idx":"84435","mark":"84389","last":"84362","mid":"84376",...}` (BTC-USD iid 6, ETH-USD iid 7 — mapping vérifié sur `/v1/info/instruments` public, 40 instruments crypto).
  - REST publics vérifiés : `/v1/info/tickers`, `/v1/info/klines?interval=1s`, `/v1/info/mark-history` (profondeur limitée 1000 pts ≈ 0,28 h/appel).
  - **Conséquence** : le flux "prix rapide" v1 devient le perps WS Polymarket en primaire (même famille de source que la métrique de résolution, hypothèse A7), Binance en fallback (`FEED_SOURCE`). Caveat documenté : API non documentée officiellement → fragile, d'où le fallback câblé d'office. SSE/EventSource : aucun flux SSE trouvé — le WS est le canal live utilisé par le front.
- **2026-09-25 (révision 2 — vérif de la question "Chainlink payant ?")** — vérifications live effectuées :
  - **A1 CONFIRMÉ par les descriptions Gamma réelles** : BTC/ETH/XRP/DOGE 15m résolvent sur **Chainlink Data Streams TWAP-60s** (`btc-usd-twap-60s-streams`, etc. ; SOL/HYPE/BNB/ZEC sur streams simples). Citation extraite d'un event live `btc-updown-15m`.
  - **Conséquence structurelle : la v1 n'a BESOIN d'aucune clé API ni abonnement** — le plan v1 supprime le `ChainlinkFeed` RPC (le feed on-chain Polygon n'est PAS la métrique de résolution ; deux adresses testées live sur RPC public publicnode = contrats absents/revert, confirmant qu'il ne fallait pas s'y fier de mémoire) et remplace la source par : spot Binance 1s + **TWAP-60s glissante reconstruite localement** (proxy A6 à mesurer en Task 0.2).
  - Signal reformulé : `movePct = (spot − twap60) / twap60` ; snapshot `ExternalFeedSnapshot` renommé (spotPrice/twap60 + champs v2 chainlink optionnels) ; DDL `source` = binance-spot | binance-twap60 | chainlink-streams (v2) ; Phases 0/1/2 réécrites (Task 0.1 marquée FAIT, backfill = klines Binance) ; risques + questions ouvertes révisés (A6 = risque principal, coût Data Streams documenté comme abonnement credential).
- **2026-09-25 (révision 1 — vérification post-rédaction)** — 7 corrections appliquées après cross-check du code :
  1. Ajout du chemin paper trading (`src/paper/engine.ts:247` reconstruit son contexte `processTick`) : sans injection dédiée, le moteur serait muet en sim — 3e site de contexte obligatoire.
  2. `feed?` doit passer par `TickExecutorBaseCtx` (`src/backtest/tick-executor.ts:44`) + retransmission dans `processTick` (`:73-79`), pas seulement `StrategyContext`.
  3. Découverte : le runner n'émet des opportunités QUE dans `isWithinMinutesBeforeClose` (`tick-executor.ts:65-79`, défauts [0,15] min) → nouvelle validation croisée `chainlinkLagMaxElapsedSec ≤ minutesBeforeCloseMax × 60` (sinon bridage silencieux).
  4. Token cible fixé par outcomeIndex (pattern flip-confirm/antiflip/open-entry), pas par tri d'ask — sinon la jambe achetée change sur flip intra-fenêtre (§3.3bis).
  5. Coercion sticky flags (`arbAskLockOnly`/`enableExpensiveHedge`) + `validateEngineBudget` (anti moteur-muet, incident 2026-09-14) ajoutés au §3.5.
  6. Backfill : la Phase 2 n'attend plus 3-5 j de collecte live si l'historique (désormais klines 1s Binance) est exploitable.
  7. `feedEnabled` déplacé de EDITABLE_CONFIG_KEYS vers env var `FEED_ENABLED` (service global non hot-appliable) ; WebSocket global Node 22 (zéro nouvelle dépendance).