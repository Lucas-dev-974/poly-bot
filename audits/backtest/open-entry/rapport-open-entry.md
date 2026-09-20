# Open-Entry : entrée dans les premières secondes + SL/TP contextuels (BTC 15m)

Date : 2026-09-19 · DB : `data/bot-live.db` · Univers : 931 fenêtres BTC-updown-15m (11 jours), 730 complètes (801 ticks / gap ≤ 60 s), 724 avec résolution.

## 1. Audit des données (réponse à « audit les données timeframe 15min btc »)

| Métrique | Valeur |
|---|---|
| Fenêtres BTC 15m | 931 (2026-09-08 → 2026-09-19) |
| Complètes (801 ticks, gap ≤ 60 s) | 730 (78.4 %) |
| Incomplètes | 201 (dont 5m : artefact de critère, hors scope) |
| Premier tick deux-côtés quoté | **p50 = 0.51 s**, p90 = 0.93 s (705/724 < 1 s) |
| Somme des asks au 1er tick | p50 = **1.01** (marché ouvert fair — pas d'arbitrage d'ouverture) |
| Spread au 1er tick | p50 = 0.01 (1 tick) |
| Profondeur L1 au 1er tick | p50 ≈ 30 shares |
| Favori émerge (diff ≥ 0.10) | p50 = **6.1 s** (p90 = 53 s) |
| Lean instantané (diff ≥ 0.25 au tick 0.5 s) | **0 occurrence** |

Lecture : une entrée **t≈0 exécutable** existe dans les données, mais **l'information n'y est pas encore** — à t=0.5 s le marché est fair et sans inclinaison mesurable. L'edge d'ouverture vit dans les **premières secondes→minutes** (le favori émerge à ~6 s), pas dans la première seconde.

## 2. Méthode

- Sim de découverte calibrée sur le loader officiel (`scripts/research/open-entry/universe.mts`, book_snapshots, bornes inclusives, résolutions requises), 1 trade/fenêtre, exits pricés sur le carnet du token **tenu** (FOK worst-price, walk bid/bid2/bid3, cap 4 ticks), invariants à chaque run (fills == closes, sum(byDay) == PnL, WR == wins/fills).
- 4 grilles : axes isolés → combos → combo finale → sim **runner-fidèle** (sizing `computeSize(15$/prix, cap 30)`, exits L1-only `requireFullSize` — mécanique exacte de `sellFillAgainstBook`/`executeOpp`).
- verify-claims : réimplémentation indépendante depuis la config → **511/511 fills, 0 mismatch, ΔPnL = 0.00**.
- Calibration runner officiel (early-conviction hold) : sim 418 fills/$1.05-per-fill ↔ runner 485 fills/$0.97-per-fill, WR 65.8 % ↔ 65.6 % (ratio fills = ratio univers 87 %, Δper-fill +8 % = caps capital/exposure non modélisés dans la sim).

## 3. Résultats

Sizing 10 shares (grilles 1-3) puis sizing runner 15 $ (grille 4) :

| Config | fills | WR | PnL | t | PF | DD/vr | old/new |
|---|---|---|---|---|---|---|---|
| HOLD-ref (entrée lean 0.15/90s, exits off) | 438 | 62.1 % | $72 | 0.71 | 1.07 | DD $62 | +76 / −4 |
| + SL struct (flip ≥0.20 ×20s + dégât 0.10) | 438 | 50.2 % | $147 | 1.89 | 1.20 | DD $34 | +102 / +46 |
| + SL tardif (>300s, −0.06) | 438 | 36.8 % | $135 | 2.14 | 1.27 | vr 0.118 | +64 / +72 |
| + TP 0.85 avant 600s | 438 | 68.5 % | **$39** | 0.44 | — | — | mort |
| COMBO win300 + struct + late | 511 | 37.2 % | $203 | **3.08** | 1.37 | DD $34 | +119 / +84 |
| **runner-fidèle : lean + struct+late** | 511 | 37.2 % | **$471** | **2.88** | 1.34 | vr 0.105 | — |
| runner-fidèle : ec hold (moteur natif) | 418 | 65.8 % | $437 | 1.84 | 1.20 | vr 0.086 | — |
| runner-fidèle : ec + SL struct+late | 418 | 38.0 % | $361 | 2.45 | 1.32 | vr 0.101 | — |
| **Runner OFFICIEL ec hold (830 univ)** | 485 | 65.6 % | **$469** | — | — | 0 rejects | — |

Diagnostic exits-off (même fenêtre d'entrée win300) : $151, DD $75 → avec SL : $203, DD $34. **La valeur vient de l'échelle de SL contextuelle**, pas de l'entrée.

### Axes morts (ne pas re-balayer)
- **TP pur** (0.85/0.90 avant 600/720 s) : $24-39 vs ref $72-150 — confirme tous les audits précédents (fav-band, dip-revert : hold to resolution optimal).
- Entrée **instantanée t=0** (lean ≥0.25 au premier tick) : 0 occurrence — l'inclinaison instantanée n'existe pas à l'ouverture.
- Trigger 0.12 isolé : t=0.06. TP même en combo : jamais survivant.

## 4. La stratégie recommandée

```
t=0           t≤300s                 pendant le hold                900s
 |              |                        |                          |
 OUVERT fair    1er tick où le favori    SL struct : l'autre jambe   RESOLUTION
 (askSum        mène de ≥0.15            mène de ≥0.20 depuis ≥20s   (hold)
 ≤1.02)         → FOK buy favori         ET bid tenu ≤ entrée−0.10   payout 1/0
                (retry si kill,          → coupe (L1, au bid)
                jamais bloquer)          SL tardif : >300s et
                                         bid tenu ≤ entrée−0.06
                                         → coupe (L1, au bid)
```

- **Entrée** : momentum d'ouverture — favori (max-ask) avec lead ≥0.15, dans [0, 300 s], marché ouvert fair (askSum ≤ 1.02 au 1er tick), spread ≤ ~0.04, FOK full-depth L1 avec retry.
- **SL contextuel à deux échelles** : précoce = changement structurel (flip adverse confirmé + dégât prix) ; tardif = petit dégât suffit (la thèse a eu 300 s pour se vérifier).
- **Hold to resolution** sinon — le TP pur reste mort à chaque audit de ce repo.

## 5. Verdict d'implémentation

- **La valeur livrable** = early-conviction (moteur natif, $469 runner) **+ politique de sortie contextuelle** — mais attention : sur l'entrée ec à sizing runner, les SL **dégradent** ($361 vs $437) car les marchés déjà unilatéraux à ≤45 s rebondissent après chaque secousse. C'est sur l'**entrée lean** (favori émergent, ≤300 s) que les SL ajoutent (+$120 : $351 → $471).
- Recommandation : **nouveau moteur `open-entry`** (lean + SL dual-scale, hold sinon), pas une modification d'early-conviction (les deux entrées réagissent à l'opposé sur les exits). Wiring complet selon `references/new-strategy-wiring.md` (6 touch-points config + pipeline defend existant — le runner n'a PAS besoin de modification : `shouldDefend/defendShares` reçoit déjà `cheapAsk`/`favoriteAsk`/`nowMs` chaque tick).
- Overlap : open-entry ≈ early-conviction sur l'entrée (478/511 même côté, PnL NON additifs — choisir l'un ou l'autre par marché), disjoint de dip-revert (0).

## Réserves honnêtes
1. 11 jours d'un seul actif = un régime ; les moitiés old/new sont positives sur la combo, mais une seule macro-condensation.
2. t 2.88-3.08 : solide au-delà du seuil, mais le panel reste petit.
3. Exits L1-only (limite du runner) : la valeur live des SL peut être supérieure (profondeur bid2/bid3 ignorée).
4. Sim ≠ runner en magnitude (per-fill +8 %) ; le runner décide, les deltas de classement tiennent.

Scripts : `scripts/research/open-entry/` (universe.mts, probe-open.mts, open-sim.mts, open-grid1..4, verify-and-overlap.mts, recheck-ec-official.mts, ec-hold-ref.mts). Données brutes : `open-entry-research-1789815600000.json`.