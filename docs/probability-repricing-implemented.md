# Probability Repricing — implémenté (v1)

**strategyId :** `probability-repricing`

## Activation

1. **Preset :** charger `config/presets/probability-repricing.json` via le dashboard / API presets
2. **Ou** dans `data/bot-settings.json` : `"strategyId": "probability-repricing"` + knobs `repricing*`

## Hypothèse v1

- Mode principal **C** : dislocation ask vs historique court CLOB (z-score / cheapness)
- Mode **A** optionnel : `repricingModeAEnabled` (rebond après drop)
- **Pas** de momentum pur B

## Feed externe

Aucun Binance/spot dans ce bot → le signal utilise l'historique ask CLOB.
`repricingFeedMaxAgeMs` est un **placeholder** (ignoré tant qu'aucun feed age n'est branché).

## State machine

`IDLE → ARMED → ENTERING → OPEN → EXITING → FLAT` (+ `HALTED`)

`forced_settlement` est loggé (phase FLAT + flag) si inventaire encore ouvert à τ≤0 — compté comme **échec d'exit**.

## Prix

- Entry : **ask** exécutable (FOK)
- Exit / edge_est : **bid** exécutable (jamais mid)

## Notes audit (2026-09-20)

- Entry/exit decisions use **ask/bid** only (never mid).
- `edge_est` = `targetAbs - feesRoundtrip - slipEntry - slipExit` (no spread drag; TP is vs entry ask).
- Dislocation z-score uses **prior** ask history (current ask sampled after scoring).
- `signal_ttl`: ARMED/ENTERING expires without refreshing `armedTs`; re-arm requires a tick without signal.
- Partial defend → `onDefendCommitted` marks FLAT; next tick resurrects OPEN if inventory remains.
- `repricingFeedMaxAgeMs` remains a placeholder (no external feed age yet).
