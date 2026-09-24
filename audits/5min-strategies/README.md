# 5min-strategies

Recherche de stratégies pour les marchés Polymarket **BTC Up/Down 5 minutes** (`btc-updown-5m`).

**Contraintes de capital** : 5 shares minimum CLOB → tickets de ~1-2 $ à ~4 $, gain 1,50-2,50 $ par trade, cible de winrate > 55 %.

## Scripts (tous autonomes, Node >= 22, aucune dépendance)

| Script | Rôle |
|---|---|
| `01-collector.mjs` | Collecte temps réel des books CLOB + résolutions Gamma en SQLite locale (`5m-data.db`) |
| `02-import-history.mjs` | Import d'historique via l'API `/trades` de Polymarket (tick = chaque trade + book reconstruit) |
| `02b-import-botdb.mjs` | Import des book snapshots (1 Hz) du bot principal (`data/bot-live.db`) + backfill des résolutions Gamma |
| `03-backtest.mjs` | Moteur de backtest : joue les 16 stratégies S1-S16 tick par tick |
| `04-analyze.mjs` | Analyse du dataset : distribution des prix, volatilité, flips, calibration P(win) |
| `05-report.mjs` | Synthèse de tous les runs → `results/INDEX.md` |
| `06-sweep-v2.mjs` | Sweep G (antiflip TP/SL) + H (sharp) + I (late-flip) |
| `07-sweep-v3.mjs` | Sweep J (bounce) + K (bounce+floor) |
| `08-final.mjs` | Validation finale : finalistes × {2$, 2.5$, 4$} × split IS/OOS |
| `09-calibrate.mjs` | Probabilités conditionnelles directes P(win \| condition) |
| `09b-calibrate-antiflip.mjs` | Calibration fine de la zone antiflip + filtres |
| `09c-calibrate-flip.mjs` | Calibration "flip marginal" (force du nouveau leader) |
| `09d-calibrate-leader.mjs` | Leader vs Other par tranche de fenêtre × bande de prix |
| `10-sweep-v4.mjs` | Sweep L (délai post-flip × bande fine, issu de la calibration) |
| `lib/api.js` | Client Gamma/CLOB/data-api réutilisable |
| `lib/tickdb.js` | Schéma et accès à la base SQLite `5m-data.db` |
| `lib/strategies.js` | 16 stratégies de base S1-S16 |
| `lib/variants.js` | Variantes A-F |
| `lib/variants2.js` | Variantes G-I (TP/SL, sharp, late-flip) |
| `lib/variants3.js` | Variantes J-K (bounce confirmation) |
| `lib/variants4.js` | Variantes L (délai post-flip, issues de la calibration) |
| `data/5m-data.db` | Base SQLite : fenêtres, ticks, résolutions, runs |

**Livrable** : [`RECOMMANDATIONS.md`](RECOMMANDATIONS.md) — les 3 meilleures
stratégies validées IS/OOS + l'analyse d'efficience du marché (pourquoi
WR > 55 % à ratio 1:1.5+ n'est pas robustement atteignable, et quoi viser à la place).

## Workflow

```bash
# 1. Collecte continue (à laisser tourner ; Ctrl+C pour arrêter)
node audits/5min-strategies/01-collector.mjs

# 2. Import d'historique (complète le dataset avec les trades passés)
node audits/5min-strategies/02-import-history.mjs

# 3. Analyse du dataset
node audits/5min-strategies/04-analyze.mjs

# 4. Backtest de toutes les stratégies
node audits/5min-strategies/03-backtest.mjs
node audits/5min-strategies/03-backtest.mjs --id=s1

# 5. Rapport de synthèse
node audits/5min-strategies/05-report.mjs
```

Résultats des runs : `results/run-*.json` + `results/INDEX.md`.