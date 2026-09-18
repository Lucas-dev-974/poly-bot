# Dip-guard — rapport d'OPTIMISATION (2026-09-16, round 2)

> **Statut : AXE RETOURNÉ — la version inversée est positive et robuste.**
> La stratégie demandée (acheter l'underdog 0.30–0.40) reste négative, mais
> son miroir exact — **acheter le FAVORI quand l'underdog cote 0.35–0.40** —
> fait **+$437 (WR 75 %, DD $78)** avec le take-profit 0.85, et **+$405–443
> en hold pur**. Split-half positif des deux côtés (OLD +$272 / NEW +$161).
> Le trigger utilisateur est conservé : c'est l'underdog 0.30–0.40 qui
> *détecte* le trade ; c'est le sens du trade qui change.

---

## 1. Méthode (skill : un axe à la fois, base incluse, hold-ref)

Univers identique au round 1 : 494 fenêtres official-aligned
(801+ ticks / gaps ≤ 60 s), 2026-09-08 → 2026-09-16, sim tick-lecture,
exits pricés sur le carnet du token détenu (walk 3 niveaux, slippage
cap 2 ticks), 1 entrée/fenêtre. Invariants `fills == closed == stop+trail+hold`
vérifiés à chaque run. Axes mesurés morts au round 1 NON re-balayés :
stop 0.15, trail 0.10/0.30, arm 0.45/0.55, band 0.28–0.42 / 0.35–0.40
(côté underdog), entry 180s/420s, stopWindow 120s.

Nouveaux axes round 2 : minElapsed, filtre favori (`favMax`), take-profit
discret (`tpBid`), direction inversée (`invert`).

## 2. Résultats par axe (sens d'origine : acheter l'underdog)

| Axe | Meilleur | PnL | Verdict |
|---|---|---:|---|
| timing (minElapsed 60/120/180) | 120 s | −$352 | améliore (+$105 vs base) mais reste négatif — l'entrée tardive évite les faux dips, pas l'edge |
| contexte favori (favMax 0.55/0.60/0.65) | 0.65 | −$461 | inopérant (0.55–0.60 = quasi aucun trade : l'underdog 0.30–0.40 implique un favori > 0.60) |
| TP discret 0.45/0.50/0.55 | 0.50 | −$503 | pire que le trailing — vende trop tôt les trades qui allaient gagner |
| stop 0.10 | — | −$620 | plus profond = pire (le crash underdog va rarement rebondir) |
| **tous** | — | **négatif** | le signal d'entrée underdog n'a pas d'espérance, confirmer round 1 |

## 3. LA DÉCOUVERTE — direction inversée (acheter le favori)

Trigger inchangé : un token cote ask 0.30–0.40 dans les 5 premières
minutes. On achète **l'autre jambe** (le favori, ask ≈ 0.62 en moyenne).

| Config (invert) | Fills | WR | PnL | maxDD | PnL/DD |
|---|---:|---:|---:|---:|---:|
| INVERT hold (aucun exit) | 486 | 66 % | +$404.76 | 175 | 2.31 |
| **INVERT d35-40 + tp0.85** | 482 | **75 %** | **+$436.70** | **78** | **5.59** |
| INVERT d35-40 hold | 482 | 67 % | +$435.98 | 172 | 2.53 |
| INVERT fav≤0.65 hold | 478 | 66 % | +$443.34 | 172 | 2.58 |
| INVERT tp0.85 only | 486 | 76 % | +$435.62 | 77 | 5.66 |
| INVERT d35-40 fav≤0.65 tp0.85 (BEST) | 478 | 75 % | +$433.57 | 82 | 5.28 |
| INVERT tp0.80 only | 486 | 77 % | +$241.49 | 102 | 2.37 |
| INVERT stop0.70 + tp0.80 | 486 | 86 % | +$186.37 | 60 | 3.11 |
| INVERT stop0.65/0.60 (round 1) | 486 | — | +$132–175 | 60–73 | stop sec dégrade le PnL ×2.5 |

Stats BEST combo : avgEntry **0.622**, avgWin +$6.12 / avgLoss −$15
(les pertes = les rares holds qui vont à résolution perdante),
EV **+3.8¢/share**, notional $7 230.

### Par jour (BEST, 9 jours)

```
09-08  +72.95   ████████
09-09 +104.20   ███████████
09-10  +37.14   ████
09-11   -1.45   (plat)
09-12  +12.01   █
09-13 +134.83   ███████████████
09-14  +54.46   ██████
09-15  +40.00   ████
09-16  -17.44   ██
→ 7 jours positifs / 9, max perte journalière $17.44 (vs −$223 hold underdog)
```

### Split-half temporel (frontière 2026-09-13 07:45 UTC)

| Demi | Fills | PnL |
|---|---:|---:|
| OLD (≤ 09-13) | 237 | **+$272.08** |
| NEW (> 09-13) | 241 | **+$161.49** |

Les deux moitiés sont positives : le signal ne dépend pas d'un régime
unique (contrôle passé par toutes les stratégies retenues du repo).

## 4. Axes mesurés sur la variante inversée (pour les prochaines passes)

- **Bande de détection underdog** : 0.35–0.40 ≫ 0.30–0.35 (+$436 vs +$24)
  et ≫ 0.28–0.42 (+$149). L'edge se concentre quand l'underdog est à
  35–40c — un favori qui ne domine qu'à ~60/65 % — pas sur les underdogs
  profonds (30–35c).
- **Take-profit 0.85 = le meilleur exit** : même PnL que le hold
  (+$436 vs +$436) avec DD **78 vs 172 (−55 %)**. Il vend les favoris qui
  montent à 0.85 avant qu'ils ne retombent ; les holds restants (164)
  sont les vrais gagnants. TP 0.80 vend trop tôt (−$195 de PnL), TP 0.90
  trop tard (DD remonte).
- **Stops = destructeurs** sur cette jambe : stop 0.60/0.65/0.70
  déclenchent sur le bruit avant la confirmation (359–387 stops, killT
  74k–127k ticks) et coûtent $250–300 de PnL. Le favori acheté à 0.62
  doit être défendu par le TP haut, pas par un stop serré.
- **favMax 0.65** : légèrement meilleur que 0.70 en PnL mais n'apporte
  rien au DD ; le filtre favori ≤ 0.60 tue l'univers (7 fills). Neutral.
- **Timing** : entry ≤ 300 s reste optimal (≤ 420 = +$409 avec plus
  d'exposition ; ≤ 240 = −$40) ; minElapsed ne fait que dégrader
  (l'info est dans les 2 premières minutes).

## 5. Verdict & recommandation

1. **La stratégie user-spec telle quelle (acheter l'underdog) : rejeter.**
   16 + 13 = 29 configs testées, aucune positive ; EV/share constamment
   négative.
2. **Le miroir inversé est un candidat sérieux** :
   `INVERT + detect 0.35–0.40 + fav ≤ 0.65 + TP 0.85 + hold sinon`
   → +$434 / 478 trades / WR 75 % / DD $82 / +3.8¢ par share, split-half
   positif des deux côtés. PnL % du notional déployé ≈ **+6.0 %**.
3. **Prochaines étapes avant tout code moteur** (discipline du repo) :
   - contre-vérification indépendante (`verify-claims` pattern) ;
   - overlap-check vs dip-revert / flip-confirm / early-conviction
     (l'entrée est corrélée aux fenêtres où le favori flippe récemment —
     le signal pourrait chevaucher antiflip-revert qui fait +$623) ;
   - calibration runner officiel avant toute décision d'implémentation.
4. **Ce qui reste interdit par la mesure** : le stop-loss 0.20 sur underdog
   (spec initiale), le stop 2 minutes, les stops sur favori, le TP 0.80.

---
*Fichiers : `dip-guard-sim-1789549414091.json` (34 configs + split-half),
scripts `scripts/research/dip-guard/`. Round 1 : `dip-guard-2026-09-16.md`.
Offline only — bot live non touché.*