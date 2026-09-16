# Flip-confirm — retournement confirmé (entrée [120,180]s)

> Univers 393 fenêtres BTC 15m (801+ ticks, gaps ≤ 60s), calibration runner officiel ±0.26% fills.
> Rapport complet : `research-new-strats/new-strategies-report-1789460471772.md`

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

## Config JSON

```json
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
```
