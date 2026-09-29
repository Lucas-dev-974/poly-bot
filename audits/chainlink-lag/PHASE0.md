# Phase 0 — Rapport de vérification des hypothèses (chainlink-lag)

> Généré le 2026-09-25 par les scripts `scripts/research/chainlink-lag/`.
> Gate du plan : Phase 0 livre ce rapport. **A6 est le verdict critique** — il conditionne le wiring du moteur (Phase 3).

## Synthèse des verdicts

| # | Hypothèse | Verdict | Détail |
|---|-----------|---------|--------|
| A1 | Résolution sur Chainlink | ✅ **CONFIRMÉ** | 8/8 préfixes (BTC/ETH/SOL/XRP/DOGE/HYPE/BNB/ZEC) citent un stream **TWAP-60s** Chainlink Data Streams. NB : le plan indiquait SOL/HYPE/BNB/ZEC sur streams simples — comportement récent différent, tous en TWAP-60s désormais |
| A2 | Référence exacte | ✅ (plan révisé) | TWAP-60s Data Streams, pas le feed on-chain. Règle : TWAP fin ≥ TWAP début → Up (tie → Up) |
| A3 | Klines 1s REST pour l'historique | ⚠️→✅ **CONTOURNÉ** | REST lent (~3.6 s/req sur archives) et budget-limité ; **`data.binance.vision` (ZIP quotidiens 1s) couvre tout le dataset** (~2.4 MB/jour) → backfill viable et rapide |
| A4 | Source Chainlink pour le bot | ✅ **TRANCHÉ** | v1 sans abonnement Data Streams (proxy gratuit suffit, cf. A6) |
| A5 | WS Binance accessible | ✅ **OK** | 4/4 sondes (trade BTC/ETH, miniTicker, combiné) OK, ~500-620 ms, **pas de geo-block 451** ; `globalThis.WebSocket` Node 22 présent (zéro dep) |
| A6 | **Proxy TWAP Binance → côté de résolution** | ✅ **OK** | **WR 100.00% (n=364, IC95 ±0%) au seuil 0.15%** (convention BACKWARD) — cf. détail ci-dessous |
| A7 | Perps idx fidèle au stream Chainlink | ⏳ à mesurer | Non backfillable — nécessite ≥ 3 j de `feed_snapshots` source `polymarket-idx` (collecte dès Phase 1) |

### Complément (2026-09-25, soir) — API perps Polymarket vérifiée en direct

| Endpoint | Verdict | Détail |
|---|---|---|
| WS `wss://ws.perpetuals.polymarket.com/v1/ws` | ✅ primaire live (plan A7) | ticks ~100 ms, sans auth |
| REST `api.perpetuals.polymarket.com/v1/info/klines` | ❌ pas de 1s fiable | `start_timestamp` **en ms**, requis ; granularité réelle ~1-2 min (barres uniquement sur trades) ; 1000 barres max, sans pagination (`end_timestamp` → 0) ; inutilisable pour le backfill 1s |
| REST `/v1/info/mark-history` | ❌ inutilisable | n=0 même à 10 min de profondeur |
| REST `/v1/info/instruments` | ✅ | host **api**.perpetuals.polymarket.com (89 instruments, `instrument_id`) |

**Conséquences** :
- **Backfill historique 1s : Binance (data.binance.vision) reste indispensable** — les REST Polymarket ne fournissent pas de série 1s continue paginable.
- Le backfill doit utiliser `start_timestamp` en **ms** (piège documenté) ; granularité réelle des klines ~1-2 min, barres uniquement là où des trades perps ont eu lieu.
- A7 (fidélité de `idx` vs métrique de résolution) reste LA mesure qui décidera si Binance peut être abandonné du chemin **signal** en live ; le chemin **backfill/backtest** garde Binance dans tous les cas.

## Détail A6 (le verdict critique)

Source des données : 1220 fenêtres résolues BTC+ETH du dataset (`bot-live.db`), klines 1s Binance via `data.binance.vision` (couverture 1218/1220 — seul le jour courant, non terminé, manque).

WR du proxy `sign(twapEnd − barre)` vs `market_resolutions.winnerOutcomeIndex` :

| Seuil \|movePct\| | Convention BACKWARD | Convention FORWARD |
|---|---|---|
| 0 | 98.28% (n=1218) | 94.01% (n=1218) |
| 0.05 | **100%** (n=803) | 99.13% (n=805) |
| 0.1 | **100%** (n=550) | 99.40% (n=498) |
| 0.15 | **100%** (n=364) | 99.70% (n=331) |
| 0.25 | **100%** (n=137) | **100%** (n=124) |

- **Fréquence de triggers** (BACKWARD) : 45.2% des fenêtres à ≥0.1%, **29.9% à ≥0.15%**, 11.2% à ≥0.25% → le moteur aura largement matière.
- **Split-half** (0.15) : ancienne 100% (n=166), récente 100% (n=198) — pas de dégradation temporelle.
- **Par asset** : btc 100% (n=320), eth 100% (n=44).
- **Distribution movePct** : min −1.454% / p5 −0.257% / médiane 0.000% / p95 +0.281% / max +1.401%.

**Découverte bonus — la convention de barre** : la convention **BACKWARD** (buffer glissant [ws−59, ws] figé à l'instant `ws`) prédit mieux la résolution que la FORWARD (TWAP [ws, ws+59]) — 98.28% vs 94.01% à seuil 0, écart surtout sur les petits moves. La métrique de résolution semble donc comparer la TWAP de fin au **dernier buffer 60s d'avant-fenêtre**, ce qui valide le design `twap60AtWindowStart` du FeedManager (buffer figé à l'ouverture).

**Caveat de méthode** : le WR 100% aux seuils ≥0.05 est un WR de *direction* (sign du move), pas une validation du niveau absolu du proxy (TWAP Binance un-exchange vs composite Chainlink). Les désaccords se concentrent sur les moves quasi-nuls (98.28% à seuil 0), exactement là où l'erreur cross-exchange dépasse le move. **Conséquence pour le moteur** : le gate `|movePct| ≥ seuil` fait double emploi — il élimine mécaniquement la zone où le proxy peut se tromper. Le seuil 0.15% offre n=364 triggers avec WR plafond mesuré.

## Livrables

- `scripts/research/chainlink-lag/00-gamma-source.mts` → `audits/chainlink-lag/A1-SOURCE-*.md` (citations exactes 8 préfixes)
- `scripts/research/chainlink-lag/01-twap-proxy.mts` → `audits/chainlink-lag/A6-PROXY-*.md` + `.json` (mesure complète par fenêtre)
- `scripts/research/chainlink-lag/02-binance-history.mts` → `audits/chainlink-lag/A3-HISTORY-*.md` (sondage REST ; supplanté par la source vision)
- `scripts/research/chainlink-lag/03-ws-binance.mts` → `audits/chainlink-lag/A5-WS-*.md` (sondes WS)
- Cache klines : `data/chainlink-lag-cache/klines-1s/<SYM>/<date>.json` (gitignore `data/`)

## Décision

**Gate A6 franchi** → la Phase 1 (feed + persistance) et la Phase 2 (sim signal) peuvent démarrer. Point de vigilance Phase 1 : le backfill (Task 1.5) doit utiliser `data.binance.vision` (ZIP quotidiens) et non le REST klines 1s (trop lent sur archives). Le choix du seuil définitif reste à la Phase 2 (sim avec contrôles causaux + confirmation multi-ticks), mais la plage utile est **[0.10, 0.25]%** (n=550 à n=137, WR 100% BACKWARD).

Verdict DEAD n'est pas requis : aucune des conditions d'arrêt (WR < 95%) n'est remplie.