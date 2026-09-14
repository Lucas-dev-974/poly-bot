# Dip-revert — axes d'amélioration testés (backtestés, live intact)

**v2 (corrigé) :** le take-profit "0.95" de la v1 était un artefact de mesure —
la sim créditait le bid du favori *courant* même quand le favori avait
**reflippé** (85/237 cas : le token détenu valait ~0.05, impossible à vendre à
0.94). Re-testé avec des sorties pricées sur le **carnet du token détenu** :
l'axe take-profit s'effondre (tous les axes de sortie anticipée sont ≤ base).

Date : 2026-09-14 · Univers : 321 fenêtres btc-updown-15m complètes (>801 ticks, gaps ≤ 60 s)
Source DB : `data/bot-live.db` en **read-only** (aucun DB source écrite, aucun ordre live).
Scripts : `scripts/research/dip-revert-research/` (`dip-sim.mts` v2, `dip-grid2.mts`).

## Calibration de la sim vs backtest officiel

| | fills | winRate | PnL |
|---|---|---|---|
| Backtest officiel (base) | 239 | 64.9 % | +$289.6 |
| Sim standalone (base) | 237 | 64.6 % | +$269.5 |

## Axes testés (v1 ~30 configs + v2 12 configs, fidélisée)

| Axe | Verdict v2 (honnête) |
|---|---|
| Take-profit token détenu ask ≥ 0.85 | +$175 vs base +$269 → **−$94** ❌ |
| Take-profit 0.90 / 0.92 / 0.95 | −$57 / −$44 / −$104 ❌ |
| Flip-stop (fav courant ≥ 0.90/0.95 ≠ détenu) | −$51 / −$15 ❌ |
| Stop token détenu ask ≤ 0.20/0.30 | −$122 / −$103 ❌ (pire en H2) |
| minRebound ≥ 2c | ❌ |
| Bounce fraction ≥ 50 % | ❌ |
| Vol floor / cap 0.15 | ➖/❌ |
| Vol cap 0.20 | 🟡 +$49 vs base (+18 %), moins de fills (217) |
| Deadline entrée 420 s | 🟡 +$33 vs base, fills 192 |
| Trend filter | ❌ (0 fill à 60 s) |
| Stop-loss / B3 combos | ❌ |

**Leçon clé (v1 → v2)** : toute sortie anticipée testée pricée sur le carnet du
token détenu dégrade ou stagne. Mécanisme : quand le favori détenu monte à 0.85+,
il gagne à la résolution 90 % du temps — vendre à 0.85 sacrifie ~15¢/share
d'espérance ; les 5-10 % de cas où il reflippe ne compensent pas.

## Ce qui reste (petits +, robustes)

- `dipRevertMaxElapsedSec = 420` : +12 % PnL, moins de fills (entrée deadline).
- Vol cap 0.20 : +18 % PnL, moins de fills.

## Verdict final

**Aucun axe de sortie anticipée ne survit à une simulation fidèle** (vente du
token réellement détenu, walk FOK 3 niveaux). Le hold-to-resolution de la base
EST la politique optimale pour ce signal. Les seuls gains légitimes restent les
filtres d'entrée légers (deadline 420 s, vol cap 0.20), et ils sont modestes.

Rapport v1 (obsolète, conservé pour l'historique) : `dip-revert-axes-2026-09-14-v1.md`.