# Early-conviction — conviction immédiate du marché

> Univers 393 fenêtres BTC 15m (801+ ticks, gaps ≤ 60s), calibration runner officiel ±0.26% fills.
> Rapport complet : `research-new-strats/new-strategies-report-1789460471772.md`

### 2. early-conviction — conviction immédiate du marché

```
Signal : dans les 45 premières secondes, le favori cote déjà >= 0.60 (<= 0.80).
        On l'achète immédiatement. Hold to resolution.
Thèse  : un marché qui se fixe instantanément est un trend fort — le favori
        gagne 67.6% à un prix moyen de 0.615 (EV +6¢/share), drawdown $82.
Split-half : OLD +$96 / NEW +$235 — positif des deux côtés.
```

## Config JSON

```json
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
}
```
