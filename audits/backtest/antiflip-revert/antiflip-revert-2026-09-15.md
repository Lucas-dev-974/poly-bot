# Antiflip-revert — favori déchu après flip récent

> Univers 393 fenêtres BTC 15m (801+ ticks, gaps ≤ 60s), calibration runner officiel ±0.26% fills.
> Rapport complet : `research-new-strats/new-strategies-report-1789460471772.md`

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

## Config JSON

```json
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
}
```
