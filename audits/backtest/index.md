# Index des backtests — `audits/backtest/`

> Résultats historiques des backtests et probes offline (aucun live). Chaque
> sous-dossier = une stratégie (ou un thème transverse). Un seul run conservé
> par configuration identique (les doublons plus anciens ont été supprimés).
> Source de données : `data/bot-live.db` en lecture seule. Scripts dans
> `scripts/` (root) et `scripts/research/<strategie>/` — voir
> `scripts/research/README.md`.

---

## Vue d'ensemble (meilleurs résultats par stratégie)

| Stratégie | Univers | Meilleure config | PnL | PnL % | Notes |
|---|---|---|---:|---:|---|
| **dip-revert** | 321–326 fenêtres | `maxElapsedSec=420` | **+$305** | +61 % | TP optionnel dégrade (off par défaut) |
| **fav-band** | 301 fenêtres | band 0.70–0.85, min 200 s | **+$299** | +398 % | 35 variantes gridées |
| **edge-lead** | 301 fenêtres | ref (gates) | −$19…−$46 | −38…−92 % | grids d'amélioration tous négatifs |
| **ask-lock** (arb) | 88 fenêtres | size 3× (cheap 3 / hedge 36) | +$3.51 | +4.7 % | 1:1, lock 0.99 |
| **arb** (couverture) | 84–85 fenêtres | conservative | −$8 | −16 % | uncover 99 % : pas d'edge sur ces fenêtres |
| **barbell** (compare) | 88 fenêtres | ratio 0.5 | +$71 | +141 % | voir compare |
| **reverse** | 88 fenêtres | preset | −$624 | −62 % | sous-remplissage destructif |

> Les univers diffèrent selon la session (84–326 fenêtres complètes, critères
> >800 ticks / gaps ≤ 60 s). Les PnL ne sont **pas** comparables entre
> univers — comparer au sein d'un même rapport.

---

## 📁 arb/ — moteur arb (couverture 1:1)

Scripts : `scripts/arb-audit-backtest.mts`

| Fichier | Config | Résultat |
|---|---|---|
| `arb-audit-1789293890125.json/.md` | preset coverage-max | PnL −$8.58 (−17 %), 139 fills, uncover 100 % |
| `arb-audit-conservative-1789296946723.*` | preset conservative | PnL −$8.03 (−16 %), uncover 99 % |
| `arb-audit-conservative-cbmax0.1-…` | cheapBuyMax 0.10 | PnL −$2.95 (−6 %), 9 fenêtres seulement |
| `arb-audit-conservative-cbmax0.12-…` | cheapBuyMax 0.12 | PnL −$5.61 (−11 %) |
| `arb-audit-conservative-cbmax0.12-emax0.9-FOK/…-GTC` | + expensiveBuyMax 0.90 | PnL −$12.18 (−24 %), FOK ≡ GTC ici |
| `arb-audit-conservative-cbmax0.12-emax0.92-FOK` | + expensiveBuyMax 0.92 | PnL −$12.27 (−25 %) |
| `arb-audit-conservative-cbmax0.5-emax0.99-FOK` | cheapBuyMax 0.50 | **0 fill** — jamais de paire |

**Verdict** : l'arb 1:1 classique n'a pas d'edge sur cette période — les paires
ne se forment pas (uncover ~100 %) ou les locks cassés détruisent le PnL.

## 📁 ask-lock/ — arb dual-FOK (ask-lock)

Scripts : `scripts/arb-audit-backtest.mts` (preset ask-lock),
`scripts/research/ask-lock/ask-lock-param-grid.mts`

| Fichier | Contenu |
|---|---|
| `arb-audit-ask-lock-1789302816650.json/.md` | preset ask-lock : PnL **+$0.23** (+0.5 %), paires couvertes 3/3 |
| `ask-lock-grid-1789314750163.json` | 9 variantes / 88 fenêtres. Top : **size-3×** (cheap 3 $, hedge 36 $) +$3.51 ; size-2× +$2.63 ; baseline +$0.23 |

**Verdict** : ask-lock couvre mieux (0 uncover) mais l'edge reste faible ;
le levier de sizing (×3) est le seul gain net visible.

## 📁 edge-lead/ — moteur edge-lead (favori d'abord)

Scripts : `scripts/research/edge-lead/*.mts`

| Fichier | Contenu |
|---|---|
| `edge-lead-600t-1m-…json` | run de référence univers 600t/1min (phase setup) |
| `edge-reject-dig-…json` | diagnostic des rejects : PnL −$28, **8108 rejects** (FOK no-fill retries, exposure-cap…) |
| `edge-lead-gates-…json` | 4 variantes de gates / 301 fenêtres : asksum 0.99 + cheap-ready → **0 fill** ; asksum 1.00 → −$38 |
| `edge-lead-improve-grid-…json` | 4 variantes / 301 fenêtres : toutes négatives (best −$16 « size-small-cap100 ») |
| `edge-asksum1-combo-…json` | 2 combos edgeAskSumMax=1 : −$4.58 |

**Verdict** : aucun axe d'amélioration d'edge-lead n'est ressorti positif ;
le moteur reste sur le preset de référence.

## 📁 fav-band/ — moteur fav-band

Script : `scripts/research/fav-band/fav-band-param-grid.mts`

| Fichier | Contenu |
|---|---|
| `fav-band-param-grid-…json` | **35 variantes** / 301 fenêtres. Top PnL : **band-070-085_min200_max600 +$299 (+398 %)**, 300 fills. Top PnL/DD : **band-068-082_min200** (+$289) |

**Verdict** : fav-band est le 2ᵉ meilleur moteur de l'univers ; bande
0.70–0.85 avec min elapsed 200 s. (Le backtest croisé dip-revert
(`dip-revert-backtest-…json`) donnait fav-band +$205 / WR 76.6 % sur 321
fenêtres — cohérent.)

## 📁 dip-revert/ — moteur dip-revert (favori chuté + rebond)

Scripts : `scripts/backtest-dip-revert.mts`,
`scripts/research/dip-revert-research/{dip-sim,recheck-official,verify-tp}.mts`

| Fichier | Contenu |
|---|---|
| `dip-confirmed-…json` | Recherche du signal : bande 0.55 / drop 3¢ / elapsed 180 s → **WR 64.5 %, EV 5.07¢/share** sur 231 fenêtres (le signal à l'origine du moteur) |
| `dip-revert-backtest-…json` | Backtest officiel initial : base **+$289.6 (57.9 %, WR 64.9 %)**, loose +$97, tight +$26, fav-band ref +$205 |
| `dip-revert-axes-…-v1.md` | ⚠️ OBSOLÈTE — artefact de pricing (favori courant) ; leçon conservée |
| `dip-revert-axes-…-v2.md` | Axe fidélisé (token détenu) : **tous les exits dégradent** ; seuls maxElapsedSec 420 et vol cap 0.20 survivent |
| `dip-revert-recheck-…json` | Re-check runner officiel (326 fenêtres) : **max420 +$305.5 (61.1 %)** > base-hold +$278 > tp-090 $194 > tp-095 $150 > combo $130 > tp-085 $74 |

**Verdict** : hold intégral optimal ; TP disponible mais déconseillé (off) ;
`dipRevertMaxElapsedSec=420` dans le preset (+10 % PnL, −19 % d'exposition).
Leçon majeure : une sortie pricée sur le favori *courant* alors qu'on détient
l'autre token fabrique des gains impossibles — toujours pricer sur le carnet
du token détenu.

## 📁 momentum/ — probes mean-reversion / scalping

Scripts : `scripts/research/mean-rev-probes/*.mjs`

| Fichier | Contenu |
|---|---|
| `explore-momentum-…json` | Exploration momentum intra-fenêtre (favori, lookback, win rates conditionnels) |
| `validate-meanrev-…json` | Signal mean-rev brut : mainSignal **WR 48.3 %** (147 fenêtres) — l'edge n'apparaît qu'avec le filtre dip+rebond |
| `measure-scalp-…json` | Scalping cheap (dip-buy + TP) : EV/share **négatif** sur les configs testées |
| `measure-scalp-tpsl-…json` | Scalping TP+SL : 60 variantes, toutes **EV ≤ −0.41¢/share** → scalping abandonné |

**Verdict** : ces probes ont **éliminé** momentum pur et scalping ; seul
dip-confirmed a survécu et est devenu dip-revert.

## 📁 compare/ — comparaisons multi-stratégies

Scripts : `scripts/research/compare/{strategy-compare-backtest,long-universe-compare}.mts`

| Fichier | Contenu |
|---|---|
| `strategy-compare-…json` (88 fenêtres) | ask-lock +$4.7 % · **edge-lead +89 %** · barbell-0.5 **+141 %** · reverse **−62 %** |
| `long-universe-compare-…json` (302 fenêtres) | **ask-lock +$11.9 (+16 %)** seul positif ; edge-lead ref −$4.6 ; conservative/coverage-max −$33 ; barbell −$48 |

**Verdict** : les classements s'inversent selon l'univers — d'où l'importance
de comparer sur un univers fixé. Le long-universe (601 ticks) est le plus
représentatif ; ask-lock y est le seul stablement positif.

## 📁 coverage/ — univers de données partagé

Script : `scripts/audit-data-coverage.mts`

| Fichier | Contenu |
|---|---|
| `audit-data-coverage-…json` | Fenêtres complètes (>800 ticks, gaps ≤ 60 s) utilisables comme univers de backtest + stats de couverture par jour/préfixe |

**Usage** : tous les backtests filtrent leur univers avec les mêmes critères ;
ce rapport fait foi pour savoir quelles fenêtres sont exploitables.

---

## Scripts réutilisables (root `scripts/`)

| Script | Rôle |
|---|---|
| `arb-audit-backtest.mts` | Backtest arb générique par preset + overrides (écrit dans `arb/`) |
| `backtest-dip-revert.mts` | Backtest dip-revert base/loose/tight + fav-band ref (écrit dans `dip-revert/`) |
| `audit-data-coverage.mts` | Audit de couverture des données (écrit dans `coverage/`) |
| `audit-data-coverage.mts` + `verify-audit.ts` | Vérification d'un audit |
| `compare-positions.ts`, `diagnose-size.ts` | Outils de diagnostic trades/positions |
| `check-quota.ts`, `redeem-all.ts` | Ops live (quota relayer, redeem) |
| `probe-ask-lock.mts`, `probe-markets.mts` | Probes CLOB / marchés |
| `scripts/research/dip-revert-research/verify-tp.mts` | Garde de régression du wiring take-profit dip-revert |

## Conventions

- Un dossier par stratégie + `coverage/` (partagé) + `compare/` (multi).
- Un run par configuration identique : le **plus récent** est conservé.
- Nommage : `<sujet>-<tag-variantes>-<timestamp>.json` (+ `.md` pour les
  rapports arb-audit). Timestamps = `Date.now()` (ms epoch).
- Les `.log`/`.txt` volumineux sans données signalétiques ne sont pas gardés.