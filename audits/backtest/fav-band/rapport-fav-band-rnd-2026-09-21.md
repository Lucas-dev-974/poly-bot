# Rapport R&D fav-band — audit, capital 20 $, winrate & avg loss

**Date** : 2026-09-21 · **Runner** : `src/backtest/runner.ts` (offline, copie VACUUM de `data/bot-live.db`) · **Univers** : 909–917 fenêtres BTC 15m complètes (minTicks 601, gap ≤ 60 s), 2026-09-08 → 09-21 · **Sizing de référence S1** : ordre 4.5 USDC / 5 sh max / expo 6 / 3 slots · capital simulé 20 $ · bot live non touché.

---

## 1. Contexte et jalons

| Jalon | Contenu |
|---|---|
| Audit initial | 21+ specs (baselines, live band, inverse GTC, exit B, whipsaw) sur toutes les BTC 15m → verdict : inverse GTC = taxation pure (WR 12.5 %), BEST = bande 0.68–0.82 · min200 · sans max · pause 3×8 · inverse OFF |
| Comparaison équitable | LIVE vs BEST au même sizing live : −23.30 (live) → +82.45 (sans inverse) → +122.06 (BEST) |
| Capital 20 $ | BEST au capital 20 $ : 4 variantes de sizing, dont une démo de ruine (S4) |
| R&D Winrate | 3 phases / 22 specs — cible WR ≥ 80 % atteinte |
| R&D Avg loss | 4 phases / 24 specs — cible avgLoss ≤ 2 $ + WR ≥ 60 % atteinte |

Config live au fil de la session : bande corrigée 0.65–0.75 → **0.68–0.82** (validé), inverse GTC coupé, pause whipsaw activée. Restent recommandés : min200/max null → max780, et l'exit B si réduction de perte prioritaire.

---

## 2. Capital 20 $ (BEST, 909 fenêtres)

Contrainte matérielle : 5 shares minimum → ordre minimum viable ≈ 4.10 $ à ask 0.82. Le sizing live 4.5 $/ordre est le plancher exécutable.

| Variante | PnL | Equity finale | WR | maxDD | DD ÷ capital | PnL/DD |
|---|---:|---:|---:|---:|---:|---:|
| S1 — ordre 4.5 $ · 5 sh · expo 6 | **+127.26** | 147.26 | 75.2 % | 42.00 | ×2.1 | 3.03 |
| S2 — ordre 5 $ · 10 sh · expo 10 | +172.87 | 192.87 | 75.2 % | 58.19 | ×2.9 | 2.97 |
| S3 — S1 + exit B (0.5/0.03/3) | +67.19 | 87.19 | 46.1 % | **12.10** | ×0.6 | **5.55** |
| S4 — ordre 15 $/trade (démo de ruine) | +513.51 | 533.51 | 75.2 % | 175.12 | **×8.8** | 2.93 |

- Robustesse au capital : S1 (20 $) ≈ run 15 $ (122.06/42 sur 903 fenêtres) — la conclusion n'est pas un artefact de budget.
- Aucune ruine : equity jamais < 20 $, mais maxDD S1 = 2.1× le capital. S4 : −88 % depuis le pic ; borne haute du levier, pas une recommandation.

---

## 3. R&D Winrate — cible 80 %+ (3 phases, 32 specs)

### Frontière

| Config | WR | PnL | maxDD | PnL/DD |
|---|---:|---:|---:|---:|
| S1 base — 0.68–0.82 · min200 | 75.25 % | +130.11 | 42.00 | 3.10 |
| + maxElapsed 780 (B4) | 75.31 % | +132.76 | 38.35 | **3.46** |
| Bande 0.76–0.82 (A4) | 78.67 % | +45.51 | 41.25 | 1.10 |
| Bande 0.78–0.82 + max780 (F4) | **80.22 %** | +45.61 | 32.45 | 1.41 |
| F4 + min250 (P6) | **80.40 %** | +46.81 | **30.75** | 1.52 |
| Bande 0.79–0.82 + max780 (P2) | 80.88 % | +41.46 | 33.00 | 1.26 |
| Bande 0.80–0.82 + max780 (P1) | **81.39 %** | +33.61 | 42.70 | 0.79 |

### Mécanismes validés

1. **Resserrer la bande par le haut** : le moteur re-time les entrées vers des asks plus chers mais plus fiables (+1.5 pp de WR par palier de 0.02).
2. **maxElapsed 780 s** : coupe le dernier quart (info déjà dans le prix) — améliore PnL, DD et PnL/DD sans toucher le WR : free lunch.
3. **minElapsed 250** : P6 = le DD le plus bas du panel 80 %.

### Ce qui ne marche pas

- **Retarder l'entrée** : min300 → +41.56 ; min450 → **−19.94 (quasi-ruine, equity 0.06)** — les entrées 200–300 s sont parmi les plus rentables.
- **Gates whipsaw maxScore** (70/60/50) : WR 71.5–75 %, PnL ≤ +28.86 — destructives.
- **Exit B sur la config 80 %** (P4) : WR 52.2 % — les sorties cassent les wins.
- Buckets 2 ¢ : `0.70–0.72` toxique (WR 68.2 %, −15.9) ; tout ≥ 0.72 est à WR 80–83 % ; `0.68–0.70` mitigé (71.8 %).

**Verdict** : WR ≥ 80 % possible (P6 : 80.40 % / DD 30.75) mais au prix de ~60 % du PnL (+47 vs +130). Le meilleur PnL/DD global reste **S1 + max780** (75.31 % / 3.46).

---

## 3 bis. R&D Avg loss (2 phases, 14 specs, 917 fenêtres)

Structure : en hold-to-resolve, une perte = −5 × prix d'entrée (−4.10 à 0.82) contre un gain de +5 × (1 − prix) = +0.90 → payoff 0.39. 52 % des pertes sont « deep » (≤ −3.50).

| Config | avgLoss | Payoff | WR | PnL | maxDD | PnL/DD |
|---|---:|---:|---:|---:|---:|---:|
| S1 base (hold) | −3.56 | 0.39 | 75.4 % | +136.86 | 42.00 | 3.26 |
| Bande basse 0.68–0.76 | −3.52 | 0.41 | 74.1 % | +126.02 | 48.45 | 2.60 |
| Exit B 0.5/0.03/3 (A1) | −0.89 | 1.54 | 46.5 % | +73.59 | 12.10 | 6.08 |
| Exit B 0.5/0.02/3 (A4) | −0.76 | 1.79 | 43.9 % | +76.55 | **9.75** | 7.85 |
| Exit B n4 (L4) | −1.08 | 1.26 | 51.3 % | +86.03 | 16.55 | 5.20 |
| **A4 + max780 + exitMin60 (L6)** | **−0.75** | 1.83 | 44.2 % | +83.30 | 9.75 | **8.54** |

- **L'exit B est LE levier** : avgLoss ÷ 4.8, queue de pertes 52 % → 0.8 %, DD ÷ 4.3. Le WR affiché chute (75 → 44 %, les SELL comptent comme pertes) mais l'espérance par unité de risque **triple** (payoff × WR : 0.30 → 0.79).
- **Rejetés** : bande d'entrée plus basse (avgLoss inchangé — la perte reste 5 × prix à résolution), exitMinElapsed ≤ 120 s (no-op, les chaînes de plus-bas mettent > 2 min à se former), n2 (trop sensible : +32.57, WR 34 %).
- Sans contrainte de cible : **L6** = champion risque (PnL/DD 8.54), **M2** (0.5/0.02/n5, bande 0.68–0.82) = meilleur PnL du groupe exit (+114.96, WR 58.07 %, avgLoss −1.41).

---

## 4. Cible « avgLoss max 2 $ + WR ≥ 60 % » — ATTEINTE (phases 3–4)

Le continuum exit B (n4/n5, drop 0.03–0.05, retrace 0.25–0.75) + re-timing bande haute + loss-only ON pose la frontière exactement sur les deux contraintes. 3 configs conformes :

| Config | WR | avgLoss | PnL | maxDD | PnL/DD |
|---|---:|---:|---:|---:|---:|
| **N4 — bande 0.74–0.82 · max780 · exit 0.5/0.02/5 · loss-only** ⭐ | **60.94 %** | **−1.56** | **+71.21** | 20.80 | **3.42** |
| N5 — idem + loss-only OFF | 60.92 % | −1.59 | +49.30 | 26.70 | 1.85 |
| N6 — idem N4 mais drop 0.03 | **63.03 %** | −1.85 | +36.88 | 36.09 | 1.02 |

### Config recommandée (N4)

```json
{
  "favBandAskMin": 0.74,
  "favBandAskMax": 0.82,
  "favBandMinElapsedSec": 200,
  "favBandMaxElapsedSec": 780,
  "favBandWhipsawEnabled": true,
  "favBandWhipsawPauseAfterLosses": 3,
  "favBandWhipsawPauseWindows": 8,
  "favBandInverseEnabled": false,
  "favBandExitEnabled": true,
  "favBandExitRetraceRatio": 0.5,
  "favBandExitMinLowerHighDrop": 0.02,
  "favBandExitConsecutive": 5,
  "favBandExitLookbackMs": 120000,
  "favBandExitMinElapsedSec": 0,
  "favBandExitLossOnly": true,
  "favBandExitSwitchEnabled": false
}
```

**Capital 20 $ → 91.21 $** · avgLoss −1.56 (÷2.3 vs hold) · worst −4.05 (deep 7.1 %) · maxDD 20.80 (×1.04 le capital).

### Chaîne causale

1. **n5 est le pivot** : exiger 5 plus-bas confirmés (au lieu de 3) fait remonter le WR de 44 → 58 % sans perdre la coupure de queue.
2. **askMin 0.74** ajoute +2.9 pp de WR (re-timing vers des asks élevés).
3. **loss-only ON** : vendre en profit détruit de la valeur (N4 bat N5 de +22 en PnL).
4. **max780** : +5 à +8 de PnL gratuit en sortie du dernier quart.

---

## 5. Findings consolidés

| # | Sévérité | Constat | Action |
|---|---|---|---|
| F1 | Majeure | Inverse GTC = taxation structurelle (WR 12.5 %, −105.75 en sim) | Rester OFF (corrigé en séance) |
| F2 | Moyenne | Timing live min180/max600 sous-optimal | min200 + max780 |
| F3 | Moyenne | Pause whipsaw 3×8 : +0.85 pp WR, DD −25 % | ON (corrigé en séance) |
| F4 | Corrigé | Bande 0.65–0.75 → 0.68–0.82 validé par backtest | RAS |
| F5 | Moyenne | Exit B : 0.5/0.02/3 (min DD) ou 0.5/0.02/5 (équilibre) ; défaut preset 0.25/0.02/2 trop serré | Si exit : jamais 0.02/n2 |
| F6 | Moyenne | Gates whipsaw score/flips destructives | Ne jamais activer maxScore/maxIntraFlips |
| F7 | Mineure | Jours rouges structurels = régime whipsaw, atténués par la pause | Ne pas « réparer » par paramètre |
| F8 | Info | Sim ≠ live : frictions FOK (19 % de tués en live), carnets fins | Comparer à config égale, même univers |
| F9 | Mineure | Capital 20 $ : 4.5 $/ordre = plancher exécutable ; equity jamais < 20 $ | Garder 4.5 $ / expo 6 |
| F10 | Majeure | WR ≥ 80 % validé mais le WR s'achète : −60 % de PnL | P6 si stabilité prioritaire |
| F11 | Majeure | Exit B 0.5/0.02/3 : avgLoss ÷ 4.8, DD ÷ 4.3, PnL/DD 8.54 (L6) | Si perte prioritaire : L6 |
| F12 | Cible atteinte | avgLoss ≤ 2 $ + WR ≥ 60 % : N4 (60.94 % / −1.56 / +71.21 / DD 20.80) | Appliquer N4 si la cible prime |

---

## 6. Artefacts

**Scripts réutilisables** (`scripts/research/fav-band-audit/`) :
`explore-btc-15m.mts` · `audit-backtest-btc15.mts` (21 specs) · `combo-run-btc15.mts` · `fair-live-vs-best.mts` · `recompare-current-live.mts` · `best-config-cap20.mts` · `wr-phase1/2/3.mts` · `loss-phase1/2/3/4.mts`

**JSON bruts** (`audits/backtest/fav-band/`) :
`fav-band-audit-btc15-1789965746350` · `fav-band-combo-btc15-1789966474335` · `fav-band-fair-live-vs-best-1789967447125` · `fav-band-recompare-live-1789969454084` · `fav-band-cap20-1789974723234` · `fav-band-wr-phase1-1789977846915` · `fav-band-wr-phase2-1789978853241` · `fav-band-wr-phase3-1789979501802` · `fav-band-loss-phase1-1789987190363` · `fav-band-loss-phase2-1789987815516` · `fav-band-loss-phase3-1789991086035` · `fav-band-loss-phase4-1789991899673`

**Canvas interactif** : `fav-band-audit-report.canvas.tsx` (rapport complet : classements, frontières WR/avg loss, equity, décompositions).

---

## 7. Réserves

- 14 jours d'historique, un seul actif (BTC), un seul régime de marché.
- Les PnL entre runs ne se somment pas : univers variables (899 → 917 fenêtres, la DB a grossi pendant la session).
- L'exit vend au bid L1 : un carnet fin peut tuer les FOK en live (19 % de tués observés en live).
- La bande 0.74–0.82 (N4) réduit la fréquence d'entrée (~0.67 trade/fenêtre) ; le carnet est plus fin à ces niveaux.
- WR mélangé (hold + sorties anticipées) : pour l'exit, la métrique pertinente est PnL/DD et payoff.
- La config live pouvant changer entre deux runs, re-fetch avant toute comparaison.