# Dip-revert — axes d'amélioration v1 (OBSOLÈTE — voir v2)

⚠️ **Ce rapport v1 contient une erreur de fidélité corrigée dans la v2**
(`dip-revert-axes-2026-09-14-v2.md`). Le "take-profit 0.95 → +$1 786" créditait
le bid du favori *courant* même quand le favori avait reflippé — dans 85/237
cas le token détenu valait ~0.05 et il est impossible de vendre un token qu'on
ne détient pas au prix du token gagnant. Résultat non implémentable.

Constats toujours valides de v1 : les filtres d'entrée (minRebound, bounce
fraction, vol floor, trend filter, stop-loss) dégradent tous le PnL — le signal
dip+rebond est saturé. Vol cap 0.20 et deadline 420 s restent de légers plus.

Univers : 321 fenêtres btc-updown-15m complètes (>801 ticks, gaps ≤ 60 s).
Sim calibrée vs backtest officiel : 237 fills / 64.6 % / +$269 vs 239 / 64.9 % / +$290.

## Axes testés v1 (30 configurations, sim d'époque)

| Axe | Verdict v1 (artefact) |
|---|---|
| B1 take-profit exit ask ≥ 0.95 | ✅ +$1 786 (ARTÉFACT — voir v2) |
| B1' 0.92–0.97 | ✅ plateau (ARTÉFACT) |
| C2 vol cap 0.20 | 🟡 +$318 vs base (+18 %) |
| D2 deadline entrée 420 s | 🟡 +$303 (+12 %) |
| A1 minRebound ≥ 2c | ❌ |
| A2 bounce fraction | ❌ |
| B2 stop-loss | ❌ |
| C1 vol floor | ➖/❌ |
| D1 trend filter | ❌ (0 fill à 60 s) |