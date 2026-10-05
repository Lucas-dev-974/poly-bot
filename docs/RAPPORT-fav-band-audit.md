# Rapport d'audit — Moteur fav-band

**Date** : 2026-09-19 (UTC) · **Périmètre** : code (`src/strategy/fav-band-strategy.ts` + wiring complet), config/presets, backtests (`audits/backtest/fav-band/`), données live (`data/bot-live.db`, 392 positions), et 2 runs backtest officiels fraîchement exécutés sur l'univers actuel (887 fenêtres complètes).

**Verdict en une phrase** : moteur code-sain (build vert, 432/432 tests, wiring complet, guards corrects), mais la **config live a dérivé hors de la zone backtestée** — bande [0.60, 0.74] jamais gridée, sous-performance mesurée ce jour sur le même univers (+$90 vs +$468 au sizing live ; +$399 vs +$468 à sizing égal), et la journée du 19/09 (−$40 live) est un **régime** que le backtest reproduit (−$29.65), pas un bug.

---

## 1. Architecture & câblage (verdict : complet)

Chaîne vérifiée de bout en bout :

```
findOpportunities (fav-band-strategy.ts)
  ├─ Gate 0  : ≥2 books avec ask (sinon return [])
  ├─ pickEdgeToken : favori = ask le plus HAUT (edge-lead-strategy.ts:39)
  ├─ POST-FILL : si getFilledCheapSizeForPair > 0 → branche hedge-inverse
  │    ├─ anti-restack : getPostedOrdersForPair(pairId,"cheap").length === 0
  │    └─ appendInverse : GTC BUY sur le token OPPOSÉ, limit=favBandInverseAskMax,
  │       size = round2(min(favFilled × ratio, computeSize(budget, limit, maxShares)))
  ├─ Bande   : ask ∈ [favBandAskMin, favBandAskMax]
  ├─ Temps   : elapsed ≥ favBandMinElapsedSec (et ≤ favBandMaxElapsedSec si non-null)
  ├─ Verrou  : countLegsByKind(pairId,"cheap") > 0 → return (1 entrée/fenêtre, DB-backed)
  ├─ Sizing  : computeSize(favBandOrderUsdc, ask, maxSharesPerOrder) → null si < 5 sh
  ├─ Depth   : bestAskSize < size × 0.8 → skip (preflight FOK)
  └─ appendOpportunity(kind="cheap") + force orderType:"FOK"
```

| Couche | État | Preuve |
|---|---|---|
| Registry / ids | ✅ | `registry.ts:22` factory + `ids.ts` STRATEGY_IDS ; `leadsWithEdgeFor` retourne `false` |
| Config (`BotConfig`) | ✅ | 9 clés favBand* avec defaults (`config.ts:393`) |
| Validation | ✅ | `validateConfigCoherence` : bande ordonnée, budget ≥ 5 sh au pire prix (leçon incident 09-14), inverse (0,0.5), `maxOpenPositionsPerSide ≥ 2` si inverse, coercition sticky `arbAskLockOnly/enableExpensiveHedge` |
| Runtime settings | ✅ | 9 clés dans `EDITABLE_CONFIG_KEYS` + aliases env + `parseField` + `FAV_BAND_KEYS`/`keysForStrategy` (hot-apply PATCH complet) |
| Executor | ✅ | kind `cheap` → jamais de gates hedge arb ; `orderTypeFor` honore l'override FOK |
| Resting | ✅ | `cheapOrderAction` → `"keep"` (jamais annulé, fills incrémentaux, close de fenêtre droppe le reste) |
| Tests | ✅ 16/16 | `tests/fav-band.test.ts` (⚠️ mais absent du script `npm test` — cf. F4) |
| Presets | ✅ | `fav-band` / `fav-band-opt` / `fav-band-opt-risk`, testés par `presets.test.ts` |
| Frontend | ✅ | types, configForm (59 refs), SettingsModal (section « Entrée fav-band »), ConfigBar, strategyPresets |
| Guide `/guide` | ❌ | `EngineId` (guide/data.ts:2) n'inclut pas fav-band — le moteur est absent de la page pédagogique (cf. F5) |

**Sizing inverse — nuance de code (F6)** : `favFilled = getFilledCheapSizeForPair` somme **toutes** les jambes cheap fillées de la paire, y compris des fills partiels de l'inverse elle-même. Avec ratio 2, un fill inverse de 20 sh porterait la prochaine émission à min(2×(20+20), caps). borné par `favBandInverseOrderUsdc` et `maxSharesPerOrder` (40), donc sans effet aux configs actuelles — mais sémantiquement le ratio devrait se mesurer sur la jambe favori seule.

---

## 2. Preuves backtest

### 2.1 Grille historique (35 variantes, 313 fenêtres, 2026-09-13 — `fav-band-param-grid-1789338249616.json`)

| Variante | PnL | WR | maxDD | PnL/DD |
|---|---|---|---|---|
| **band-070-085_min200_max600** (→ preset `fav-band-opt`) | **+$298.76 (+398 %)** | 78.3 % | 113.47 | 2.63 |
| band-070-085_min200 (baseline) | +$290.05 (+387 %) | 78.0 % | 113.47 | 2.56 |
| band-068-082_min200 (→ preset `opt-risk`) | +$289.40 | 76.3 % | 108.08 | **2.68** |
| band-070-085_min180 | +$233.77 | 76.8 % | 142.60 | 1.64 |

Points de grille : bandes testées = {0.68–0.82, 0.70–0.85, 0.70–0.80, 0.72–0.88, 0.75–0.85, 0.78–0.90, 0.65–0.80} ; minElapsed ∈ {120…400} ; maxElapsed ∈ {null, 600, 720}. **La bande live [0.60, 0.74] n'a jamais été testée** : aucun plancher < 0.65, aucun plafond < 0.80 dans la grille. (Note : les lignes `size*` de la grille passaient par `cheapOrderUsdc`, clé remplacée par `favBandOrderUsdc` le 09-14 — la grille est antérieure au commit `ec306f9` ; l'edge est inchangé, seule la clé de budget a changé.)

### 2.2 Calibration sim ↔ runner (historique, `research-new-strats/calibration-official-*.json`)

Sonde fav-band : 387 vs 386 fills (±0.26 %), $293 vs $309 — la sim de découverte est calibrée sur le runner officiel.

### 2.3 NOUVEAU — bande live vs preset testé, univers actuel (887 fenêtres complètes, runner officiel, 2026-09-19 — `live-band-vs-tested-1789807900574.json`)

| Config | Fills | WR | PnL | maxDD | PnL/DD |
|---|---|---|---|---|---|
| **LIVE** [0.60–0.74] min200 max600, sizing live (5 sh / expo 15) | 797 | 68.1 % | **+$90.05** | 42.65 | 2.11 |
| LIVE bande, sizing grid (40 sh / expo 40) | 795 | 68.2 % | **+$399.40** | 192.23 | 2.08 |
| **PRESET testé** `fav-band-opt` [0.70–0.85] min200 max600, sizing grid | 856 | **76.2 %** | **+$467.93** | 237.67 | 1.97 |

Lecture honnête : à sizing égal, la bande live fait **−$69 (−15 %)** de PnL absolu et **−8 pts de WR** face au preset testé, mais un PnL/DD légèrement supérieur (2.08 vs 1.97) — c'est une variante défendable, pas une absurdité. Le problème n'est pas qu'elle est mauvaise, c'est qu'elle **n'a jamais été validée** : la zone d'extension [0.60, 0.70) est précisément celle où le live perd (§3.2), et aucun chiffre de grille ne la couvrait avant ce run.

### 2.4 Attribution par jour UTC de la config LIVE (run officiel, `live-band-perday-*.json`)

| Jour | Trades | PnL sim | | Jour | Trades | PnL sim |
|---|---|---|---|---|---|---|
| 09-08 | 43 | +9.80 | | 09-14 | 77 | +1.50 |
| 09-09 | 59 | +10.95 | | 09-15 | 83 | **−25.15** |
| 09-10 | 78 | **−4.80** | | 09-16 | 81 | +19.25 |
| 09-11 | 31 | +4.50 | | 09-17 | 152 | +42.30 |
| 09-12 | 17 | +5.65 | | 09-18 | 84 | +28.05 |
| 09-13 | 63 | +27.65 | | 09-19 | 29 | **−29.65** |

**3 jours rouges dont deux francs (09-15, 09-19) existent aussi en simulation pure** avec la config live → le signal fav-band est un pari de régime : les journées whipsaw le frappent quelle que soit la bande.

---

## 3. Performance live (392 positions, 09-13 → 09-19 — `live-positions-1789807303023.md`)

| Métrique | Valeur | | Métrique | Valeur |
|---|---|---|---|---|
| Closed | 391 (won 221 / lost 96 / sold 74) | | PnL cumulé | **+50.82 USDC** |
| WR strict (won/(won+lost)) | **69.7 %** | | Gain moyen / perte moyenne | +1.75 / −4.01 |
| WR large (sold+ inclus) | 75.4 % | | Profit factor | 1.13 |
| Streaks max | 21 wins / 6 losses | | Meilleur / pire | +4.11 / −9.75 |
| Résolution p50/p95/max | 79 s / 248 s / 4019 s | | Ordres | 383 filled-fok, 91 killed-fok (19 %), 73 sells |

### 3.1 Buckets de prix d'entrée (fillPrice) — le cœur du finding

| Bucket | Trades | Won | PnL |
|---|---|---|---|
| 0.60–0.65 | 31 | 10 (32 %) | **−19.21** |
| 0.65–0.70 | 128 | 57 (45 %) | **−28.68** |
| **Σ zone d'extension [0.60,0.70)** | **159** | **42 %** | **−47.89** |
| 0.70–0.75 | 180 | 123 (68 %) | **+74.35** |
| 0.75–0.80 | 36 | 22 (61 %) | +8.37 |
| 0.80–0.85 | 7 | 5 | +2.60 |

La zone testée historiquement (≥ 0.70) porte tout le PnL (+$85 sur 223 trades) ; l'extension live [0.60, 0.70) en détruit 48 (159 trades à WR 42 %). CI binomiale sur 159 trades à 42 % : [34 %, 50 %] — statistiquement sous le seuil de rentabilité du favori (~1 − prix ≈ 35–40 %), mais l'échantillon reste petit et couplé au régime.

### 3.2 Timing d'entrée

Le bucket 200–300 s (276 trades, −$29.23) est le seul négatif ; les entrées 300–800 s sont toutes positives. Les « entrées > 600 s » du rapport automatique sont un **artefact** : `closePositionManual` réécrit `createdAt` à la fermeture (preuve par jointure orders : le BUY réel est placé/fillé à 202 s, le SELL manuel à 799 s). Seul 1 placement réel > 600 s sur 392 — le gate `favBandMaxElapsedSec=600` tient.

### 3.3 Fills hors bande (46)

Deux mécanismes légaux, pas de bug de gate : (a) fills **sous** le plancher 0.60 (ex. 0.46 du 09-16 08:19Z) = amélioration de prix CLOB / fill sur niveaux profonds lors de l'effondrement du carnet entre l'émission FOK et le match (flip-slippage favorable) ; (b) fills **au-dessus** du plafond 0.74 (0.75–0.85, 43 trades) = **ère de config antérieure** (bande 0.70–0.85 avant le hot-apply — un FOK BUY ne peut jamais remplir au-dessus de son limite). Rejouer la timeline de config par ère plutôt que par bande unique.

### 3.4 Jour rouge 09-19 (−$40.21 live)

Reproduit en sim à −29.65 (même config, univers complet) : l'écart de ~$10 = frictions d'exécution live (flip-slippage défavorable, 91 FOK tués) + fenêtres live hors univers sim. Verdict : **régime whipsaw, pas un bug du moteur** — cohérent avec le max loss streak de 6. Facteur aggravant propre au live : le sizing a été déridé **en séance** (tailles observées 5→7→15 sh ; le JSON ne garde que le dernier PATCH à 5 sh) — les deux pires pertes unitaires (−$9.30/−$9.45, 03:33/03:48Z) tombent pendant ce passage, au plus bas de la bande. Les 73 closes manuels (`manual-close:*`, `shouldDefend`/`defendShares` = 0 dans le moteur) ont sauvé la journée (+$10.50) mais brouillent le signal moteur : le WR « moteur pur » est le strict 69.7 %.

---

## 4. Synthèse des findings

| # | Sévérité | Finding | Action |
|---|---|---|---|
| F1 | 🔴 Majeure | **Dérive de config live** : bande [0.60, 0.74] + max600 jamais backtestée avant ce jour (preset testé = [0.70, 0.85]) ; sous-performance mesurée : −15 % PnL, −8 pts WR à sizing égal | Revenir au preset `fav-band-opt` (hot-apply) **ou** gider l'axe [0.60–0.70] avant de le garder (le run 2.3 en donne déjà la tête de série) |
| F2 | 🟠 Moyenne | La zone d'extension [0.60, 0.70) est PnL-négative en live (−$48, WR 42 %, n=159) ; [0.70, 0.75) porte tout (+$74) | Idem F1 ; si l'objectif est plus de fills, préférer élargir le plafond (0.85) que d'abaisser le plancher |
| F2b | 🟠 Moyenne | Sizing déridé **en séance** le 09-19 : tailles 5→7→15 sh observées alors que `bot-settings.json` ne garde que le dernier PATCH (5 sh) — les 2 pires pertes unitaires (−$9.30/−$9.45) tombent pendant ce déridage, au plus bas de la bande, au moment du whipsaw | Figer le sizing ; toute montée doit passer par la grille AVANT hot-apply (les 73 closes manuels ont sauvé la journée : +$10.50, mais ils brouillent le signal moteur) |
| F3 | 🟠 Moyenne | Journées rouges structurelles (09-10, 09-15, 09-19 en sim ; 09-19 en live) — pari de régime, pas de défaut moteur | Sizing est le seul levier non destructeur (leçon dip-revert : exits/hedge dégradent tous) ; ne pas « réparer » un jour rouge par un paramètre |
| F4 | 🟡 Mineure | `tests/fav-band.test.ts` absent du script `npm test` (16 tests ne tournent que manuellement) | Ajouter le fichier au script `test` (1 ligne, package.json via round-trip JSON) |
| F5 | 🟡 Mineure | Page guide `/guide` : fav-band absent d'`EngineId`/`ENGINE_META` (règle strategy-guide-sync) | Carte dédiée (frontend guide : data.ts + GuideTabs + pill/story) |
| F6 | 🟢 Basse | Sizing inverse = ratio × (somme des cheap fillées, inverse inclus) — cumulatif par construction | Borner le ratio à la jambe favori (`getFilledSizeForPair(pairId,"cheap")` filtrée) ; sans urgence (caps budget/maxShares) |
| F7 | ⚪ Info | `closePositionManual` réécrit `createdAt` → les buckets d'elapsed du rapport live surestiment les entrées tardives (23/24 artifacts) | Utiliser `orders.ts` (placement) pour le timing d'entrée des positions sold |
| F8 | ⚪ Info | 19 % de FOK tués (91/474) = friction de profondeur top-of-book normale ; retry tick suivant fonctionne (1 seul abandon implicite) | Rien — c'est le coût d'un pipeline FOK pur |
| F9 | ⚪ Info | `bot-settings.json` = dernier PATCH uniquement ; les fills trahissent 2 ères de bande (0.70–0.85 puis 0.60–0.74) | Ne jamais dater une config live par le JSON — passer par les fills (déjà fait ici) |

**Zones vérifiées saines** : pas de fuite de comportement arb (hedges/FOK dual jamais armés, `hedgeAtPostTime` → skip, coercitions sticky) ; verrou une-entrée-par-fenêtre DB-backed (re-survit au restart tsx watch) ; depth preflight 0.8× ; `computeSize` + `validateEngineBudget` empêchent le mutisme de sizing (incident 09-14 couvert par test) ; anti-restack inverse testé sur 4 états de book ; GTC inverse jamais annulée + expiry couverte par le path stale commun.

---

## 5. Recommandations (chiffrées)

1. **R1 — Aligner la config live sur un preset backtesté** (hot-apply, aucun code) : `fav-band-opt` (0.70–0.85, min200, max600). Sur l'univers actuel : +$468 / WR 76.2 % vs +$90 / WR 68.1 % au sizing live. Alternative défendable si l'objectif est le drawdown : garder [0.60, 0.74] mais en le traitant comme une variante à part entière (PnL/DD 2.11 à sizing live), et la grider proprement.
2. **R2 — Sizing** : 5 sh live = risque minimal (worst −$5/trade, maxDD 43 en sim). Monter à 10–15 sh multiplie PnL et DD par ~2.5–3 à PnL/DD constant (grille : size5 +$98/DD 38 vs size15 +$290/DD 113) — choix de risque, pas d'EV.
3. **R3 —** Ajouter `tests/fav-band.test.ts` au script `npm test` (fix 1 ligne).
4. **R4 —** Carte enfant : page guide fav-band (`frontend/src/guide/*`) + éventuellement borne du ratio inverse sur la jambe favori (F5/F6).
5. **R5 —** Ne PAS ajouter d'exit/stop/TP à fav-band : toutes les axes de sortie testés sur les moteurs directionnels dégradent le PnL (dip-revert : 7 axes morts) ; la sortie par résolution est optimale pour ce type de signal. Re-auditer à ~30–40 trades clos après tout changement de config (CI binomiale).

## 6. Artefacts & reproductibilité

- Code : `src/strategy/fav-band-strategy.ts`, `src/strategy/edge-lead-strategy.ts` (helpers), `src/config.ts:637-697`, `src/runtime-settings.ts`, `tests/fav-band.test.ts`
- Grille : `audits/backtest/fav-band/fav-band-param-grid-1789338249616.json` (script `scripts/research/fav-band/fav-band-param-grid.mts`)
- **Nouveaux runs (ce jour)** : `audits/backtest/fav-band/live-band-vs-tested-1789807900574.json` et `live-band-perday-*.json` (scripts réutilisables `scripts/research/fav-band-research/probe-live-band*.mts`, work-DB VACUUM, runner officiel)
- Live : `audits/backtest/fav-band/live-positions-1789807303023.md` (script `scripts/research/fav-band-research/live-positions.mts`, re-jouable à chaud)
- Build `tsc` vert, suite `npm test` 432/432 (hors fav-band, cf. F4), `npx tsx tests/fav-band.test.ts` 16/16.

*Réserves honnêtes : 12 jours d'historique, 2 familles de slugs (BTC/ETH 15m), un seul régime de marché — tout écart de WR/PnL entre variantes est un pari de régime avant d'être une vérité ; les PnL entre rapports ne se somment pas (univers 313 vs 887 fenêtres).*