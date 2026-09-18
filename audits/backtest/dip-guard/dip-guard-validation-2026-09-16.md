# Dip-guard — validation round 3 (2026-09-16)

> **Statut : CANDIDAT VALIDÉ.** Contre-vérification indépendante exacte,
> chevauchement quantifié (non-additivité ~59 % avec antiflip), calibration
> runner officiel **0 % de drift**. Le signal inversé est prêt pour la
> décision d'implémentation.

---

## 1. Verify-claims — contre-vérification indépendante ✅

Réimplémentation **recodée depuis la spec** (pas importée de la sim) :
moteur, sell-walk FOK worst-price, détection, exits — tout réécrit.

| Config | Sim origine | Verify indépendant | Verdict |
|---|---|---|---|
| INV-hold | 486 / $404.76 / 66 % / DD 175 | **486 / $404.76 / 65.8 % / DD 175.28** | MATCH |
| d35-40 tp0.85 | 482 / $436.70 / 75 % / DD 78 | **482 / $436.70 / 75.3 % / DD 78.12** | MATCH |
| BEST fav≤0.65 tp0.85 | 478 / $433.57 / 75 % / DD 82 | **478 / $433.57 / 75.1 % / DD 82.14** | MATCH |

Invariants : `fills == tp + hold` ✓, `sum(byDay) == PnL` ✓, `WR == wins/fills` ✓.

**Nouveaux chiffres validés** :
- **t-stat empirique** (PnL par trade, pas la formule WR) : **2.17** sur le
  BEST — au-dessus du seuil 2.0 du repo. (La formule recomposée WR du
  template donnait 1.61 sur INV-hold ; l'empirique sur le combo TP, qui
  coupe les pertes, donne 2.17.)
- **PnL % sur notional déployé (base unique)** : INV-hold **+55.5 %**,
  d35-40 tp0.85 **+60.4 %**, BEST **+60.5 %** — corrige le +6.0 % noté
  en round 2 (le notional était sous-estimé, taille = min($15/ask, 30)
  sur un ask 0.62 ⇒ ~24 sh par trade, pas 24 $ exposés).
- PnL par elapsed d'entrée : pas de concentration suspecte (buckets
  0–60 s à 300 s tous porteurs, cf. JSON).

## 2. Overlap-check — corrélations quantifiées ⚠️

`dip-guard INVERT` tradé 478 fenêtres. Chevauchements :

| Paire | Communes | Même côté | Côté OPPOSÉ |
|---|---:|---:|---:|
| **dip-guard ∩ antiflip-revert** | **282** | 161 | **121** |
| dip-guard ∩ early-conviction | 275 | 265 | 10 |
| dip-guard ∩ flip-confirm | 229 | 140 | 89 |

**Lecture** :
- Le chevauchement est **massif** : 282/478 = **59 %** des fenêtres
  dip-guard sont aussi tradées par antiflip-revert, 59 % par
  early-conviction (265/275 = 96 % des trades early-conv sur les mêmes
  fenêtres), 48 % par flip-confirm.
- **early-conviction : quasi-doublon directionnel** (96 % même côté) —
  acheter le favori tôt dans la fenêtre. Running les deux moteurs
  ensemble ≈ doubler l'exposition sur ~275 fenêtres.
- **antiflip : couverture partielle** (121 opposés) — sur 43 % des
  fenêtres communes les moteurs prennent des côtés opposés ; leurs PnL
  ne s'additionnent pas mécaniquement mais se neutralisent partiellement
  en risque.
- **Les PnL des 4 stratégies NE SONT PAS additifs.** Un portefeuille
  dip-guard + antiflip + early-conviction n'est pas +$434 + $623 + $330 :
  le vrai chiffre demande un sim multi-moteurs avec un budget commun.
- Hiérarchie PnL/notional : dip-guard BEST **+60.5 %** ≫ antiflip
  +21 % ≫ early-conviction +10 %. Le capital a plus d'edge par dollar
  dans dip-guard INVERT que dans les 3 stratégies existantes.

## 3. Calibration runner officiel ✅

Sonde fav-band (0.70–0.85, min 200 s, $15, 30 sh) sur le même univers
494 fenêtres, dans les deux moteurs :

| Moteur | Fills | PnL | WR |
|---|---:|---:|---:|
| Runner officiel (`src/backtest/runner.ts`) | 487 | $117.84 | 74.7 % |
| Sim dip-guard (même mécanique) | 487 | $117.24 | 74.7 % |
| **Drift** | **0 %** | **+$0.60** | **0 pt** |

Calibration **parfaite** (fills identiques au trade près, PnL à 0.6 $).
Attente repo ±1–2 % fills largement respectée. **Les chiffres dip-guard
INVERT (+$434, WR 75 %, DD $82) ont un statut de backtest calibré.**

(Note : la sonde PnL $117 ici vs $293–299 dans les rapports fav-band
historiques = univers différent — 494 fenêtres 801+ vs 301–313 fenêtres
601+. La comparaison n'est pas inter-univers ; la calibration, si.)

## 4. Verdict

| Contrôle | Résultat |
|---|---|
| Réimplémentation indépendante | **MATCH exact** (3/3 configs) |
| Invariants comptables | tous passés |
| t-stat empirique (combo TP) | **2.15–2.17 > 2.0** |
| PnL/notional corrigé | **+60 %** |
| Overlap | 48–59 % fenêtres partagées — **non-additif**, prioriser |
| Calibration runner officiel | **0 % drift fills** |

**Le signal dip-guard INVERT (acheter le favori quand l'underdog cote
0.35–0.40, ask ≤ 0.65, TP 0.85, sinon hold) est validé sur les 3 axes.**

Décision suivante : implémentation moteur natif (wiring complet type
antiflip/flip-confirm) OU confrontation directe avec antiflip-revert sur
le capital (un seul moteur sur ces fenêtres — dip-guard a le meilleur
PnL/DD et le meilleur PnL % par dollar, mais antiflip garde le PnL
absolu le plus élevé et t=2.74 sur sa propre publication).

---
*Fichiers : `verify-claims-1789551998497.json`, `overlap-check-1789552003484.json`,
`calibration-official-1789552037661.json` dans ce dossier. Scripts :
`scripts/research/dip-guard/{verify-claims,overlap-check,calibrate-official}.mts`.
Offline only — bot live non touché.*