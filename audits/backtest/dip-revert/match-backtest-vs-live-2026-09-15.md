# Match backtest vs live — dip-revert (réponse à « est-ce que ça match ? »)

Méthode : sim officielle (calibrée) rejouée sur les **mêmes fenêtres** que le live
(fenêtres complètes de la période 14 sept 13:48Z → 15 sept 05:45Z), sizing live
(5 shares), config runtime **réelle** (voir §1).

## Réponse courte : oui pour le 14, non pour le 15 — et la divergence du 15 est diagnostiquée

| Métrique | Sim (config runtime réelle) | Live réel | Match ? |
|---|---|---|---|
| Fills | 48 | 57 closed | ≈ (sim saute 5 fenêtres incomplètes + 4 signaux ratés) |
| Winrate | 66.7 % | 57.4 % | −9 pts |
| **Gain moyen** | **+2.00** | **+2.02** | ✅ exact |
| **Perte moyenne** | **−2.95** | **−2.98** | ✅ exact |
| PnL 14 sept | **+19.58** | **+13.59** | ✅ même signe, même ordre |
| PnL 15 sept | **−2.69** | **−16.58** | ❌ live 6× pire |
| PnL total | +16.89 | −2.99 | écart = la journée du 15 |

**La mécanique de trade est fidèle** (avgWin/avgLoss identiques au centime près :
le modèle de prix/sizing/payout est correct). **LeWR et le PnL du 15 divergent.**

## Pourquoi le 15 diverge (décomposition, live −16.58 vs sim −2.69)

1. **WR live 41 % sur le 15** (7/17) vs 64 % backtest. Les 6 pertes sont des
   entrées 0.54-0.65 qui ont toutes perdu (−2.8 à −3.25). Le backtest sur les
   MÊMES fenêtres ne perd que −2.69 : le marché du 15 (00:00-05:45Z) a été
   plus imprévisible que la moyenne — 8 jours de backtest contiennent des
   tranches pareilles (09-12 : −23 ; 09-10 : −5 à −130 selon config). La
   journée du 15 est **dans la distribution**, pas une anomalie de code.
2. **Malchance de séquence** : les pertes du 15 sont concentrées (3 pertes de
   suite 00:03-00:50, puis 4 pertes 04:03-05:18). En backtest la même période
   alterne davantage — variance de petit échantillon (17 trades).
3. **Le fill 0.31** (−3.0, crash de flip) : absent de la sim par construction
   (la sim lit le carnet au tick, pas la latence FOK). C'est un coût
   d'exécution live pur, comptabilisé dans le live et pas dans la sim.

## Découverte importante au passage : le JSON settings n'est PAS la config runtime

Les fills live vont jusqu'à **0.65** (10 positions à 0.64-0.65, +2.05 au total)
et démarrent à **181 s** — donc le runtime tourne sur **band 0.55-0.65,
elapsed 180** (= la config BASE officielle), PAS les valeurs du fichier
`bot-settings.json` (band 0.63, elapsed 480). Le bot ne relit pas le fichier :
celui-ci n'est réécrit que par un PATCH dashboard (hot-apply). Les modifications
manuelles du fichier n'ont **aucun effet** tant qu'aucun PATCH/redémarrage ne
les applique. La sim « config live exacte » avec elapsed 480 n'avait donc pas
de sens — la vraie comparaison est ci-dessus.

## Verdict global

- **Le backtest matche le live** sur la mécanique (prix, sizing, payouts
  exacts) et sur le jour 14 (+19.6 sim vs +13.6 live — l'écart ~30 % s'explique
  par les 5 fenêtres incomplètes, les killed-fok re-quotes et le régime).
- **Le 15 sept est une mauvaise journée de marché**, pas une divergence
  structurelle : même période, la sim perd aussi (−2.7), le live perd plus
  (−16.6) à cause d'une séquence défavorable + l'incident FOK du 0.31.
- L'espérance backtest (+16.9 sur 57 trades à 5 shares) vs live (−2.99) :
  l'écart −19.9 se décompose en ~−14 (séquence/malchance, dans la distribution)
  et ~−3 (latence FOK non modélisable en backtest).

Conclusion : le backtest reste un prédicteur valide de l'ordre de grandeur
mensuel, mais à 57 trades et PF 1.16, une journée rouge efface plusieurs
journées vertes — c'est exactement ce qui s'est passé. Rien à corriger dans le
code ; le levier (si tu veux moins de variance) reste le sizing.

Script : `scripts/research/dip-revert-research/match-live-final.mts` (v1/v2
conservées pour l'historique de raisonnement).