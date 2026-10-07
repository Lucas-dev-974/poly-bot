# Fav-band — séries gagnantes (win streaks) par fenêtre horaire — 2026-10-05

Toutes les heures sont en **heure de Paris (CEST, UTC+2)**. Aucun changement d'heure dans les périodes analysées.
Lecture seule sur `data/bot-live.db`. Aucun réglage live modifié.

## 1. Sources de données

| Source | Rôle | Détail |
|---|---|---|
| `sim_positions` (`strategyId='fav-band'`) | **Primaire** — simulation officielle du bot (mode sim, papier) | 540 lignes, du 2026-09-26 07:58 au 2026-10-05 12:33. Filtre : entrées FOK `marketable`, marchés `btc-updown-15m` → **n = 497**. Exclus : 42 entrées sur `btc-updown-5m` (26–28/09, testées en sensibilité) et 1 jambe GTC « resting » à 0,10 (pas une entrée fav-band). |
| `backtest_positions` run `259af8b2…` (2026-09-20, preset fav-band, ask 0,70–0,85, exit activé, whipsaw on) | **Secondaire** — vérification hors période | Jambes fav (fill 0,70–0,85) → n = 512, période 2026-09-08 → 2026-09-20. W/L = signe du PnL (beaucoup de sorties `sold` à petite perte) → baseline WR très différent (41,4 %) ; on ne compare **que les écarts relatifs** par heure. |
| JSON `fav-band-opt-cap50-*.json` | Non utilisé | Résumés agrégés, pas de lignes par trade. |
| `positions` (live) | Non utilisé | Demande = simulation. Déjà analysé dans `patterns/`. |

Définitions : **W** = `pnl > 0`, **L** = `pnl <= 0` (2 positions `sold` en sim, classées par signe). Horodatage = `createdAt` (entrée). Série chronologique unique, une entrée par fenêtre 15m (1 seule fenêtre a 2 entrées). Une « streak » = run maximal de W consécutifs (les trous de sim > 2 h ne coupent **pas** les runs ; 15 trous de 2–4 h et 2 trous ~19–24 h).

Config sim actuelle (snapshot `sim_state.simConfigJson`) : ask 0,67–0,80, minElapsed 200 s, 15 USDC/ordre, exit off, whipsaw off. **Attention** : le sizing a changé le 2026-10-01 (≈5 parts / ≈3,7 USDC avant → 15 USDC après) ; l'historique de config sim n'est pas versionné en DB.

## 2. Baseline (primaire, sim 15m)

- n = **497** trades (350 W / 147 L), **WR = 70,4 %** (IC95 Wilson 66,3–74,3 %), 10 jours calendaires.
- PnL total = **−73,26 USDC** malgré 70 % WR : gain moyen +4,30, perte moyenne −10,73 → WR de break-even ≈ **71,4 %** (moyenne mélangeant les deux régimes de sizing).
- **Test des runs (Wald-Wolfowitz)** : 185 runs observés vs 208 attendus si i.i.d. → z = −2,48, **p = 0,013** → W et L sont **groupés dans le temps** (effet régime de marché). Longueur moyenne des runs W = 3,76 vs 3,38 attendu.
- Sensibilité 15m+5m (n = 539) : même conclusion (WR 70,9 %, runs z = −3,09, p = 0,002).
- Secondaire backtest : **aucune** dépendance sérielle (z = +0,23, p = 0,82).

## 3. Streaks gagnantes

- Streaks ≥ 2 : **67** ; ≥ 3 : 53 ; ≥ 5 : 26. Distribution : 1:26, 2:14, 3:13, 4:14, 5:5, 6:6, 7:5, 8:3, 9:3, 10:2, 17:2.
- **Plus longues** (primaire) :

| Long. | Début | Fin | Jour | Durée | PnL |
|---|---|---|---|---|---|
| 17 | 2026-09-27 16:03 | 2026-09-27 21:09 | Dim | 5,1 h | +23,65 |
| 17 | 2026-09-29 06:33 | 2026-09-29 13:49 | Mar | 7,3 h | +24,70 |
| 10 | 2026-09-28 19:48 | 2026-09-28 22:19 | Lun | 2,5 h | +14,60 |
| 10 | 2026-10-02 08:50 | 2026-10-02 11:22 | Ven | 2,5 h | +63,86 |
| 9 | 2026-09-26 15:22 | 2026-09-26 17:20 | Sam | 2,0 h | +13,60 |
| 9 | 2026-10-03 17:20 | 2026-10-03 19:18 | Sam | 2,0 h | +57,19 |
| 9 | 2026-10-05 10:34 | 2026-10-05 12:33 | Lun | 2,0 h | +50,75 |

- Sensibilité 15m+5m : record = **19** (2026-09-27 17:06 → 21:09).
- La plus longue streak (17) **n'est pas anormale** sous permutation (p global = 0,29 ; 95e centile nul = 22).
- Plus longues séries perdantes : 4 (×4). **3 des 4 commencent à 02h** : 29/09 02:06, 30/09 02:03, 04/10 02:20 (+ 29/09 15:03).
- Heure de début des 26 streaks ≥ 5 : 22h (4), 06h (3), 09h (3), 14h/16h/19h (2 chacune)… **Aucune** streak ≥ 5 ne passe par 01h, 02h ou 05h.
- Part des trades appartenant à une streak ≥ 5 : **00h–06h = 9,6 %** (n = 115, WR 63,5 %, PnL −107,35) vs **06h–24h = 49,7 %** (n = 382, WR 72,5 %, PnL +34,09) ; **22h–24h = 75 %** (n = 40, WR 82,5 %, PnL +95,52). Descriptif, non testé formellement.

## 4. Fenêtres horaires (primaire)

Colonnes : n, WR, IC95, lift vs baseline (pp), p binomial exact vs 70,4 %, q BH (FDR sur la famille du tableau), part des trades dans une streak ≥ 2.

### Heures notables (24 bins d'1 h, n = 17–26 par heure, 5–8 jours distincts)

| Heure | n | WR | IC95 | Lift | p | q BH | %streak≥2 | PnL | Jours |
|---|---|---|---|---|---|---|---|---|---|
| **23h–00h** | 21 | **95,2 %** | 77,3–99,2 | +24,8 | 0,008 | 0,10 | 95 % | +91,17 | 6 |
| 07h–08h | 20 | 90,0 % | 69,9–97,2 | +19,6 | 0,082 | 0,55 | 80 % | +44,94 | 6 |
| 20h–21h | 21 | 85,7 % | 65,4–95,0 | +15,3 | 0,15 | 0,62 | 76 % | +18,89 | 6 |
| 03h–04h | 17 | 82,4 % | 59,0–93,8 | +11,9 | 0,43 | 0,85 | 82 % | +38,51 | 5 |
| **02h–03h** | 18 | **27,8 %** | 12,5–50,9 | **−42,6** | **0,0002** | **0,005** | 28 % | −73,47 | 6 |
| 06h–07h | 21 | 52,4 % | 32,4–71,7 | −18,0 | 0,092 | 0,55 | 43 % | −71,26 | 7 |
| 21h–22h | 25 | 56,0 % | 37,1–73,3 | −14,4 | 0,13 | 0,61 | 56 % | −27,84 | 7 |

### Bins 2 h (12 bins alignés)
Meilleur : **22h–00h** n = 40, WR 82,5 % (68,0–91,3), +12,1 pp, p = 0,12, q = 0,71, PnL +95,52. Pire : **02h–04h** n = 35, WR 54,3 %, −16,1 pp, p = 0,042, q = 0,51. Les 10 autres : 64,9–75,6 %, tous p > 0,47.

### Bins 3 h (8 alignés + 24 glissants)
Meilleure fenêtre glissante : **23h–02h** n = 64, WR 78,1 % (66,6–86,5), +7,7 pp, p = 0,22 ; 09h–12h 77,1 % ; 07h–10h 77,3 %. Pire : **00h–03h** 57,4 % (p = 0,034, q = 0,27, PnL −123,36) et **02h–05h** 56,6 % (p = 0,034).
→ La fenêtre « 2h–5h » prise en exemple est en réalité la **plus faible** de la sim, pas un cluster de streaks.

### Jour de semaine
WR de 69,2 % à 72,7 % pour les 7 jours, tous p > 0,75. **Rien** — et chaque jour ne couvre que 1–2 dates, donc non interprétable.

## 5. Contrôle multiple-testing (permutations, B = 5000, labels W/L mélangés, horodatages fixes)

| Statistique | Observé | p global | Lecture |
|---|---|---|---|
| WR max sur 24 heures (n ≥ 10) | 95,2 % (23h) | **0,049** | limite ; à peine au seuil de 5 % |
| WR **min** sur 24 heures | 27,8 % (02h) | **0,0008** | robuste au balayage des 24 heures |
| WR max sur fenêtres 3 h glissantes | 78,1 % (23h–02h) | 0,81 | **aucun** cluster 3 h significatif |
| Part max de trades en streak ≥ 2 (3 h glissant) | 73,4 % | 0,90 | aucune densité de streaks anormale |
| Plus longue streak W | 17 | 0,29 | normale vu WR 70 % |

## 6. Vérification hors période (backtest 259af8b2, 08–20/09)

- **02h–03h** : 4/20 = 20,0 % vs baseline 41,4 % → test unilatéral pré-spécifié (« plus bas ») **p = 0,039**. 0 streak ≥ 2 démarrée à 02h ; bin 2 h 02h–04h = 23,5 % (le pire des 12). Par jour : 0/2, 0/3, 0/1, 0/3, 0/2, 2/4, 2/5. **Même direction que la sim → seul effet qui se réplique.**
- **23h–00h** : 12/28 = 42,9 % vs 41,4 % → p = 0,51. **Ne se réplique pas.**
- Sim 02h par jour : 28/09 0/2, 29/09 0/3, 30/09 0/3, 02/10 2/2, 04/10 1/4, 05/10 2/4 → les 8 premières entrées de 02h sont toutes perdues ; plus mitigé depuis le 01/10.
- Sim 23h par jour : 4/4, 1/1, 4/4, 4/4, 3/4, 4/4 (6 jours, régulier mais petit n).
- Stabilité : classement des 8 bins 3 h avant/après 01/10 → Spearman = −0,50 (p = 0,21) : **le classement 3 h n'est pas stable** entre les deux moitiés.

## 7. Conclusions

1. **Pas de fenêtre horaire « à streaks » robuste.** Les W sont bien groupés dans le temps (runs test p = 0,013), mais ces séries suivent des **régimes de marché** à différents moments de la journée, pas une heure fixe : aucun bin 2–3 h ne sort du bruit après correction (p global 0,81 / 0,90).
2. **Candidat positif faible : 23h–00h** (20/21, q BH = 0,10, p permutation 0,049) — 6 jours seulement, **non répliqué** sur le backtest. À surveiller, pas à exploiter.
3. **Signal le plus solide = anti-fenêtre 02h–03h Paris** (= 00h UTC, rollover du jour UTC) : 27,8 % WR, q = 0,005, p permutation 0,0008, et **même direction** sur le backtest indépendant (20 %, p = 0,039). Ça porte 3 des 4 plus longues séries perdantes. Plus largement, 00h–06h a peu de streaks longues (9,6 % des trades en streak ≥ 5 vs 49,7 % le reste du temps).
4. Jour de semaine : rien (et données insuffisantes).

## 8. Caveats

- **Petits n** : 17–26 trades par heure, 5–8 jours distincts. Un IC95 sur un bin fait ±20 pp.
- **Seulement ~10 jours de sim**, avec un changement de sizing le 01/10 et un historique de config non versionné ; la sim n'a pas tourné en continu (17 trous > 2 h), la couverture horaire par jour est donc inégale.
- **Tests multiples** : 24 + 12 + 8 + 24 + 7 bins testés. Seul 02h passe BH ; 23h ne passe pas BH (q = 0,10).
- Le backtest secondaire a des règles différentes (exit, whipsaw, bande 0,70–0,85) et une définition W/L par signe du PnL avec beaucoup de petites sorties perdantes → seulement une vérification de direction, pas des chiffres comparables.
- Les streaks traversent les trous de sim ; les couper aux trous > 2 h raccourcirait certains runs (non fait).
- Mécanismes (rollover UTC à 02h Paris, clôture US ~23h Paris) = **hypothèses**, non testées.
- Aucun de ces résultats n'est un filtre validé ; un éventuel filtre « pas d'entrée 02h–03h » doit passer par un backtest officiel + du forward avant tout changement live.

## 9. Fichiers

- `streaks-time-windows-2026-10-05.json` — tous les chiffres (bins, permutations, streaks, réplications).
- `series-sim-15m.csv` — série W/L chronologique (heure de Paris, longueur de run, appartenance à une streak).
- `streaks-ge5-sim-15m.json` — les 26 streaks ≥ 5.
- `raw-sim-positions-fav-band.json`, `raw-backtest-positions-fav-band.json`, `sim-config-snapshot.json`, `backtest-run-requests.json` — extraits bruts en lecture seule.
- `analyze_streaks.py`, `streaks5.py` — scripts (Python, pandas/scipy).

## Follow-up 2026-10-05 (streaks >=6 / créneaux 100%)

- `RAPPORT-streaks6-allwin-creneaux-2026-10-05.md`
- `streaks-6-and-allwin-slots-2026-10-05.json`
- `analyze_streaks6_allwin.py`
