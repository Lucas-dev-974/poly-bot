# 3 nouvelles stratégies — backtest calibré (2026-09-15)

Univers : **393 fenêtres BTC 15m complètes et résolues** (>800 ticks, gaps ≤ 60s), source data/bot-live.db (lecture seule). Période : 2026-09-08T06:30:00.000Z → 2026-09-15T03:45:00.000Z.

Calibration sim ↔ runner officiel (sonde fav-band, même univers) : **387 fills / $293.15 / WR 77.3%** (sim) vs **386 fills / $308.57 / WR 77.5%** (runner officiel `runBacktest`) — écart 0.26% fills. Les résultats ci-dessous ont donc un statut de backtest calibré.

## Résultats (hold-to-resolution, $15/ordre, 30 shares max, FOK ask + depth guard)

| Stratégie | Fills | WR | PnL | DD max | EV/share | Prix moyen | PnL/notional | Jours +/- | Variance (std/\|PnL\|) | t-stat |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| **antiflip-revert** | 232 | 52.2% | 622.80 | 103.20 | $0.09 | 0.432 | 20.7% | 6/2 | 0.16 | 2.74 |
| **early-conviction** | 219 | 67.6% | 330.41 | 82.16 | $0.06 | 0.615 | 10.1% | 6/2 | 0.13 | 1.93 |
| **flip-confirm** | 188 | 66.5% | 389.35 | 79.41 | $0.08 | 0.581 | 13.8% | 6/2 | 0.111 | 2.44 |

### 1. antiflip-revert — favori déchu après flip récent

```
Signal : le favori d'identité FLIPPE (elapsed >= 240s), le nouveau favori
        cote 0.45-0.65, on achète l'ANCIEN favori (ask 0.35-0.45, floor 0.40)
        dans les 90s suivant le flip. Hold to resolution.
Thèse  : sur-réaction au retournement — l'ancien favori re-gagne ~52%
        alors qu'il cote ~0.43 (EV +9¢/share).
Contrôle causal : sans la condition flip → +$147 ; flip ancien (>180s) → +$2.7 ;
        flip récent → +$623. Le flip récent EST le signal.
Split-half : OLD +$380 / NEW +$242 — positif des deux côtés.
Robustesse tie-break : 3/232 entrées déclenchées par un flip d'égalité
        pure ; avec hystérésis (flip si lead >= 1 tick) PnL +$651 — pas
        un artefact de tie-break.
Profil d'entrée (elapsed) : l'essentiel du PnL vient de 240-360s (+$428,
        n=141) et 600-720s (+$184, n=25) ; les entrées 720-840s sont
        légèrement négatives (−$19, n=13) — exécutable en live.
```

### 2. early-conviction — conviction immédiate du marché

```
Signal : dans les 45 premières secondes, le favori cote déjà >= 0.60 (<= 0.80).
        On l'achète immédiatement. Hold to resolution.
Thèse  : un marché qui se fixe instantanément est un trend fort — le favori
        gagne 67.6% à un prix moyen de 0.615 (EV +6¢/share), drawdown $82.
Split-half : OLD +$96 / NEW +$235 — positif des deux côtés.
```

### 3. flip-confirm — retournement confirmé en fenêtre médiane

```
Signal : un flip survient tôt dans la fenêtre ; <= 90s après ce flip, on
        achète le NOUVEAU favori s'il cote 0.55-0.65, en elapsed [120,180]s.
        (La fenêtre [120,180] est le timing d'ENTRÉE ; le flip, lui, date de
         <= 90s avant l'entrée.) Hold to resolution.
Thèse  : les retournements confirmés en première mi-temps sont informatifs,
        les flips tardifs sont du bruit (entrées m180+ dégradent). WR 66.5%.
Split-half : OLD +$259 / NEW +$130 — positif des deux côtés.
Robustesse tie-break : 0 entrée sur flip d'égalité pure ; avec hystérésis
        (flip si lead >= 1 tick) le PnL monte à +$404 — pas un artefact.
```

## Axes morts (ne pas re-balayer)

- **cheap-leader** (askSum < 1.00) : −$12 à −$47, askSum ne prédit rien.
- **fav-streak** (gate de stabilité) : dominé par fav-band existant sur la même bande (+$156 vs +$293).
- **late-lock** (favori tardif 600-840s) : −$46 à −$109, le favori tardif est pricé juste.
- **lotto underdog** (ud <= 0.12, fav >= 0.88) : −$138 à −$212, WR 7-10% insuffisant.
- **whipsaw** (double flip) : +$147 full mais OLD +$289 / NEW −$142 — pari de régime.
- **winstreak n3** (continuité cross-fenêtre) : +$113 mais 65 fills seulement, échantillon mince ; rejeté pour prudence.
- **flipconfirm hors fenêtre [120,180]** : s'effondre (m180 −$227, m240 −$652).

## Config des stratégies (paramètres retenus)

```json
[
  {
    "label": "antiflip-revert",
    "family": "antiflip",
    "minElapsedSec": 240,
    "maxElapsedSec": null,
    "bandMin": 0.35,
    "bandMax": 0.45,
    "maxSpread": 0.05,
    "orderUsdc": 15,
    "maxShares": 30,
    "flipLookbackMs": 90000,
    "deposedAskMin": 0.4
  },
  {
    "label": "early-conviction",
    "family": "firstfav",
    "minElapsedSec": 0,
    "maxElapsedSec": 45,
    "bandMin": 0.6,
    "bandMax": 0.8,
    "maxSpread": 0.05,
    "orderUsdc": 15,
    "maxShares": 30
  },
  {
    "label": "flip-confirm",
    "family": "flipconfirm",
    "minElapsedSec": 120,
    "maxElapsedSec": 180,
    "bandMin": 0.55,
    "bandMax": 0.65,
    "maxSpread": 0.05,
    "orderUsdc": 15,
    "maxShares": 30,
    "flipLookbackMs": 90000
  }
]
```

## Réserves honnêtes

- Univers mono-régime (8 jours, BTC 15m uniquement) : les WR/PnL sont mesurés sur un seul régime de volatilité. Le t-stat le plus haut est 2.7 ; early-conviction (1.93) reste SOUS le seuil conventionnel de 2.0 — signal prometteur mais non significatif à lui seul.
- Chevauchement mesuré : antiflip ∩ flip-confirm = 129 fenêtres communes (même côté 73, opposé 56), antiflip ∩ early-conviction = 120 (même côté 72), flip-confirm ∩ early-conviction = 80 (même côté 30, opposé 50). Les trois PnL ne s'additionnent PAS : en combinant 2 moteurs, la somme des deux notionaux sur les fenêtres communes s'expose doublement au même résultat.
- antiflip-revert a le meilleur PnL mais le WR le plus bas (52%) : la variance par trade est élevée (avgWin $17.0 vs avgLoss $12.9) — sizing prudent requis.
- Les implémenter en moteurs natifs exigera le wiring complet (6 touch points config + guide frontend), cf. references/new-strategy-wiring.md.
