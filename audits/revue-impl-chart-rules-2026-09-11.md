# Revue d'implémentation — éditeur / chart-rules / graph (2026-09-11)

## Périmètre

Diff local non poussé sur `polymarket-reverse-arbitrage-bot` (pas de remote Git) :
moteur `ChartRulesStrategy`, interpréteur `GraphStrategy`, persistence `strategy_graphs`,
API dashboard, frontend `strategy-editor`, backtest wiring, tests associés.

## Bugs corrigés

### Critique — horloge GraphStrategy (`src/strategy/graph/interpreter.ts`)

`shouldSellExpensiveEdge` et `hedgeAtPostTime` forçaient `gctx.nowMs = Date.now()`,
ignorant `ctx.nowMs`. En backtest, les ops temporels (`holdTrueFor`, `secondsElapsed`, …)
sur le chemin sell/hedge lisaient l'horloge murale → faux timers / non-déterminisme.

**Fix :** `methodClock(ctx.nowMs)`. `HedgePostContext` expose maintenant `nowMs?`,
branché depuis `backtest/runner.ts` et `bot/opportunity-executor.ts`.

### Majeur — mélange ask/bid dans les samples chart (`chart-rules-strategy.ts`)

`findOpportunities` / resting poussaient le **bestAsk** favorite dans la même série
que `shouldSellExpensiveEdge` (best **bid**). Une règle sell en tendance lisait donc
un mélange ask+bid → pentes fantômes.

**Fix :** clés `pairId::token::ask|bid`. Les sells favorite trendent sur `bid` ;
buys et sells cheap restent sur `ask`.

### Majeur — `sellAll` mort (UI + schéma)

Checkbox « Tous vendre » en éditeur, champ validé, **jamais lu** par le moteur
(qui liquéfie déjà toute la position fillée).

**Fix :** UI remplacée par un hint honnête ; `normalizeChartRule` défaut `sellAll: true`
pour les sells ; `sellAll === false` désactive la règle (pas de vente partielle).

### Note — `afterFill` sur les sells

Laissé tel quel : les chemins sell sont déjà gated par la position fillée
(`expensiveSize` / `filledCheap`). Forcer `afterFillReady` via le tracker
cassait les cas où le contexte porte la taille sans fill tracker miroir.

## Dead code / dettes laissées

| Item | Statut |
|------|--------|
| Méthodes graph ignorées si `chartRules.length > 0` (`createStrategy`) | Intentionnel — chemin chart prioritaire |
| `GraphStrategy.edgeOrderAction` = bandes config globales (pas le graph) | Limitation connue ; chart-rules a son propre path |
| Champ `sellAll` encore dans le schéma JSON | Conservé pour compat ; `false` = disable |
| `model-ia/` untracked | Hors revue moteur ; non touché |
| `StrategyGraphRepository.get` mute `leadsWithEdge` DB au read | Side-effect surprenant, non bloquant |

## Fichiers touchés par cette revue

- `src/strategy/graph/interpreter.ts`
- `src/strategy/trading-strategy.ts`
- `src/strategy/chart-rules-strategy.ts`
- `src/strategy/chart-rule.ts`
- `src/strategy/graph/types.ts`
- `src/backtest/runner.ts`
- `src/bot/opportunity-executor.ts`
- `frontend/src/strategy-editor/ChartRulePanel.tsx`
- `tests/strategy-graph-temporal.test.ts` (régression horloge)
- ce fichier

## Tests

`tests/strategy-chart-rules.test.ts` + `tests/strategy-graph-temporal.test.ts` : **34/34 pass**.

## Suivi recommandé

1. Brancher un remote Git et ouvrir une PR du diff complet.
2. Étendre `GraphStrategy` avec une méthode `edgeOrderAction` graph-native si des customs sans chartRules en ont besoin.
3. ~~Test non-mélange ask/bid~~ — fait (`falling asks must not fake…`).
4. ~~Guide once / dependsOn~~ — fait (éditeur + onglet Livrables).
