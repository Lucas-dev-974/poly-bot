# Implémentation open-entry — moteur natif (2026-09-19)

Moteur `open-entry` livré de bout en bout : backend (moteur + config + runtime-settings + presets + tests), frontend (types + settings dialog + presets), guide pédagogique, validation runner officiel avec contrôle hold.

## Fichiers livrés

**Backend**
- `src/strategy/open-entry-strategy.ts` — moteur complet
- `src/strategy/ids.ts`, `src/strategy/registry.ts` — enumeration + factory
- `src/config.ts` — 11 clés `openEntry*` (10 numériques + switch `openEntrySlEnabled`), defaults = config exactement backtestée, validation `validateConfigCoherence` complète (ranges + invariant `slLateDist ≤ slStructDist` + `validateEngineBudget`)
- `src/runtime-settings.ts` — 4 points (EDITABLE_CONFIG_KEYS, ENV_ALIASES, parseField, OPEN_ENTRY_KEYS + branch keysForStrategy)
- `tests/helpers.ts` (testConfig), `tests/open-entry.test.ts` (16 tests), `tests/presets.test.ts` (ID list + filter), `package.json` (test ajouté)
- `config/presets/open-entry.json` — preset UI/backtest avec les valeurs backtestées

**Frontend**
- `frontend/src/types/index.ts` — `NativeStrategyId` + BotConfig
- `frontend/src/utils/configForm.ts` — form state + configToForm + formToSettings + coercions hedge + `validateConfigForm` + `fieldErrors` (miroir 1:1 du backend)
- `frontend/src/config/strategyPresets.ts` — import + option + preset
- `frontend/src/components/modals/SettingsModal.tsx` — section `openentry` (11 champs + hints chiffrés), garde `isDirectionalHold`, applyPreset + engine-select
- `frontend/src/guide/data.ts` — EngineId, ENGINE_META, RESOLUTION_ROWS, BOT_STEPS, lifecycle OPENENTRY_LIFE_*, STRATEGY_COMPARE_ROWS élargi à 10 colonnes (tuple + lignes lockstep), NEW_FILES
- `frontend/src/guide/GuideTabs.tsx` — pill, lifecycle card, `<Show>` story, composant `OpenEntryStory` (mécanique + callout volatilité-vs-espérance + table + étapes)

## Fidélité au signal backtesté

- **Fair gate mémorisée** : évaluée au PREMIER tick deux-côtés puis mémorisée par paire (la sim validée mesurait l'ouverture au 1er tick). La 1ʳᵉ version ré-évaluait chaque tick : 827 fills / per-fill $0.41 (dilution) → corrigé, 555 fills / per-fill $0.59.
- **Entrée FOK full-depth L1 + retry** (jamais de blocage après kill — règle dip-revert).
- **SL dual-scale via pipeline defend** (`usesDefendAsExit`, précédent dip-revert TP) : aucun changement du runner. `onBuyCommitted` ancre le prix d'entrée réel ; état par paire (entry price, flip adverse depuis, fenêtre dérivée du slug — pas de 900 en dur) avec purge anti-fuite.
- **Triggers honnêtes au bid** : le runner vend au bid L1 full-size ; le trigger s'arme sur `cheapAsk ≤ entry − dist − 1 tick` pour que le bid réel ≤ trigger au fill (worst-price).

## Validation runner officiel (830 fenêtres, `wiring-runner.mts`)

| Run | fills | PnL | WR | SELL defend | rejects |
|---|---|---|---|---|---|
| wired (SL ON) | 918 trades (555 BUY) | $329.73 | 34.6 % | 363 | 0 |
| hold-ref (SL OFF) | 555 | $365.22 | 63.4 % | 0 | 0 |

**Verdict delta : hold $365 > wired $330** à sizing runner (exits L1-only, bid). Contrairement à la sim de recherche (3 niveaux + sizing 10-15$, +$471 vs $351), le runner fait payer les SL : chaque stop vend au bid L1 exact, et le trigger sur ask (−1 tick) coupe avant le bid. C'est l'inverse du signal sim — le runner décide (règle du repo).

- Sim calibrée (hold, entrée identique) : 418 fills / $1.05-per-fill / WR 65.8 % ↔ runner 485 / $0.97 / 65.6 % — cohérent.
- La valeur défendable des SL : **volatilité** (pertes coupées, WR par trade plus bas mais pertes par trade lissées) et **profondeur L2/L3 en live** (le runner ne peut pas vendre au-delà du L1 — la valeur sim vient du walk bid2/bid3).
- Overlap early-conviction : 478/511 même côté — PnL non additifs, un seul des deux moteurs par marché en pratique.

## Vérification

- `npm run build` : vert
- `npm run test` : **448/448** (dont 16 tests open-entry : émission UP/DOWN, fenêtre, lean, fair gate, spread, profondeur, anti-stack, coercions sticky, validation SL incohérent, trigger SL struct (flip+degât), refus sans flip confirmé, SL tardif avant/après, hedge skip)
- `npm --prefix frontend run build` : vert (dist 420 kB)
- `<Show>` SettingsModal 37/37, GuideTabs 21/21 (pas de section fantôme)

## Livrables audits

- `audits/backtest/open-entry/rapport-open-entry.md` — recherche complète
- `audits/backtest/open-entry/open-entry-wiring-runner-*.json` — runs wired/hold
- `scripts/research/open-entry/*` — scripts de recherche et de validation réutilisables