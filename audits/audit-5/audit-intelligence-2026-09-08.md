# Audit 5 — Logique du bot, faiblesses et axes d'intelligence

**Date** : 2026-09-08 (v2 — corrigée après re-vérification du code ; la v1 analysait la config `.env` en ignorant l'overlay runtime `data/bot-settings.json`, qui est la source de vérité effective — voir §1.1 et constat 7.20)
**Périmètre** : `src/` complet (19 modules), `tests/`, `scripts/`, `README.md`, `STRATEGY.md`, `.env`, `.env.example`, `data/bot-settings.json` (config effective), continuité avec les audits 1 à 4.
**Méthode** : lecture intégrale du code source, traçage des flux de décision (scan → books → opportunités → exécution → résolution), reconstitution mathématique du profil risque/rendement réel de la configuration **effective** (overlay inclus), re-vérification de chaque affirmation de la v1 contre le code, recoupement avec les audits précédents.
**Objet** : (1) auditer la logique du bot, (2) identifier les faiblesses, (3) proposer des axes d'amélioration pour rendre le bot plus intelligent dans ses prises de position.

---

## 0. Synthèse exécutive

Le code est **techniquement mature** : architecture modulaire propre, TypeScript strict, garde-fous financiers multiples (cap d'exposition, claims de fenêtre, anti-empilement mémoire + DB, annulation des hedges orphelins, backoff de balance), persistance SQLite WAL, tests sur les fonctions pures. Les correctifs des audits 1 à 4 sont en place et cohérents.

Mais l'audit révèle des constats stratégiques majeurs qui touchent directement l'espérance de gain :

| # | Constat | Gravité |
|---|---------|---------|
| C1 | **La « paire couverte » n'est pas un arbitrage** : le hedge est dimensionné par budget USDC (`EXPENSIVE_ORDER_USDC=6`), pas en parts 1:1 avec le cheap (1 USDC). Avec 6:1, la paire perd même dans le scénario où l'underdog gagne (ex. cheap @ 0.17 : +4.88 − 6 = **−1.12 $**). Le statut `covered` est une fiction comptable. | 🔴 P0 |
| C2 | **Favori nu marketable** : en GTC (config effective), le hedge se remplit instantanément (ask dans la bande 0.77-0.85) pendant que le cheap reste *resting* sous son ask → ~6 USDC de favori nu. | 🔴 P0 |
| C3 | **Sélection adverse structurelle** : les bids cheap ne se remplissent que quand l'underdog *chute à travers* le bid (corrélé à la perte) et ne se remplissent jamais dans le scénario gagnant (l'underdog remonte au-dessus du bid). | 🔴 P0 |
| C4 | **Le bot ne regarde pas le sous-jacent** : aucune donnée de prix BTC, aucune volatilité, aucun temps restant dans la décision. Il trade des bandes de prix statiques sur des marchés dont l'issue dépend entièrement du prix spot. | 🟠 P1 |
| C5 | `PAIR_COST_MAX=1.02` autorise une paire à prix cumulé > 1 $ pour un payoff de 1 $ — une perte verrouillée si les tailles étaient 1:1 ; aujourd'hui c'est une borne sur le seul prix cheap (`cheap ≤ 1.02 − hedgePrice`), pas un verrou de profit. | 🟠 P1 |
| C6 | Le coût de paire n'est **pas revalidé au moment du fill** : les deux jambes sont générées sur le même book, mais leurs fills réels (asynchrones) ne sont jamais contrôlés comme coût global. | 🟠 P1 |
| C7 | Garde balance contournable : si `getAvailableCollateral()` n'a jamais réussi, `available === null` → **aucune vérification de solde** avant de poster des ordres live (fail-open). | 🟠 P1 |
| C8 | **`.env` n'est pas la source de vérité** : l'overlay `data/bot-settings.json` écrase silencieusement les valeurs `.env` pour toutes les clés éditables, avec des écarts importants (hedge 6 vs 20 USDC, bandes 0.77-0.85 vs 0.80-0.90, `disablePairTargetCost=true` vs défaut `false`). Un opérateur qui édite `.env` ne change rien. | 🟠 P1 |

Les axes d'amélioration (section 8) visent à transformer le bot d'« exécuteur de bandes de prix statiques » en « décideur informé » : oracle de prix spot, modèle probabiliste du résultat (distance au prix d'ouverture + volatilité + temps restant), dimensionnement par edge (Kelly), revalidation de paire au moment du fill, circuit breakers, et calibration empirique sur les données accumulées.

---

## 1. Configuration effective auditée

### 1.1 ⚠️ Deux sources, une seule vérité

`config.ts` charge `.env` **puis** applique l'overlay runtime :

```ts
// config.ts — loadConfig(), fin
const overlay = readRuntimeSettingsSync(RUNTIME_SETTINGS_PATH); // data/bot-settings.json
Object.assign(config, overlay);
```

Ce fichier est écrit par le dashboard à chaque changement de réglage (`applyRuntimeSettings` → `writeRuntimeSettings` du snapshot complet des 28 clés éditables). **La config effective est donc `bot-settings.json` quand une clé y figure, `.env` sinon.** L'audit v1 a analysé `.env` comme config active : erreur de méthode corrigée ici. Ce mécanisme est lui-même un constat (7.20).

Le bot tourne en **LIVE** (`DRY_RUN=false`) sur BTC uniquement, avec la config effective suivante (overlay > .env) :

| Paramètre | Effective (overlay) | `.env` (ignoré) | Remarque |
|---|---|---|---|
| `MARKET_SLUG_PREFIXES` | `btc-updown-15m` | idem | un seul flux de fenêtres |
| `POLL_INTERVAL_MS` | 1000 | idem | 1 s — agressif (audit-4 P2 demandait 2-5 s) |
| `CHEAP_BUY_MIN/MAX` | 0.07 / **0.20** | 0.07 / 0.25 | |
| `CHEAP_ORDER_USDC` | 1 | idem | |
| `EXPENSIVE_BUY_MIN/MAX` | **0.77 / 0.85** | 0.80 / 0.90 | bande hedge effective |
| `EXPENSIVE_ORDER_USDC` | **6** | **20** | 6× le budget cheap — cœur du constat C1 |
| `EXPENSIVE_ORDER_TYPE` | **GTC** | idem | → hedge marketable/resting (constat C2) |
| `PAIR_TARGET_COST` | 0.95 | non défini | **inopérant** : voir ligne suivante |
| `DISABLE_PAIR_TARGET_COST` | **true** | non défini (défaut false) | le prix cheap = `min(ask, cheapBuyMax)`, PAS `target − hedge` |
| `PAIR_COST_MAX` | 1.02 | non défini | borne le cheap à `1.02 − hedgePrice` |
| `MAX_SHARES_PER_ORDER` | 30 | idem | |
| `MAX_OPEN_POSITIONS_PER_SIDE` | 1 | idem | |
| `MAX_EXPOSURE_USDC` | **20** | 45 | |
| `MINUTES_BEFORE_CLOSE_MIN/MAX` | 0 / 15 | idem | trade toute la fenêtre |
| `SIM_REQUIRE_COVERED_PAIR` | true | idem | |
| `AUTO_REDEEM_WINNERS` | true (`.env` seulement) | — | pas une clé éditable overlay |

> ⚠️ **Hygiène sécurité** : `.env` contient une clé privée et des secrets relayer en clair. Le dossier n'est **pas un dépôt git** (le `.gitignore` couvre bien `.env` et `data/` — bon point), mais avant toute init git, vérifier qu'aucune copie/sauvegarde ne contient ces secrets, et envisager une rotation des clés si la machine est partagée.

---

## 2. Ce que fait réellement le bot (modèle mental vérifié)

Pipeline vérifié par lecture croisée `bot.ts` → `strategy.ts` → `trader.ts` → `trade-tracker.ts` → `position-resolver.ts` :

1. **Scan** (`market-scanner.ts`) : Gamma `/events?tag_slug=15M` (limit 50), filtre par préfixe de slug, extraction de `windowStart` depuis le slug, filtre temporel.
2. **Books** : CLOB `/book?token_id=` pour chaque token → `bestBid`, `bestAsk`, `bestAskSize`.
3. **Décision** (`strategy.ts`) :
   - `pickReverseToken` = token au ask le plus bas (underdog).
   - `pickFavoriteToken` = l'autre token si ask ≥ `expensiveBuyMin` avec ≥ 5 shares au touch.
   - Claim de fenêtre sticky (anti flip-flop), droppé si rien de commis et l'underdog flip.
   - Cheap : un seul ordre à `min(bestAsk, cheapBuyMax)` (car `disablePairTargetCost=true`), dans `[CHEAP_BUY_MIN, CHEAP_BUY_MAX]`, borné par `pairCostMax − hedgePrice`.
   - Hedge : un seul ordre à `min(ask favori, EXPENSIVE_BUY_MAX)`, tailé par `computeSize(EXPENSIVE_ORDER_USDC, hedgePrice, MAX_SHARES)`.
4. **Exécution** (`bot.ts`) : garde `minMinutesBeforeCloseToBuy` (null ici) → backoff balance → garde band hedge → cap exposition → dispatch GTC/FOK.
5. **Suivi** : polling des ordres posted (fills, cancels), annulation stale à `windowEnd + 300s`, `cancelOrphanHedgesIfNeeded` quand un cheap disparaît, `replaceMarketableCheap` (annulation/repost au même tick).
6. **Résolution** (`position-resolver.ts`) : Gamma `outcomePrices` ≥ 0.99 / ≤ 0.01 après `windowEnd + 5s`, retries, fallback `none` en live.

Le code est fidèle à sa description, **sauf sur le point central du dimensionnement** (section 3).

---

## 3. Constat C1 — « Paire couverte » ≠ arbitrage

### 3.1 Le code taille le hedge par budget, pas en parts 1:1

```ts
// strategy.ts — findOpportunities()
const hedgeSize =
  cheapCommittedForHedge > 0
    ? computeSize(
        config.expensiveOrderUsdc,   // ← 6 USDC (budget), PAS cheap.size
        hedgePrice,
        config.maxSharesPerOrder,
      )
    : null;
```

Le test `strategy.test.ts` le confirme explicitement : *« sizes hedge by EXPENSIVE_ORDER_USDC, not cheap shares »* (`assert.notEqual(hedge.size, cheap.size)`).

### 3.2 Conséquence chiffrée (config effective : 6 USDC hedge / 1 USDC cheap)

La paire n'est pas un profit verrouillé : **le signe du PnL dépend des prix de fill, et le scénario underdog peut être perdant**.

Cas A — favori 0.85, underdog 0.17 (cheap = min(0.17, 0.20) = 0.17, borne paire : 1.02 − 0.85 = 0.17 ✓) :

| Jambe | Taille | Prix | Coût | Si ce côté gagne |
|---|---|---|---|---|
| Cheap (underdog) | 5.88 sh | 0.17 | 1.00 $ | +4.88 $ |
| Hedge (favori) | 7.06 sh | 0.85 | 6.00 $ | +1.06 $ |

- **Favori gagne** (cas fréquent) : +1.06 − 1.00 = **+0.06 $**.
- **Underdog gagne** (la thèse « reverse » !) : +4.88 − 6.00 = **−1.12 $**.

Cas B — favori 0.80, underdog 0.22 (cheap clampé à 0.20 resting, hedge 0.80) :

- Favori gagne : 7.50 sh → +1.50 − 1.00 = **+0.50 $**.
- Underdog gagne : 5.00 sh → +4.00 − 6.00 = **−2.00 $**.

Le « hedge » de 6 $ **écrase le payoff du cheap** : même un retournement gagnant laisse la paire dans le rouge dès que le cheap se remplit au-dessus de ~0.14 $ (seuil : `1/cheapPx > 7`). La paire gagne petit quand le favori tient et perd gros quand il casse — **un pari directionnel sur le favori, pas un arbitrage**. La thèse documentée (payer l'underdog sous-évalué) ne reçoit que 1/7 du capital ; l'autre 6/7 achète le favori à un prix qui reflète déjà sa probabilité (EV ≈ 0 avant variance).

Le statut `covered` en DB et les métriques `coveredExposure` / `arbRealizedPnl` / `coverRate` **mesurent une couverture qui n'existe pas**.

### 3.3 Les documents se contredisent eux-mêmes

- `README.md` (exemple) : *« hedge at $0.87, **size 1:1 with cheap** »*.
- `README.md` (schéma config) : *« `EXPENSIVE_ORDER_USDC` — USDC budget per hedge order (**not 1:1 cheap shares**) »*.
- `STRATEGY.md` §2.2 : *« un seul ordre 1:1 »*.
- Code : budget. Overlay : 6 USDC. Trois sources, trois valeurs (C8/7.20).

**Il faut trancher** (voir §9.2) — c'est le choix le plus structurant de tout le projet.

### 3.4 Bande cheap effective (corrigé v2)

Avec `disablePairTargetCost=true`, le prix cheap est `min(bestAsk, cheapBuyMax)` borné par la paire :

```
prixCheap = min(askUnderdog, 0.20, 1.02 − hedgePrice)
hedgePrice = min(askFavori, 0.85)
```

- Favori à 0.85 → cheap ≤ 0.17 ; favori à 0.80 → cheap ≤ 0.20 (borne bande).
- Le cheap est **marketable** dès que `askUnderdog ≤ 0.20` (remplissage immédiat) et **resting** au-dessus.
- Un **nouveau** cheap n'est posté que si le favori est dans `[0.77, 0.85]` ; au-dessus de 0.85, la fenêtre est ignorée (garde `favoriteInRange`).

*(La v1 décrivait une bande [0.05, 0.15] issue de `PAIR_TARGET_COST − hedgePrice` — formule inactive avec `disablePairTargetCost=true`.)*

---

## 4. Constat C2 — Favori nu marketable : un chemin réel

### 4.1 Mécanique

Avec `EXPENSIVE_ORDER_TYPE=GTC` (config effective), le hedge est autorisé dès qu'un cheap est **commis**, et « commis » inclut un cheap **resting** (pas rempli) :

```ts
// bot.ts — executeOpportunity()
const cheapCommitted =
  opportunity.kind === "expensive" &&
  this.config.expensiveOrderType === "FOK"
    ? this.tracker.getFilledCheapSizeForPair(...)   // FOK : fill réel requis
    : this.tracker.getCheapSizeForPair(...);        // GTC : fill + RESTING
```

Le prix du hedge est `min(bestAsk favori, 0.85)` :

- Favori ask **0.80** (dans la bande 0.77-0.85) → hedge posté à 0.80 = **marketable** → remplissage quasi instantané.
- Le cheap, lui, est resting dès que `askUnderdog > 0.20` — la situation typique quand le favori cote 0.77-0.85 (underdog implicite ~0.15-0.23, ask souvent > 0.20).

Résultat : le bot achète **~6 USDC de favori au marché** avec pour seule « couverture » un bid de 1 $ qui dort sous le marché. Statut de paire : `partial` (favori nu). Si retournement : −6 $ ; si le favori tient : +1.06 $.

### 4.2 Le miroir du hedge orphelin existe, l'inverse n'est pas couvert

`cancelOrphanHedgesIfNeeded` annule bien le hedge quand le **cheap disparaît** (annulé/stale). Mais le cas inverse — **le hedge se remplit alors que le cheap resting ne se remplira jamais** — n'a aucune garde : pas d'annulation, pas de conversion, pas de re-couverture. Le favori nu est porté jusqu'à la résolution.

### 4.3 Gravité

Ce n'est pas un cas limite : dès que (a) le favori ask est strictement dans la bande et (b) l'underdog ask > 0.20 — la situation courante de milieu de fenêtre — le bot engage son budget hedge principal sur une configuration que la doctrine (`SIM_REQUIRE_COVERED_PAIR=true`) prétend exclure. Le seul cas où la paire se couvre vraiment est `askUnderdog ≤ 0.20` (cheap marketable), où les deux jambes se remplissent quasi simultanément.

---

## 5. Constat C3 — Sélection adverse structurelle des entrées cheap

Le cheap se remplit de deux façons, toutes deux défavorables :

1. **Chemin marketable** (`askUnderdog ≤ prixCheap`) : le bot paie l'ask immédiatement, dès que l'underdog cote ≤ 0.20 — i.e. quand le marché le donne quasi mort. Il rattrape le couteau qui tombe.
2. **Chemin resting** (bid < ask) : le bid ne se remplit que si un vendeur **traverse** le bid — i.e. si l'underdog chute davantage. Dans le scénario gagnant (retournement), l'underdog **monte** : le bid resting sous le marché n'est jamais touché. **Le fill est corrélé à la perte.**

Autrement dit : *le bid cheap se remplit précisément quand il ne faut pas, et ne se remplit pas quand il faudrait*. C'est la définition même de la sélection adverse sur market maker. Le `simFillProbabilityNonMarketable=0.3` du dry-run modélise un fill **indépendant** du futur — les backtests sont donc structurellement trop optimistes sur cette jambe (audit-4 §2.29 l'avait partiellement noté).

**Correction structurelle** : le signal d'entrée ne doit pas être un prix statique mais une **probabilité** (voir §9.1), et les ordres cheap devraient être marketables quand l'edge le justifie plutôt que des bids passifs adversement sélectionnés.

---

## 6. Constat C4 — Le bot trade à l'aveugle du sous-jacent

L'issue d'un marché « Up or Down » 15 min est une fonction pure du prix spot : `sign(prix_clôture − prix_ouverture)`. Or le bot ne connaît **ni le prix d'ouverture de la fenêtre, ni le prix spot courant, ni la volatilité, ni le temps restant** dans sa décision (le temps n'intervient que comme filtre grossier de scan et dans le modèle de fill du sim).

Il en découle :
- Aucune distinction entre un underdog à 0.15 avec 14 min restantes (le BTC peut encore traverser l'open) et un underdog à 0.15 avec 40 s restantes (quasi impossible) — la même limite est postée.
- Aucune distinction entre un underdog né d'un micro-dip (distance spot→open faible → forte probabilité de retournement) et un underdog né d'un trend violent (distance large, momentum → probabilité faible).
- Aucune mesure de l'edge : le bot ne peut pas savoir si 0.15 est sous-évalué ou sur-évalué ; il applique une doctrine (« les underdogs à un chiffre sont sous-évalués ») sans la vérifier par marché ni par instant.

C'est **le plus grand levier d'intelligence disponible** (§9.1).

---

## 7. Problèmes de logique de configuration de la stratégie

Tableau dédié : chaque paramètre, ce que l'opérateur **croit** faire, ce que le code **fait réellement**, et le problème de logique qui en résulte. Vérifié par lecture de `strategy.ts`, `config.ts`, `runtime-settings.ts`, `data/bot-settings.json`, et du dashboard `SettingsModal.tsx`/`ConfigBar.tsx`.

### 7.1 Tableau des paramètres de stratégie

| # | Paramètre | Intention affichée (dashboard/README) | Comportement réel du code | Problème de logique |
|---|---|---|---|---|
| L1 | `DISABLE_PAIR_TARGET_COST` (toggle « Désactiver le prix cible ») | Le nom suggère qu'on **désactive la paire couverte**. Hint dashboard : *« Ignore le calcul pairTargetCost − hedgePrice. Le prix cheap devient min(bestAsk, cheapBuyMax). »* | Ne change **que la formule de prix cheap**. Le hedge est **toujours posté**, toujours dimensionné par `EXPENSIVE_ORDER_USDC`, jamais en 1:1. La paire dite « couverte » reste pleinement active. | **Nom trompeur** : l'opérateur peut croire qu'il a désactivé la logique de paire/couverture alors qu'il a seulement changé la formule de prix cheap. Le constat C1 (fiction de paire couverte) s'applique dans les deux positions du toggle. |
| L2 | `ENABLE_EXPENSIVE_HEDGE` (toggle « Activer le hedge expensive ») | Hint : *« Sans hedge, la jambe cheap devient un pari directionnel non couvert. »* | **OFF** : aucun hedge posté, cheap posté sans condition de couverture (`favoriteInRange` forcé à `true`, `pairCostOk` forcé à `true`). **ON** : hedge posté mais dimensionné par budget, pas 1:1. | **Aucune des deux positions ne produit un vrai arbitrage 1:1.** OFF = pari nu sur underdog ; ON = barbell 6:1 étiqueté « couvert ». Le vrai arbitrage 1:1 n'est **pas configurable**. |
| L3 | `EXPENSIVE_ORDER_USDC` (champ « Hedge order (USDC) », hint « Budget par ordre hedge ») | README/STRATEGY : *« hedge 1:1 with cheap »* / *« un seul ordre 1:1 »* | `computeSize(expensiveOrderUsdc, hedgePrice, maxShares)` — taille = budget / prix, **indépendante** de la taille cheap remplie. Test unitaire : `assert.notEqual(hedge.size, cheap.size)`. | **Contradiction documentation ↔ code ↔ tests.** Le « 1:1 » documenté n'existe pas dans le code. Le statut `covered` en DB et `arbRealizedPnl` mesurent une couverture qui n'a pas lieu. Avec 6 USDC vs 1 USDC, la paire perd même si l'underdog gagne (§3.2). |
| L4 | `PAIR_COST_MAX` (défaut 1.02) | *« Hard cap if a pair overshoots the target »* — plafond de coût d'une paire pour garantir un profit | Vérifie seulement `prix cheap + hedgePrice ≤ pairCostMax` au moment de **générer** l'opportunité, pas au fill. En mode 1:1, une paire à 1.02 $ pour 1 $ de payoff = **perte verrouillée de 2 %**. En mode budget, la borne ne contraint que le prix cheap (`cheap ≤ 1.02 − hedgePrice`), pas le coût global pondéré. | **Valeur > 1.00 autorise une perte garantie** en mode 1:1. La borne n'est jamais revalidée au fill réel (asynchrone). Devrait être < 1.00 et portant sur le coût total pondéré, pas la somme des prix. |
| L5 | `PAIR_TARGET_COST` (défaut 0.95, config effective 0.95) | *« Cheap = this − hedge (0.80 → 0.15) »* — prix cible de la paire | **Inopérant** quand `disablePairTargetCost=true` (config active) : la formule `target − hedge` est court-circuitée. Le paramètre reste visible et éditable dans le dashboard, et affiché dans la ConfigBar (*« cible 0.95 »*), mais n'a **aucun effet**. | **Config morte affichée comme active.** L'opérateur peut modifier `pairTargetCost` dans le dashboard sans aucun changement de comportement. La ConfigBar affiche « cible 0.95 » qui ne s'applique pas. |
| L6 | `SIM_REQUIRE_COVERED_PAIR` (toggle, config `true`) | *« Skip new cheap unless the favorite ask is in [hedgeMin, hedgeMax] »* — exige une paire couverte | Vérifie seulement que le **ask du favori** est dans la bande au moment du claim. Ne vérifie **pas** que le hedge se remplit, ni que les tailles sont 1:1, ni que le coût global < 1. Un cheap de 1 $ + un hedge de 6 $ sur un favori à 0.80 valide cette garde. | **La garde valide une « couverture » qui n'en est pas une.** Le nom suggère une exigence de paire couverte réelle ; le code n'exige que la *possibilité* de poster un hedge (présence du favori dans la bande), pas sa réalisation ni son dimensionnement. |
| L7 | `EXPENSIVE_ORDER_TYPE=GTC` (config active) | *« GTC = restant »* — hedge qui repose sur le carnet | GTC à `min(ask, expensiveBuyMax)`. Quand `ask ≤ expensiveBuyMax` (favori dans la bande), le GTC est **marketable** → fill quasi instantané. Le cheap, lui, est souvent resting (target < ask). → hedge rempli sans cheap rempli = favori nu. | **Le type GTC ne protège pas contre le favori nu.** Le FOK exige un cheap rempli avant de fire ; le GTC non. Aucune garde n'empêche le chemin « hedge marketable sur cheap resting ». (C2) |
| L8 | `EXPENSIVE_BUY_MIN=0.77` (config effective) | *« Min price for expensive leg (must be favorite) »* | Un token à 0.77 a une probabilité implicite de ~77 %. Le bot l'achète comme « hedge » à 0.77, payoff max 1.00 → gain de 23 % si le favori tient, perte de 77 % si retournement. | **0.77 n'est pas un favori fort.** La bande 0.77-0.85 capture des favoris modestes où l'edge du hedge est faible (EV ≈ 0 avant variance). Le « hedge » à 0.77 est un pari directionnel à 77 % de proba, pas une couverture. |
| L9 | `CHEAP_BUY_MAX=0.20` (config effective) | *« Fourchette des bids reverse »* — plafond de prix cheap | Avec `disablePairTargetCost=true`, le prix cheap = `min(ask, 0.20)`. Quand `ask ≤ 0.20`, le cheap est **marketable** → le bot paie l'ask immédiatement d'un underdog déjà quasi mort (sélection adverse). | **Plafond = prix d'achat marketable d'un sous-évalué déjà acté par le marché.** Acheter l'underdog à l'ask quand il cote ≤ 0.20, c'est acheter le consensus « quasi mort » — pas un edge. (C3) |
| L10 | `MIN_MINUTES_BEFORE_CLOSE_TO_BUY=null` (config effective) | *« Ne pas acheter si la clôture est dans moins de X minutes »* | `null` = désactivé → le bot trade dès la première seconde de la fenêtre, quand les prix sont ~0.50/0.50 (pas d'underdog, pas d'edge). | **Aucun filtre temporel.** Les premières minutes d'une fenêtre 15m n'ont pas d'underdog à un chiffre ; la stratégie n'a pas d'edge avant qu'un trend émerge. Le bot scanne quand même et poste dès qu'un côté dépasse 0.77. |
| L11 | `MAX_OPEN_POSITIONS_PER_SIDE=1` | *« Max 1 order per outcome »* | Avec budget sizing, « 1 per side » = 1 cheap (1 USDC) + 1 hedge (6 USDC) = 7 USDC pour une « paire » 6:1. Le garde ne voit pas que c'est un barbell, pas une paire. | **Le garde « per side » est cohérent avec le dimensionnement budget** mais masque l'asymétrie : 1 ordre cheap ≠ 1 ordre hedge en capital engagé. Le ratio 6:1 n'est ni configurable ni visible comme tel. |
| L12 | `MAX_EXPOSURE_USDC=20` (config effective, `.env` dit 45) | *« Hard cap on total open + resting exposure »* | Somme des coûts de toutes les positions ouvertes + ordres reposants. Avec 6 USDC par hedge, 20 USDC permet ~3 paires simultanées (3 × 7 USDC). | **Cap cohérent mais l'overlay le coupe à 20 vs 45 dans `.env`** — un opérateur qui lit `.env` croit avoir 45 USDC de marge. (C8/7.20) |
| L13 | `CHEAP_ORDER_USDC=1` vs `EXPENSIVE_ORDER_USDC=6` | Deux budgets indépendants, aucun lien | Aucun mécanisme ne relie les deux budgets. Le ratio cheap:hedge (1:6) est un **artefact** des deux valeurs choisies indépendamment, pas un paramètre de stratégie assumé. | **Le ratio capital cheap:hedge n'est ni un paramètre ni documenté.** C'est le cœur du constat C1 : la répartition du capital entre les deux jambes est accidentelle, pas décidée. |
| L14 | Dashboard `ConfigBar.tsx` | Affiche `Hedge {min}–{max} · {usdc} USDC · cible {pairTargetCost}` | Affiche `pairTargetCost` (0.95) **même quand `disablePairTargetCost=true`** → la « cible » affichée ne s'applique pas. | **Affichage mensonger** : la ConfigBar montre une cible inactive. L'opérateur croit que le bot vise une paire à 0.95 alors que le prix cheap est `min(ask, 0.20)`. |

### 7.2 Interactions contradictoires entre paramètres

| # | Combinaison | Contradiction | Effet réel |
|---|---|---|---|
| L15 | `ENABLE_EXPENSIVE_HEDGE=false` + `SIM_REQUIRE_COVERED_PAIR=true` | « Exiger une paire couverte » mais « pas de hedge » → contradictoire | Le code résout en forçant `favoriteInRange=true` quand hedge désactivé → cheap posté sans couverture. La garde `requireCoveredPair` est **silencieusement neutralisée**. Aucun warning. |
| L16 | `DISABLE_PAIR_TARGET_COST=true` + `PAIR_TARGET_COST` éditable | La cible est éditable mais ignorée | L'opérateur peut changer `pairTargetCost` dans le dashboard sans effet. Pas de warning, pas de grisé. |
| L17 | `PAIR_COST_MAX=1.02` + dimensionnement budget (pas 1:1) | La borne de coût de paire suppose un 1:1 (somme de prix = coût par share-paire) | Avec budget sizing, la borne ne contraint que le prix cheap, pas le coût global pondéré. `1.02` n'a pas le sens « profit verrouillé ≤ 2 % » — c'est juste `cheapPrice ≤ 1.02 − hedgePrice`. |
| L18 | `EXPENSIVE_ORDER_TYPE=GTC` + `EXPENSIVE_BUY_MIN=0.77` | GTC marketable à l'ask + bande qui commence bas (0.77) | Tout favori ask ∈ [0.77, 0.85] déclenche un hedge marketable instantané. Plus la bande est basse, plus le hedge se remplit vite — et plus le favori est faible (probabilité implicite 77 %). La combinaison maximise le favori nu. |

### 7.3 Synthèse — le problème structurel de la configuration

Le système de configuration **ne propose pas** le mode que la doctrine documente (vrai arbitrage 1:1 à coût < 1 $). Les seuls modes accessibles sont :

1. **Hedge OFF** → pari nu sur underdog (jambe unique, espérance négative si sélection adverse).
2. **Hedge ON, budget sizing** → barbell capital-asymétrique étiqueté « paire couverte » (C1).
3. **`disablePairTargetCost` ON/OFF** → ne change que la formule de prix cheap, pas la nature de la paire.

Le **vrai arbitrage 1:1** (`hedgeSize = filledCheapSize`, `pairCost < 1.00`, revalidation au fill) n'est pas un réglage — c'est un changement de code (cf. axe B §9.2). Le tableau ci-dessus documente pourquoi la configuration actuelle, **même manipulée avec les meilleures intentions**, ne peut pas produire la stratégie documentée : les paramètres qui la décriraient (1:1, verrou profit, revalidation au fill) n'existent pas dans l'interface.

---

## 8. Faiblesses et bugs résiduels (vérifiés)

> **Note de numérotation** : les constats de cette section sont préfixés `7.x` par convention (issus des audits 1-4 et延续), ils ne se rapportent **pas** au tableau des paramètres de stratégie `L1`-`L18` de la section §7. Le constat `7.20` est le seul nouveau de cet audit.

### 🔴 Élevé

| # | Localisation | Constat |
|---|---|---|
| 7.1 | `strategy.ts` (génération) + `bot.ts` (exécution) | **Le coût de paire n'est pas revalidé au moment du fill.** `pairCostCents ≤ pairCostMax` est vérifié au moment de *générer* les opportunités, sur le book du tick courant. Les fills réels sont asynchrones (cheap resting rempli plus tard, hedge marketable immédiat) et jamais re-contrôlés comme coût global. Un cheap qui se remplit à 0.20 pendant que le hedge a fill à 0.85 = paire à 1.05 par share-paire — en mode « vrai arb 1:1 » ce serait une perte verrouillée ; en mode budget c'est une paire hors de toute doctrine de coût. |
| 7.2 | `bot.ts` `executeOpportunity` + `getCachedAvailableCollateral` | **Garde balance fail-open** : si le fetch CLOB échoue au premier appel (et à chaque expiration du cache 30 s), `available === null` → la garde est **complètement sautée**. L'ordre part quand même ; le CLOB le rejettera si le solde est insuffisant (pas de perte directe), mais via le chemin d'erreur générique avec retries (spam, `balanceBackoff` déclenché plus tard) au lieu du chemin propre. Une garde financière doit être fail-closed : solde inconnu → pas d'ordre. |
| 7.3 | `bot.ts`/`trader.ts` — appels `placeBuy`/`placeBuyFOK`/`cancelOrder` | **Aucun timeout applicatif sur le placement d'ordre** : un POST CLOB qui pend bloque toute la boucle de tick (le guard `ticking` supprime les ticks suivants ; le scanner a 10 s de timeout, pas le client de trading — sous réserve d'un éventuel timeout interne de la lib, non vérifiable hors ligne). Une suspension réseau fige le bot pendant que les fenêtres 15 min continuent de tourner. |
| 7.4 | `bot.ts` `processEvent` | **Pas de re-check du book avant exécution** : entre le fetch du book et le POST (après `replaceMarketableCheap` avec ses appels réseau, les inserts snapshots, les opportunités précédentes), le marché bouge. Le cheap GTC non-marketable est protégé par construction, mais le hedge marketable peut partir sur un ask périmé (le CLOB rejette, retry… spam). Un refresh ciblé du book juste avant le POST éliminerait la classe entière. |
| 7.20 | `config.ts` + `runtime-settings.ts` + `data/bot-settings.json` | **`.env` n'est pas la source de vérité** : l'overlay runtime écrase silencieusement 28 clés éditables. Preuve vivante : `.env` dit `EXPENSIVE_ORDER_USDC=20` / bande `0.80-0.90` / `CHEAP_BUY_MAX=0.25`, l'overlay dit `6` / `0.77-0.85` / `0.20` / `disablePairTargetCost=true` — et c'est l'overlay qui s'applique. Deux risques : (a) un opérateur édite `.env` et croit changer le comportement ; (b) si `bot-settings.json` devient invalide (clé inconnue, JSON corrompu), `sanitizePatch` throw → le catch de `loadConfig` **warn en console et ignore TOUT l'overlay** → le bot repasse silencieusement sur les valeurs `.env` (hedge 20 USDC au lieu de 6 !). Le dashboard devrait avertir visuellement quand overlay ≠ `.env`, et un overlay invalide devrait être fail-loud au boot en mode live. |

### 🟠 Moyen

| # | Localisation | Constat |
|---|---|---|
| 7.5 | `strategy.ts` `hasDepth` | FOK plafonné par la profondeur du **touch seul** (`bestAskSize ≥ hedgeSize × 0.8`), alors qu'un FOK peut balayer plusieurs niveaux ≤ `expensiveBuyMax`. **Inactif avec la config actuelle** (`EXPENSIVE_ORDER_TYPE=GTC` court-circuite `hasDepth`), mais actif dès un retour au FOK : un touch mince tue le FOK en boucle → abandon après 20 retries → cheap jamais couvert. Il faut *walker* le ladder pour calculer la taille exécutable réelle. |
| 7.6 | `position-resolver.ts` `resolveDue()` | **Pas de cache de résolution par slug dans le cycle** : les deux jambes d'une paire appellent `fetchMarketResult(eventSlug)` pour le **même slug**. Cas nominal : 2× le fetch (mineur). Cas pathologique (Gamma indisponible) : chaque position due enchaîne jusqu'à 5 retries × 5 s **en séquentiel** → N positions dues = N × 25 s de résolveur bloqué, fetchs dupliqués inclus. |
| 7.7 | `bot.ts` `computeStats` (fillRate) | **`totalAttempts` a 3 sémantiques** (audit-4 §2.9, non résolu) : sim = chaque tentative ; live GTC = chaque post ; live FOK = seulement les fills. Le `fillRate` affiché n'est comparable ni entre modes ni dans le temps. |
| 7.8 | `auto-redeemer.ts` chemin succès | **`bus.emit({ type: "relayerQuota" })` émis deux fois** (double copier-coller, même commentaire dupliqué deux fois dans le bloc `try`). Doublon d'event SSE + DB à chaque redeem réussi. |
| 7.9 | `bot.ts` `replaceMarketableCheap` | Annule le cheap resting pour le repost marketable à l'ask. Le repost a lieu **au même tick** (`replaceMarketableCheap` s'exécute avant `findOpportunities` dans `processEvent`, la clé étant `unmark`ée) — la fenêtre de course est donc seulement le laps cancel→POST (quelques secondes), durant lequel un autre taker peut lever l'ask. Gain de prix réel, perte d'opportunité possible non mesurée. Acceptable, à documenter. |
| 7.11 | `market-scanner.ts` `scan()` | `limit=50` sans pagination (audit-4 §2.25, non résolu) : si Polymarket expose > 50 événements 15M actifs (BTC/ETH/SOL/XRP…), les marchés ciblés peuvent sortir de la page → le bot rate des fenêtres entières sans erreur visible. |
| 7.12 | `simulated-broker.ts` vs `trader.ts` | En sim, un hedge dont la limite est < ask peut se remplir *probabilistiquement* ; en live, le même GTC resting ne remplit que sur un vrai dip du favori. Divergence sim/live documentée (audit-4 §2.29), toujours vraie — le backtest surestime le taux de couverture GTC. |

### 🟡 Faible

| # | Localisation | Constat |
|---|---|---|
| 7.13 | `bot.ts` `emitOrderCancelled` | Fabrique un event avec `market: {} as never` — trou de typage pragmatique ; toute évolution du type `UpDownEvent` cassera silencieusement ce chemin. |
| 7.14 | `bot.ts` retry counts par `tradeKey` (inclut le prix) | Un reprice change la clé → le compteur de retries repart de zéro. Un favori oscillant au bord de la bande peut être retenté indéfiniment. Impact faible mais contre-intuitif. |
| 7.15 | `trader.ts` `getOrderStatus` + `bot.ts` `pollOrderFills` | `filled = sizeMatched >= originalSize` : un GTC **partiellement rempli** dont la fenêtre expire n'est finalisé qu'au chemin stale/cancel. Entre-temps, `getFilledCheapSizeForPair` voit 0 → aucun hedge ne part pour la portion réellement acquise (audit-4 §2.17, toujours vrai). |
| 7.16 | `tests/` | Le cycle de vie des ordres live (`cancelStaleOrders`, `pollOrderFills`, `cancelOrphanHedgesIfNeeded`, `finalizeLiveOrder`) — les chemins qui manipulent de l'argent réel — n'a **aucun test** (pas de mock ClobClient). Les tests couvrent les fonctions pures, pas l'orchestration. |
| 7.17 | `dashboard/server.ts` | **Vérifié ✅** : le serveur bind explicitement sur `127.0.0.1` (ligne 189) — pas exposé au réseau. Reste : l'API locale (`/api/settings`, `/api/reset`) n'a aucune authentification, donc accessible à tout process local (faible sur une machine mono-utilisateur, à documenter). |
| 7.18 | `.env` + overlay | `POLL_INTERVAL_MS=1000` en production live : 1 scan Gamma + 2 books CLOB par seconde ≈ 260 k requêtes/jour. Audit-4 P2 demandait 2-5 s ; risque de rate-limit et coût réseau inutile — la fenêtre 15 min ne justifie pas la seconde. |
| 7.19 | `README.md`/`STRATEGY.md` | Contradiction 1:1 vs budget (§3.3) ; les deux documents décrivent la formule `PAIR_TARGET_COST − hedge` inactive depuis `disablePairTargetCost=true` ; bande hedge documentée ≠ effective. |

### Retraits de la v1 (constats infirmés par la re-vérification)

| # | Constat v1 | Pourquoi retiré |
|---|---|---|
| ~~7.10~~ | « posted orders stales gonflent `maxOpenPositionsPerSide` après la fenêtre » | **Faux** : le garde est par `(eventSlug, outcome)` et le slug contient le timestamp de la fenêtre (`btc-updown-15m-<ts>`) — les stales de la fenêtre N−1 ne peuvent pas bloquer la fenêtre N. Et après `windowEnd`, le scanner ne retourne plus le marché, donc plus aucune opportunité n'est générée. |

### Reprends des audits précédents, volontairement non traités (à assumer explicitement)

- **2.14** : prix de fill GTC estimé (`bestAskAtFill` capturé au POST), jamais lu depuis le CLOB → `cost`/`pnl` des positions live approximatifs.
- **2.17** : fill partiel invisible jusqu'à finalisation (cf. 7.15).
- **2.26** : `relayer.ts` — commentaire `amounts = [yesAmount, noAmount]` vs code `[2^255]`, RPC public codé en dur.
- **2.37** : GTC posté sans `orderID` inannulable côté exchange.
- **Git** : toujours pas de dépôt git — aucune capacité de rollback sur un bot qui trade en live. C'est le risque opérationnel le plus simple à éliminer.

---

## 9. Comment rendre le bot plus intelligent — axes d'amélioration

L'ordre suit le rapport impact/effort. Les axes A à C transforment la *qualité des décisions* ; D à F consolident.

### 9.1 Axe A — Oracle de prix + modèle probabiliste (le gros levier)

**Problème résolu** : C4 (trade à l'aveugle), C3 (entrées sans edge mesuré).

Le marché « Up or Down » est une option digitale sur le spot. Sa valeur théorique est calculable en quasi-temps réel :

```
P(Up gagne) = Φ( ln(S_t / S_open) / (σ·√τ) )     (approximation, drift négligé sur 15 min)

S_t     = prix spot BTC live (Binance/Coinbase WebSocket)
S_open  = prix d'ouverture de la fenêtre
σ       = volatilité réalisée courte (EWMA des returns 1 s sur ~10 min)
τ       = temps restant / durée fenêtre
Φ       = CDF normale
```

Implémentation concrète :

1. **`MarketOracle`** (nouveau module) :
   - WS Binance `btcusdt@trade` (ou Coinbase ticker) → spot en continu, < 100 ms de latence.
   - `S_open` : capturé au `windowStart` de chaque fenêtre (le bot tourne en continu, il voit passer les ouvertures ; fallback : reconstruire via klines Binance de la minute d'ouverture).
   - `σ` : EWMA des returns 1 s, mises à jour par tick.
2. **`EdgeModel`** (nouveau module) :
   - `modelProb = P(up)` ci-dessus → `modelProb(underdog) = 1 − modelProb`.
   - `impliedProb` depuis le book : micro-mid `(bid+ask)/2` de chaque token (ou `1 − askFavori` en conservateur).
   - `edge = modelProb − prixPayable` (en points de probabilité).
3. **Nouvelle règle d'entrée** : poster un cheap seulement si `edge ≥ EDGE_MIN` (ex. 3 pts) **et** `modelProb(underdog) ≥ CHEAP_MIN_PROB` (ex. 0.10). Remplace les bandes statiques par une condition informée — un underdog à 0.18 avec 12 min restantes et un spot à 0.02 % de l'open peut être une excellente entrée ; le même prix à 40 s de la fin est un don d'argent.
4. **Décroissance temporelle intégrée au modèle** : `modelProb(underdog)` tombe mécaniquement quand τ → 0 si le spot n'a pas traversé l'open. Plus besoin de bricoler `MIN_MINUTES_BEFORE_CLOSE_TO_BUY` : le modèle le fait, proprement, en continu.
5. **Filtre de momentum** : si `|Δspot|` sur les 60 dernières secondes > k·σ (trend violent en cours), désactiver les entrées cheap jusqu'au retour sous le seuil — ne pas acheter l'underdog pendant l'impulsion adverse.
6. **Edge sur le hedge aussi** : n'acheter le favori que si `modelProb(favori) − askFavori ≥ EDGE_HEDGE_MIN` (ex. 2 pts). Le hedge actuel achète le favori *parce qu'il est cher* — le modèle peut révéler qu'un favori à 0.85 a une proba réelle de 0.82 (edge négatif → skip).

**Effort** : ~2-3 jours (oracle WS + modèle + brancher dans `findOpportunities`). **Impact** : transformation de la stratégie. C'est l'axe n°1.

### 9.2 Axe B — Trancher le dimensionnement : vrai arbitrage OU barbell assumé

**Problème résolu** : C1, C5, contradiction docs/code.

**Option B1 — Vrai arbitrage (recommandé pour la sécurité du capital)** :
- `hedgeSize = filledCheapSize` (parts 1:1 ; le budget devient un *plafond* secondaire).
- Verrou profit : ne poster/keeper le hedge que si `prixFillCheap + askFavori ≤ PAIR_LOCK_MAX` (ex. **0.98**, PAS 1.02).
- Paire remplie = profit verrouillé `(1 − coût) × taille`, quel que soit le résultat. Le PnL devient une fonction du nombre de paires, pas de la direction des fenêtres — et les métriques `covered`/`arbRealizedPnl` redeviennent honnêtes.

**Option B2 — Barbell assumé (si l'intention est bien directionnelle)** :
- Renommer l'accounting (jambe `favorite` ≠ « hedge »), gérer chaque jambe avec son propre budget/edge/risque.
- Dimensionner par **Kelly fractionné** : `f = edge / odds` (edge du modèle 9.1, odds = payoff), plafonné (¼-Kelly) et borné par `MAX_EXPOSURE_USDC`.
- Le ratio cheap:favori devient un paramètre assumé au lieu d'un artefact de config.

Quelle que soit l'option : **`PAIR_COST_MAX` doit être < 1.00 en mode 1:1** (une paire à 1.02 $ pour 1 $ de payoff est une perte par définition), et README/STRATEGY/tests doivent être alignés sur la décision.

### 9.3 Axe C — Guards d'exécution intelligents

**Problème résolu** : C2, C6/7.1, 7.2, 7.4, 7.5.

1. **Revalidation de paire au moment du fill (7.1)** : avant chaque fill de jambe, recalculer le coût global de la paire avec le prix réel ; ne fire/keeper le hedge que si `coût ≤ PAIR_LOCK_MAX`. Un favori parti à 0.86+ pendant que le cheap fill à 0.17 → paire à 1.03 → **skip** (et couper le cheap, voir point 3).
2. **Anti favori-nu (C2)** :
   - Exiger un cheap **rempli** (`getFilledCheapSizeForPair > 0`) avant tout hedge marketable, pour **tous** les types d'ordre — le FOK a déjà cette sémantique, l'étendre au GTC ; ou
   - re-pricer le hedge GTC sous le touch (`ask − 1 tick`) pour qu'il ne se remplisse que sur un vrai dip, jamais en marketable nu.
   - **Ordre de priorité inversé** : le chemin « cheap marketable d'abord, hedge ensuite » doit être le seul chemin valide ; le chemin « hedge marketable sur cheap resting » doit être impossible.
3. **Support SELL (coupe de secours)** : `TradeSide` est déjà prévu pour `"SELL"` dans les types. Ajouter `placeSell` (FOK market) pour :
   - couper un cheap dont le modèle 9.1 a effondré la proba après fill (limite la perte au lieu d'attendre 0) ;
   - défendre une paire devenue hors doctrine (coût > cap après fill asynchrone) — revendre la jambe excédentaire plutôt que de porter un pari non prévu.
4. **FOK sizing par profondeur réelle (7.5)** : walker les niveaux asks ≤ `EXPENSIVE_BUY_MAX`, cumuler la taille exécutable, dimensionner le FOK à `min(souhaité, exécutable)`.
5. **Garde balance fail-closed (7.2)** : `available === null` en live → **skip** l'ordre (et logguer), au lieu de poster à l'aveugle.
6. **Timeout d'exécution (7.3)** : envelopper chaque appel trading dans un timeout applicatif (ex. `Promise.race` 8 s) — un CLOB pendu ne doit pas geler la boucle.
7. **Refresh book avant POST (7.4)** : re-fetcher le book du token concerné juste avant l'exécution (un seul appel ciblé) et revalider les conditions.

### 9.4 Axe D — Gestion du risque adaptative

1. **Circuit breaker drawdown** : pause automatique si perte réalisée du jour > `DAILY_LOSS_LIMIT_USDC` ; reprise manuelle uniquement.
2. **Limite de pertes consécutives** : après N hedges perdus d'affilée (ex. 3), pause + alerte — un retournement de régime de volatilité (news, liquidations en cascade) rend la doctrine caduque jusqu'à recalibration.
3. **Filtre de régime de volatilité** : vol trop basse → les underdogs à un chiffre sont *correctement* pricés (pas d'edge) ; vol extrême → le favori lui-même est risqué. Trader la bande médiane via le modèle 9.1 plutôt qu'en permanence.
4. **Diversification de flux** : réactiver ETH, ajouter SOL/XRP (`MARKET_SLUG_PREFIXES`) — 4 flux de 96 fenêtres/jour au lieu d'un ; réduit la variance journalière du PnL sans toucher au risque par fenêtre.
5. **Budget par fenêtre** : cap explicite du coût total engagé par `pairId` (cheap + hedge), aujourd'hui seulement implicite via `MAX_EXPOSURE_USDC` global (20).

### 9.5 Axe E — Sim/backtest fidèles + calibration empirique

1. **Modéliser la sélection adverse dans `SimulatedBroker`** : un fill cheap non-marketable doit **corriger** la probabilité de victoire vers le bas (le fill survient *parce que* le prix a traversé le bid). Sans ça, tout backtest cheap est trop rose. Concrètement : à la résolution simulée, conditionner `P(gain)` sur le chemin (ex. `P(gain | fill resting) = 0.7 × proba_marché`).
2. **Rejouer les books persistés** : `book_snapshots` stocke déjà best bid/ask/size par tick. Étendre au book complet (2-3 niveaux) et écrire un replayer de backtest déterministe — les fenêtres passées sont la meilleure donnée de calibration.
3. **Calibration empirique (la data est déjà là)** : requêter `positions` par bucket `(fillPrice, minutesLeft, σ_régime)` → P(gain) empirique vs P(gain) du modèle 9.1 → **Brier score** par bucket. Le bot a déjà des semaines de positions ; c'est un ajustement de requêtes SQL + un script, sans nouvelle donnée à collecter.
4. **Statistiques de diagnostic** : PnL par heure de la journée, par régime de vol, par bande de prix cheap, ratio de sélection adverse (mouvement du spot dans les 60 s après chaque fill) — ajouter au dashboard pour piloter le modèle.

### 9.6 Axe F — Robustesse technique et configuration

1. **Source de vérité unique pour la config (7.20)** : au boot en mode live, logger explicitement la config effective (les 28 clés) et **alerter** sur chaque divergence overlay ↔ `.env` ; refuser de démarrer (ou exiger un flag) si `bot-settings.json` est invalide — le fail-soft actuel peut faire passer le hedge de 6 à 20 USDC sans aucun signal.
2. **WebSocket CLOB** pour les books (market channel) : latence 1 s → < 100 ms, et supprime le polling REST à 1 s (7.18) — les deux problèmes se résolvent ensemble. REST en fallback.
3. **POLL_INTERVAL_MS ≥ 2000** immédiat si le WS n'est pas encore fait.
4. **Pagination du scan** (7.11) : boucler tant que la réponse est pleine, ou interroger par slug de fenêtre calculé (`btc-updown-15m-<ts courant>`) au lieu de scanner les 50 événements.
5. **Cache résolution par slug** (7.6) : dans `resolveDue()`, un `Map<eventSlug, result>` par cycle — divise par deux les appels Gamma et supprime les séquences de retries dupliquées.
6. **Unification `totalAttempts`** (7.7) : un compteur par sémantique (`posted`, `filled`, `rejected`), `fillRate = filled/posted` partout.
7. **Tests du cycle de vie live** (7.16) : mock de `ClobClient` (post/cancel/getOrder paramétrables par scénario) + tests sur `cancelStaleOrders`, `pollOrderFills`, `cancelOrphanHedgesIfNeeded`, `finalizeLiveOrder` — c'est là que se joue l'argent réel, et c'est testable sans réseau.
8. **Git init + tag de version** : avant toute modification issue de cet audit, figer l'état actuel (`git init && git add -A && git commit`) — capacité de rollback minimale sur un bot live. Le `.gitignore` existant couvre déjà `.env` et `data/`.
9. **Fix mineurs** : doublon `relayerQuota` (7.8), retry key sans prix (7.14), alignement docs sur `disablePairTargetCost` (7.19).

---

## 10. Roadmap priorisée

| Priorité | Action | Réf | Effort | Effet |
|---|---|---|---|---|
| **P0** | Fail-loud sur config : alerter sur divergence overlay/`.env`, refuser un overlay invalide en live | 7.20 | 0.5 j | Élimine le risque « hedge 6 → 20 USDC silencieux » |
| **P0** | Trancher 1:1 vs budget + `PAIR_COST_MAX < 1.00` en mode arb | C1, C5 | 0.5 j | Élimine une classe de perte garantie |
| **P0** | Interdire le hedge marketable sur cheap resting (favori nu) | C2, 9.3-2 | 0.5 j | Élimine le chemin de perte dominant |
| **P0** | Garde balance fail-closed + timeout d'exécution | 7.2, 7.3 | 0.5 j | Sécurité live |
| **P1** | Oracle spot WS + modèle `P(up)` + règle d'entrée par edge | C4, 9.1 | 2-3 j | Transformation stratégique |
| **P1** | Revalidation du coût de paire au moment du fill | 7.1/C6, 9.3-1 | 0.5 j | Verrouille l'edge |
| **P1** | Circuit breakers (daily loss, pertes consécutives, régime vol) | 9.4 | 1 j | Limitation du risque de régime |
| **P2** | FOK sizing par profondeur + refresh book avant POST | 7.5, 7.4, 9.3-4/7 | 1 j | Taux de couverture ↑ (FOK) |
| **P2** | Support SELL (coupe cheap post-fill, défense de paire) | 9.3-3 | 1 j | Réduction des pertes |
| **P2** | Sim avec sélection adverse + replayer book_snapshots | 9.5-1/2 | 1-2 j | Backtests crédibles |
| **P2** | Calibration empirique (buckets fillPrice × minutesLeft × σ, Brier) | 9.5-3 | 1 j | Mesure réelle de l'edge |
| **P2** | WS CLOB books + poll 2 s+ + pagination scan | 9.6-2/3/4 | 1-2 j | Latence et robustesse |
| **P3** | Tests mock ClobClient du cycle de vie ordres | 9.6-7 | 1-2 j | Prévention régression live |
| **P3** | Git init + versioning | 9.6-8 | 0.25 j | Rollback |
| **P3** | Cache résolution par slug, fix `relayerQuota`, fillRate, docs | 7.6, 7.8, 7.7, 7.19 | 0.5 j | Hygiène |

**Séquence suggérée** : P0 en premier (~2 jours, zéro nouveau concept, sécurise le live et la config), puis l'axe A (9.1) qui rend tous les autres axes mesurables, puis C, D, E, F.

---

## 11. Décision et plan de refonte

Suite à cet audit, l'opérateur a décidé une **refonte** de la logique de stratégie. L'analyse des deux stratégies cohérentes accessibles par refonte (B1 arbitrage 1:1 vs B2 barbell assumé), le diagnostic du bot actuel comme hybride involontaire à espérance négative, l'arbre de décision, et le plan d'exécution en séquences sont documentés dans le plan dédié :

→ **[plan-refonte-b1.md](plan-refonte-b1.md)** — Plan de refonte B1 (Séquences 1 + 2), conçu pour que le passage vers B2 soit une évolution et non une réécriture.

Résumé de la décision : **B1 (arbitrage 1:1 avec verrou de profit) en premier**, car c'est ce que la doctrine documente, la variance est faible, l'oracle de prix n'est pas bloquant, et l'apprentissage se fait sans perte de capital. B2 (barbell assumé avec oracle + modèle probabiliste) reste ouvert comme évolution future via le point d'extension `SizingStrategy`.

### 11.1 Résumé du diagnostic

Le bot actuel est un **hybride involontaire** : il combine le dimensionnement asymétrique du barbell (6:1, variance directionnelle) sans l'edge de l'arbitrage (pas de 1:1, pas de verrou de profit) ni l'edge du barbell assumé (pas d'oracle, pas de prédiction). Avec la config effective (favori 0.85, underdog 0.17, hedge 6 USDC vs cheap 1 USDC), son espérance est **négative** (−0.21 $/paire à 20 % de retournement) — il perd dans le scénario même qu'il prétend viser. Les détails chiffrés et l'arbre de décision sont dans le plan.

---

## 12. Limites de l'audit

- **Aucune requête sur les bases SQLite live** n'a été effectuée (choix de périmètre : audit de code) — les chiffres de comportement historique cités renvoient aux audits 3 et 4. La calibration empirique (9.5-3) devra re-valider les taux de victoire cheap/hedge sur données fraîches.
- La v1 de cet audit avait analysé `.env` comme config active : corrigé dans cette v2 (§1.1). Toute décision opérationnelle doit se faire sur la colonne « effective » du tableau §1.
- Le comportement exact du CLOB (statuts d'ordre partiels, sémantique fine de `takingAmount` en fill partiel, timeouts internes de la lib, profondeur réelle des books 15m) n'est pas vérifiable hors ligne ; les constats 7.3/7.4/7.5/7.15 s'appuient sur la lecture du code et la doc Polymarket.
- `relayer.ts` n'a pas été relu en profondeur (audit-4 §2.26 documente ses incohérences non résolues — reprises en §7).
- La recommandation centrale (oracle spot + modèle probabiliste) suppose que le prix d'ouverture de fenêtre est reconstituable avec précision suffisante (WS continu ou klines 1 min) — à valider empiriquement sur quelques fenêtres avant d'en faire une dépendance dure.

---

*Fin de l'audit 5 (v2) — généré le 2026-09-08, corrigé après re-vérification le même jour. Décision et plan de refonte : voir §11 et [plan-refonte-b1.md](plan-refonte-b1.md).*