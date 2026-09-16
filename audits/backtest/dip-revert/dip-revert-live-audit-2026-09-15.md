# Dip-revert — audit des positions live (07:45Z, 15 sept 2026)

Données : `data/bot-live.db` en read-only, snapshot à 2026-09-15 07:44-07:47Z.
Bot vivant : ingestion sub-seconde sur toutes les tables (book/market/balance à < 10 s).

## 1. Vue d'ensemble — le PnL live est repassé négatif

| Métrique | Valeur | vs audit 04:11Z |
|---|---|---|
| Positions totales | 58 (57 closed + 1 résolue depuis) | +6 |
| Won / Lost / Sold | 31 / 23 / 3 | +1W/+5L |
| **Winrate** | **57.4 %** (59.6 % sold inclus) | 62.5 % → **↓5 pts** |
| **PnL closed cumulé** | **−2.99 USDC** | +8.40 → **−11.4** |
| Perte moyenne / gain moyen | −2.98 / +2.02 | inchangé |
| Profit factor | 0.93 | 1.16 → <1 |
| Capital engagé | 168.33 USDC (58 pos × ~2.9) | — |

| Jour (UTC) | Positions | W/L/S | PnL |
|---|---|---|---|
| 14 sept | 41 | 25/13/3 | **+13.59** |
| 15 sept (00:00-05:33Z) | 17 | 6/10/0 | **−16.58** |

Toutes stratégies confondues, le bot du 15 sept = 31 positions, **−9.49** (dip-revert
est le seul moteur actif). La stratégie qui affichait +8.4 à 04:00Z a tout rendu
et plus : les 7 dernières positions sont 2W/5L (−13.5).

## 2. Anomalie n°1 — un fill à 0.31 (hors bande) : exécution DANS le crash

`btc-updown-15m-1789448400` (Up, 5 sh @ 0.31, **−3.0**) — la seule position hors
bande 0.55-0.63. Reconstitution depuis `book_snapshots` + `orders` :

```
05:09:54  UP ask 0.61 (dans bande, spread 0.01, depth OK) → signal valide, FOK émis
05:09:58  FOK limit 0.56 → KILLED (le carnet bouge, top-of-book insuffisant)
05:10:01  UP ask 0.60, size 16 → nouveau FOK limit 0.60 émis
05:10:02  ← LE FLIP : UP 0.60 → 0.28 en UN tick (DOWN devient favori)
05:10:02  FOK exécuté à 0.31 — l'ordre a traversé le carnet pendant le crash
Résultat : lost −3.00 (UP n'est jamais revenu)
```

**Cause racine** : latence d'exécution FOK sur un livre qui s'effondre. L'ordre
émis au tick T s'exécute au prix du carnet au moment du match, pas au moment du
signal — ici exactement pendant un flip 0.60→0.28. L'entrée a payé 0.31 pour un
token que le carnet cotait déjà perdant. Ce n'est PAS une violation de bande
(le signal au moment d'émission était conforme), c'est un **risque de slippage
de flip** — le FOK limit 0.60 a rempli à 0.31 car le prix est passé sous la
limite pendant la transmission (price improvement mécanique, mais catastrophique
ici : on achète le token qui s'effondre).

Fréquence : 1 occurrence sur 58 positions, −3 USDC. Pas systémique mais c'est le
type de trade qui coûte le plus (entrée dans le crash = WR quasi nul).

## 3. Anomalie n°2 — settings live divergents de la config auditée

`bot-settings.json` au moment de l'audit : `dipRevertMinElapsedSec = 480`
(8 min) — pas 180 (base) ni 150 (axe gagnant). Entrées réelles du matin :
194-683 s après le début de fenêtre, dont **3 entrées > 420 s** et une à 683 s
(11:23 dans une fenêtre de 15 min).

Le backtest n'a jamais testé minElapsed 480. Corrélation entrée × PnL live :

| Bucket d'entrée | n | Wins | PnL |
|---|---|---|---|
| < 240 s | 29 | 14 | −16.42 |
| 240-420 s | 15 | 11 | +10.14 |
| > 420 s | 14 | 8 | +3.29 |

La bande 240-420 s est la seule positive — cohérente avec la deadline 420 du
backtest. Les entrées < 240 s perdent (le rebond n'est pas encore confirmé).

## 4. Santé opérationnelle

- **Résolutions** : les 10 dernières fenêtres se résolvent 6-175 s après la
  clôture (source gamma/clob avant 04:45Z, fallback probabiliste après —
  `market_resolutions` s'est arrêté à 04:45Z mais `position-resolver` continue
  de résoudre les positions par les events, délais normaux). Aucune position
  bloquée à l'instant (la position 05:33 s'est résolue *won* +2.1 pendant l'audit).
- **killed-fok** : 21/77 ordres d'entrée (27 %) — stable vs hier (23 %), le
  garde de profondeur fait son travail.
- **Aucune position fantôme** : wallet cohérent, la position open de 05:33
  (`Up @ 0.58`) s'est résolue won pendant l'audit.

## 5. Lecture d'ensemble et recommandations (aucun changement appliqué)

1. **Le régime de marché a changé ce matin** : WR 57 % vs 65 % backtest, PF 0.93.
   La journée du 15 est négative sur TOUTES les tranches horaires sauf 02-04Z.
   Ce n'est pas un bug d'exécution, c'est un signal moins rentable dans ce
   régime — cohérent avec le backtest : l'edge (PF 1.16 au mieux) est mince et
   sensible au régime.
2. **Le fill 0.31 est le seul vrai incident d'exécution** (−3, soit 18 % de la
   perte du jour). Mitigation possible (non implémentée) : annuler/retenter si
   le fill price s'écarte trop du prix d'émission (ex : fill < limit − 3×tick ⇒
   re-quote au lieu d'accepter), ou passer le depth guard sur le carnet post-flip.
3. **minElapsed 480 en live n'a pas été validé par backtest** — la donnée live
   (57 % WR, entrées 480+ marginalement positives mais n=14) est trop courte.
   La valeur backtestée reste 150 s (ou 180 s base), avec deadline 420 s.
4. Le trade par trade reste sain : pas d'ordre fantôme, pas de doublon de
   paire, PnL par trade conforme au modèle (win +2.0, loss −3.0, asymétrie
   attendue avec l'entrée 0.55-0.63).

## Chiffres clés pour décision

- Ce matin : −16.58 en 5h30 (17 pos) — 2× la perte max tolerable si on vise
  le PF backtest 1.16 (marge annuelle faible).
- Le signal reste profitable en backtest sur 396 fenêtres (PF 1.16-1.28 selon
  config) mais la journée live en cours est dans le bas du range du backtest
  (09-12 : −23, 09-15 : −14 à −29 selon config — on est à −16.58, DANS la
  distribution attendue).

Rapport généré depuis `data/bot-live.db` read-only ; scripts : `live-positions.mts`.