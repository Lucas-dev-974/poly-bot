# Configs par stratégie — dé-synchronisation des budgets hérités

> **Pour Hermes :** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal :** Chaque stratégie possède ses propres clés de budget/sizing — plus aucun paramètre de comportement partagé entre moteurs. Fav-band reçoit `favBandOrderUsdc` (sa propre clé) au lieu d'emprunter `cheapOrderUsdc` (calibré 1 USDC pour les jambes cheap de l'arb à 0.07–0.13, mathématiquement incompatible avec la bande fav 0.70–0.85 → moteur muet, cause racine de l'incident du 14/09 12:48→14:30).

**Architecture :** Le pipeline d'exécution (`kind: "cheap"/"expensive"` dans `opportunity-executor.ts`) reste inchangé — c'est le vocabulaire interne des jambes, pas un paramètre. Seule la couche config/sizing est découpée : nouveaux champs `BotConfig` par stratégie, remplacement des usages dans les stratégies, nouvelle validation de viabilité du sizing (le bug de fond : un budget qui ne peut jamais atteindre `MIN_CLOB_SHARES` dans la bande du moteur était accepté silencieusement), keys dashboard par stratégie, presets, graph custom, tests, docs.

**Tech stack :** TypeScript (ESM, tsx), node:test, SolidJS (frontend), JSON presets `config/presets/`.

---

## Contexte et décisions (à respecter tel quel — ce sont les décisions de design, pas à re-négocier par tâche)

### D1. Découpage des clés par stratégie (décision d'orchestrateur — à écrire dans chaque carte si délégué)

| Stratégie | Budget d'entrée (NOUVEAU/NOM EXISTANT) | Autres clés propres | Clés partagées (ne pas dupliquer) |
|---|---|---|---|
| `arb` | `cheapOrderUsdc` (existant, garde son nom) | `cheapBuyMin/Max`, `pairLockMax`, `arbAskLockOnly`, `arbAskSumMax`, `arbAskLockMinElapsedSec`, `arbAskLockMaxImbalance`, `expensiveBuyMin/Max`, `expensiveOrderUsdc`, `expensiveOrderType`, `requireCheapFillBeforeExpensive` | SHARED |
| `barbell` | `barbellCheapOrderUsdc` (NOUVEAU, défaut 15) | `barbellHedgeRatio`, + mêmes bandes arb | SHARED |
| `reverse` | `reverseCheapOrderUsdc` (NOUVEAU, défaut 15) | `reverseCancelCheapOffBand`, `reverseDefendEnabled`, `reverseMaxGridLevels`, `reverseHedgeCapToFilledCheap` | SHARED |
| `edge-lead` | `edgeCheapOrderUsdc` (existant ✓) + `edgeOrderUsdc` | déjà propre — rien à faire | SHARED |
| `fav-band` | `favBandOrderUsdc` (NOUVEAU, défaut **15**) | `favBandAskMin/Max`, `favBandMinElapsedSec`, `favBandMaxElapsedSec` | SHARED |
| `dip-revert` | `dipRevertOrderUsdc` (existant ✓) | déjà propre — rien à faire | SHARED |
| `custom:*` (graph) | `customOrderUsdc` (NOUVEAU, défaut 15) | — | SHARED |

Rationnel barbell : `barbellCheapOrderUsdc` plutôt qu'un `cheapOrderUsdc` "global retaillé" — le prix d'entrée barbell reste le cheap leg (0.07–0.13) mais l'usager veut un budget indépendant par moteur, pas une retaillé silencieux.

Rationnel défauts = 15 : cohérent avec `dipRevertOrderUsdc: 15` (valeur qui a prouvé qu'elle trade), et > plancher `MIN_CLOB_SHARES(5) × max(bande)`. Ne PAS réutiliser 1.

### D2. Le `kind: "cheap"` du pipeline NE change PAS
C'est un identifiant de jambe du pipeline (`opportunity-executor.ts`, `reverse-bot.ts`), lu par `orderTypeFor`, `manageLiveResting`, tracker keys (`makeKey(slug, outcome, "cheap", price)`). Le renommer casserait `trade_keys`, `posted_orders.key`, la réconciliation et le live DB pour zéro bénéfice config. Hors scope — noter dans le livrable que le vocabulaire pipeline reste.

### D3. `cheapOrderUsdc` reste la clé arb (pas de renommage)
Il est nommé, documenté et calibré pour l'arb ; le renommer (`arbCheapOrderUsdc`) casserait les presets existants `ask-lock/conservative/lock-harvest/coverage-max` + tous les work-DB backtest pour une lisibilité marginale. Décision : on garde, la doc clarifie qu'il est ARB-ONLY.

### D4. Viabilité du sizing = validation première classe
Nouveau helper `validateEngineBudget(usdc, bandMin, bandMax, label)` dans `src/utils/prices.ts` : throw si `usdc / bandMax < MIN_CLOB_SHARES` (aucune taille possible dans toute la bande). Appelé pour CHAQUE moteur dans `validateTradingConfig` (fav-band, dip-revert, edge-lead cheap+edge, reverse cheap, barbell cheap, custom). C'est le garde-fou qui rend l'incident impossible à reproduire : une config fav-band avec budget 1 sera rejetée au PATCH avec un message clair au lieu d'un moteur muet.

### D5. Stratégie de migration des données vivantes
- `data/bot-settings.json` (gitignored, LIVE) : migré au boot par un patch de compat (voir Task 1). Si la clé nouvelle manque mais l'ancienne existe, la nouvelle prend l'ancienne valeur (fav-band : 1 → **on force le défaut 15** pour fav-band spécifiquement, car 1 est le bug ; pour les autres, héritage mécanique).
- Presets `config/presets/*.json` : migrés dans le même commit (fichiers versionnés, pas de compat runtime nécessaire).
- `strategy_graphs` en DB : 2 graphs custom existants n'utilisent PAS `cheapOrderUsdc` (vérifié : `computeSize` absent des deux graphJson). Aucune migration DB nécessaire — les nouveaux graphs utilisent `customOrderUsdc` automatiquement.
- Backtests historiques (`backtest_runs`) : inchangés, ils portent leur snapshot de config.

### D6. UI — un champ par moteur, libellé clair
- `SettingsModal.tsx` : la section "Entrée fav-band" affiche `favBandOrderUsdc` ("Budget FOK favori (USDC)"), plus de renvoi à cheapOrderUsdc. La section arb garde `cheapOrderUsdc` avec label "Budget cheap leg arb (USDC)".
- `ConfigBar.tsx` : affiche le budget du moteur ACTIF (`strategyId` switch), pas une valeur générique.
- `BacktestPresetPanel.tsx` : le panel fav-band montre `favBandOrderUsdc`.

### D7. Docs/guide
- `README.md` (section config/stratégies), `STRATEGY.md` (si contrat sizing décrit), `frontend/src/guide/**` (tableaux config, onglet livrables si nécessaire) : mettre à jour les tableaux de clés par moteur.
- `.cursor/rules/strategy-guide-sync.mdc` déclenché : `npm run build` dans `frontend/` obligatoire après edits guide.

### D8. Ce qui ne bouge PAS (anti-scope-creep)
- `tests/presets.test.ts` liste d'IDs : aucune suppression/ajout d'ID de preset, seulement les valeurs de settings.
- Le schéma DB (aucune table à créer).
- `orderTypeFor`, `appendOpportunity`, `pickEdgeToken`, le pipeline FOK.
- Les moteurs edge-lead et dip-revert : déjà propriétaires de leurs budgets — zéro diff code, seulement presets/dashboard si nécessaire.

---

## Inventaire des usages à remplacer (ground truth, à re-vérifier au moment du patch)

`grep -rn "cheapOrderUsdc" src tests frontend/src config` → usages :
- `src/strategy/fav-band-strategy.ts:75` → `config.favBandOrderUsdc`
- `src/strategy/barbell-sizing.ts:25,36` → `config.barbellCheapOrderUsdc`
- `src/strategy/reverse-strategy.ts:91` → `config.reverseCheapOrderUsdc`
- `src/strategy/graph/ops.ts:255` → `config.customOrderUsdc`
- `src/strategy/arb-sizing.ts:111,121` → inchangé (arb)
- `src/config.ts:65,269` (type+défaut), `src/config.ts:532-533` (validation fav-band à étendre)
- `src/runtime-settings.ts` : EDITABLE_CONFIG_KEYS, SETTING_TO_ENV, parse switch, FAV_BAND_KEYS/BARBELL_KEYS/REVERSE_KEYS/CUSTOM_KEYS
- `tests/helpers.ts:14` (testConfig), 9 fichiers tests
- `frontend/src/utils/configForm.ts`, `frontend/src/types/index.ts:152`, `SettingsModal.tsx` (×2 sections), `ConfigBar.tsx`, `BacktestPresetPanel.tsx`
- `README.md` (table des paramètres)
- Presets : `fav-band.json`, `fav-band-opt.json`, `fav-band-opt-risk.json`, `dip-revert.json` (rien), `reverse.json`, `conservative.json`/`ask-lock.json`/`lock-harvest.json`/`coverage-max.json` (arb → rien)

---

## Tasks

### Task 1: Types + défauts config (`src/config.ts`)

**Objective:** Ajouter les 4 nouvelles clés au contrat BotConfig avec defaults sûrs.

**Files:**
- Modify: `src/config.ts` (interface ~ligne 65, defaults ~ligne 269)

**Steps:**
1. Interface `BotConfig` : ajouter
   ```ts
   favBandOrderUsdc: number;      // défaut 15
   barbellCheapOrderUsdc: number; // défaut 15
   reverseCheapOrderUsdc: number; // défaut 15
   customOrderUsdc: number;       // défaut 15
   ```
2. `loadDefaults()` : ajouter les 4 defaults à 15.
3. Migration boot : dans le parsing du settings file, si `favBandOrderUsdc` absent mais `cheapOrderUsdc` présent → utiliser **15** (jamais l'héritage 1, c'est le bug). Pour barbell/reverse/custom : hériter de `cheapOrderUsdc` si présent (comportement pré-patch équivalent, mais leur bande cheap 0.07–0.20 rendait 1 viable... SAUF si l'utilisateur a un preset custom : le plus sûr reste l'héritage mécanique pour ces 3, le défaut 15 ne s'applique que si AUCUNE valeur nulle part).
   - ⚠️ fav-band = cas spécial FORCÉ à 15 quelle que soit la valeur legacy. Commenter le pourquoi (incident 14/09).

### Task 2: Test viabilité budget + helper (`src/utils/prices.ts`)

**Objective:** TDD du garde-fou `validateEngineBudget`.

**Files:**
- Modify: `src/utils/prices.ts` (helper)
- Test: `tests/prices.test.ts`

**Steps:**
1. Failing test :
   ```ts
   // validateEngineBudget(1, 0.70, 0.85, "fav-band") throws
   // validateEngineBudget(15, 0.70, 0.85, "fav-band") ok
   // validateEngineBudget(1, 0.07, 0.13, "arb cheap") ok
   ```
2. Implémentation :
   ```ts
   export function validateEngineBudget(
     usdc: number, bandMin: number, bandMax: number, label: string,
   ): void {
     const minShares = Math.floor((usdc / bandMax) * 100) / 100;
     if (minShares < MIN_CLOB_SHARES) {
       throw new Error(
         `${label}: budget ${usdc} USDC cannot reach MIN_CLOB_SHARES (${MIN_CLOB_SHARES}) ` +
         `at band max ${bandMax} (needs >= ${(MIN_CLOB_SHARES * bandMax).toFixed(2)} USDC)`,
       );
     }
   }
   ```
3. Run `npm run test 2>&1 | grep -A5 prices` → PASS. Commit.

### Task 3: Wiring validation dans `validateTradingConfig`

**Objective:** Chaque moteur valide son budget contre sa bande au boot ET au PATCH runtime.

**Files:**
- Modify: `src/config.ts` (blocs `fav-band` ~515, `dip-revert` ~539, + nouveaux blocs barbell/reverse/custom si absents)
- Test: `tests/config.test.ts`

**Steps:**
1. Tests d'abord : config fav-band avec `favBandOrderUsdc: 1` → `validateTradingConfig` throw avec le message du helper ; idem barbell `barbellCheapOrderUsdc: 0.5`, reverse, custom.
2. Brancher `validateEngineBudget` dans chaque bloc stratégie existant :
   - fav-band : `validateEngineBudget(config.favBandOrderUsdc, config.favBandAskMin, config.favBandAskMax, "fav-band")`
   - dip-revert : idem sur `[dipRevertBandMin, dipRevertBandMax]`
   - barbell : sur `[cheapBuyMin, cheapBuyMax]` (bande cheap arbitraire du moteur)
   - reverse : idem
   - edge-lead : sur `[edgeCheapBandMin, edgeCheapBandMax]` pour `edgeCheapOrderUsdc`
   - custom : pas de bande statique → valider `customOrderUsdc / 0.99 >= MIN_CLOB_SHARES` (pire cas marché à 0.99)
3. `applyRuntimeSettings` appelle déjà `validateConfigCoherence` + `validateTradingConfig` → le PATCH 1 USDC est maintenant rejeté avec le message. Test runtime-settings : PATCH fav-band `favBandOrderUsdc: 1` → 400.
4. Run tests. Commit.

### Task 4: Stratégies consomment leurs clés

**Objective:** Chaque moteur lit son budget, plus d'emprunt.

**Files:**
- Modify: `src/strategy/fav-band-strategy.ts:75`, `src/strategy/barbell-sizing.ts:25,36`, `src/strategy/reverse-strategy.ts:91`, `src/strategy/graph/ops.ts:255`
- Test: `tests/fav-band.test.ts`, `tests/strategy.test.ts` (reverse), `tests/strategy-graph-parity.test.ts`

**Steps:**
1. Remplacer les 5 usages (inventaire ci-dessus). Un diff d'une ligne par site.
2. `tests/helpers.ts` : ajouter les 4 clés au `testConfig` (contrat de config, cf. skill repo).
3. `tests/fav-band.test.ts` : remplacer `cheapOrderUsdc: 15` par `favBandOrderUsdc: 15` (4 sites) + ajouter un test : budget 1 → AUCUNE opportunité mais (nouveau) un event d'erreur config au boot (couvert par Task 3, ici on assert juste le mute sizing à budget insuffisant si validate court-circuité en backtest job).
4. Run `npm run test` full → PASS (baseline d'abord : compter pass/fail AVANT toute modif, cf. skill reverse-arbitrage-bot-research). Commit.

### Task 5: runtime-settings (clés éditables + env + presets sanitize)

**Objective:** Dashboard peut éditer les nouvelles clés, par stratégie.

**Files:**
- Modify: `src/runtime-settings.ts` (EDITABLE_CONFIG_KEYS, SETTING_TO_ENV ~95, parse case ~249, FAV_BAND_KEYS:432, BARBELL_KEYS:399, REVERSE_KEYS:412, + CUSTOM_KEYS)
- Test: `tests/runtime-settings.test.ts`

**Steps:**
1. Ajouter les 4 clés à `EDITABLE_CONFIG_KEYS` + aliases env + parse (number).
2. `FAV_BAND_KEYS` : remplacer `"cheapOrderUsdc"` par `"favBandOrderUsdc"`. `BARBELL_KEYS` : ajouter `barbellCheapOrderUsdc` (garder/remplacer cheapOrderUsdc selon usages barbell réels — arb-sizing partagé ? NON : barbell-sizing.ts:25 lit déjà sa propre jambe, remplacer). `REVERSE_KEYS` : ajouter `reverseCheapOrderUsdc` (remplacer cheapOrderUsdc:419). Créer `CUSTOM_KEYS = [customOrderUsdc, ...]` et le brancher dans `keysForStrategy` (case custom → CUSTOM_KEYS ; arb+custom partagent le fallback actuel — vérifier : `keysForStrategy` ligne 482 commente "arb + custom sans leadsWithEdge" → séparer).
3. Tests : keysForStrategy("fav-band") contient favBandOrderUsdc et PAS cheapOrderUsdc ; sanitizePatch refuse les clés d'un autre moteur quand strategyId switch (le switch fav-band→arb doit appliquer les ARB_KEYS, le PATCH contenant favBandOrderUsdc est ignoré → vérifier le comportement switch existant, aligner le test).
4. Run tests. Commit.

### Task 6: Presets migrés

**Objective:** Les presets fav-band/reverse/barbell portent les nouvelles clés avec valeurs saines.

**Files:**
- Modify: `config/presets/fav-band.json`, `fav-band-opt.json`, `fav-band-opt-risk.json` (remplacer `"cheapOrderUsdc": 15` → `"favBandOrderUsdc": 15` — les 3 presets ont DÉJÀ 15, donc comportement inchangé)
- Modify: `config/presets/reverse.json` si cheapOrderUsdc présent → `reverseCheapOrderUsdc` (même valeur)
- Test: `tests/presets.test.ts`

**Steps:**
1. Éditer les JSON (garder CRLF si présent).
2. `tests/presets.test.ts` : mettre à jour les assertions de valeurs si elles référencent cheapOrderUsdc pour fav-band (ligne ~80 : `favBand.settings.favBandAskMin` — vérifier si une assertion budget existe).
3. Run `npm run test 2>&1 | grep -A12 "not ok"` → presets passe. Commit.

### Task 7: Frontend — formulaire, ConfigBar, backtest panel

**Objective:** L'UI affiche le budget du moteur actif, plus d'alias.

**Files:**
- Modify: `frontend/src/utils/configForm.ts` (state + fromConfig + patch)
- Modify: `frontend/src/types/index.ts:152` (type)
- Modify: `frontend/src/components/modals/SettingsModal.tsx:511(arb), 950-956(fav-band → favBandOrderUsdc), + sections dip/barebell/reverse si cheapOrderUsdc y est référencé`
- Modify: `frontend/src/components/layout/ConfigBar.tsx:19` (switch strategyId)
- Modify: `frontend/src/components/backtest/BacktestPresetPanel.tsx:70,189,194` (cheapKeys + champs fav → favBandOrderUsdc)
- Verify: `npm run build` in `frontend/`

**Steps:**
1. configForm : ajouter les 4 champs string au state + `fromConfig` (String(config.favBandOrderUsdc ?? 15)) + parsing patch.
2. SettingsModal : section fav-band → champ `favBandOrderUsdc` (hint : "Budget FOK favori (USDC). Taille = budget / ask, plafonnée par max shares."). Section arb garde cheapOrderUsdc. Vérifier la section barbell/reverse : grep cheapOrderUsdc dans SettingsModal (ligne 511 = section arb/expensive ; s'assurer qu'elle appartient bien à arb avant de la laisser).
3. ConfigBar : `Cheap {c().cheapBuyMin}–{c().cheapBuyMax} · {c().cheapOrderUsdc} USDC` → afficher selon `strategyId` : fav-band → `Fav {favBandAskMin}–{favBandAskMax} · {favBandOrderUsdc} USDC`, dip-revert idem, arb/barbell/reverse → cheap actuel.
4. BacktestPresetPanel : favBand keys list + Num field swap.
5. `cd frontend && npm run build` → PASS. Commit.

### Task 8: Docs + guide (règle .cursor)

**Objective:** La doc décrit la nouvelle politique config par moteur.

**Files:**
- Modify: `README.md` (table des paramètres)
- Modify: `STRATEGY.md` si le contrat sizing y est décrit
- Modify: `frontend/src/guide/data.ts` / `GuideTabs.tsx` si des tableaux listent cheapOrderUsdc comme budget fav-band
- Verify: `npm run build` in `frontend/`

**Steps:**
1. Grep `cheapOrderUsdc` dans README.md, STRATEGY.md, frontend/src/guide/** → remplacer les mentions fav-band/dip-revert par les clés dédiées ; ajouter une ligne "budgets par moteur" dans le README.
2. Build frontend. Commit.

### Task 9: Vérification finale live (non-codée : procédure manuelle)

**Objective:** Prouver le fix sur le live.

**Steps:**
1. Redémarrer le bot (le process tsx watch recharge) avec settings migrés.
2. Vérifier DB : `SELECT * FROM bot_state` / événements — à la prochaine traversée de bande, `opportunity_snapshots` doit recevoir des lignes `kind=cheap` avec le nouveau budget.
3. Un FOK part si ask dans bande → `openedPosition` event.

---

## Risks / tradeoffs

1. **Preset back-compat** : un ancien preset JSON user-side (hors repo) avec seulement cheapOrderUsdc chargé sur fav-band → migration Task 1 force 15 pour fav-band. Barbell/reverse héritent (mécanique), OK car leur bande 0.07–0.13 rend 1 viable... mais si l'utilisateur avait calibré autrement, l'héritage mécanique préserve exactement le comportement pré-refactor. Documenté.
2. **Custom graphs futurs** : `customOrderUsdc` unique par graph — deux graphs custom ne peuvent pas avoir des budgets différents en même temps. Accepté (les 2 graphs actuels n'en utilisent pas ; extensibilité future : clé par graph dans graphJson si besoin réel).
3. **Backtest engine** : `src/backtest/job.ts` ne référence pas cheapOrderUsdc directement (vérifié) mais les presets backtest passent par RuntimeSettingsPatch → sanitizePatch doit accepter les nouvelles clés (sinon backtest casse). Test : lancer un backtest fav-band en dry.
4. **Le kind "cheap" pipeline reste** : risque de confusion future — mitigé par D2 (commentaire déjà présent dans fav-band-strategy.ts) + README "budgets par moteur".
5. **`tests/presets.test.ts`** : suite fragile aux presets (pitfall connu du skill) — si elle échoue après Task 6, diff expected ids vs config/presets/ et vérifier les valeurs exactes.

## Open questions (aucun bloquant — décisions prises par défaut, à contester avant exécution)
- Défauts 15 USDC partout : OK ? (aligné dip-revert ; maxExposureUsdc actuel = 15 → un seul ordre à la fois, cohérent)
- `customOrderUsdc` : validation pire-cas à 0.99 — acceptable ?
- Barbell/reverse : garder aussi `cheapBuyMin/Max` SHARED (bandes cheap identiques arb/barbell/reverse) ou les dupliquer aussi ? Décision : SHARED (ce sont les bandes du marché, pas du budget) — à confirmer si l'utilisateur veut un cloisonnement total.

## Plan de test global
1. Baseline : `npm run test` (compter pass/fail) + `npm run build` AVANT modif.
2. Après chaque task : `npm run test 2>&1 | grep -A12 "not ok"` (trace les fails).
3. Frontend : `cd frontend && npm run build`.
4. Final : backtest dry d'un preset fav-band + redémarrage live (Task 9).