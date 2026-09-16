# Audit — Gestion des timeframes (15m → 5m et au-delà)

*Audit du 2026-09-15, session read-only. Aucun code modifié.*

---

## TL;DR

Le bot est **beaucoup plus proche d'être multi-timeframe que le hardcoded `15m` ne le suggère** :
le slug de marché porte déjà sa durée (`btc-updown-5m-1781178900`), le frontend le parse déjà,
et le schéma DB stocke `windowStart`/`windowEnd` par ligne. Le vrai verrou est un petit
ensemble de **constantes 15m en dur** (`WINDOW_SECONDS`, `tag_slug=15M`, `EXPECTED_TICKS=900`)
plus un problème de fond : **les paramètres des moteurs sont calibrés en secondes absolues
pour une fenêtre de 900 s** et n'ont pas de sens tels quels sur 300 s.

Le refactor central est petit (dérivation de la durée depuis le slug) ; le travail lourd
est la **re-calibration empirique des paramètres** (backtest), pas le code.

---

## 1. Ce qui est DÉJÀ agnostique (aucun changement requis)

| Composant | Preuve |
|---|---|
| Extraction du windowStart depuis le slug | `parseWindowStart` regex `-(\d{10})$` (`src/utils/market.ts:5`) — ne lit pas la durée |
| Filtrage par préfixes de marché | `marketSlugPrefixes` est de la **config hot-reloadable** (`data/bot-settings.json`), pas du code |
| Schéma DB | `book_snapshots` / `market_snapshots` stockent `windowStart`/`windowEnd` **par ligne**, écrits depuis le scan → pas de migration de schéma |
| Fenêtre d'affichage (frontend) | `parseSlugWindow` (`frontend/src/utils/market.ts:33`) parse déjà `-(\d+)([mh])-(\d{10})` : le commentaire ligne 5 documente explicitement `btc-updown-5m-...` |
| Modal historique | `MarketHistoryModal` utilise en priorité `target.windowStart/windowEnd` (venant des rows DB) → l'axe temporel du graphe suit la vraie durée |
| Résolution des gagnants | Gamma `/events?slug=<exact>` + fallback CLOB `prices-history` sur `[windowEnd, windowEnd+120]` (`src/backtest/resolve.ts`) — agnostique |
| Sizing / MIN_CLOB_SHARES | dépend des prix et du budget, pas de la durée |
| Tick loop | `pollIntervalMs` (1 Hz live) indépendant de la durée de fenêtre |
| `pairId` / claims / clé anti-doublon | dérivés de `slug:windowEnd` — uniques par fenêtre quelle que soit la durée |
| Pruning des snapshots | par rétention temps (days), pas par fenêtre |
| Scanner (fenêtre de vie) | `now ∈ [windowStart, windowEnd]` calculé depuis le slug (`src/market-scanner.ts:63-67`) |

**Vérifié en direct** : le slug 15m `sol-updown-15m-1785941100` donne bien endDate
`2026-08-05T15:00:00Z` = start+900, et le slug 5m `btc-updown-5m-1766162100` donne
`11:35AM-11:40AM ET` = start+300. **Même convention de slug sur les deux timeframes**,
`orderPriceMinTickSize = 0.01` sur les 5m (comme les 15m), books 5m réels et liquides
(asks 0.63×514 / bids 0.62×50 sur la fenêtre active BTC).

---

## 2. Les ancrages 15m en dur (la liste complète trouvée)

| # | Fichier:ligne | Contenu | Effet si on passe en 5m sans rien changer |
|---|---|---|---|
| A1 | `src/utils/market.ts:3` | `WINDOW_SECONDS = 15*60` | windowEnd faux (+10 min) → le scanner accepte des marchés expirés et rejette des marchés vivants. **Verrou n°1.** |
| A2 | `src/market-scanner.ts:40` | `tag_slug=15M` | les marchés 5m ne sont jamais scannés → aucun enregistrement, aucun trading. **Verrou n°2.** |
| A3 | `src/backtest/completeness.ts:3` | `EXPECTED_TICKS = 900` | coverage 5m = 300/900 = 33 % → toutes les fenêtres 5m paraissent creuses |
| A4 | `src/backtest/completeness.ts:5` | `MIN_TICKS = 855` (95 %) | `DEFAULT_COMPLETENESS` filtre tout univers 5m → backtest vide (sauf override par requête) |
| A5 | `src/backtest/completeness.ts:151-157` | `windowBoundsFromSlug` : end = start+900 | même bug que A1 côté backtest/affichage des bounds |
| A6 | `src/backtest/completeness.ts:4` | `WINDOW_MS` bornes de parsing | maxGapMs/edgeGapMs bornés à 900 s — inoffensif (5m ⊂ 15m) mais sémantiquement faux |
| A7 | `src/strategy/chart-rule-presets.ts:28` | `edgeLeadChartRules(durationSec=900)` + zones `8*60` | preset edge-lead calé sur 15 min |
| A8 | `frontend/src/strategy-editor/graph-types.ts:72` | `DEFAULT_CHART_DURATION_SEC = 900` | fallback éditeur si pas de windowStart/End — mineur |
| A9 | `src/trade-tracker.ts:570,588` + `src/db/repositories.ts:452` | pruning postedOrders/claims codé `+ 900` | bénin : les claims vivent *plus longtemps* que la fenêtre 5m (conservateur, pas de bug) — à documenter seulement |
| A10 | `src/market-scanner.ts:43` | `limit=50` sur Gamma | voir §4 : sur 5m l'API renvoie beaucoup d'événements stale dans la première page |
| A11 | `frontend/src/pages/BacktestPage.tsx:662-664` | select prefix hardcodé `btc/eth-updown-15m` | pas d'option 5m dans l'UI backtest |
| A12 | scripts research (`dip-sim.mts:98`, `ask-lock-param-grid.mts:70`, …) | `LIKE 'btc-updown-15m-%'` | one-offs, hors prod — à étendre si on veut backtester 5m |

Tests qui verrouillent explicitement les valeurs 15m (à mettre à jour en même temps que le
refactor, sinon ils échouent volontairement — c'est leur rôle) :
- `tests/backtest-completeness.test.ts:94-97` : `EXPECTED_TICKS = 900`, `MIN_TICKS = 855`
- `tests/backtest-completeness.test.ts:89-92` : bounds 15m d'un slug
- `config/presets/*.json` : tous les presets portent `minutesBeforeCloseMax: 15`

---

## 3. Le problème de fond : les paramètres moteurs sont calibrés en secondes absolues

C'est le point le plus important — et il ne se règle pas en code mais en **re-backtest**.
Une fenêtre 5m a un budget temps de 300 s au lieu de 900 s : tout paramètre en secondes
change de signification (×3).

| Moteur | Paramètre | Valeur 15m | Signification 5m |
|---|---|---|---|
| **dip-revert** (moteur live actuel) | `dipRevertMinElapsedSec` | 180 (20 % de la fenêtre) | **60 % de la fenêtre** — l'entrée devient tardive |
| | `dipRevertDropLookbackMs` | 60 000 (6,7 % de la fenêtre) | 20 % de la fenêtre — le "dip" mesuré sur 60 s est un autre signal (chutes 1-min BTC bien plus fréquentes → sur-trading) |
| | `dipRevertMinDrop` | 0.03 | même seuil absolu, mais atteint bien plus souvent sur 5m |
| **fav-band** | `favBandMinElapsedSec` | 200 (22 %) | **67 %** — quasi plus d'entries |
| **edge-lead** | `edgeConfirmSamples` | N **ticks** (pas de temps !) | ✅ insensible au timeframe tant que le tick reste 1 s — c'est le seul moteur intrinsèquement "tick-based" |
| | preset chart-rule `startSec: 8*60` | 8 min | à moitié hors fenêtre |
| **arb / barbell** | locks, hedge, `pairLockMax` | basés sur les **prix**, quasi indépendants du temps | ✅ sauf `arbAskLockMinElapsedSec` (null par défaut = off → OK) |
| **reverse** | preset `minutesBeforeClose 3-12` | entrée sur les minutes 3→12 | sur 5m : `minutesLeft ∈ [0,5]` → fenêtre effective réduite à [3,5] — rétrécie, pas muette |
| **tous** | `minutesBeforeCloseMax` (sémantique *minutes*) | 15 | couvre encore 5m (0-15 ⊃ [0,5]) — pas un bug, mais la granularité *minute* devient grossière sur une fenêtre de 5 minutes |

Deux lectures possibles, à trancher avant tout code :
1. **Le signal lui-même se transpose** (dip de 3 c sur 60 s garde son edge sur 5m) → il suffit
   de re-scaler les gardes temporelles (elapsed, lookback) proportionnellement.
2. **Le signal est un phénomène de régime 15m** et doit être re-découvert sur 5m
   (les 313 fenêtres conformes BTC 15m ne prouvent rien pour 5m).

L'honnêteté empirique commande la lecture 2 : les edges directionnels (dip-revert, fav-band)
sont des régimes, pas des formules. La brique backtest existe déjà pour le vérifier.

---

## 4. Scanning & API Gamma (vérifié en live)

Constat live sur `tag_slug=5M` : l'API renvoie les événements **triés par windowStart
croissant**, et la première page de 100 contient **66 événements stale** (créés fin 2025,
toujours `active=true, closed=false` côté Gamma). Le scanner actuel (`limit=50`, filtre
`now ∈ [start, end]` *après* fetch) risque de **rater les fenêtres vivantes** poussées
hors première page. Deux remèdes possibles, testés :
- `end_date_min=<now>` → renvoie bien les fenêtres à venir uniquement (validé : les 7
  prochaines fenêtres BTC 5m sont retournées) ;
- ou paginer jusqu'à couverture complète puis filtrer localement.

Sur 5m, le nombre d'assets actifs simultanés est plus grand (BTC, ETH, XRP, SOL, ZEC, BNB,
HYPE…), mais **une seule fenêtre active par asset à la fois** → le coût par tick reste
~2 fetches CLOB par asset suivi, pas de multiplication si `marketSlugPrefixes` reste
focalisé (ex. BTC uniquement). Volume DB : ~3× plus de fenêtres/heure (12 vs 4 par asset)
→ croissance des snapshots ×3 ; les rétentions (`BOOK/MARKET_SNAPSHOT_RETENTION_DAYS`,
défaut 0 = infini) deviennent un choix à faire explicite (DB déjà à 335 MB).

---

## 5. Backtest — ce qui change

1. **Univers** : construit depuis les données enregistrées (`listBacktestWindows` lit
   `book_snapshots` groupés par slug). Il n'existe **aucune fenêtre 5m en DB aujourd'hui**
   (830k rows, 540 slugs, 100 % `*-15m-*`). Donc : le backtest 5m ne peut pas tourner avant
   une **phase d'enregistrement 5m** (bot en `READONLY_LIVE` ou préfixes 5m + `readonlyLive`
   → scan + snapshots sans trading). Ordre des opérations : enregistrer d'abord, backtester ensuite.
2. **Complétude** : les critères (`minTicks`, `maxGapMs`, `maxEdgeGapMs`) sont déjà
   paramétrables par requête (`CompletenessRequest`, `parseCompletenessCriteria`) — mais le
   **défaut** (855) et `coveragePct = tickCount/EXPECTED_TICKS` sont 15m. Il faut un
   `expectedTicks` dérivé de la durée du slug (ex. `durationSec / tickIntervalSec`, = 300
   pour un tick 1 Hz) et des critères par défaut cohérents (ex. minTicks ≈ 285).
   Noter : `isCompleteFromStats` n'utilise PAS `coveragePct` (affichage seul) → le flag
   `complete` resterait correct dès que minTicks est passé par requête ; c'est le défaut
   global qui casse.
3. **Runner** : `toEvent` hardcode `orderPriceMinTickSize: 0.01` — vérifié correct pour 5m.
4. **Filtres UI** : le select prefix de `BacktestPage` hardcode BTC/ETH 15m — à dériver des
   préfixes réellement présents en DB (ou de la config).

---

## 6. Affichage graphique — ce qui change

Quasi rien :
- `MarketHistoryModal` : `windowStart/windowEnd` lus depuis les rows DB (prioritaires) ou
  `parseSlugWindow` (déjà 5m-aware) → axe temps correct automatiquement.
- Zoom/pan : le viewport est dérivé des timestamps réels → agnostique.
- Éditeur de règles chart : `durationSec` dérivé de `windowEnd - windowStart`
  (`ChartRulePanel.tsx:492-495`) → correct par fenêtre ; seuls les **presets par défaut**
  (zones 0–900 s, snap) restent calés 15m (mineur, cosmétique).
- `DEFAULT_CHART_DURATION_SEC = 900` : fallback uniquement → mineur.

---

## 7. Recommandation d'architecture

### Principe : la durée devient une propriété du SLUG, plus une constante

Le slug porte déjà tout : `{asset}-updown-{n}m-{startTs}`. Une seule fonction à ajouter :

```ts
// src/utils/market.ts
export function windowSecondsFromSlug(slug: string): number | null {
  const match = slug.match(/-(\d+)([mh])-(\d{10})$/);
  return match ? Number(match[1]) * (match[2] === "h" ? 3600 : 60) : null;
}
```

(le parser existe déjà côté frontend — le dupliquer côté backend, ou le partager)

Puis :
1. **Scanner** : `windowEnd = windowStart + windowSecondsFromSlug(slug)` ; `tag_slug`
   devient dérivé de la config (liste de tags `15M`/`5M`) ou remplacé par
   `end_date_min=now` + filtrage préfixe local (plus robuste, résout aussi le problème
   de pagination stale du §4).
2. **Backtest** : `windowBoundsFromSlug` utilise la durée du slug ; `EXPECTED_TICKS`
   devient `expectedTicksFor(durationSec)` (durée/tickRate) ; `coveragePct` idem ;
   les critères par défaut se déclinent par durée (15m: 855, 5m: ~285 à définir).
3. **Presets** : ajouter des presets 5m porteurs de LEURS paramètres calibrés
   (`btc-updown-5m` + elapsed/lookback re-calibrés par backtest). Pas de scaling
   automatique des paramètres — c'est un piège : un edge de régime ne se transpose pas
   par règle de trois, il se mesure.
4. **Frontend** : select prefix dérivé des slugs réellement en DB ; le reste est déjà prêt.
5. **Guide** : mettre à jour `/guide` (règle cursor `strategy-guide-sync`) et `STRATEGY.md`
   quand le comportement change.

### Trois options de déploiement

| Option | Description | Verdict |
|---|---|---|
| **A. Durée dérivée du slug (recommandée)** | une instance, tag/config choisis, tout le reste suit le slug | petit refactor (~4 fichiers + tests), zéro ambiguïté, prépare le multi-timeframe |
| B. Deux instances (une 15m, une 5m) | zéro code si on accepte A3-A4 restés en dur + DB séparées | double l'ops, ne résout pas completeness, bricole |
| **C. Multi-timeframe dans une seule instance** | scanner accepte plusieurs tags, chaque fenêtre porte sa durée | extension naturelle de A (même refactor), mais + charge et + risque tant que les params 5m ne sont pas calibrés — à faire APRÈS A |

A et C sont en fait le même travail de code : la seule différence est combien de tags la
config met dans la liste. Recommandation : **A maintenant, C possible plus tard sans
re-refactorer.**

### Ordre d'exécution suggéré

1. Refactor "durée depuis le slug" + tag_slug paramétrable + tests (completeness par durée).
2. Phase **recording 5m** (bot live en readonly ou préfixes 5m, trading coupé) — quelques
   jours pour construire un univers backtest 5m (>80 % des 300 ticks, gaps ≤ 2 s).
3. Backtest des moteurs sur l'univers 5m : d'abord arb/barbell (les plus agnostiques),
   puis dip-revert/fav-band (recalibration empirique complète : elapsed, lookback, drop,
   bandes) avec la méthodologie sweeps existante (découverte sim → runner officiel).
4. Presets 5m + UI (selects prefix) + guide.
5. Optionnel : mode multi-timeframe (option C) et `minutesBeforeClose` en secondes si la
   granularité minute devient trop grossière.

---

## 8. Points de vigilance

- **Ne pas re-tuner "à la main"** les paramètres directionnels pour 5m : chaque valeur doit
  sortir d'un backtest avec nombre de fenêtres suffisant (l'univers 5m est vide aujourd'hui —
  c'est le premier jalon du planning, pas le code).
- `MIN_CLOB_SHARES = 5` et les budgets (ex. `dipRevertOrderUsdc 15`) : sur des books 5m
  parfois plus fins, le garde `bestAskSize < size → retry` reste le bon comportement ; la
  re-calibration sizing fait partie de la passe backtest.
- Tests à écrire/mettre à jour : `backtest-completeness.test.ts` (expectedTicks par durée),
  un test `windowSecondsFromSlug` (15m/5m/4h/4m invalide), presets (la suite
  `presets.test.ts` casse à chaque ajout de preset — prévu).
- Le fallback `±30 min` de `MarketHistoryModal` (l.315) n'est utilisé que sans slug ni
  windowStart/End → non concerné.
- Garder `WINDOW_SECONDS` comme **défaut de repli** (slugs sans durée lisible) plutôt que
  le supprimer, pour ne pas casser les slugs legacy.
- Aucun secret/credential concerné par ce chantier.