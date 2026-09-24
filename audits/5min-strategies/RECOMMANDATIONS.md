# Recommandations finales — BTC Up/Down 5 minutes

> Généré le 2026-09-23 · dataset : 920 fenêtres résolues (836 avec ≥100 ticks/token),
> 402 214 ticks de book à ~1 Hz. Validation : backtest tick-par-tick, split
> in-sample (1re moitié chronologique) / out-of-sample (2e moitié).

## Le verdict honnête d'abord

**L'objectif "WR > 55 % avec ratio 1:1.5-2" n'est pas atteignable de façon robuste
sur ce marché**, et ce n'est pas un défaut de recherche : la calibration directe
(scripts `09*.mjs`, 402 k ticks) montre que le marché 5m est **efficace** :

| Condition mesurée | n | WR | EV(5 sh) |
|---|---|---|---|
| Leader fort (ask 0.65+) en cours | 37 229 | 83.1 % | **−0.10 $** (trop cher) |
| Leader stable depuis ≥60 s, ask 0.50+ | 39 656 | 81.1 % | **−0.14 $** |
| Déposé post-flip [0.40-0.45] à +10 s | 501 | 51.1 % | **+0.44 $** |
| Antiflip large [0.30-0.50], entrée immédiate | 571 | 50.4 % | +0.18 à +0.33 $ |
| Underdog limit 0.10 (loterie) | 570 | 8.3 % | −0.09 $ |

Les configurations à WR élevé (80 %+) sont **déjà dans le prix** : leur EV est
négative. Le edge réel se situe à **WR ≈ 50-55 % sur des prix ≈ 0.30-0.45**, où le
breakeven est de 30-45 % — c'est là que le PnL est positif et stable IS/OOS.

La métrique qui compte n'est donc pas le WR brut mais **WR − breakeven(prix)**.
Une stratégie à 50.7 % en achetant 0.37 en moyenne gagne plus qu'une stratégie
à 60 % en achetant 0.62.

## Les 3 meilleures stratégies (budget 2 $ / 5 shares / trade)

### 🥇 #1 — A-antiflip-0.3-0.45-d5s (recommandée)

**Règle** : dès que le leader (ask le plus haut) change d'identité (= "flip"),
attendre 5 s, puis acheter l'**ancien favori déposé** si son ask est dans
[0.30, 0.45] et si le flip est survenu dans les 60 % de la fenêtre. Hold jusqu'à
la résolution. 1 trade max / fenêtre.

| Metric | 2 $ / 5 sh | 2.50 $ / 5 sh |
|---|---|---|
| Trades | 75 / 836 fenêtres | 219 |
| Winrate | **50.7 %** (IS 55 % / OOS 45 %) | 47.0 % |
| Coût moyen | 1.83 $ | 2.00 $ |
| Gain net si win | **+3.17 $** | +3.00 $ |
| Perte si lose | −1.83 $ | −2.00 $ |
| Ratio gain:risque | **1.73** | 1.50 |
| EV / trade | **+0.71 $** | +0.31 $ |
| PnL total (dataset) | +53.10 $ | +67.15 $ |

Pourquoi elle est #1 : meilleur EV/trade sous la contrainte stricte 2 $, ratio
1.73 (dans la cible 1:1.5-2), logique simple (mean-reversion post-flip), edge
présent in-sample **et** out-of-sample.

### 🥈 #2 — H-antiflip-sharp-d0.12-0.3-0.45 (qualité > quantité)

**Règle** : comme #1, mais n'entre que si le déposé a décoté d'au moins **12 ¢
par rapport à son sommet pré-flip** (chute brutale = surréaction du marché),
ask ∈ [0.30, 0.45]. Hold.

| Metric | 2 $ / 5 sh |
|---|---|
| Trades | 71 |
| Winrate | 49.3 % (IS 54 % / OOS 44 %) |
| Coût moyen | 1.85 $ |
| Gain / perte | +3.15 $ / −1.85 $ |
| EV / trade | **+0.65 $** |

Fréquence similaire à #1, profil légèrement plus "contrarian". Bonne
diversification avec #1 (les fenêtres gagnées ne se recouvrent pas totalement).

### 🥉 #3 — K-antiflip-bounce0.08-floor0.4-m0.6 (la plus stable IS/OOS)

**Règle** : après le flip, suivre le plancher de l'ancien favori ; acheter
seulement quand son ask a **rebondi de ≥ 8 ¢ depuis ce plancher** et reste
≥ 0.40 (marché ne le condamne pas) et ≤ 0.60. Hold.

> ⚠️ Audit 09h : une collision d'IDs masquait cette variante (les sweeps v3
> testaient en réalité la version bandMax=0.52). Re-validée avec l'ID corrigé,
> c'est désormais la **meilleure stabilité IS/OOS** du panel.

| Metric | 2 $ / 5 sh | 2.50 $ / 5 sh | 4 $ (référence) |
|---|---|---|---|
| Trades | 27 | 237 | **492** |
| Winrate | 44.4 % (IS 36 % / OOS 50 %) | 50.2 % (IS 54 % / OOS 46 %) | **54.9 %** (IS 55 % / OOS 55 %) |
| EV / trade | +0.22 $ | +0.27 $ | +0.36 $ |

À 4 $ de budget : WR 54.9 % **parfaitement stable** (55 % IS / 55 % OOS, n=492),
PnL +175 $. À 2 $ strict, peu de signaux passent le filtre ask ≤ 0.40 (27 trades)
— c'est la stratégies à réserver à un budget légèrement supérieur, ou à combiner
avec #1 à 2 $.

## Ce qui a été écarté (et pourquoi)

| Famille | Verdict | Preuve |
|---|---|---|
| Acheter le favori en cours (fav-band, fav-limit, "early lock") | ❌ EV négative | E-favlimit 0.70 : 61.9 % WR mais **−336 $** (4 $ budget) ; le prix paie déjà la proba |
| Limit order sous le marché (sniper) | ❌ adverse selection | D-doglimit 0.10 : WR 8.3 %, −400 $ ; un limit fillé = que le marché allait contre vous |
| TP/SL (exit au bid) | ❌ spread destructeur | G-antiflip TP/SL : toutes les variantes < WR du hold ; le bid rend 4-8 ¢ à chaque sortie |
| Momentum underdog (B-dogmom) | ⚠️ EV+ en 4 $, EV− en 2 $ | WR 33-43 %, trop dépendant des fills à bas prix |
| Bounce confirmation faible (3-5 ¢) | ❌ pas mieux que le simple antiflip | J-variants : WR 37-48 %, l'attente du rebond détériore le prix d'entrée |
| Leader stable fort (poursuite) | ❌ | 80 % WR mais EV −0.05 à −0.17 $ : marché efficient |

## Ce qu'il faut retenir des contraintes

1. **Le lot minimum CLOB (5 shares) fixe le ticket à 5×ask** : pour respecter
   1-2 $, l'ask doit être ≤ 0.40. C'est une contrainte structurelle, pas
   négociable.
2. **Gain mathématique** : 5 shares à prix p → gain net = 5(1−p), perte = 5p.
   À p=0.37 : gain +3.15 $ (ratio 1.73). Votre cible "1.50-2.50 $" est donc
   largement couverte dès que le prix ≤ 0.40 — le vrai levier est le WR vs
   breakeven, pas le gain par trade.
3. **Ne pas monter au-delà de ~0.50 de prix d'entrée** : le ratio tombe sous
   1:1 et l'edge disparaît.

## Plan de mise en œuvre recommandé

1. Lancer le collecteur en continu pour accumuler du live : `node audits/5min-strategies/01-collector.mjs`
2. **Paper-trader la #1** (A-antiflip-0.3-0.45-d5s) 2-3 jours, comparer le WR
   live au backtest (50.7 %).
3. Si le live confirme ≥ 50 % sur 100+ trades, monter en #1 + #3 en parallèle
   (diversification des profils d'entrée).
4. Réévaluer chaque semaine : `node audits/5min-strategies/08-final.mjs --budget=2 --max-shares=5`
   sur le dataset enrichi — l'edge post-flip peut se déplacer avec le régime de
   volatilité du BTC.

## Reproduction

```bash
# Calibration directe (probabilités conditionnelles)
node audits/5min-strategies/09-calibrate.mjs
node audits/5min-strategies/09b-calibrate-antiflip.mjs
node audits/5min-strategies/09c-calibrate-flip.mjs
node audits/5min-strategies/09d-calibrate-leader.mjs

# Validation finale des finalistes (IS/OOS, par jour, Up/Down)
node audits/5min-strategies/08-final.mjs --budget=2   --max-shares=5
node audits/5min-strategies/08-final.mjs --budget=2.5 --max-shares=5
node audits/5min-strategies/08-final.mjs --budget=4

# Sweep des variantes L (délai post-flip × bande)
node audits/5min-strategies/10-sweep-v4.mjs --budget=2.5 --max-shares=5

# Rapport d'ensemble
node audits/5min-strategies/05-report.mjs
```

Résultats bruts : `results/final-*.json`, `results/sweep*.json`, `results/INDEX.md`.