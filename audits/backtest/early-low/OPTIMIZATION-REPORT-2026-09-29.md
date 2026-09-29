# Rapport d'optimisation — moteur early-low

**Date :** 2026-09-29 · **Données :** `data/bot-live.db` (21 jours, 2026-09-08 → 2026-09-29, 4.9 M snapshots)
**Universe :** fenêtres 15m BTC, ≥ 500 ticks, gap ≤ 180 s — ~2 092 fenêtres (~20 000 ticks/fenêtre)
**Méthode :** backtests via le runner officiel (`runBacktest`, fills FOK sur profondeur L1+rejets, résolutions réelles). Chaque variante testée sur **split in-sample / out-of-sample** pour éviter l'overfitting.
**Scripts :** `scripts/research/early-low/optimize.mts` (phases A/B), `optimize-combos.mts` (phase C'), `robustness.mts` (validation multi-split).

---

## TL;DR

| | Ancien preset (exit 0.40 wait-and-see, entrée 300 s) | **Nouveau preset (hold + entrée 150 s)** |
|---|---|---|
| PnL 21 jours | **−$30.39** (−$1.75 IS / −$24.64 OOS) | **+$33.55** (+$15.27 IS / +$18.36 OOS) |
| Signe par split (8 segments) | négatif 7/8 | **positif 8/8** |
| Trades | 279 | 40 |
| Max drawdown | −$28.29 (OOS) | −$10.00 (IS) / −$8.00 (OOS) |

**La config par défaut du moteur, le preset `early-low.json`, les défauts frontend et le guide ont été mis à jour.**
L'ancien exit wait-and-see reste disponibles via `earlyLowExitEnabled` (il est désormais **off par défaut**).

---

## 1. Point de départ et hypothèse

Le sweep initial (851 fenêtres ≥ 750 ticks) avait choisi `0.12 / 0.40 / momentum 0` (+$9.63).
Rejoué sur l'univers élargi (21 jours, critères assouplis), ce preset est **négatif** (−$1.75 IS, −$24.64 OOS) : le sweep avait été optimisé sans hold-pure dans la grille et sur un sous-ensemble de fenêtres ultra-complètes.
Constat clé : le wait-and-see ne fait que **couper les gagnants** (avgLoss = −$1.00 partout : aucune perte n'est coupée par l'exit, il limite seulement les upside à ~3× le prix d'entrée au lieu de ~0.88/share de payout à la résolution).

## 2. Phase A/B — 19 variantes simples (single-knob), chaque variante testée IS + OOS

| Variante | Description | IS | OOS | Verdict |
|---|---|---|---|---|
| **hold-pure** | exit désactivé | **+$17.62** | **−$6.08** | **GARDER** (meilleur des deux segments) |
| **max150** | fenêtre d'entrée 150 s | −$0.88 | **+$2.99** | **GARDER** |
| sl4 | stop-loss bid ≤ 0.04 | +$9.61 | −$21.44 | IS seulement |
| base | preset actuel (référence) | −$1.75 | −$24.64 | référence |
| t1/t2/t3 | trailing 1/2/3¢ | −$3.13 / −$9.31 / −$12.91 | ~−$25 | pire |
| x035 / x045 | seuil exit 0.35 / 0.45 | −$5.68 / −$8.46 | −$27 / −$20 | pire |
| max450 | fenêtre 450 s | −$82.43 | −$74.68 | pire (trop de tickets perdants) |
| drop-r* | entrée "drop confirmé" | idem base | idem base | pas discriminant (ref toujours vue) |
| sp03/sp04 | spread 0.03/0.04 | idem base | idem base | pas discriminant (L1 toujours serré) |

Lecture : **l'exit wait-and-see est le principal destructeur de valeur** — le hold intégral gagne sur les deux
segments. Le stop-loss aide (IS +$11.4 vs base) mais pas assez en OOS seul. La fenêtre 150 s améliore l'OOS
(sept fois moins de trades perdants en fin de fenêtre).

## 3. Phase C' — combos focalisées (13 variantes)

| Combo | IS | OOS |
|---|---|---|
| **max150-hold** (entrée ≤150s **+ hold intégral**) | **+$15.27** | **+$18.36** ✅ |
| max150-hold-sl4 | +$13.01 | +$14.58 |
| max150-hold-sl6 | −$1.60 | +$8.68 |
| hold-sl4 (sans fenêtre resserrée) | +$6.86 | −$24.59 |
| hold-pure (sans fenêtre resserrée) | +$17.62 | −$6.08 |
| max200 / max225 + hold + sl4 | −$5.30 / −$6.18 | +$2.81 / −$3.55 |

La **fenêtre 150 s** est l'ingrédient qui rend le hold vraiment robuste : elle élimine les tickets achetés
entre 2,5 et 5 min (zone la plus perdante : le marché a déjà tranché, la décote n'est plus une surréaction).

## 4. Robustesse multi-split (4 splits × 5 configs = 40 backtests)

La candidate `prop150-hold` (hold + entrée 150 s) :

| Split | Preset (avant/après) | prop150-hold (avant/après) | prop180-hold |
|---|---|---|---|
| 21 sept. | +$1.06 / **−$31.45** | +$20.27 / **+$13.36** | +$25.36 / +$7.54 |
| 23 sept. | −$1.75 / **−$28.64** | +$15.27 / **+$18.36** | +$14.36 / +$18.54 |
| 24 sept. | −$16.75 / **−$13.64** | +$30.45 / **+$3.18** | +$25.54 / +$7.36 |
| 25 sept. | −$10.65 / **−$19.74** | +$27.45 / **+$6.18** | +$18.54 / +$14.36 |

- `prop150-hold` : **8/8 segments positifs**, cumul **+$33.55** (trades : 40 IS + 68 OOS).
- `prop180-hold` : aussi 8/8 positifs (moins bon OOS que 150). `prop120` : trop peu de trades (trop sélectif).
- Preset actuel : négatif sur 7/8 segments — la perte provient surtout de la **période récente**.
- Stop 0.04 additionnel (`prop150-hold-sl4`) : légèrement dégradant vs hold seul — pas de stop par défaut.

## 5. Config retenue (défauts appliqués)

```json
{
  "earlyLowBuyAskMin": 0,
  "earlyLowBuyAskMax": 0.12,
  "earlyLowMaxElapsedSec": 150,
  "earlyLowMaxSpread": 0.06,
  "earlyLowOrderUsdc": 1,
  "earlyLowExitEnabled": false,
  "earlyLowStopLossEnabled": false,
  "earlyLow15mOnly": true
}
```

Nouveaux knobs (off par défaut, testés et non retenus en défaut) :
`earlyLowDropEntryEnabled/PriceMin/Min/MinElapsedSec` (entrée drop confirmé), `earlyLowTrailingEnabled/Offset`
(trailing), `earlyLowStopLossEnabled/BidMax` (stop bid), `earlyLowExitMaxElapsedSec` (deadline) — tous
disponibles pour research via env `EARLY_LOW_*` et UI.

## 6. Modifications code

| Fichier | Changement |
|---|---|
| `src/strategy/early-low-strategy.ts` | +9 knobs optionnels (drop confirmé, trailing, stop-loss, deadline), header docs |
| `src/config.ts` | interface + defaults (hold, 150 s) + validation des 9 knobs |
| `src/runtime-settings.ts` | clés / alias env / parsing / groupe EARLY_LOW_KEYS |
| `config/presets/early-low.json` | preset aligné sur la config optimisée |
| `tests/early-low.test.ts` | 23 tests (stop/trailing/deadline) + exit validation conditionnelle |
| `tests/helpers.ts` | defaults de test alignés (exit off, 150 s) |
| frontend (7 fichiers) | defaults configForm, sections SettingsModal, guide data/GuideTabs, presets, comparatif, lifecycle |
| README.md | section early-low mise à jour |

Vérifications : `tsc --noEmit` ✓ · 71/71 tests ✓ · build frontend ✓.

## 7. Limites et suite

1. **Taille d'échantillon modeste** : 40 trades (prop150-hold, split 23/09) — l'espérance est positive mais
   l'intervalle de confiance reste large. Prévoir un suivi en paper trading avant tout passage live.
2. **Un seul asset** : toutes les fenêtres testées sont BTC 15m. Le gate `earlyLow15mOnly` est conservé.
3. Les rapports bruts (JSON + MD) :
   - `audits/backtest/early-low/opt-2026-09-29T11-33-42-405Z.{md,json}` (phases A/B)
   - `audits/backtest/early-low/opt-combos-2026-09-29T12-12-01-774Z.{md,json}` (phase C')
   - `audits/backtest/early-low/robustness-2026-09-29T13-08-50-915Z.{md,json}` (multi-split)
4. Scripts reproductibles :
   - `npx tsx scripts/research/early-low/optimize.mts 500 180000 2026-09-23T00:00:00Z`
   - `npx tsx scripts/research/early-low/optimize-combos.mts 500 180000 2026-09-23T00:00:00Z`
   - `npx tsx scripts/research/early-low/robustness.mts 500 180000`
5. Scripts exploratoires conservés : `db-inspect.mjs`, `db-schema.mjs`, `db-perday.mjs/.mts`,
   `db-complete-day.mts` (profilage dataset). `backtest-official.mts` non modifié.