# Audit live — EXPENSIVE_ORDER_TYPE=GTC en production (audit-3)

**Date** : 2026-09-06, 07:40–07:50 UTC+2
**Périmètre** : process live (node tsx, PID 8564), snapshot de `data/bot-live.db` (WAL inclus), buffer SSE `/api/state` (:3105), `.env` actif, code `src/`.
**Méthode** : copie snapshot de la DB (jamais la DB chaude), requêtes SQL sqlite3, interrogation du dashboard, inspection du process Windows, relecture du code touché par les changements récents.
**Contexte** : audit réalisé ~4 h après le déploiement du toggle `EXPENSIVE_ORDER_TYPE` (FOK→GTC, `config.ts` / `bot.ts:506` / `strategy.ts`) et du fix du check d'arbitrage (`strategy.ts:165-174` — `expensiveFillCost = expensiveBuyMin` en mode GTC).
**Avertissement** : le bot trade pendant l'audit — les compteurs SQL bougent entre les relevés ; tous les chiffres sont issus du snapshot pris à 07:40.

---

## 0. Verdict en une phrase

**Le bot est sain sur le plan opérationnel (0 paire bloquée, 0 empilement, 0 erreur d'exécution depuis le restart), rentable en cumul (+27.11 $), mais la fenêtre pilote du mode GTC expensive vient de révéler un défaut structurel de conception : un bid posé sous l'ask ne remplit que sur dip transitoire, or un favori qui confirme s'éloigne vers le haut — le GTC expensive n'attrape pas les gains, il attrape les dips.**

---

## 1. Process et configuration active

| Élément | Relevé | Statut |
|---|---|---|
| Process | PID 8564, `node tsx src/index.ts` (sans `watch` → script `live`) | ✅ correct |
| Démarrage | 2026-09-06 07:37:08 | — |
| `DRY_RUN` | `false` | live réel |
| `READONLY_LIVE` | `false` | trading actif |
| `EXPENSIVE_ORDER_TYPE` | **`GTC`** | nouveau toggle actif |
| `CHEAP_BUY_MIN/MAX` | 0.07 / 0.20 | élargi vs défaut (0.10) |
| `EXPENSIVE_BUY_MIN/MAX` | 0.80 / 0.90 | resserré vs défaut (0.85/0.95) |
| `EXPENSIVE_ORDER_USDC` | 5 | ≥ plancher CLOB (5 × 0.80 = 4.00 ≤ 5) ✅ |
| `MAX_OPEN_POSITIONS_PER_SIDE` | 1 | 1 jambe par côté/fenêtre |
| `MAX_EXPOSURE_USDC` | 45 | balance dispo 45.70 → juste |
| `SIM_REQUIRE_COVERED_PAIR` | `true` | pas de cheap sans hedge *disponible* |
| `SIM_RESOLVE_FALLBACK` | **`none`** | ✅ risque d'audit-2 levé (était `probabilistic`) |
| `AUTO_REDEEM_WINNERS` | `true` | 53 redeems effectués, dernier 06:46 |
| `MIN_MINUTES_BEFORE_CLOSE_TO_BUY` | vide (désactivé) | garde inactive |
| `POLL_INTERVAL_MS` | **1000** | 🟠 très agressif (voir §7) |
| Balance CLOB | 45.70 $ dispo (snapshot 07:39) | ✅ cohérente avec l'exposition |

**Au moment de l'audit** : 1 position open (cheap Down @0.07, fenêtre 07:45), 1 ordre GTC expensive resting (Up @0.82, orderId `0x69c6…ef128`, status `live` sur le CLOB), 1 window_claim active, 0 paire non résolue orpheline.

---

## 2. Performances cumulées

Source : dernier event `stats` + requêtes SQL sur `positions` / `arb_pairs`.

| Métrique | Valeur |
|---|---|
| PnL réalisé total | **+27.11 $** |
| — dont arb (paires couvertes, 52 paires) | **+43.09 $** |
| — dont directionnel (1 jambe, 24 paires) | **−15.98 $** |
| Win rate positions | 41.5 % (56 W / 79 L) |
| Fill rate | 90.1 % (136 remplis / 151 tentés) |
| Cover rate paires | 68.4 % (52 couvertes / 76 résolues) |

### Par jambe

| Kind | n | Coût total | PnL | Détail |
|---|---|---|---|---|
| cheap | 77 | 79.22 $ | **+20.79 $** | 7 won → +93.01 (payoff ~13×) ; 70 lost → −72.22 (−1 $ chacun) |
| expensive | 58 | 328.15 $ | **+6.32 $** | 49 won → +56.75 (avgFill 0.825) ; 9 lost → −50.43 (avgFill 0.790) |

**Lecture économique** : la stratégie fait ce qu'elle dit dans `STRATEGY.md` — les cheap perdent 9 fois sur 10 à −1 $ et les retournements payent ~13×. La jambe expensive est un hedge quasi-neutre (+6.32 $ sur 328 $ engagés) qui sécurise la couverture des paires. La valeur vient des paires couvertes (+43.09) ; les paires directionnelles (cheap sans hedge rempli) saignent (−15.98) — c'est précisément le symptôme que le mode GTC devait réduire.

### Par jour

| Jour | Positions | PnL |
|---|---|---|
| 2026-09-04 | 13 | −9.94 $ |
| 2026-09-05 | 71 | **+48.71 $** |
| 2026-09-06 (au moment de l'audit) | 51 | −11.66 $ (variance normale, fenêtres perdantes en série) |

---

## 3. Autopsie de la fenêtre pilote GTC (BTC 07:30–07:45)

La première fenêtre entièrement jouée sous `EXPENSIVE_ORDER_TYPE=GTC`. Timeline reconstruite depuis `events`, `retry_counts`, `trade_keys`, `posted_orders`.

```
07:30  Fenêtre 1788672600 ouverte. Le process précédent (ère FOK) tourne.
       Claim : cheap=Down, expensive=Up (Up ≥ 0.80).
07:30→07:37  FOK @0.80 tué chaque seconde → retry ×20 en ~20 s → clé MARQUÉE.
             FOK @0.81 idem → retry ×20 (07:36:15) → clé MARQUÉE.
             (20 retries = SIM_MAX_RETRY_ATTEMPTS ; à 1 s de poll, un niveau
              meurt en 20 secondes quand l'ask ne descend jamais à lui.)
07:37:08  Restart du bot avec EXPENSIVE_ORDER_TYPE=GTC.
07:37:13  Ladder GTC [0.80…0.90] : 0.80/0.81 déjà marquées → skip.
          → 0.82 posté (bid Up, size 6.09, ~5 $). 1 seul niveau possible
            (MAX_OPEN_POSITIONS_PER_SIDE=1 bloque 0.83+).
          → Ordre `live` sur le CLOB, reason="resting", jamais marketable
            (ask Up ~0.85 > 0.82).
07:37:13  Cheap Down @0.07 posté côté opposé → remplit (marketable).
07:45:00  Résolution : BTC Up gagne. Le prix d'Up monte vers 1.00,
          ne redescend JAMAIS à 0.82 → bid jamais atteint.
07:45:09  Position cheap Down résolue LOST (−1 $).
~07:50    Le GTC @0.82 est annulé par cancelStaleOrders (windowEnd+300s).
Résultat : paire directionnelle (1 jambe), −1 $, hedge immobilisé pour rien.
```

**Trois enseignements :**

1. **Le pipeline GTC expensive fonctionne mécaniquement** : posté → resting → compté dans `countPendingOrdersForSide`/exposition → pollé → sera annulé stale. Aucun bug d'implémentation sur ce chemin.
2. **Le choix du niveau est structurellement mauvais pour un bid** : `priceLevels()` énumère en ordre croissant et le garde `MAX_OPEN_POSITIONS_PER_SIDE=1` garde le **premier niveau non-marqué** = le plus **bas**. Or un bid placé 3–5 ¢ sous l'ask ne remplit que si le prix **descend jusqu'à lui**. Un favori qui confirme **monte et s'éloigne**. Le GTC cheap (bid 0.07, token qui meurt en descendant vers 0) fonctionne parce que le prix **traverse** le bid ; le GTC expensive échoue parce que le prix s'**échappe** dans l'autre sens. Le mode GTC expensive n'attrape que les dips transitoires sous le niveau — l'inverse du régime où le hedge est le plus utile.
3. **Empoisonnement du ladder par l'ère FOK** : les clés marquées (0.80, 0.81) par les 20 retries FOK de l'ancien process persistent en DB (`trade_keys`/`retry_counts`, prune 24 h) et décalent le choix GTC vers le haut (0.82). Bénin ici, mais deux process successifs avec des stratégies d'ordre différentes partagent le même espace de clés `slug:outcome:kind-price`.

**Fenêtre suivante (07:45–08:00) observée en direct** : livres Up 0.51 / Down 0.50 (coin-flip), aucun token ≥ 0.80 → pas de favori → `SIM_REQUIRE_COVERED_PAIR=true` → aucun ordre, ni cheap ni expensive (« Watching market » en boucle). Comportement conforme, mais rappelle que le bot n'est actif que sur les fenêtres où un favori émerge (~fin de fenêtre).

---

## 4. Qualité d'exécution des jambes expensive (ère FOK)

| Observation | Données | Interprétation |
|---|---|---|
| Fills 0.72–0.79 (sous `EXPENSIVE_BUY_MIN`) | ~12 fills | ✅ **Price improvement, pas violation** — le ask a chuté entre le snapshot du tick et l'exécution du FOK ; pour un BUY, remplir moins cher que le min visé est favorable. Le garde `not-a-favorite` (`bot.ts:455-476`) valide le bestAsk du snapshot, l'exécution peut être meilleure. |
| Fills 0.92–0.93 (au-dessus de `EXPENSIVE_BUY_MAX=0.90`) | fills 05:25→06:07 | 🔴 Violation pré-clamp — c'est le bug documenté (fix `fokPrice = min(bestAsk, expensiveBuyMax)` dans `trader.ts:122`, appliqué 09-06). Tous antérieurs au process actuel. **0 fill > 0.90 depuis le restart** ✅. |
| FOK tués | 413 events `killed-fok` | Le symptôme d'origine du passage en GTC. Chaque kill = 1 appel CLOB + 1 event ; à 1 s de poll, jusqu'à ~20 kills/min/niveau avant marquage. |
| Erreurs « Order failed: … FOK » | 5 492 events `error` cumulés (dernier 09-05 16:27) | Era FOK sans le catch « couldn't be fully filled ». Le catch existe (`trader.ts:143-161`) ; plus aucune erreur de ce type depuis ✅. |

**Rejets historiques (résolus)** : 6 777 `insufficient-balance` (09-05 07:00→12:59, portefeuille vide puis rechargé — le garde-fou a fait son travail, spam interrompu par le rechargement, pas par un fix), 2 354 `readonly-live` (ère READONLY_LIVE), 92 `too-close-to-close` (garde depuis désactivée). Aucun de ces motifs ne réapparaît depuis le restart.

---

## 5. Backcheck des correctifs antérieurs

| Correctif (date) | Vérification live | Statut |
|---|---|---|
| Catch-up finalisation paires après restart (09-05) | 0 paire non-résolue avec toutes jambes résolues (requête §stuck) | ✅ tient |
| Guard DB-backed anti-empilement (09-05) | 0 doublon `pairId+kind` postérieur au fix ; les doublons cheap du 09-04 (4 jambes/fenêtre, `tsx watch` era) sont les seuls | ✅ tient |
| Clamp FOK au-dessus de `EXPENSIVE_BUY_MAX` (09-06) | 0 fill > 0.90 depuis le process actuel | ✅ (process redémarré avec le fix) |
| Toggle `EXPENSIVE_ORDER_TYPE` + fix arb-check GTC (09-06) | 1er ordre GTC expensive posté à 07:37:13, status `live` sur le CLOB ; l'arb-check n'a pas bloqué l'opportunité (avant le fix, `0.20 + 0.90 = 1.10 ≥ 1.0` → rejet systématique) | ✅ implémentation vérifiée, ⚠️ conception à revoir (§3) |
| `SIM_RESOLVE_FALLBACK=none` (reco audit-2) | `.env` : `none` | ✅ appliqué |
| Fuite ledger simulé en DB live (audit-2, latente) | Table `ledger` : 0 ligne | ✅ non matérialisée |
| `EXPENSIVE_ORDER_USDC=5` (plancher CLOB 5 shares) | 5 / 0.82 = 6.09 shares ≥ 5 | ✅ respecté |
| Auto-redeem winners (09-05) | 53 events « Auto-redeemed winning position », dernier 06:46 | ✅ opérationnel |

---

## 6. Anomalies mineures

1. **Snapshot balance à 0 au boot** (07:37:11 : `availableCollateral: 0`) — signature connue du sync CLOB au démarrage ; corrigé au tick suivant (45.70 à 07:37:42). Ne pas alarmer si le badge affiche 0 dans les 30 premières secondes.
2. **`simulatedStats` toujours émis en live** (7 571 events) — fuite de nommage d'audit-2 non corrigée : les stats live partent sous un type « simulated ». Cosmétique mais prête à confusion.
3. **`positionsValue` oscille à ~0.01–1.07 $** pendant que la position cheap ouverte vaut son coût réel au bid courant — cohérent avec la valorisation bestBid d'un token quasi-mort ; pas un bug.

---

## 7. Hygiène opérationnelle

| Sujet | Relevé | Évaluation |
|---|---|---|
| Taille DB | 66.4 MB pour ~49 h d'historique | 🟠 voir events |
| Table `events` | 49 268 rows / 5 492 erreurs cumulées ; prune > 7 j existe (`bot.ts:92-98`) mais à 1 s de poll → ~24k rows/jour → régime permanent ~170k rows | 🟠 supportable, mais 1 s de poll quadruple la facture vs 4 s |
| **Table `stats_snapshots`** | 3 250 rows, **aucun prune** (`pruneData` couvre events/balance/keys/retries, pas celle-ci) | 🔴 nouveau : croissance illimitée (~1 600 rows/jour) |
| `POLL_INTERVAL_MS=1000` | 152 scans dans le buffer 5 min ; 86k ticks/jour ; chaque tick = scan Gamma + books CLOB | 🟠 risque de rate-limit et coût I/O ; 2–5 s suffisent (les niveaux cheap n'apparaissent qu'en fin de fenêtre) |
| `posted_orders` / `window_claims` | 1 / 1 rows, prunés correctement | ✅ |
| FOK kills persistants (pre-restart) | 397 kills sur 3 h | éliminés par le passage en GTC, mais remplacés par l'immobilisation du bid (§3) |

---

## 8. Recommandations (priorisées)

**P1 — Corriger le choix de prix du GTC expensive (le point de cet audit).**
Le mode GTC actuel ne changera quasiment rien au taux de couverture : le bid le plus bas non-marqué est le moins susceptible de remplir, et le favori qui gagne s'en éloigne par le haut. Option recommandée (**A**) : en mode GTC, poster l'expensive à `min(bestAsk, expensiveBuyMax)` — marketable il remplit immédiatement au ask (≤ 0.90), non-marketable il repose **au niveau du marché** au lieu de 3–8 ¢ derrière ; le ladder expensive devient un ordre unique au prix courant clampé. Variante B (moins propre) : énumérer le ladder expensive en ordre décroissant. **Impact attendu** : le taux de couverture des paires (68 %) est la seule variable qui sépare +43 $ (couvertes) de −16 $ (directionnelles) — c'est le levier de PnL n°1.

**P2 — Prune `stats_snapshots`** : ajouter à `pruneData()` (bot.ts:92-98) un `statsSnapshots.prune(now - 30 j)` identique à `balanceSnapshots`. Croissance illimitée constatée.

**P3 — Relever `POLL_INTERVAL_MS` à 2000–5000.** Divise par 2–5 le volume d'events, les appels Gamma/CLOB et la taille DB, sans perdre d'edges (les niveaux cheap n'émergent qu'en fin de fenêtre ; à 1 s, 20 retries tuent un niveau en 20 s, ce qui a précipité le marquage 0.80/0.81 de la fenêtre pilote).

**P4 — Espace de clés FOK vs GTC** (mineur) : les clés `slug:outcome:kind-price` étant partagées entre les deux modes d'ordre, un changement de mode en cours de fenêtre hérite des marquages de l'ancien mode. Si P1 est appliqué (ordre unique au prix courant), le problème disparaît de facto.

**P5 — Renommer `simulatedStats` en `stats` en live** (audit-2, fuite 2) — purement cosmétique, à regrouper avec le prochain passage frontend.

---

## 9. Limites de l'audit

- Snapshot DB à 07:40 : la fenêtre pilote GTC (07:30–07:45) était encore en cours à la prise de copie ; son issue (cheap lost, bid @0.82 non rempli, annulation stale) est reconstituée depuis le buffer SSE live et le comportement du code (`cancelStaleOrders`, `pollOrderFills`), pas depuis des rows DB finalisées.
- Un seul sample de fenêtre GTC complète : la conclusion structurelle (bid sous ask ne remplit que sur dip) est dérivée de la mécanique du matching, pas d'une base statistique. Recommandation : si P1 n'est pas appliqué immédiatement, laisser tourner le GTC actuel 3–4 h de plus pour confirmer le taux de fill empirique avant de trancher.
- Les compteurs `totalAttempted/totalFilled` incluent l'histoire des process précédents (plusieurs restarts) ; les métriques par jour restent fiables (positions datées).