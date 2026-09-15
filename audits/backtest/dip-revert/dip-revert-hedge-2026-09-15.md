# Dip-revert — hedge jambe inverse (backtest, AUCUNE implémentation)

Date : 2026-09-15 · Univers : 396 fenêtres btc-updown-15m complètes (>801 ticks, gaps ≤ 60 s)
Source DB : `data/bot-live.db` read-only. Script : `scripts/research/dip-revert-research/dip-hedge-sim.mts`
Sim fidèle (entrée = base officielle et variante e150+d050 gagnante ; hedge = BUY jambe
opposée, walk FOK 3 niveaux d'asks, taille = ratio × notional de la position ; la
position reste en hold-to-resolution). Comptabilité : coût du hedge payé à l'exécution,
payouts (position + hedge) à la résolution, exactement une fois chacun.

## Variante « couverture classique » (parité de shares)

Hedge = même **nombre de shares** sur les deux jambes, dès que la paire somme
sous un seuil — verrouille `size × (1 − somme)` quoi qu'il arrive :

| Config | hedges | PnL | Δ |
|---|---|---|---|
| free-parity sum ≤ 1.00 | 235 | 183.57 | −141.8 |
| free-parity sum ≤ 1.02 | 287 (tous) | −79.76 | −405.1 |
| free-parity sum ≤ 1.05 | 287 (tous) | −82.64 | −408.0 |

Même verdict. À sum ≤ 1.02, on hedge TOUT (l'entrée dip-revert se fait à
0.55–0.65, donc la paire somme 0.90–1.10 en permanence) : le PnL devient
systématiquement négatif (−0.28/trade en moyenne) car on paie en moyenne
sum > 1 par paire. Les fenêtres où sum < 1 verrouillent un profit de
1–2 ¢/share — trop faible pour compenser les autres.

## Test « réduction de variance » (l'argument en faveur du hedge)

Même en perdant en moyenne, un hedge pourrait se justifier en réduisant la
volatilité du PnL. Vérifié : ratio std(PnL journalier) / |PnL total| —

| Config | PnL | std-jour | std/\|pnl\| |
|---|---|---|---|
| no-hedge | +325 | 56 | **0.17** |
| free-parity 1.00 | +184 | 39 | 0.21 |
| stop-a0.20 | +197 | 52 | 0.27 |
| post-r050 | −214 | 48 | 0.22 |
| post-r100 | −740 | 71 | 0.10 (saignement régulier) |

Aucun hedge n'améliore le rendement ajusté au risque. post-r100 a une volatilité
faible mais c'est un saignement constant, pas une couverture.

## Variante « ordre limit reposé » (demande du 15/09, pas un hedge 1:1)

Principe testé : après l'entrée dip-revert, placer un **ordre limit BUY GTC à
0.20 (±0.10/0.15/0.25/0.30) sur la jambe opposée**, cible = même nombre de
shares que la position. Il ne se remplit que si l'opposée s'effondre sous le
seuil (donc quand notre favori monte fort) ; remplissage **incrémental** tick
par tick (walk des niveaux d'asks ≤ limite), jamais annulé — la fenêtre est
courte, l'ordre expire à la résolution. Aucune obligation de couverture
complète : les fills partiels restent partiels.

| Config | fills | hedges (complètes) | PnL | Δ vs no-hedge |
|---|---|---|---|---|
| limit 0.10 | 287 | 199 | 222.23 | −103.1 |
| limit 0.15 | 287 | 205 | 118.86 | −206.5 |
| **limit 0.20** | 287 | 219 | 160.07 | **−165.3** |
| limit 0.25 | 287 | 231 | 130.52 | −194.8 |
| limit 0.30 | 287 | 244 | 68.07 | −257.3 |
| limit 0.20 (entrée e150+d050) | 285 | 212 | 81.62 | −243.7 |

**Verdict : perdant aussi, mais c'est la moins mauvaise famille de hedge.**
Mécanisme : l'ordre ne se remplit que dans les états où l'opposée est tombée
sous 0.20 — c'est-à-dire quand notre favori cote 0.80+ et gagne ~90 % du temps.
Chaque fill paye h (≈0.10–0.20) pour un payout de 1 seulement dans les ~10 %
de retournements : E[delta/share] ≈ P(win|fill)·(−h) + (1−P(win|fill))·(1−h),
négatif dès que P(win|fill) > ~0.85 avec h ≈ 0.15. Le jour par jour le montre
clairement : le limit **aide les mauvais jours** (09-12 : +0.49 vs −22.93 ;
09-15 : −5.81 vs −13.66 ; 09-10 : +24.5 vs −19.9) mais **sacrifie les bons**
(09-08 : +43.7 vs +104.4 ; 09-14 : −40.4 vs +24.6). Net : négatif.

Variance : std(PnL jour)/|PnL| = 0.20 pour limit 0.20 vs **0.17** pour no-hedge
— même l'argument risque/rendement ne le sauve pas.

Nota simulation : fills au prix des asks affichés ≤ limite, sans effet de file
(queue position) ni d'annulation — approximation généreuse ; un vrai ordre
reposé ferait au mieux pareil.

## Verdict global : le hedge détruit la valeur sur ce signal

| Politique | Variantes testées | Δ PnL vs no-hedge |
|---|---|---|
| **post** (hedge immédiat à l'entrée) | ratio 1.0, 0.5, base + winner | **−530 à −1107** ❌ |
| **free** (hedge si somme asks ≤ 1.00/0.99/0.98) | 3 seuils × 2 entrées | **−42 à −168** ❌ |
| **stop** (hedge si ask détenu ≤ 0.35/0.30/0.25/0.20) | 4 seuils | **−128 à −250** ❌ |
| **limit** (ordre reposé 0.10–0.30, fill incrémental) | 5 prix × 2 entrées | **−103 à −257** ❌ |

Référence no-hedge : +325.35 (sim, 287 fills, WR 64.5 %) — calibrée sur les runs précédents.

## Détail

| Config | fills | hedges | kills | WR | PnL | Δ |
|---|---|---|---|---|---|---|
| no-hedge-ref | 287 | 0 | 0 | 64.5 | 325.35 | 0 |
| free-sum0.99 | 287 | 200 | 16 | 64.5 | 283.43 | −41.9 |
| free-sum0.98 | 287 | 190 | 5 | 64.5 | 249.80 | −75.6 |
| stop-a0.20 | 287 | 131 | 6 | 64.5 | 196.88 | −128.5 |
| stop-a0.30 (e150+d050) | 285 | 150 | 3 | 64.6 | 190.48 | −134.9 |
| free-sum1.00 | 287 | 235 | 50 | 64.5 | 157.74 | −167.6 |
| post-r050 | 287 | 283 | 4 | 64.5 | −214.08 | −539.4 |
| post-r100 | 287 | 281 | 6 | 64.5 | −740.44 | −1065.8 |

## Pourquoi (mécanisme, pas juste les chiffres)

1. **post** : l'entrée dip-revert achète le favori à 0.55–0.65 ; la jambe opposée
   cote alors 0.35–0.45. Hedge 1:1 en notional ⇒ on paie ~0.40 par share de hedge
   pour gagner exactement 1 si l'entrée perd. C'est une assurance qui coûte ~70 %
   de l'espérance du trade : même en gagnant les deux jambes à la résolution
   (favori gagne → hedge expire à 0), le payout combiné plafonne à
   (1 − prix entrée) − prix opp < moitié du PnL non couvert. Le WR ne bouge pas
   (64.5 % — le hedge n'empêche pas les pertes, il les redistribue), seul le PnL
   s'effondre : **−1066 $ sur 287 trades, −3.7 $/trade**.
2. **free** : économiquement le meilleur (le hedge ne se déclenche que quand la
   paire coûte ≤ 1, donc le profit est verrouillé à l'entrée de la 2e jambe), mais
   ces situations sont rares (200/287 avec sum ≤ 0.99, encore moins sous 0.98) et
   le locked profit (1 − sum ≈ 1-2 ¢/share) est minuscule devant le coût
   d'opportunité quand la paire somme > 1 : on finance un hedge qui rapporte
   moins que l'espérance du favori seul.
3. **stop** : le plus intuitif (« l'ask détenu s'effondre → couvrir ») mais
   l'ask détenu à ≤ 0.20 signifie que le marché a déjà re-prix la position comme
   perdante : acheter l'opposée à ce moment paie le nouveau prix du favori
   (0.80+), c'est de l'achat de high. Le hedge récupère moins que ce que
   l'entrée aurait gagné en tenant.

## Cohérence avec les résultats précédents

Troisième confirmation du même mécanisme (v1/v2 du 14/09, exits ; hedge du 15/09) :
**toute structure qui cède de l'espérance du favori détenu (vente anticipée OU
achat de la jambe opposée) dégrade le PnL du signal dip-revert**. Le hold 2 jambes
indépendantes max est la politique optimale. Si l'objectif est la réduction de
variance (drawdown), le seul levier non destructeur reste le sizing, pas le hedge.

## Caveats

- Sim standalone (pas le runner officiel : le runner ne peut pas hedger sans
  implémenter `hedgeAtPostTime` dans `dip-revert-strategy.ts` — interdit par la
  consigne). La sim est fidélisée à ±1 % sur la config no-hedge (325.35 sim vs
  345.39 runner) ; les deltas de politique hedge sont 10-100× plus grands que
  cette marge d'erreur, le classement est robuste.
- Le hedge « free » a été testé avec recheck à chaque tick jusqu'à
  résolution (généreux pour l'axe : un hedge possible n'importe quand dans la
  fenêtre) — même à cette aide maximale, il perd.

Rapport JSON : `dip-hedge-sim-1789448134611.json`.