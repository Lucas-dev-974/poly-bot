# Rapport patterns fav-band - 2026-10-02

## Contexte

Analyse **gagnants vs perdants** pour la strategie `fav-band`, a partir des ticks
`book_snapshots` (meme source que les scripts research fav-band / backtests).

### Sources de donnees

| Source | Utilisee ? | Detail |
|--------|------------|--------|
| Positions live `data/bot-live.db` (`strategyId='fav-band'`, status won/lost/sold) | **Oui (primaire)** | 673 positions |
| JSON backtest cap50 `fav-band-opt-cap50-*.json` | Meta seulement | Resume pnl/trades/wr - **pas de lignes par position** |
| `backtest_positions` (run optionnel) | Non | non demande |

Cap50 de reference : `audits\backtest\fav-band\fav-band-opt-cap50-1790938381315.json`

Resume cap50 : `{"label":"fav-band-opt_cap50","presetId":"fav-band-opt","ms":120488,"capitalStart":50,"pnl":428.28,"pnlPct":856.56,"fills":1054,"rejects":13,"windows":1105,"skippedIncomplete":791,"trades":1054,"wins":797,"losses":257,"wr":75.6,"maxDd":238.51,"worst":-15,"minEquity":50,"endEquity":478.28,"pnlPerDd":1.796,"configSnapshot":{"favBandOrderUsdc":15,"favBandAskMin":0.7,"favBandAskMax":0.85,"favBandMinElapsedSec":200,"favBandMaxElapsedSec":600,"maxSharesPerOrder":40,"maxExposureUsdc":40,"maxOpenPositionsPerSide":1,"simulatedCapital":50}}`

**Coverage ticks** : 672/673 positions win/loss avec books exploitables.
Les chiffres ci-dessous ne sont **pas inventes** : si une feature a `n` faible, elle est marquee comme telle.

## Baseline

- Positions win/loss analysees : **673** (wins=466, losses=207)
- Winrate : **69.2%**
- PnL cumule (labels win+loss) : **40.38** USDC
- Par status brut : won: n=331 pnl=525.04 | lost: n=178 pnl=-622.1 | sold: n=164 pnl=137.44
- Par outcome : Up: n=356 WR=69.7% | Down: n=317 WR=68.8%

## Top discriminateurs EX-ANTE (Cohen's d, win vs loss)

Features disponibles **a l'entree** (pas de path post-fill). |d|~0.2 faible, 0.5 moyen, 0.8 fort.

| Rang | Feature | mean(win) | mean(loss) | diff | Cohen's d | n win/loss |
|------|---------|-----------|------------|------|-----------|------------|
| 1 | Marge favori vs autre a l'entree (`favMarginAtEntry`) | 0.441 | 0.2188 | 0.2222 | **0.854** | 466/207 |
| 2 | Ask favori a l'entree (`entryAsk`) | 0.726 | 0.6148 | 0.1112 | **0.853** | 466/207 |
| 3 | Fill price (`fillPrice`) | 0.698 | 0.6258 | 0.0722 | **0.67** | 466/207 |
| 4 | Best ask at fill (`bestAskAtFill`) | 0.7048 | 0.6548 | 0.05 | **0.622** | 466/204 |
| 5 | Part favori avant entree (`favShareBefore`) | 0.7456 | 0.6824 | 0.0632 | **0.231** | 466/207 |

### Lecture rapide des 5 plus forts

1. **Marge favori vs autre a l'entree** : plus elevee chez les wins (dmean=0.2222, d=0.854).
2. **Ask favori a l'entree** : plus elevee chez les wins (dmean=0.1112, d=0.853).
3. **Fill price** : plus elevee chez les wins (dmean=0.0722, d=0.67).
4. **Best ask at fill** : plus elevee chez les wins (dmean=0.05, d=0.622).
5. **Part favori avant entree** : plus elevee chez les wins (dmean=0.0632, d=0.231).


## Top discriminateurs EX-POST (diagnostic uniquement)

Ces features utilisent le chemin **apres** l'entree : elles separent tres bien win/loss mais ne sont **pas** des filtres live.

| Rang | Feature | mean(win) | mean(loss) | diff | Cohen's d | n win/loss |
|------|---------|-----------|------------|------|-----------|------------|
| 1 | MAE ask (min apres - entree) (`maeAsk`) | -0.1649 | -0.5938 | 0.4289 | **2.233** | 461/207 |
| 2 | Part favori apres entree (`favShareAfter`) | 0.9229 | 0.4446 | 0.4783 | **2.163** | 461/207 |
| 3 | MFE ask (max apres - entree) (`mfeAsk`) | 0.2682 | 0.1254 | 0.1428 | **1.367** | 461/207 |
| 4 | Range ask apres entree (`askRangeAfter`) | 0.4332 | 0.7191 | -0.2859 | **-1.312** | 461/207 |
| 5 | Lower-lows apres entree (`lowerLowsAfter`) | 5.9764 | 13.8841 | -7.9077 | **-1.247** | 466/207 |

## Filtres actionnables (lift vs baseline, ex-ante seulement)

Filtres calculables **a l'entree** (pas de path post-entry). Lift = WR_filtre - WR_baseline (points de %).

| Filtre | n | WR | Lift (pp) | Couverture | PnL |
|--------|---|----|-----------|------------|-----|
| entryAsk >= 0.78 | 66 | 90.9% | **21.67** | 9.8% | 46.01 |
| 0.72 <= entryAsk <= 0.80 | 206 | 77.7% | **8.43** | 30.6% | 37.01 |
| favMarginAtEntry >= 0.20 | 618 | 73.0% | **3.74** | 91.8% | 61.02 |
| elapsedSec >= 300 | 211 | 72.0% | **2.8** | 31.4% | 86.76 |
| elapsedSec >= 400 | 128 | 71.1% | **1.85** | 19.0% | 43.84 |

> Les filtres marques ex-post dans `stats-latest.json` (path/MAE/lower-lows apres entree) servent au diagnostic, **pas** comme filtre live.

## Distributions par buckets

### entryAsk
- [0.65, 0.7): n=197 WR=62.9% pnl=-54.11
- [0.7, 0.74): n=212 WR=76.4% pnl=69.12
- [0.74, 0.78): n=113 WR=77.0% pnl=13.72
- [0.78, 0.82): n=17 WR=70.6% pnl=-9.05
- [0.82, 0.9): n=10 WR=90.0% pnl=5.69

### elapsedSec
- [0, 200): n=8 WR=50.0% pnl=-3.38
- [200, 300): n=454 WR=68.3% pnl=-43
- [300, 400): n=83 WR=73.5% pnl=42.92
- [400, 500): n=61 WR=68.8% pnl=7.08
- [500, 700): n=44 WR=75.0% pnl=22.58
- [700, 900): n=23 WR=69.6% pnl=14.18

### flipsBefore
- [0, 1): n=126 WR=68.3% pnl=-10.1
- [1, 2): n=101 WR=65.3% pnl=-30.14
- [2, 4): n=135 WR=68.2% pnl=-4.19
- [4, 8): n=165 WR=69.7% pnl=21.76
- [8, 50): n=146 WR=73.3% pnl=63.05

### favShareBefore
- [0, 0.5): n=149 WR=59.1% pnl=3.51
- [0.5, 0.7): n=103 WR=75.7% pnl=30.74
- [0.7, 0.85): n=123 WR=74.8% pnl=35.4
- [0.85, 0.95): n=94 WR=63.8% pnl=-25.6
- [0.95, 1.01): n=204 WR=72.5% pnl=-3.67

### askRangeBefore
- [0, 0.05): n=1 WR=100.0% pnl=1.45
- [0.05, 0.08): n=0 WR=0.0% pnl=0
- [0.08, 0.12): n=3 WR=66.7% pnl=0.63
- [0.12, 0.2): n=46 WR=54.4% pnl=-36.1
- [0.2, 0.5): n=566 WR=70.5% pnl=52.11

## Idees de filtres a tester (backtest)

1. **Ask plus haut / favori plus net** : tester `favBandAskMin` remonte (ex. 0.72-0.78) et/ou un seuil `favMarginAtEntry` (ask_held - ask_other).
2. **Bande sweet-spot** : sur ce live, `[0.70, 0.78)` a le meilleur couple WR/PnL - a rejouer sur le runner officiel fav-band-opt.
3. **Elapsed >= 300s** : lift modeste mais PnL live positif sur le sous-ensemble - tester `favBandMinElapsedSec=300`.
4. **Ne pas sur-filtrer les flips** : `flipsBefore<=1` degrade le WR ici (contre-intuitif) - ne pas bloquer sur stabilite seule.
5. **Exit / MAE** : les losses ont MAE ask bien plus profonde (ex-post) - retenter exit-B / lower-low cut sur le grid, pas un filtre d'entree.

## Limites / caveats

- Le JSON **fav-band-opt-cap50** ne contient pas les positions individuelles : l'analyse porte sur le **live** fav-band (et un run backtest seulement si `--include-backtest-run` a ete passe a l'extract).
- Le live peut differer du preset `fav-band-opt` (sizing, maxElapsed, exit rules, capital).
- Cohen's d et lifts sont **descriptifs** ; pas de correction multiple ni de validation out-of-sample ici.
- Features path/MAE/lower-lows sont **ex-post** : utiles pour comprendre les pertes, pas pour filtrer a l'entree.
- Coverage partielle possible sur de tres vieilles fenetres : voir `coverageNote` dans le dataset.

## Fichiers

- Dataset : `audits/backtest/fav-band/patterns/dataset-latest.json` (+ CSV)
- Stats : `audits/backtest/fav-band/patterns/stats-latest.json`
- Scripts : `scripts/research/fav-band-patterns/`

## Re-run

```bash
npx tsx scripts/research/fav-band-patterns/extract-dataset.mts
npx tsx scripts/research/fav-band-patterns/analyze-patterns.mts
# ou
npx tsx scripts/research/fav-band-patterns/run-pipeline.mts
```
