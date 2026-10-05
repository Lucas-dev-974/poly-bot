# Fav-band — comparaison définitions de sortie (A pics cassés vs B creux confirmés)

**Date** : 2026-09-20 · **Scope** : exemples synthétiques + lecture des artefacts existants (`lower-lows.ts`, `scripts/python/analyze_lower_lows_fast.py`, audit exit-rule). Pas de changement live. PnL `runBacktest` B non rejoué ici (wiring exit mode B pas branché sur le runner).

## Définitions

### A — pics cassés (code live `stepExitChainWith`)
Après le fill, suivi de l'ask détenu. Chaque chute ≥ `minDrop` sous le plus-haut courant (`curPeak`) = 1 palier. Après `consecutive` paliers dans le lookback → SELL. Reprise ≥ dernier pic → reset. **Pas d'attente de rebond** pour valider un creux.

Défauts ship : exit OFF ; si ON : drop 0.05 / n=3 / lookback 120s / loss-only ON (audit exit-rule).

### B — creux confirmé (ta définition + port `lower-lows.ts`)
Un plus-bas n'est confirmé qu'après un **rebond** ≥ `retraceRatio × drop` (toi : ~50 % ; code Python/TS actuel : **0.25** par défaut, avec clamp 1 tick … minSwing). Ensuite on enchaîne des plus-bas confirmés plus bas. Exit après `consecutive` creux confirmés.

Exemple user : 0.65 → 0.55 → 0.60 (rebond 5¢ = 50 % de la chute 10¢) ⇒ low confirmé = 0.55.

## Exemples synthétiques (entry = premier tick, A drop=0.05 n=3, B minSwing=0.05 n=3)

| Série | Path | A fire | B@50% fire | B@25% fire | Lecture |
|---|---|---|---|---|---|
| user | 0.65→0.60→0.55→0.57→0.60 | non (1 palier) | non (1 creux à 0.55 au rebond 0.60) | idem | B valide le low 0.55 ; A a déjà compté un pic cassé plus tôt, pas assez pour exit |
| three_steps | 0.65→0.55→0.60→0.50→0.55→0.45→0.50 | **oui** @0.45 | **oui** @0.50 (3e confirm) | oui | A sort au 3e pic cassé ; B sort un tick plus tard (attend le rebond) |
| noise_chop | zigzag −2/−3¢ | **oui** | non | oui plus tard | A sort sur bruit de paliers ; B@50% exige de vrais swings + gros rebonds |
| slow_grind | descente sans rebond | **oui** | **non** | **non** | **Divergence clé** : A sort sur grind ; B ne confirme jamais sans rebond |
| V_recovery | 0.65→0.55→0.70 | non (reset) | non (reset) | non | Les deux reset si reprise au-dessus du high |

## Artefacts DB déjà présents (B@25 %, n=3, swing 5¢)

`lower_low_analysis_sample.json` (100 marchés BTC 15m) :
- 61 / 100 ont une séquence ≥3 LL côté Up ; 57 côté Down
- Ce n'est **pas** un PnL fav-band : détection sur mids, pas le pipeline exit FOK loss-only

Audit prior A (`fav-band-exit-rule-2026-09-20.md`) :
- baseline exit OFF : +420.70 PnL, maxDD 246.83
- A 0.05/3 : +365.39, maxDD 55.62 (meilleur trade-off DD)
- A 0.02/2 : destructeur (−63)

## Où ça diverge le plus
1. **Grind sans rebond** : A sort, B ne sort pas (B plus patient / plus « structurel »).
2. **Micro-bruit 2–3¢** : A (surtout 0.02/2) sort trop ; B@50% filtre beaucoup plus.
3. **Timing** : même quand les deux finissent par sortir, B sort **après** le rebond de confirmation → pire fill potentiel (ask déjà remonté) mais moins de faux positifs.

## Recommandation (sans ship)
- **Ne pas remplacer A par B@50% à l'aveugle** : B coupe le grind (souvent le vrai risk-off) et retarde la vente.
- Si l'objectif est « moins de sorties sur bruit » : rester sur **A 0.05/3 loss-only** (déjà audité en PnL).
- Si l'objectif est ta sémantique de plus-bas : prototyper B avec `retraceRatio=0.5`, `minSwing=0.05`, `n=2` et `n=3`, **loss-only ON**, switch OFF — puis grille `runBacktest` (même univers que l'audit exit) avant d'activer.
- Le port `src/backtest/lower-lows.ts` + scripts Python existent déjà (ratio 0.25) : brancher un `favBandExitMode` OFF-by-default serait le prochain pas code, pas un flip de preset.

## Caveats
- Exemples = détecteurs isolés, pas fills FOK / bid L1 / loss-only.
- Float 0.60−0.55 peut valoir 0.049999 en IEEE : seuils exacts à tester en cents (le port TS raisonne déjà en cents).
- Pas de tableau PnL A vs B dans ce fichier faute de mode B dans le runner officiel.
