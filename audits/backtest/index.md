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
| **antiflip-revert** (new) | 393 fenêtres | minElapsed 240s / flip ≤ 90s / déchu 0.35–0.45 | **+$623** | +21 % notional | WR 52.2 %, t-stat 2.7 — favori déchu post-flip |
| **flip-confirm** (new) | 393 fenêtres | entrée [120,180]s post-flip, nouveau fav 0.55–0.65 | **+$389** | +14 % | WR 66.5 %, t-stat 2.4 — retournement médian confirmé |
| **early-conviction** (new) | 393 fenêtres | fav ≥ 0.60 dans les 45 premières s | **+$330** | +10 % | WR 67.6 %, t-stat 1.9 — conviction immédiate |
| **dip-guard** (new, 2026-09-16) | 494 fenêtres | INVERSÉ : favori quand underdog 0.35–0.40, TP 0.85 | **+$434** | +6.0 % notional | WR 75 %, split-half positif — sens user (underdog) mort, miroir positif |
| **open-entry** (implémenté, 2026-09-19) | 724 fenêtres / runner 830 | lean ≥0.15 ≤300s, fair open ≤1.02 ; SL dual-scale (switch) | hold **$365** / SL $330 (runner officiel) | +6 % notional (sim) | hold bat les SL à sizing L1 ; SL = volatilité ↓. Rapport recherche + implémentation dans `open-entry/` |
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

## 📁 model-ia/ — étude de faisabilité modèle IA (2026-09-16)

Scripts : `scripts/research/ml-feasibility/` (probe-dataset, probe-universe)

| Fichier | Contenu | Résultat |
|---|---|---|
| `model-ia/RAPPORT-ml-feasibility.md` | Faisabilité d'un modèle IA (liquidité, prix, patterns, outcome) sur données enregistrées | **Faisable** : 655 fenêtres, 510 complètes+résolues, équilibre 320/331, ~14 features carnet/tick. Marché en cours ✅, prochain marché ⚠️. Baseline à battre = calibration de l'ask. ≈ 2 sessions. |
| `model-ia/SPEC-next-market.md` | Spécification modèle IA « next-market » (prédiction outcome du prochain marché, features trans-fenêtres, logistique TS pur, walk-forward par jour, 5 gates GO/NO-GO, collecte 4 semaines) | **Spec v1 prête** : n requis mesuré (0,53 → n=2173, 0,55 → n=778), collecte ~80 fenêtres/jour, P0 (baselines sur 510 fenêtres) = seule phase non conditionnée. |
| `model-ia/SPEC-patterns.md` | Spécification modèle IA « patterns » (tâche A : patterns intra-marché SAX/shapelets sur prix/liquidité ; tâche B : séquences d'outcome type up>up>down ; découverte non supervisée → confirmation supervisée pooled) | **Spec v1 prête** : probe streaks mesuré (UUU→57,4 % Down n=68, continuité 48,3 % n=644 = hasard ; MDE ±15-17 pts par bucket), critère de redécouverte des 4 moteurs, 6 gates. P0 (découverte sur 510 fenêtres) = 2 sessions. |

---

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
| `live-audit-1789807461060.md` | **Audit positions LIVE** (392 pos., 13→19/09) : WR strict 69.7 %, PnL +$50.82. Finding : config live bande [0.60,0.74] **jamais backtestée** — la zone < 0.70 perd −$47.89 (159 trades) ; jour 09-19 rouge −$40.21 (whipsaw + sizing déridé en séance 7→15 sh) ; flip-slippage FOK confirmé (fill 0.46, outcome favorable) ; 73 closes manuels. Script : `scripts/research/fav-band/live-positions.mts` |

| `live-band-vs-tested-…json` + `live-band-perday-…json` | **Bande LIVE chiffrée sur l'univers ACTUEL** (887 fenêtres, runner officiel, 19/09) : LIVE [0.60-0.74] sizing live (5sh/15exp) **+$90.05 / WR 68.1 % / DD 42.7** ; LIVE à sizing grid +$399.40 / WR 68.2 % ; preset testé 070-085_max600 **+$467.93 / WR 76.2 % / DD 237.7** → la bande live sous-performe de −15 % de PnL et −8 pts WR à sizing égal (PnL/DD comparable 2.08 vs 1.97). Par jour UTC (config live) : jours rouges sim 09-10 (−4.8), 09-15 (−25.2), 09-19 (−29.7) → le whipsaw est un régime, pas un bug. Scripts : `scripts/research/fav-band-research/probe-live-band*.mts` |
| `fav-band-exit-rule-1789883396238.json` + `fav-band-exit-rule-2026-09-20.md` | **Sortie « dégradation » (pics de plus en plus bas)** / 830 fenêtres / runner officiel. Baseline exit OFF **+$420.70 / WR 76 % / DD 246.8**. Config large 0.05/3 pics : **+365.39 / DD 55.62 (−77 %) / PnL/DD 6.57** — le trade-off risque/rendement gagnant. Config intuitive 0.02/2 : **−63.25** (sort sur le bruit du carnet). Switch inverse post-vente : **−65.63** (64 fills, rachète le token qui monte — même verdict que l'étude hedge dip-revert). Loss-only OFF : −60.66. Défauts ship : drop 0.05, 3 pics, lookback 120 s, loss-only ON, **exit OFF** + **switch OFF** par défaut. Script : `scripts/research/fav-band/exit-rule-backtest.mts` |

**Verdict** : fav-band est le 2ᵉ meilleur moteur de l'univers ; bande
0.70–0.85 avec min elapsed 200 s. (Le backtest croisé dip-revert
(`dip-revert-backtest-…json`) donnait fav-band +$205 / WR 76.6 % sur 321
fenêtres — cohérent.) **Live 19/09** : moteur rentable sur 6 jours (5
positifs), mais la config hot-appliquée (bande étendue à 0.60, sizing
déridé) n'a aucun chiffre backtest derrière elle — retour à
band-070-085_min200_max600 recommandé, minElapsed 300 à backtester.
**Rapport d'audit complet (code + wiring + backtest + live + runs du jour)**
: `RAPPORT-fav-band-audit.md` à la racine (findings F1–F9, recommandations R1–R5
; note : `tests/fav-band.test.ts` absent du script `npm test`).
**Sortie dégradation (2026-09-20, implémentée)** : la règle « pics de plus en
plus bas » est câblée full-stack (config/runtime-settings/stratégie/UI dialog +
preset run) derrière `favBandExitEnabled` (OFF par défaut). Ne l'activer qu'en
0.05/3 : le seuil fin (2¢/2 pics) sort sur le bruit et détruit le PnL ; le
switch inverse est confirmé destructeur (gardé OFF).

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

## 📁 antiflip-revert/ — favori déchu après flip récent (2026-09-15)

Scripts : `scripts/research/antiflip-revert/` (discovery rounds 1–4, verify-claims)

| Fichier | Contenu |
|---|---|
| `antiflip-revert-2026-09-15.md` | Rapport : **+$623** (WR 52.2 %, t 2.74), contrôle causal (sans flip +$147 / flip récent +$623), split-half OLD +$380 / NEW +$242, robustesse tie-break (hystérésis +$651), profil d'entrée par elapsed |
| `strat-antiflip-revert-…json` | Résultat final + config (minElapsed 240s, flip ≤ 90s, déchu 0.35–0.45 floor 0.40) |
| `discovery-sim…json` (4 rounds) | Création du signal + sculpting + contrôles causaux |
| `verify-claims-…json` | Contre-vérification indépendante + test tie-break/hystérésis |

## 📁 flip-confirm/ — retournement confirmé, entrée [120,180]s (2026-09-15)

Scripts : `scripts/research/flip-confirm/` (discovery rounds 3 & 6)

| Fichier | Contenu |
|---|---|
| `flip-confirm-2026-09-15.md` | Rapport : **+$389** (WR 66.5 %, t 2.44), split-half OLD +$259 / NEW +$130, hystérésis +$404 |
| `strat-flip-confirm-…json` | Résultat final + config (entrée [120,180]s post-flip, nouveau fav 0.55–0.65) |
| `discovery-sim3/6-…json` | Création + fenêtrage (hors [120,180] : m180 −$227, m240 −$652) |

## 📁 early-conviction/ — conviction immédiate ≤ 45s (2026-09-15)

Scripts : `scripts/research/early-conviction/` (discovery rounds 2 & 4)

| Fichier | Contenu |
|---|---|
| `early-conviction-2026-09-15.md` | Rapport : **+$330** (WR 67.6 %, t 1.93 — sous le seuil 2.0), split-half OLD +$96 / NEW +$235, DD $82 le plus bas |
| `strat-early-conviction-…json` | Résultat final + config (fav ≥ 0.60 ≤ 0.80 dans les 45 premières s) |
| `discovery-sim2/4-…json` | Création + sculpting de la bande/seuil |

## 📁 dip-guard/ — underdog 0.30–0.40 + stop/trailing (2026-09-16, INVERSÉ POSITIF)

Scripts : `scripts/research/dip-guard/` (universe.mts étendu côté BID + dip-guard-sim.mts)

| Fichier | Contenu |
|---|---|
| `dip-guard-2026-09-16.md` | Round 1 : entrée underdog ask 0.30–0.40 ≤ 300s, stop bid ≤ 0.20, trailing armé à 0.50 → **−$457 base** (WR 33 %), HOLD-ref −$664, 16/16 configs négatives |
| `dip-guard-optim-2026-09-16.md` | Round 2 optimisation : axe par axe (timing, favMax, TP, **direction inversée**) → le miroir **acheter le favori quand l'underdog cote 0.35–0.40** fait **+$434 (WR 75 %, DD $82)** avec TP 0.85, split-half OLD +$272 / NEW +$161 |
| `dip-guard-sim-…json` | Round 1 : grille 16 configs · Round 2 : grille 34 configs + split-half |

**Verdict round 2** : le signal user (acheter l'underdog) est mort confirmé
(29 configs négatives) ; son miroir inversé est un candidat sérieux
(+6.0 % du notional, EV +3.8¢/share, 7 j positifs / 9). Stops destructeurs
sur la jambe favori ; TP 0.85 = meilleur exit (DD −55 % vs hold). Avant
implémentation : verify-claims indépendant + overlap vs antiflip-revert
(familles proches) + calibration runner officiel.

### Round 3 — validation (2026-09-16) : `dip-guard-validation-2026-09-16.md`

Les 3 contrôles passés : verify-claims indépendant **MATCH exact** (3/3
configs, t-stat empirique **2.17**), overlap quantifié (48–59 % fenêtres
partagées avec les 3 stratégies retenues — **PnL non additifs**,
early-conviction quasi-doublon 96 % même côté, antiflip 121 opposés),
calibration runner officiel **0 % drift** (fav-band sonde 487/487 fills,
$117.84 vs $117.24). PnL/notional corrigé : **+60 %**. Le miroir inversé
est **validé** — décision suivante : implémentation moteur OU confrontation
multi-moteurs avec antiflip-revert (dip-guard a le meilleur PnL %/dollar,
antiflip le PnL absolu max).

## 📁 open-entry/ — entrée premières secondes + SL contextuels (recherche, 2026-09-19)

Scripts : `scripts/research/open-entry/` (universe.mts, probe-open.mts, open-sim.mts,
open-grid1..4, verify-and-overlap.mts, recheck-ec-official.mts, ec-hold-ref.mts)

| Fichier | Contenu |
|---|---|
| `rapport-open-entry.md` | **Rapport complet** : audit données (premier tick deux-côtés p50 0.51 s, marché ouvert fair p50 1.01, lean instantané 0 occurrence) + 4 grilles + verify-claims (511/511 exact) + calibration runner officiel (ec hold 485 fills / $469 / WR 65.6 % ↔ sim 418/$1.05-per-fill/WR 65.8 %) + overlap (≈ early-conviction 478/511 même côté, disjoint dip-revert 0) |
| `open-entry-research-…json` | Données brutes des grilles (g1-g4), calibration, overlap, verdict |
| `ec-recheck-official-…json` | Run runner officiel early-conviction hold (830 fenêtres, 0 rejects) — ancrage de calibration |

**Verdict** : la valeur d'ouverture n'est pas dans la première seconde (marché
fair, pas d'inclinaison instantanée) mais dans le **favori émergent** (diff
≥0.15 atteinte à p50 6 s). Meilleur candidat sim runner-fidèle : **lean +
SL struct (flip ≥0.20 ×20s + dégât 0.10) + SL tardif (>300s, −0.06) = +$471,
t 2.88, vr 0.105, old/new positifs tous deux** ; le hold nu = $351 (la valeur
vient de l'échelle de SL, pas de l'entrée). TP pur re-confirmé mort ($24-39).
Sur l'entrée early-conviction native à sizing runner, les SL **dégradent**
($361 vs $437 hold) → **ne pas brancher les SL sur early-conviction** ;
candidat = nouveau moteur `open-entry` (lean), PnL NON additifs avec
early-conviction. Univers 724 fenêtres = 11 jours d'un seul actif (un régime).

### Implémentation moteur (2026-09-19) : `IMPLEMENTATION-open-entry.md`

Moteur natif `open-entry` livré de bout en bout (backend + frontend + guide +
preset + 16 tests + **panneau preset backtest** : onglets Entrée/SL dédiés,
ConfigBar résumé lean/fair/SL). Fair gate mémorisée au 1er tick deux-côtés
(fix de dilution : 827 fills → 555). Validation runner officielle avec
contrôle exits-OFF via `openEntrySlEnabled` : **hold $365.22 (WR 63.4 %) >
SL ON $329.73 (WR 34.6 %)** — à sizing runner (exits L1-only au bid), les
SL coûtent de l'espérance ; leur valeur = volatilité (lissée) + profondeur
L2/L3 que le runner ne peut pas vendre. Switch laissé à l'utilisateur
(défaut ON = config backtestée). Overlap early-conviction 478/511 même
côté — PnL non additifs, un seul des deux par marché. Builds backend
448/448 + frontend verts, `<Show>` balancés 37/37, 21/21 et 34/34.

## 📁 research-new-strats/ — travail transverse (3 stratégies, 2026-09-15)

Scripts : `scripts/research/research-new-strats/` (univers partagé `universe.mts`,
sims `discovery-sim*.mts`, sim finale `final-sim.mts`, calibration runner
`calibrate-official.mts`, rapport `write-report.mts`, overlap-check.mts)

| Fichier | Contenu |
|---|---|
| `new-strategies-report-…json/.md` | **Rapport consolidé** des 3 stratégies : antiflip-revert **+$623** (WR 52.2 %), flip-confirm **+$389** (WR 66.5 %), early-conviction **+$330** (WR 67.6 %) ; axes morts documentés (cheap-leader, late-lock, lotto, whipsaw, winstreak, fav-streak dominé) |
| `calibration-official-…json` | Sonde fav-band sim vs runner officiel sur le même univers : 387 vs 386 fills, $293 vs $309, WR 77.3 % vs 77.5 % — la sim est calibrée (écart 0.26 % fills) |
| `final-sim-…json` | Run final des 3 stratégies sur univers aligné officiel + split-half OLD/NEW (toutes positives des deux côtés) |
| `discovery-sim…-…json` (6 rounds) | Discovery rounds 1–6 (copiés par stratégie dans leurs dossiers) |
| `calibration-analysis-…json` | Cartographie de miscalibration per-tick (repère : recent-flip WR 49.7 %, stable 75.7 %) — attention chiffres per-tick gonflés, usage découverte uniquement |

**Verdict** : 3 signaux directionnels hold-to-resolution survivent aux contrôles
causaux, au split-half, à la contre-vérification indépendante et au test de
tie-break/hystérésis ; calibrés contre le runner officiel. Chevauchement
antiflip↔flip-confirm = 129 fenêtres communes — ne pas additionner les PnL.
Implémentation en moteurs natifs = wiring complet (cf. skill `new-strategy-wiring`).

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
| `scripts/research/dip-revert-research/live-positions.mts` | Positions LIVE dip-revert : winrate, PnL, streaks (lit bot-live.db) |
| `scripts/backtest-dip-revert-axes.mts` | Validation runner officiel des axes d'entrée dip-revert (écrit dans `dip-revert/`) |
| `scripts/research/dip-revert-research/dip-hedge-sim.mts` | Hedge jambe inverse dip-revert : post/free/stop/parité (écrit dans `dip-revert/`) |
| `scripts/research/research-new-strats/final-sim.mts` | Sim finale des 3 nouvelles stratégies + split-half (écrit dans `research-new-strats/`) |
| `scripts/research/research-new-strats/write-report.mts` | Rapport assemblé des 3 nouvelles stratégies (JSON+MD dans `research-new-strats/`) |
| `scripts/research/research-new-strats/calibrate-official.mts` | Calibration sim ↔ runner officiel (sonde fav-band, work-DB VACUUM INTO) |
| `scripts/research/research-new-strats/overlap-check.mts` | Chevauchement fenêtres/côtés entre les 3 stratégies |
| `scripts/research/antiflip-revert/` | Scripts antiflip (discovery 1–4 + verify-claims) → écrit dans `antiflip-revert/` |
| `scripts/research/flip-confirm/` | Scripts flip-confirm (discovery 3 & 6) → écrit dans `flip-confirm/` |
| `scripts/research/early-conviction/` | Scripts early-conviction (discovery 2 & 4) → écrit dans `early-conviction/` |
| `scripts/research/dip-guard/{dip-guard-sim,verify-claims,overlap-check,calibrate-official}.mts` | Dip-guard : discovery+optimisation (34 configs + split-half), contre-vérification indépendante, overlap multi-stratégies, calibration runner officiel (sonde fav-band) → écrit dans `dip-guard/` |
| `scripts/research/open-entry/*.mts` | Open-entry : probe premières secondes, sim de découverte (1 trade/fenêtre, exits sur le carnet tenu), grilles 1-4 (calibrée runner), verify-claims + overlap, recheck runner officiel early-conviction → écrit dans `open-entry/` |

## Conventions

- Un dossier par stratégie + `coverage/` (partagé) + `compare/` (multi).
- Un run par configuration identique : le **plus récent** est conservé.
- Nommage : `<sujet>-<tag-variantes>-<timestamp>.json` (+ `.md` pour les
  rapports arb-audit). Timestamps = `Date.now()` (ms epoch).
- Les `.log`/`.txt` volumineux sans données signalétiques ne sont pas gardés.