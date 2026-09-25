# Polymarket Reverse Arbitrage Bot

A TypeScript/Node.js bot for Polymarket's 15-minute Up/Down markets (BTC, ETH, SOL, etc.). Interchangeable **engines** (`strategyId` in `data/bot-settings.json`) — 11 native engines:

- **`arb` (B1, default)** — maker bid on the cheap (underdog), then a **1:1 hedge** after that fill only if `cheapFill + hedgeAsk ≤ PAIR_LOCK_MAX < 1.00`. If the lock is unreachable after fill (**Policy A**), FOK **SELL** the uncovered cheap — do **not** hold it as a directional leftover.
  - Mode optionnel **ask-lock / dual-FOK** (preset `ask-lock`) : voir section [Ask-lock (dual-FOK)](#ask-lock-dual-fok--mode-arb).
- **`barbell`** — same cheap-then-hedge flow, but the hedge size is `filledCheap × barbellHedgeRatio` (default 0.5). **No profit lock.** Leftover cheap is an intentional directional bet. Higher variance than B1.
- **`fav-band`** — stratégie **directionnelle** : FOK buy du **favori** si ask ∈ `[favBandAskMin, favBandAskMax]` après `favBandMinElapsedSec`, hold jusqu'à résolution, **sans hedge**. Voir [Fav-band](#fav-band--favori-mid-band).
- **`dip-revert`** — FOK buy du favori après une **chute intra-fenêtre + rebond**, hold jusqu'à résolution. Voir [Dip-revert](#dip-revert--favori-chuté--rebond-mean-reversion).
- Moteurs directionnels calibrés (393 fenêtres, runner officiel) : **`antiflip-revert`** (favori déchu post-flip, +$623), **`flip-confirm`** (nouveau favori post-flip précoce, +$389), **`early-conviction`** (favori ≥ 0.60 dans les 45 premières s, +$330) — rapports dans `audits/backtest/<id>/`.
- **`open-entry`** — favori émergent à l'ouverture (lean ≥ 0.15 ≤ 300 s), SL dual-scale optionnel. Implémentation dans `audits/backtest/open-entry/`.
- **`probability-repricing`** — path trade intramarket (dislocation z-score du ask, exits bid stricts) ; voir `docs/probability-repricing-implemented.md`.
- Autres moteurs natifs : `edge-lead`, `reverse` (presets dédiés). Graphs custom via `custom:<id>` (éditeur `/strategy-editor`).


## Strategy Overview

**Covered pair (binary market, arb engine):** one side pays $1, the other $0. Holding 1 Up + 1 Down always redeems **$1.00**. Buying both for **≤ `PAIR_LOCK_MAX`** (default 0.98) locks `(1 − pairCost)` per share.

```
┌─────────────────────────────────────────────────────────────────┐
│  arb — TRUE ARB                          barbell — RATIO        │
├─────────────────────────────────────────────────────────────────┤
│  Cheap GTC maker:                    Cheap GTC: min(ask, max)   │
│    min(ask, CHEAP_BUY_MAX,           Hedge after fill:          │
│    PAIR_LOCK_MAX − hedge)              filledCheap × ratio      │
│  Hedge 1:1 after fill iff            No pair lock. Ask < min →  │
│    fill + hedge ≤ PAIR_LOCK_MAX        hold leftover cheap.     │
│  Else Policy A: FOK SELL cheap       Defense sells only the     │
│  Also defend if ask > MAX              missing hedge slice.     │
└─────────────────────────────────────────────────────────────────┘
```

**Example (lock 0.98):**
- Favorite ask **0.85** (inside `EXPENSIVE_BUY_MIN`–`MAX`) → lock cap for the cheap bid = `0.98 − 0.85 = 0.13` (then also capped by `CHEAP_BUY_MAX`, default **0.10**)
- Cheap ask 0.16 → sit at **min(0.16, CHEAP_BUY_MAX, 0.13)** (do not wait for ask+ask ≤ lock; 15m books usually sum to ~1.01)
- After a fill at the posted limit with hedge still at 0.85 and `fill + 0.85 ≤ 0.98` → hedge **1:1** → locked edge `(1 − pairCost)` per share
- If the cheap fills at **0.20** and the favorite ask is **0.85** (`0.20+0.85=1.05 > 0.98`) → **no hedge**. **Policy A**: FOK **SELL** the uncovered cheap at the bid — do **not** hold it directional hoping the favorite gets cheaper
- Separately, if the favorite asks **above** `EXPENSIVE_BUY_MAX` (e.g. 0.97) with an **uncovered** cheap → band defense also FOK **SELL**s the uncovered excess (`cheap − hedge`) at the bid (`defendPair`), then cancels any resting GTC hedge. A pair already covered 1:1 is **never** sold, even if the favorite goes to $1.

A GTC hedge is never posted against a *resting* cheap (anti naked-favorite). If a resting cheap is cancelled without a fill, any hedge GTC on that pair is cancelled too.


## Ask-lock (dual-FOK) — mode arb

Variante du moteur **`arb`** (B1) pour n’entrer que lorsqu’un **vrai lock marché** est déjà visible sur le book : `ask_cheap + ask_expensive ≤ lock`. Les deux jambes sont prises en **FOK le même tick** (dual-FOK), sans bid maker resting ni jambe seule volontaire.

Sur les books BTC 15m, `ask+ask` vaut souvent ~1.01 : les opportunités sont **rares**, mais le backtest était légèrement positif là où le maker Policy A perdait beaucoup.

### Activer

1. Dashboard → **Configuration** → onglet **Profils** → moteur **arb** → profil **Ask-lock dual-FOK**  
   (ou page **Backtest** → preset **Ask-lock dual-FOK**)
2. Vérifier les champs, puis **Enregistrer** (écrit `data/bot-settings.json` et met à jour la config live)

Éditer seulement `config/presets/ask-lock.json` **ne change pas** la config affichée à l’ouverture du dialog : il faut appliquer le profil puis enregistrer. Redémarrer le bot si la mémoire process n’a pas encore relu les settings.

### Paramètres

| Clé | Défaut | Rôle |
|-----|--------|------|
| `arbAskLockOnly` | `false` | Active le mode ask-lock (sinon maker classique + Policy A) |
| `arbAskSumMax` | `null` | Plafond ask+ask optionnel ; `null` = utilise `pairLockMax` |
| `pairLockMax` | (preset 0.99) | Lock de profit ; aussi plafond fill-time / Policy A |
| `expensiveOrderType` | `FOK` (preset) | Les jambes ask-lock sont taguées FOK même si GTC est configuré ailleurs |

Le preset élargit aussi les bandes cheap/hedge : en ask-lock le filtre principal est le **sum des asks**, pas la bande maker.

### Flux (un tick)

1. Les deux asks existent et `ask_cheap + ask_expensive ≤ lock` (`pairLockMax` ou `arbAskSumMax`).
2. Profondeurs connues et suffisantes sur **les deux** asks.
3. Taille dual = `min(budget cheap, budget hedge, depth cheap, depth expensive)`, ≥ 5 shares CLOB ; sinon skip.
4. Émission **cheap FOK** + **expensive FOK** (même tick ; cheap exécuté en premier).
5. Préflight backtest : ne prend le cheap que si le hedge est fillable sur le même book.
6. Live : pas de clamp `expensiveBuyMax` sur ces FOK ; `confirmCheapTokens` est sauté (le fill FOK cheap vient d’avoir lieu, le wallet peut lag).

Si le hedge échoue malgré tout → **Policy A** (FOK SELL du cheap non couvert), comme en arb classique.

### Différences vs arb maker

| | Maker (défaut) | Ask-lock |
|--|----------------|----------|
| Entrée | Bid GTC `min(ask, cheapBuyMax, lock − hedge)` | Uniquement si ask+ask déjà ≤ lock |
| Hedge | Après fill cheap, si encore lockable | FOK prévu 1:1 dès l’entrée |
| Bandes favorite | Obligatoires pour entrer | Contournées (le lock ask+ask suffit) |
| Volume BTC 15m | Élevé, beaucoup de dumps Policy A | Faible, peu de trades |

### Backtest

```bash
npx tsx scripts/arb-audit-backtest.mts ask-lock
```

### Fichiers clés

- `src/strategy/arb-sizing.ts` — gate ask+ask, taille dual
- `src/strategy/orchestrate.ts` — FOK des deux jambes, profondeur
- `src/backtest/runner.ts` — préflight dual-FOK
- `src/bot/opportunity-executor.ts` / `src/trader.ts` — live FOK sans clamp bande
- `config/presets/ask-lock.json` — preset UI / backtest


## Fav-band — favori mid-band

**Nouvelle** stratégie directionnelle (`strategyId: fav-band`). Ce n'est **pas** ask-lock, ni edge-lead, ni reverse.

Idée empirique (BTC 15m) : après ~200 s dans la fenêtre, le favori (ask le plus haut) dans une bande mid `[0.70, 0.85]` gagne assez souvent pour que l'achat FOK au ask + hold jusqu'à résolution soit +EV ; les favoris « certitude » (> ~0.90) sont souvent surcotés.

- Une seule jambe **FOK BUY** sur le favori
- **Pas de hedge**, pas de Policy A, pas de confirm multi-ticks
- Hold jusqu'à résolution (redeem 1 $ / 0 $)
- En interne la jambe est `kind: "cheap"` (pipeline d'ordres unique) — ce n'est **pas** l'underdog

### Activer

1. Dashboard → **Configuration** → onglet **Profils** → moteur **fav-band** → profil **Fav-band (mid favorite hold)**  
   (ou page **Backtest** → preset **Fav-band**)
2. Vérifier les champs (notamment `favBandOrderUsdc`), puis **Enregistrer** (`data/bot-settings.json` + config live)

Éditer seulement `config/presets/fav-band.json` **ne change pas** la config live : appliquer le profil puis enregistrer. Redémarrer le bot si besoin.

### Paramètres

| Clé | Défaut (preset) | Rôle |
|-----|-----------------|------|
| `strategyId` | `fav-band` | Active ce moteur |
| `favBandAskMin` / `favBandAskMax` | `0.70` / `0.85` | Bande d'ask du favori pour entrer |
| `favBandMinElapsedSec` | `200` | Secondes min depuis `windowStart` |
| `favBandMaxElapsedSec` | `null` | Cap optionnel ; `null` = jusqu'à la fin de fenêtre |
| `cheapOrderUsdc` | `15` | Budget USDC de l'entrée FOK (clé arb ; **fav-band utilise `favBandOrderUsdc`**) |
| `maxSharesPerOrder` | `40` | Cap shares |
| `maxOpenPositionsPerSide` | `1` | Une entrée directionnelle à la fois |
| `enableExpensiveHedge` / `arbAskLockOnly` | `false` | Forcés / nettoyés pour éviter des sticky flags ask-lock |

### Contrainte CLOB (mise minimale)

Polymarket impose **≥ 5 shares** (et ≥ ~1 $ de notionnel). La taille = `cheapOrderUsdc / ask` :

| `cheapOrderUsdc` | ask 0.70 | ask 0.85 | Entrées ? |
|------------------|----------:|--------:|-----------|
| `3` | ~4.3 shares | ~3.5 shares | **Jamais** (sous le min 5) |
| `5` | ~7.1 | ~5.9 | OK sur toute la bande |
| `15` | ~21 | ~18 | OK (preset) |

**Minimum pratique pour [0.70, 0.85] : `cheapOrderUsdc ≥ 5`** (strictement ≥ `5 × favBandAskMax` ≈ 4.25 $).

### Flux (un tick)

1. Les deux books ont un ask ; le favori = ask le plus haut (`pickEdgeToken`).
2. Ask favori ∈ `[favBandAskMin, favBandAskMax]`.
3. `elapsedSec ≥ favBandMinElapsedSec` (et ≤ max si défini).
4. Pas déjà de jambe fill / open sur la paire (une entrée par fenêtre).
5. `computeSize(cheapOrderUsdc, ask)` ≥ 5 shares ; profondeur ask ≥ ~80 % de la taille si connue.
6. Émission **FOK BUY** au ask live ; hold jusqu'à résolution.

### Différences vs autres moteurs

| | Fav-band | Ask-lock | Edge-lead | Reverse |
|--|----------|----------|-----------|---------|
| Cible | Favori mid-band | Lock ask+ask | Favori + confirm + cheap | Underdog |
| Ordre | FOK BUY seul | Dual FOK | GTC / logique edge | Directionnel underdog |
| Hedge | Non | Oui (1:1 immédiat) | Cheap follow-up possible | Non |
| Sortie | Résolution (ou fermeture manuelle) | Lock / Policy A | Edge sell / resolve | Résolution |

### Fermeture manuelle (dashboard)

Liste **Positions ouvertes** → **Fermer** → confirmation → FOK **SELL** au best bid. Au fill, seule cette `positionId` passe en `sold` (hedges resting de la paire annulés). Refus si pas de bid, taille &lt; 5, ou FOK tué / non confirmé.

API : `POST /api/open-positions/close` body `{ "positionId": "..." }`.

### Backtest (indicatif BTC 15m)

Sur un long univers (~305 fenêtres) le preset fav-band a montré un PnL nettement plus élevé que ask-lock, avec variance / maxDD élevés (WR ~78 %). À retravailler live avec une mise ≥ 5 $.

### Fichiers clés

- `src/strategy/fav-band-strategy.ts` — logique d'entrée
- `src/strategy/ids.ts` / `registry.ts` — `strategyId: fav-band`
- `config/presets/fav-band.json` — preset UI / backtest
- `tests/fav-band.test.ts` — unit tests
- `src/bot/resting-manager.ts` — `closePositionManual`
- `src/trade-tracker.ts` — `closePositionAsSold`
- `src/dashboard/server.ts` — `POST /api/open-positions/close`
- `frontend/src/components/panels/OpenPositions.tsx` — bouton Fermer

## Dip-revert — favori chuté + rebond (mean-reversion)

**Nouvelle** stratégie directionnelle (`strategyId: dip-revert`). Ce n'est **pas** fav-band, ni edge-lead, ni arb/ask-lock.

Idée empirique (BTC/ETH 15m, univers audité > 800 ticks / 60 s de trous max, 313 fenêtres) : après ~180 s dans la fenêtre, le favori (ask le plus haut) qui a subi une **chute intra-fenêtre** ≥ 3 ¢ en 60 s puis qui **stabilise / rebondit** (ask repassé au-dessus de son minimum local) gagne à la résolution **~64 % du temps** (vs ~52 % pour le favori moyen). Le marché sur-pénalise temporairement le favori après une secousse ; la clôture revient à la tendance dominante.

- Une seule jambe **FOK BUY** sur le favori, bande `[0.55, 0.65]`
- **Pas de hedge**, pas de défense, pas de vente anticipée — hold jusqu'à résolution
- Une entrée par fenêtre (FOK raté par profondeur → retenté au tick suivant)
- En interne la jambe est `kind: "cheap"` (pipeline d'ordres unique) — c'est le **favori**, pas l'underdog

### Activer

1. Dashboard → **Configuration** → onglet **Profils** → moteur **dip-revert** → profil **Dip-revert (dip favori + rebond, hold resolve)**  \
   (ou page **Backtest** → preset **Dip-revert**)
2. Vérifier les champs, puis **Enregistrer** (`data/bot-settings.json` + config live)

Éditer `config/presets/dip-revert.json` ne change pas la config live : appliquer le profil puis enregistrer. Redémarrer le bot si besoin.

### Paramètres

| Clé | Défaut | Rôle |
|-----|--------|------|
| `strategyId` | `dip-revert` | Active ce moteur |
| `dipRevertBandMin` / `dipRevertBandMax` | `0.55` / `0.65` | Bande d'ask du favori pour entrer |
| `dipRevertMinDrop` | `0.03` | Chute minimale (¢) sur la fenêtre lookback |
| `dipRevertDropLookbackMs` | `60000` | Fenêtre glissante de mesure du drop |
| `dipRevertMinElapsedSec` | `180` | Secondes min depuis `windowStart` |
| `dipRevertMaxElapsedSec` | `null` | Cap optionnel ; `null` = jusqu'à la fin de fenêtre |
| `dipRevertMaxSpread` | `0.04` | Spread max du favori à l'entrée (liquidité) |
| `dipRevertOrderUsdc` | `15` | Budget USDC de l'entrée FOK |
| `dipRevertExitTakeProfitEnabled` | `false` | Take-profit optionnel : FOK SELL du favori détenu à seuil atteint |
| `dipRevertExitWinAsk` | `0.85` | Seuil TP sur l'ask du favori détenu (doit être > bande max) |
| `maxSharesPerOrder` | `30` | Cap shares |
| `maxOpenPositionsPerSide` | `1` | Une entrée directionnelle à la fois |
| `enableExpensiveHedge` / `arbAskLockOnly` | `false` | Forcés / nettoyés (pas de hedge, pas d'ask-lock) |

### Flux (un tick)

1. `elapsedSec ≥ dipRevertMinElapsedSec`.
2. Favori = token au **best ask le plus haut** (`pickEdgeToken`), ask ∈ bande.
3. Fenêtre glissante `dipRevertDropLookbackMs` : le plus vieil ask − ask actuel ≥ `dipRevertMinDrop`.
4. Rebond : ask actuel **> minimum local** de la fenêtre (le prix a cessé de descendre).
5. Spread ≤ `dipRevertMaxSpread`, profondeur ask suffisante pour la taille, pas déjà de jambe fillée.
6. Émission **FOK BUY** au ask live ; hold jusqu'à résolution.

**Sortie optionnelle (take-profit)** : `dipRevertExitTakeProfitEnabled` (défaut `false`). Activé, le bot vend en FOK SELL au bid le favori détenu dès que **son propre ask** atteint `dipRevertExitWinAsk` (défaut 0.85, doit être > bande max). Un FOK tué par manque de profondeur garde la position jusqu'à la résolution. Backtest officiel (326 fenêtres) : le TP dégrade le PnL à tous les seuils (+$74 à +$194 vs +$278 hold) — le hold intégral reste la politique recommandée. Le seul axe testé qui améliore le résultat est `dipRevertMaxElapsedSec: 420` (+$305).

### Différences vs autres moteurs

| | Dip-revert | Fav-band | Edge-lead | Ask-lock |
|--|------------|----------|-----------|----------|
| Condition | Chute + rebond intra-fenêtre | Ask favori mid-band | Favori + confirm + cheap | Lock ask+ask |
| Ordre | FOK BUY seul | FOK BUY seul | GTC / logique edge | Dual FOK |
| Hedge | Non | Non | Cheap follow-up possible | Oui (1:1 immédiat) |
| Sortie | Résolution (ou TP optionnel) | Résolution (ou fermeture manuelle) | Edge sell / resolve | Lock / Policy A |

### Backtest (indicatif BTC 15m, univers 321 fenêtres)

Capital simulé 500 $, preset par défaut : **PnL ≈ +290 $ (+58 %)**, 239 fills, **winRate ≈ 65 %** sur les fenêtres réellement tradées (155 wins / 84 losses) — cohérent avec la recherche (~64 %). Positif sur longue période mais fortement directionnel (variance élevée, pas de hedge). Référence fav-band sur le même univers : +205 $ (+41 %), winRate ~77 %. À retravailler live avec une mise prudente.

### Fichiers clés

- `src/strategy/dip-revert-strategy.ts` — logique d'entrée
- `src/strategy/ids.ts` / `registry.ts` — `strategyId: dip-revert`
- `config/presets/dip-revert.json` — preset UI / backtest
- `tests/dip-revert.test.ts` — unit tests
- `scripts/backtest-dip-revert.mts` — backtest univers audité

## Architecture

```
src/
├── index.ts                 # Entry point, wiring + main loop
├── config.ts                # All settings via env vars (validated)
├── bot.ts                   # Re-export ReverseBot (compat for index / tests)
├── bot/                     # ReverseBot façade + modules live : reverse-bot (tick),
│                            # opportunity-executor (gates), resting-manager (GTC/défense/close),
│                            # live-order-lifecycle, balance-guard, order-type, tick-snapshots
├── strategy.ts              # Barrel: arb findOpportunities + predicate re-exports
├── strategy/                # TradingStrategy plugins (11 moteurs natifs), sizing, registry,
│                            # graph/ (DSL + interpréteur pour les graphs custom)
├── trader.ts                # Live trading via @polymarket/clob-client-v2 (Polygon, CLOB)
├── trade-tracker.ts         # Position/pair state, window claims, posted orders, retry logic
├── position-resolver.ts     # Settlement detection via Gamma API (outcomePrices >= 0.99)
├── market-scanner.ts        # Finds active Up/Down events from Gamma API
├── market-data.ts           # Recording market + book snapshots (dataset backtest / ML)
├── market-rules.ts          # Flags trading/recording par marché
├── relayer.ts               # Deposit-wallet (V2) redemption via Polymarket relayer
├── relayer-quota.ts         # Quota dédié relayer (countdown, record, backoff)
├── auto-redeemer.ts         # Boucle de redemption des gagnants (pré-flight quota, dedup)
├── withdraw.ts              # Retraits USDC
├── backtest/                # Runner officiel : broker, windows, completeness, tick-executor (page /backtest)
├── paper/                   # Moteur paper-trading live (page Simulation)
├── ws/                      # Feeds CLOB websocket (book, market, user)
├── runtime-settings.ts      # Clés hot-éditables + sanitizePatch (PATCH dashboard)
├── strategy-presets.ts      # Import/sanitize des presets JSON
├── dashboard/
│   ├── server.ts            # HTTP + SSE dashboard (port 3105)
│   ├── events.ts            # Event bus (ring buffer + SQLite persistence)
│   ├── balance.ts           # Portfolio tracking (collateral + positions)
│   ├── market-history.ts / market-trades.ts    # Page Données
│   ├── sim-handlers.ts      # API simulation
│   └── strategy-chart-api.ts # Validation/sauvegarde des graphs custom
├── db/
│   ├── database.ts          # SQLite schema + migrations (WAL mode)
│   ├── repositories.ts      # Type-safe repositories for all tables
│   └── index.ts             # Repository factory
├── types.ts                 # All shared interfaces
├── logger.ts                # Structured logging + event bus emission
└── utils/
    ├── market.ts            # Slug parsing, tick sizes, book helpers
    ├── prices.ts            # Price level generation, size computation
    ├── book-imbalance.ts    # Features de déséquilibre du carnet
    ├── order-status.ts      # Normalisation des statuts CLOB
    └── random.ts            # Seeded xorshift32 RNG (deterministic sim)
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Dual mode** | `DRY_RUN=true` (simulation) / `DRY_RUN=false` (live CLOB orders) |
| **Persistence** | SQLite (WAL) for positions, pairs, ledger, order history, window claims |
| **Dashboard** | Real-time SSE dashboard at `http://localhost:3105` |
| **Redemption** | V2 deposit-wallet (POLY_1271) on-chain redeem via relayer |
| **Safety guards** | Exposure caps, max open per side, covered-pair requirement, depth checks |
| **Deterministic sim** | Seeded RNG for reproducible backtests |

## Configuration

Two files, no overlap:

| File | What it holds |
|------|----------------|
| `.env` | Secrets and infra: `DRY_RUN`, keys, hosts, dashboard port, DB paths |
| `data/bot-settings.json` | **All strategy parameters** (bands, lock, budgets, poll, sim). Edited from the dashboard. |

Copy `.env.example` to `.env`. Copy `bot-settings.example.json` to `data/bot-settings.json` (or save once from the dashboard). Named **parameter packs** live in `config/presets/` and each file **must** declare `strategyId`. The two shipped packs (**Couverture max**, **Conservateur**) are `arb`. Pick the **Moteur** then a profil in the dashboard Configuration dialog, then **Enregistrer**. Live (`DRY_RUN=false`) **refuses to start** without `data/bot-settings.json`. Leftover `CHEAP_*` / `EXPENSIVE_*` / `POLL_*` / `STRATEGY_ID` in `.env` are ignored.

```bash
# .env — secrets + infra
DRY_RUN=true                    # true = simulation, false = live trading
PRIVATE_KEY=0x...               # EOA private key (required for live)
FUNDER_ADDRESS=0x...            # Deposit wallet address (for redemption)
READONLY_LIVE=false
SIGNATURE_TYPE=3                # POLY_1271 deposit wallet
AUTO_REDEEM_WINNERS=false

# Polymarket API
GAMMA_API_HOST=https://gamma-api.polymarket.com
CLOB_HOST=https://clob.polymarket.com
DATA_API_HOST=https://data-api.polymarket.com
RELAYER_HOST=https://relayer-v2.polymarket.com
CHAIN_ID=137

# CLOB credentials (for live trading)
CLOB_API_KEY=...
CLOB_SECRET=...
CLOB_PASSPHRASE=...

# Builder credentials (for redemption via relayer)
BUILDER_API_KEY=...
BUILDER_SECRET=...
BUILDER_PASSPHRASE=...

# Database
PERSISTENCE_ENABLED=true
DB_PATH=data/bot.db              # dry-run history
DB_PATH_LIVE=data/bot-live.db    # live trading history (separate)

# Dashboard
ENABLE_DASHBOARD=true
DASHBOARD_PORT=3105
```

Strategy keys (dashboard → `data/bot-settings.json`). See `bot-settings.example.json`.

```json
{
  "pollIntervalMs": 5000,
  "marketSlugPrefixes": ["btc-updown-15m", "eth-updown-15m"],
  "cheapBuyMin": 0.07,
  "cheapBuyMax": 0.10,
  "cheapOrderUsdc": 1,
  "strategyId": "arb",
  "barbellHedgeRatio": 0.5,
  "pairLockMax": 0.98,
  "enableExpensiveHedge": true,
  "expensiveBuyMin": 0.85,
  "expensiveBuyMax": 0.95,
  "expensiveOrderUsdc": 15,
  "expensiveOrderType": "FOK",
  "maxSharesPerOrder": 20,
  "maxOpenPositionsPerSide": 1,
  "maxExposureUsdc": 45,
  "simResolveFallback": "none"
}
```

`expensiveOrderUsdc` is a secondary cap on the hedge. Below 5 shares at the hedge price there is no hedge. On **arb**, a $1 cheap at 0.07 needs ~14 USDC to cover 1:1 at 0.95. On **barbell**, the hedge target is `filledCheap × barbellHedgeRatio` (not a profit lock).

## Installation & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run (dry-run by default)
npm start

# Or with tsx watch (auto-restart on change)
npm run dev
```

## Dashboard

Open `http://localhost:3105` for real-time monitoring:
- Live positions & PnL (bouton **Fermer** = FOK SELL manuel au bid, avec descente jusqu'à 3 ticks si la profondeur l'exige, et resync wallet si le solde réel est inférieur à la position — voir [Fav-band](#fav-band--favori-mid-band))
- Active opportunities
- Balance & collateral
- Event log (SSE stream)
- Manual redemption trigger (positions Polymarket redeemables)

The dashboard is a **SolidJS + Vite** frontend in `frontend/`:

```bash
# Dev mode — backend (tsx watch, :3105) + frontend (Vite, :5173) ensemble
npm run dev:all

# Dev mode séparé (Vite dev server on :5173, proxies API/SSE to backend on :3105)
cd frontend && npm install && npm run dev

# Production build (outputs to dist/dashboard/public/, served by the backend)
npm run build:dashboard

# Full build (backend + dashboard)
npm run build:all
```

The backend serves the built assets from `dist/dashboard/public/`. Run `npm run build:dashboard` before `npm start` if you want the compiled UI (Vite writes there). In dev, `npm run dev:all` uses the Vite proxy on :5173.

A GTC order posted without a CLOB `orderID` cannot be cancelled on the exchange (tracker-only cleanup).

## Database Schema (SQLite)

```
Live / trading     positions, arb_pairs, orders, posted_orders, trade_keys,
                   retry_counts, window_claims, redeems, withdrawals, bot_state
Enregistrement     market_snapshots, book_snapshots, opportunity_snapshots,
(dataset ML)       market_rules, market_resolutions, stats_snapshots, balance_snapshots
Simulation         ledger + sim_pairs, sim_positions, sim_posted_orders, sim_trades,
(paper / dry-run)  sim_window_claims, sim_trade_keys, sim_retry_counts, sim_state
Backtest           backtest_runs, backtest_trades, backtest_positions
Graphs custom      strategy_graphs
Events             events (persisted bot events, SSE replay)
```

> Schéma complet et migrations : `src/db/database.ts`. Un `bot-live.db` avec enregistrement
> des marchés activé contient aujourd'hui 31 tables.

## Safety & Risk Controls

1. **Exposure cap** (`MAX_EXPOSURE_USDC`) — total open + resting cost never exceeds limit
2. **Per-side limit** (`MAX_OPEN_POSITIONS_PER_SIDE`) — max 1 order per outcome (configurable)
3. **Favorite already in band** — no new cheap unless the favorite ask is in `[EXPENSIVE_BUY_MIN, EXPENSIVE_BUY_MAX]` (a hedge limit far below a 0.97 ask is not a cover)
4. **CLOB fill confirmation** — a CLOB `matched` is not enough: cheap positions open only when the funder holds the tokens (re-checked up to 8 ticks, since the CLOB balance can lag a maker fill); FOK sells are confirmed by token-balance drop (ghost MATCHED / empty `makingAmount` are ignored). A partially filled cheap that must be repriced/cancelled is cancelled **first**, then the filled part is booked — no remainder is left orphaned on the book.
5. **CLOB minimums** — order size floored at 5 shares / $1 notional; tick size never below 0.01
6. **Balance guard** — live orders skipped when cached CLOB collateral < estimated cost; 60s pause after 3 consecutive balance rejections
7. **Stale order cleanup** — cancel GTC orders after windowEnd + 5 min; unacked rows (no `orderId`) pruned at +15 min, tracked orders at +24 h
8. **Window claim** — outcomes stay locked for the window, but an uncommitted claim is dropped if the underdog flips; no claim on a one-sided book
9. **Pair lock (`arb` only)** — *maker path* when `arbAskLockOnly=false`: new cheap GTC: `limit + min(favoriteAsk, expensiveBuyMax) ≤ PAIR_LOCK_MAX`. Hedge after fill: `fillPrice + min(freshAsk, expensiveBuyMax) ≤ PAIR_LOCK_MAX`. If the lock is unreachable after fill (**Policy A**: `fillPrice + favoriteAsk > PAIR_LOCK_MAX`), FOK **SELL** the uncovered cheap at the bid — do **not** hold it directional. A budget-capped hedge must not leave uncovered dust in `(0, 5)` shares: leave exactly 5 sellable, or skip the partial hedge so the full uncovered stays defendable. If dust is already below 5, hold to resolution (CLOB cannot sell it). **Ask-lock** (`arbAskLockOnly=true`): see [Ask-lock (dual-FOK)](#ask-lock-dual-fok--mode-arb). **Barbell ignores the lock.**
10. **Pair defense** — FOK SELL at the bid only if the favorite ask is **above** `EXPENSIVE_BUY_MAX` **and** the pair is not covered (`arb`: 1:1; `barbell`: filled hedge ≥ cheap × ratio). Shares sold = `defendShares` (arb: cheap − hedge; barbell: missing hedge slice only). Ask below `EXPENSIVE_BUY_MIN` does not dump the cheap. After a sale, resting GTC hedges of that pair are cancelled.

## Redemption (V2 Deposit Wallet)

For resolved positions, the bot can redeem via Polymarket's relayer:
- Requires `BUILDER_API_KEY`, `BUILDER_SECRET`, `BUILDER_PASSPHRASE`
- Uses `FUNDER_ADDRESS` (deposit wallet holding the tokens)
- Submits batch: `setApprovalForAll` (if needed) + `redeemPositions`
- Polls relayer until `STATE_MINED`

`READONLY_LIVE` mode does not require `PRIVATE_KEY` (no trading client is created); it only needs `FUNDER_ADDRESS` for balance display.

```bash
# Trigger via dashboard or API
POST /api/redeem { "conditionId": "...", "outcomeIndex": 0, "negRisk": false }
```

## Testing

```bash
# Type check
npm run build

# Unit tests (node:test)
npm test

# Run simulation (dry-run)
DRY_RUN=true npm start
```

## Project Structure Rationale

- **Backend-side grouping**: All data transformation (pairing, enrichment, stats) happens in `bot/` (orchestration in `reverse-bot.ts`)/`strategy.ts`/`trade-tracker.ts` — the dashboard is a thin viewer
- **Window claims**: Outcomes stay locked for the window to avoid flip-flopping, unless nothing is committed and the underdog flips (claim is cleared and re-picked)
- **Posted order tracking**: Live GTC orders tracked separately from filled positions (they're "resting" exposure)
- **Deterministic simulation**: Seeded RNG enables reproducible backtests with identical seeds

## License

MIT