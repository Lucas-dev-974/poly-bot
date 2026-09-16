# TODO — Audit du code base (reverse-arbitrage-bot)

> Audit fait en lisant le code directement (pas de doc). Passes 1-2 + vérifications croisées.
> Marqueur **[VÉRIFIÉ ✅]** : point contrôlé, verdict noté. Les items sans marqueur restent à faire.

---

## 1. Configuration & secrets

- [x] **[VÉRIFIÉ ✅]** Lignes « tronquées » de `src/config.ts` (360/369/372, `toPublicConfig` 436-442) : artefact de redaction de secrets de l'outil de lecture (masquage `process.env.*_API_KEY` / destructuring). `npx tsc --noEmit` passe (exit 0), le fichier sur disque est complet et correct. Aucune action code nécessaire.
- [x] **[VÉRIFIÉ ✅]** `toPublicConfig` : destructuring valide, tous les champs secrets omis (`privateKey`, `clob*`, `builder*`, `relayer*`). Aucune fuite par `bus.emit(config)`.
- [x] **[VÉRIFIÉ ✅]** Couche runtime-settings : `relayerApiKey` / `relayerApiKeyAddress` absents de `FORBIDDEN_KEYS` mais rejetés par `isEditableKey` (pas dans `EDITABLE_CONFIG_KEYS`) → « Unknown field ». Double protection OK.
- [ ] Vérifier la cohérence `signatureType` (défaut 3 = POLY_1271 deposit wallet) entre trader, relayer et le wallet réel utilisé.
- [ ] Vérifier que `RELAYER_API_KEY_ADDRESS` est bien configuré comme le signer EOA (le code fallback sur `account.address`, jamais sur funderAddress — bon), et qu'un mauvais alias env ne casse pas silencieusement le quota dédié.

---

## 2. Validation & cohérence config

- [x] **[VÉRIFIÉ ✅]** `validateConfigCoherence` couvre les 6 moteurs natifs : bandes cheap/expensive croisées, pairLockMax [0.90, 1.00[ (arb), barbellHedgeRatio (0,1], reverseMaxGridLevels, fav-band (bandes + elapsed + sticky flags forcé off), dip-revert (bandes + drop + elapsed + spread), edge-lead (bandes, samples, budgets, sizing modes).
- [x] **[VÉRIFIÉ ✅]** `keysForStrategy` : chaque moteur n'expose que ses clés (SHARED + strategy keys), les clés d'un autre moteur sont ignorées au PATCH live. `simRequireCoveredPair` confirmé mort (commentaire orchestrate + omis de ARB_KEYS/BARBELL_KEYS) — gardé dans EDITABLE pour compat JSON/presets.
- [ ] Décider du sort de `simRequireCoveredPair` : suppression propre (code + presets + types) ou maintien tel quel. Le flag est mort partout.
- [ ] Vérifier que `applyRuntimeSettings` restaure bien le snapshot sur TOUTES les erreurs (validate + write) — lu, semble correct (try/catch + restoreSnapshot), mais ajouter un test qui couvre le cas `writeRuntimeSettings` échoue (disque plein) après validation passée.
- [ ] Custom graphs : la validation ne connaît que `validateStrategyGraph` (structure graph). Vérifier qu'aucun paramètre config utilisé par un graph custom (via `param.kind === "config"`) peut être absent/invalide sans erreur de démarrage — `validateTradingConfig(config, { leadsWithEdge })` est appelé au boot avec leadsWithEdge du graph, mais les clés ARB génériques restent les seules éditables.

---

## 3. Exécution live & ordres

- [ ] Confirmer qu'un « defend » issu de `hedgeAtPostTime` (executor) ne double pas l'action du defend par tick (`resting-manager.defendUncoveredPairs`) dans le même tick : les deux chemins appellent `defendPair(pairId)` — la protection passe par `defendShares`/`shouldDefend` réévalués avec fresh book, pas par un lock. Vérifier qu'un FOK SELL en vol + un second déclenchement même tick ne vendent pas deux fois (fenêtre de course entre les deux appels `placeSell`).
- [x] **[VÉRIFIÉ ✅]** Keys stables (`policy-a-defend:`, `defend:`, `edge-sell:`, `manual-close:`, `cheap-missing:`) : préfixes distincts de `makeKey(slug:outcome:kind-price)`, aucune collision possible par construction.
- [ ] Vérifier la gestion du « defend » quand `placeSell` échoue réseau (throw) : `defendPair` catch et log, mais `cheap-missing` / Policy-A tradeKey restent marqués — confirmer qu'un retry est possible au tick suivant (le key `policy-a-defend:` reste marké volontairement — c'est voulu pour éviter le spam, mais un défend raté par réseau ne se re-tentra jamais pour cette paire ; acceptable si le band-defend par tick prend le relais, à confirmer).
- [x] **[VÉRIFIÉ ✅]** Retry/mark FOK : killed → incrementRetry, mark permanent à `simMaxRetryAttempts`, émission dashboard max 1 fois (retries === 1). Idempotent.
- [ ] Vérifier `order-type.ts` (`orderTypeFor`) : **LU en passe 3** — logique confirmée : override `opportunity.orderType` prioritaire (fav-band FOK, ask-lock dual-FOK), sinon FOK pour expensive si `expensiveOrderType === "FOK"` et pas leadsWithEdge, sinon GTC. Conforme à l'exécution (executor `useFOK = orderTypeFor(...) === "FOK"`). Véridié, aucun fix requis.
- [ ] Vérifier `tick-snapshots.ts` : non lu (insertion/prune snapshots + emitStats).
- [ ] Vérifier `resting-manager.replaceMarketableCheap` : après cancel partiel, le `updatePostedRemainder` est appelé par finalizeLiveOrder — confirmer la chaîne complète (cancel → status re-read → finalize → remainder persisté).

---

## 4. Persistance & reprise après crash

- [x] **[VÉRIFIÉ ✅]** Réconciliation posted/open : `postedOverlapsOpen` match par CLOB orderId (`live:<orderId>`), fallback tokenId+pairId+kind ; `postedWorkingRemainder` ne compte que le remainder non couvert. Les fills partiels shrink le posted (INSERT OR REPLACE). Le double-comptage post-crash est couvert.
- [x] **[VÉRIFIÉ ✅]** Catch-up finalization à `loadFromDb` : paires non résolues avec toutes les jambes résolues → finalizePair. Paires 'open' sans jambes attendent.
- [ ] Vérifier le window claim : `pruneWindowClaims` parse `/:(\d{10})$/` sur le pairId — si `windowEnd` n'est pas 10 chiffres (horloge 2038+ ou slug custom), le claim n'est jamais pruné. Faible proba, à confirmer.
- [ ] Vérifier `db/database.ts` + `repositories.ts` : non lus (schéma, migrations, index, WAL).
- [ ] Vérifier la rétention snapshots (market/book/opportunity) et le prune 1h vs volumes réels.

---

## 5. Résolution de positions

- [ ] Vérifier que `outcomeIndex` est rempli dans TOUTES les créations de position (FOK executor : `opportunity.token.outcomeIndex` ; GTC lifecycle : `order.outcomeIndex` du posted context ; défense/manual : token du book `outcomeIndex ?? 0`). Le fallback extractWinner par nom d'outcome est prioritaire — l'index n'entre que si le nom ne matche pas. Cas à couvrir : `outcomes` Gamma renommés ("Up"/"Down" vs "Yes"/"No").
- [ ] Confirmer le seuil 0.99/0.01 contre les marchés à prix de settlement intermédiaire (0.9995/0.0005 : couvert ; un settlement à 0.5/0.5 (void/50-50) n'est pas géré → position reste open pour toujours ; vérifier si ce cas existe sur les 15m).
- [x] **[VÉRIFIÉ ✅]** Double-compte PnL : guard `status !== "open"` dans resolvePosition + `pruneResolvedPosition` sans recompte ; `finalizePair` écrit realizedPnl une fois (guard `pair.status !== "resolved"`).
- [ ] Vérifier `resolveDue` : interval 5s fire-and-forget, catch par position. Le sleep `simResolveRetryIntervalMs` (5s × 5 retries) DANS determineWinner bloque la boucle resolveDue jusqu'à 30s+ par position due — si plusieurs positions dues, elles se traitent séquentiellement. Acceptable ? À mesurer en live.

---

## 6. Relayer & quota

- [x] **[VÉRIFIÉ ✅]** Interceptor axios : fragile face aux updates SDK (accès interne `client.httpClient.instance`), mais commenté et fonctionnel. Point de vigilance à chaque upgrade SDK — ajouté en section 11.
- [ ] Vérifier `relayer-quota.ts` : non lu (état quota, countdown, record*).
- [x] **[VÉRIFIÉ ✅]** Auto-redeemer : pré-flight quota + re-check mid-batch, backoff par position avec parse « resets in N seconds », dedup conditionId:outcomeIndex, reload des succès < 24h au boot. Anti-spam solide.
- [ ] Point résiduel : une position redeemée avec succès il y a > 24h mais pas encore marquée redeemable=false par data-api serait re-soumise après expiration du reload. Coût : un call relayer inutile (redeem redondant). Confirmer si le redeem redondant est safe on-chain (redeemPositions idempotent : oui pour les tokens déjà brûlés) — faible risque, à confirmer.

---

## 7. Stratégies custom / graph

- [x] **[VÉRIFIÉ ✅]** `graph/interpreter.ts` lu : évaluation lazy avec cache + détection cycle runtime (`evaluating`), GraphReturn pour le return, ports data/control, and/or/if/gate/switch.
- [x] **[VÉRIFIÉ ✅]** `graph/validate.ts` lu : ops interdits par méthode (FORBIDDEN), racines manquantes, cycles data-edge (tri topologique), postEdge/postCheap ports obligatoires, confirmTicks unique + params config-only, contraintes temporelles (inPhase, windowRange, sampleWindow ≥ 2× poll, trend* sur sampleWindow).
- [x] **[RÉSOLU ✅]** `METHOD_OPS` supprimé de `graph/validate.ts` (passe 3). Décision : suppression, PAS application — la whitelist cassait le graph POC embarqué lui-même (`and`/`or`/`not`/`if`/`askOf`/`isNull`/`return`/`round2` n'y sont pas listés). Les FORBIDDEN conservés. Tests verts.
- [x] **[NON-BUG ✅]** `GraphStrategy.edgeOrderAction` force "keep" si `leadsWithEdge === false` : NON-BUG confirmé. `edgeOrderAction` n'est appelé QUE par `manageRestingEdgeLead`, qui n'est invoqué QUE si `leadsWithEdge` (resting-manager.ts:36). Un graph non edge-lead gère ses hedges resting via `cancelOrphanHedgesIfNeeded`/`cancelRestingHedgesForPair` — exactement comme arb/barbell natifs (leur `edgeOrderAction` retourne aussi "keep" en dur). Le garde est un invariant du pipeline, pas un bug.
- [x] **[RÉSOLU ✅]** Try/catch par méthode dans GraphStrategy (passe 3) : `interpretMethodSafe()` avec fallbacks safe (findOpportunities → `[]`, cheap/edgeOrderAction → `"keep"`, shouldDefend → `false`, defendShares → `0`, hedgeAtPostTime → `skip`, shouldSellExpensiveEdge → `false`) + log + event dashboard `error`. Un bug graph n'avorte plus le processEvent (l'autre market du tick et le resting sont traités). Test de régression ajouté (div-by-zero runtime, graph valide à la construction).
- [ ] **NOUVEAU — `manageRestingEdgeLead` lit `edgeOrders[0].outcome` pour trouver le book** et l'applique à toute la boucle d'annulation. Un seul order edge par paire en pratique (guards), mais si plusieurs outcomes coexistaient, l'action serait évaluée sur le mauvais book. Confirmer l'invariant un-ordre-edge-par-paire (appendOpportunity le garantit-il pour les graphs customs avec plusieurs postEdge ?).
- [x] **[VÉRIFIÉ ✅]** `ensure-edge-order.ts` : soft-migration des graphs sans edgeOrderAction (default method injecté). Les autres méthodes sont obligatoires à la validation — un graph pré-7-méthodes échouera à la validation si une autre méthode manque. Vérifier s'il existe des graphs persistés plus vieux que cette contrainte (migration DB à tester).
- [x] **[VÉRIFIÉ ✅]** `chart-rules-strategy.ts` lu : once/dependsOn/afterFill/lossPct/outOfBand, hydratation depuis tracker au restart (fail-closed multi-buys même kind), `promoteFills` par appel.
- [ ] Chart-rules : `signalReady` trend (sans bande ni confirmTicks) sur cheap sells utilise l'ask ; sur favorite sells le bid — le sample push pour `shouldDefend` pousse favoriteAsk (l'ask du favori) alors que la vente favorite trende sur le bid poussé dans `shouldSellExpensiveEdge`. Deux séries différentes pour deux hooks — vérifier qu'aucune règle sell cheap ne trende sur un sample d'ask mélangeant les deux sources.

---

## 8. Stratégies directionnelles (fav-band, dip-revert)

- [x] **[VÉRIFIÉ ✅]** fav-band / dip-revert : validation force `arbAskLockOnly=false` + `enableExpensiveHedge=false` (pas de fuite hedge). Une entrée par paire (filledCheap + countLegsByKind). fav-band force orderType FOK sur les opportunities émises.
- [x] **[RÉSOLU ✅]** dip-revert cutoff : DÉJÀ CORRIGÉ dans le repo (commit take-profit, `stateFor` utilise `config.dipRevertDropLookbackMs` ligne ~171 + prune des states stale ligne ~157). La pass 1/2 de l'audit portait sur l'ancienne version du fichier. Tests de régression lookback 120s ajoutés en passe 3 (2 tests : signal fire au bon span + jamais de feu avec span court).
- [x] **[NON-BUG ✅]** dip-revert span 70% : cohérent une fois le cutoff fixé — le span suit le lookback configuré. Le test lookback 120s verrouille ce comportement.
- [x] **[RÉSOLU ✅]** dip-revert `states` Map : prune déjà implémenté dans le repo (staleness = max(lookback, 60s) × 2, purge itérative dans stateFor). Vérifié sur la version actuelle du fichier.
- [ ] edge-lead : `EdgeConfirmBuffer` et `lossStart` par paire — vérifier le purge (buffer.reset existe par paire ; lossStart seulement deleté sur conditions). Confirmer l'absence d'accumulation sur des milliers de paires.

---

## 9. Tests & complétude

- [ ] Couverture edge manquante à ajouter :
  - [ ] FOK SELL `sell-unconfirmed` → comportement holding (defendPair, edge-lead, manual close).
  - [ ] Crash entre `addOpenPosition` et `removePostedOrder` (double-count test existe ?).
- [x] Graph custom : **fait en passe 3** — fallback runtime testé (div-by-zero, tests/strategy-graphs.test.ts). Le cycle data-edge reste bloqué à la validation (tri topologique), le runtime guard (cycle `evaluating`) existe déjà.
- [ ] `applyRuntimeSettings` : restore snapshot après échec d'écriture disque.
- [x] dip-revert avec lookback > 60s : **fait en passe 3** (2 tests de régression dans tests/dip-revert.test.ts).
  - [ ] Redémarrage avec graphs custom persistés pré-migration edgeOrderAction.
- [ ] Vérifier que les tests backtest et live partagent bien les mêmes décisions (moteurs identiques — orchestrate est partagé ; backtest-fill/backtest-engine à relire pour la parité fill sim vs live).
- [ ] Presets (`config/presets/*.json`) : re-vérifier la cohérence de chaque preset avec les validations actuelles (bands, budgets, ratios) après toute évolution moteur.

---

## 10. Frontend

- [x] **[VÉRIFIÉ ✅]** `frontend/src/api/client.ts` : wrappers HTTP purs, aucune logique de trading dupliquée. OK.
- [ ] Vérifier l'alignement types frontend (`frontend/src/types/index.ts`) avec `BotConfig` backend — un champ ajouté côté backend sans MAJ frontend casse l'affichage config silencieusement (ou pas : vérifier le typage).
- [ ] Vérifier que l'éditeur graph frontend valide côté BACKEND : **VÉRIFIÉ en passe 3 — NON-PROBLÈME.** Le frontend n'a AUCUNE logique de validation dupliquée : `api.strategyValidate` POST sur `/api/strategy/validate`, qui appelle `validateStrategyGraph` backend (dashboard/server.ts:299). Un graph invalide est rejeté avant save. Aucune divergence possible.
- [ ] Vérifier `chart-rule-replay.ts` : non lu (replay des règles dans l'éditeur — parité avec l'interprétation live).
- [ ] Guide `/guide` : cohérence avec les moteurs actuels — à faire après la première passe de corrections (règle projet : guide suit le code).

---

## 11. Veille externe

- [ ] Versions SDK Polymarket (`@polymarket/clob-client-v2`, `@polymarket/builder-relayer-client`, `@polymarket/builder-signing-sdk`) : vérifier compat et changelog (l'interceptor axios sur `client.httpClient.instance` est le point le plus fragile).
- [ ] Endpoints Gamma (`/events?tag_slug=15M`, `/events?slug=`) et CLOB (`/book`) : stabilité, pagination, formats (outcomePrices string vs array déjà géré dans parseGammaList).
- [ ] Constantes contracts Polygon (CTF, pUSD, CtfCollateralAdapter, NegRiskCtfCollateralAdapter) : vérifier qu'elles correspondent à la version live utilisée par le wallet funder.
- [ ] `sharesFromConditionalBalance` : heuristique `raw >= 1000 ? raw/1e6 : raw` — documenter la limite (un wallet avec ≥ 1000 shares réels non-6-decimals serait faux). Positions actuelles ~5-20 shares : OK aujourd'hui, fragile si sizing augmente.

---

## 12. Nettoyage & refactor (si décidé plus tard)

- [ ] Supprimer `simRequireCoveredPair` (code, EDITABLE_CONFIG_KEYS, presets, types) — flag mort confirmé.
- [x] Supprimer `METHOD_OPS` dans graph/validate.ts : **fait en passe 3** (suppression, cf. §7).
- [ ] Consolider `opportunity-executor.ts` : ~10 gates séquentiels, extraire une pipeline déclarative si le nombre de moteurs continue de croître.
- [ ] Extraire la duplication `closePairCheapAsSold` / `closePairExpensiveAsSold` (même logique à kind près) dans trade-tracker.
- [ ] Unifier le tri des opportunities (reverse-bot.ts:377 leadsWithEdge sort) dans une méthode de strategy si les customs doivent ordonner différemment.

---

## Ordre de priorité suggéré (à discuter)

1. ~~**§7 graph custom**~~ : **TRAITÉ en passe 3** — METHOD_OPS supprimé, catch runtime ajouté, edgeOrderAction = non-bug.
2. ~~**§8 dip-revert**~~ : **DÉJÀ CORRIGÉ dans le repo** + tests de régression ajoutés en passe 3.
3. **§3 exécution** : double-defend même tick → **NON-BUG confirmé passe 3** (single-threaded awaited : resting-manager se termine avant l'executor, tracker synchronisé entre les deux). order-type.ts lu et vérifié. Reste : tick-snapshots.ts, resolveDue.
4. **§5 résolution** : séquentialité resolveDue, seuils settlement.
5. Le reste : veille SDK, DB, tests edge.

---

Dernière mise à jour : passe 3 (implémentation des fixs confirmés). 
- Supprimé METHOD_OPS (src/strategy/graph/validate.ts) — validation morte qui aurait cassé le graph POC si appliquée.
- Ajouté interpretMethodSafe() (src/strategy/graph/interpreter.ts) — fallback safe par méthode + log + bus error.
- Ajouté 3 tests : dip-revert lookback 120s (×2), graph runtime fallback div-zero (tests/strategy-graphs.test.ts).
- Verdicts non-bug : edgeOrderAction keep (invariant pipeline), double-defend même tick (single-thread awaited), validation graph frontend (déléguée backend via /api/strategy/validate).
- Baseline : 373 tests pass / 0 fail, tsc OK.
- Note : le repo a évolué pendant l'audit (3 nouveaux commits : réorg audits, take-profit dip-revert). Les pass 1/2 portent sur l'ancienne version du fichier dip-revert — corrigé dans cette passe.