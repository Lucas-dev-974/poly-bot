# Probability Repricing — Papier d'implémentation

**Objectif :** spécifier une stratégie *Intramarket Probability Repricing* pour un bot Polymarket crypto (fenêtres courtes, typiquement BTC/ETH Up-Down 5m / 15m), de façon assez concrète pour coder, backtester et opérer.

**Statut :** design d'ingénierie. **v1 implémentée** (`strategyId: probability-repricing`) — voir `docs/probability-repricing-implemented.md`. Pas un claim de profitabilité. Les seuils ci-dessous sont des *placeholders* à calibrer.

**Sources de référence (recherche publique PolyTutor) :** famille `@vega7` / intramarket repricing, price dislocation, crypto short-duration, architecture système — sans paramètres propriétaires publiés.

---

## 1. Problème

Sur un marché binaire court (ex. *Bitcoin Up or Down* 5 minutes), le prix des tokens YES/NO est une **probabilité implicite** qui bouge pendant la fenêtre.

Deux hypothèses économiques distinctes :

| Hypothèse | Question | P&L |
| --- | --- | --- |
| **Outcome / settlement** | Ai-je raison à la résolution ? | `$0` ou `$1` |
| **Repricing / path** | Puis-je entrer et ressortir à un meilleur prix *avant* la résolution ? | `exit − entry` (exécutable) |

Le bot de repricing **ne cherche pas nécessairement à prédire le settlement**. Il trade l'évolution de la proba.

> Direction seule ≠ edge. Sans fill de sortie, un trade de path redevient une position directionnelle.

---

## 2. Définition formelle

### 2.1 Marché

- Venue : Polymarket CLOB
- Type : binaire Up/Down court (crypto)
- Actifs de référence externes : spot / mid Binance, Coinbase, etc. (selon ton stack ; ex. `binance-provider`)
- Horloge : temps restant jusqu'à résolution `τ` (secondes)

### 2.2 Prix exécutables (pas le midpoint)

Pour le token `T ∈ {YES, NO}` :

- `ask(T)` = meilleur ask (entrée long)
- `bid(T)` = meilleur bid (sortie long)
- `mid(T) = (bid + ask) / 2` — **affichage seulement**, jamais pour le P&L décisionnel
- `spread(T) = ask − bid`
- `depth_bid(T, q)`, `depth_ask(T, q)` — liquidité jusqu'à taille `q`

P&L réalisable d'une position longue de taille `q` entrée à `p_in` :

```text
PnL_realizable ≈ q * (bid_exécutable_moyen(q) − p_in) − fees
```

### 2.3 Événement de trade

Un cycle de repricing = :

1. **Entry** : achat de `T` à `p_in = ask` (ou fill moyen)
2. **Hold** sous contraintes de risque / temps
3. **Exit** : vente (ou réduction) à `p_out = bid` avant résolution  
   **ou** fallback settlement si exit impossible

Succès du design = maximiser l'espérance de `PnL_realizable` **après** frais, slippage et non-fills — pas le win-rate mark-to-mid.

---

## 3. Hypothèses de signal (à choisir / combiner)

Le repo public ne tranche pas. Ton bot doit **déclarer** laquelle (ou le mix) :

### A. Reversion (dislocation)

Le prix binaire a **sur-réagi** vs spot / vs historique court → on achète le cheap, on attend un partial recovery.

### B. Momentum

Le move continue → on entre *dans* le sens, on sort quand le momentum s'essouffle ou qu'une cible de reprice est atteinte.

### C. Microstructure / cross-feed

Écart entre :
- mouvement du spot externe,
- proba implicite Polymarket,
- état du livre (spread, depth, ask-crossover)

→ opportunité quand le CLOB n'a pas encore assimilé le feed.

**Recommandation d'implémentation v1 :** commencer par **C + règles d'exit strictes**, avec un mode A optionnel. Momentum pur (B) sans filtre de liquidité est dangereux en 5m.

---

## 4. Architecture cible

```text
Feeds externes (spot / mid)
        +
Polymarket CLOB (book + trades)
        │
        ▼
Time Sync & Market Registry
        │
        ▼
Market-State Engine
  - mid, bid, ask, spread, depth
  - τ (time to resolution)
  - features spot (return, vol courte, PTB si dispo)
        │
        ▼
Dislocation / Signal Engine
        │
        ▼
Entry Validator (edge, fees, τ, risk budget)
        │
        ▼
Execution (orders, partial fills)
        │
        ▼
Position Monitor
        │
        ▼
Exit / Repricing Logic
        │
        ▼
Settlement / Reconciliation (fallback)
```

Sépare clairement :
- **signal** (opportunité théorique),
- **tradeability** (peut-on *exécuter* entry + exit ?),
- **risk** (taille, exposition, corrélation multi-marchés).

---

## 5. État machine du bot

États recommandés :

| État | Description |
| --- | --- |
| `IDLE` | Scan des marchés éligibles |
| `ARMED` | Signal valide, en attente de confirmation / liquidité |
| `ENTERING` | Ordre(s) d'entrée en vol |
| `OPEN` | Position ouverte, moniteur exit |
| `EXITING` | Ordre(s) de sortie en vol |
| `FLAT` | Flat sur ce marché ; log + métriques |
| `HALTED` | Kill-switch / erreur feed / risque |

Transitions critiques :
- `ARMED → IDLE` si le signal expire (`signal_ttl`) ou si `τ < τ_min_entry`
- `OPEN → EXITING` sur target, stop, time-stop, signal reverse, ou dégradation liquidité
- `EXITING → OPEN` si cancel partiel et replan
- Toute transition vers settlement si `τ → 0` avec inventaire résiduel

---

## 6. Features (inputs)

### 6.1 CLOB

- `bid`, `ask`, `spread` YES et NO
- top-N depth (ex. 5 niveaux)
- imbalance : `(depth_bid − depth_ask) / (depth_bid + depth_ask)`
- `yes_ask + no_ask` (coût d'un pair maker / sanity)
- last trade price / aggressor side si dispo

### 6.2 Temps

- `τ` secondes restantes
- fraction de fenêtre écoulée `t_frac ∈ [0,1]`
- flag *late window* : `τ < τ_late` (ex. 30–45s) → **désactiver nouvelles entries**, agressiver exits

### 6.3 Spot / référence

Selon ton `binance-provider` (ou équivalent) :

- `r_Δt` : return spot sur Δt ∈ {1s, 2s, 5s, 15s}
- distance vs *price to beat* / open de fenêtre si le contrat le définit (PTB)
- retard feed : `feed_age_ms` — si trop vieux, **pas de trade**

### 6.4 Features de dislocation (exemples)

À calibrer ; noms indicatifs :

```text
z_prob   = (mid_YES − fair_model) / σ_short
gap_feed = f(spot_move) − Δmid_YES   # le livre a-t-il suivi ?
cheapness = ask_YES   # ou min(ask_YES, ask_NO) selon le côté
edge_est  = E[bid_exit] − ask_entry − fees − slip_buffer
```

`fair_model` v1 peut être naïf (ex. mapping spot→proba via historique, ou simple règle PTB). Mieux vaut un modèle **simple et mesurable** qu'un modèle opaque.

---

## 7. Règles d'entrée (spec v1)

Pseudo-règles ; tous les seuils = config.

### 7.1 Filtres hard (non négociables)

1. Marché éligible (asset, durée, statut open)
2. `feed_age_ms ≤ feed_max_age`
3. `τ ≥ τ_min_entry` (assez de temps pour entrer **et** sortir)
4. `spread(T) ≤ spread_max_entry`
5. `depth_ask(T, q) ≥ q` (fill d'entrée réaliste)
6. Pas déjà `OPEN` sur ce `condition_id` (ou règle de pyramiding explicite)
7. Budget risque restant OK (section 9)

### 7.2 Signal (exemple mode Reversion / Dislocation)

Entre long `T` si :

```text
ask(T) ≤ p_entry_max          # ex. 0.08–0.25 selon style
AND edge_est ≥ edge_min       # après fees + slip buffer
AND dislocation_score ≥ s_min
AND NOT late_window
```

### 7.3 Signal (exemple mode Momentum / follow)

```text
sign(r_Δt) == side(T)
AND |r_Δt| ≥ r_min
AND ask(T) dans [p_lo, p_hi]  # éviter d'acheter déjà 0.90+
AND momentum_persistence ≥ k
```

### 7.4 Taille

```text
q = min(
  q_max_per_market,
  floor(risk_budget_remaining / ask(T)),
  depth_cap * depth_ask(T)
)
```

Ne jamais size sur `mid`.

---

## 8. Règles de sortie (cœur du edge)

Sans exit robuste, ce n'est **pas** du repricing.

### 8.1 Exit take-profit (reprice atteint)

```text
bid(T) ≥ p_in + target_abs
OU bid(T) ≥ p_in * (1 + target_rel)
OU edge_restant < edge_min_hold
```

Utiliser le **bid exécutable pour q**, pas le mid.

### 8.2 Time-stop

```text
hold_time ≥ hold_max
OU τ ≤ τ_force_exit
```

En late window : cancel resting, marketable exit selon politique (IOC / FOK / sweep limitée).

### 8.3 Stop / abandon

```text
bid(T) ≤ p_in − stop_abs
OU signal reverse (momentum / fair_model)
OU spread s'élargit au-delà de spread_max_exit
OU depth_bid insuffisante pour q_restant
```

### 8.4 Politique de partial fills

- Tracker `q_filled`, `q_remaining`, `avg_entry`
- Exit proportionnel à l'inventaire réel
- Si exit partiel : rester en `OPEN` sur le résidu avec mêmes règles

### 8.5 Fallback settlement

Si inventaire > 0 à `τ ≈ 0` :
- logger `forced_settlement = true`
- P&L = settlement − entry (net fees)
- compter comme **échec d'exit** dans les métriques (même si P&L > 0)

---

## 9. Risque

### 9.1 Limites

| Limite | Exemple de knobs |
| --- | --- |
| Par marché | `q_max`, `notional_max` |
| Par fenêtre temporelle | max positions concurrentes 5m |
| Corrélation | cap joint BTC+ETH+SOL+XRP |
| Perte | `daily_loss_limit`, `max_drawdown_session` |
| Fréquence | `max_entries_per_hour` |

### 9.2 Kill-switch

Halt si :
- feed stale prolongé
- écart clock / desync
- taux d'erreurs API / reject élevé
- `forced_settlement` rate > seuil
- breach daily loss

### 9.3 Fees & edge minimum

```text
edge_min = fees_roundtrip + slip_entry_buffer + slip_exit_buffer + safety_margin
```

Si `edge_est < edge_min` → pas d'entrée, même si le signal "a l'air beau".

---

## 10. Exécution

### 10.1 Styles d'ordre (v1 simple)

| Phase | Style suggéré |
| --- | --- |
| Entry | limit agressive (cross le ask) ou IOC taille limitée |
| Exit take-profit | limit au bid+ / join, avec timeout puis escalate |
| Exit forcé / late | IOC / sweep borné (`max_slip`) |

### 10.2 Idempotence & state

Persister :
- `order_id`, `client_order_id`
- fills, fees
- inventaire local vs inventaire reconcilié venue
- version de config / signal_id

Reconciliation périodique : bot state ↔ positions Polymarket.

### 10.3 Latence

Mesurer :
- `signal_to_order_ms`
- `order_to_ack_ms`
- `ack_to_fill_ms`

Un signal correct + fill trop tard = autre trade.

---

## 11. Backtest & simulation (obligatoire avant live)

### 11.1 Données minimales

- L2 (ou au moins BBO) Polymarket à haute fréquence
- timestamps alignés
- spot aligné
- fee schedule réaliste

### 11.2 Hypothèses de fill (être pessimiste)

- Entry au **ask** (+ slip si taille > top level)
- Exit au **bid** (− slip)
- Pas de fill magique au mid
- Queue / latency model simple (delay fixe puis calibré)

### 11.3 Métriques

| Métrique | Pourquoi |
| --- | --- |
| PnL net (fees inclus) | vérité |
| % exits avant settlement | est-ce vraiment du repricing ? |
| % forced settlement | qualité d'exit |
| avg hold time | profil |
| fill rate entry/exit | exécutabilité |
| slippage réalisé vs modèle | calibration |
| PnL par bucket de `τ` à l'entry | timing |
| max adverse excursion | stops |

### 11.4 Anti-patterns de backtest

- Utiliser le mid pour entry/exit
- Ignorer les tailles vs depth
- Look-ahead sur résolution
- Optimiser le win-rate settlement au lieu du PnL path

---

## 12. Plan d'implémentation (ordre suggéré)

### Phase 0 — Fondations

1. Registry marchés crypto short-duration
2. Sync clock + `τ`
3. Ingestion BBO/L2 + spot
4. Paper ledger (positions, fills simulés)

### Phase 1 — Shadow / paper

5. Signal engine (une seule hypothèse, ex. dislocation simple)
6. Entry/exit state machine **sans** ordres réels
7. Dashboard métriques (edge_est, forced settlement proxy)

### Phase 2 — Micro live

8. Ordres réels taille minimale, 1 marché (ex. BTC 5m)
9. Kill-switch + daily loss
10. Journal post-trade (pourquoi entry/exit)

### Phase 3 — Scale

11. Multi-assets avec budget corrélé
12. Calibration seuils sur rolling window
13. A/B de politiques d'exit (time-stop vs target)

---

## 13. Config (exemple YAML)

```yaml
repricing:
  markets:
    assets: [BTC, ETH]
    windows: [5m]
  feeds:
    max_age_ms: 250
  entry:
    tau_min_sec: 90
    spread_max: 0.03
    p_entry_max: 0.22
    edge_min: 0.025
    q_max: 25
  exit:
    target_abs: 0.06
    stop_abs: 0.08
    hold_max_sec: 120
    tau_force_exit_sec: 25
    spread_max_exit: 0.05
  risk:
    notional_max_per_market: 30
    daily_loss_limit: 40
    max_concurrent: 2
```

Ces chiffres sont des **points de départ**, pas des optima.

---

## 14. Checklist "prêt à coder"

- [ ] Définir l'hypothèse A/B/C retenue pour v1
- [ ] Modèle de prix exécutable (bid/ask/depth) branché
- [ ] State machine + persistence
- [ ] `edge_est` avec fees
- [ ] Exit forcé sur `τ`
- [ ] Métriques path vs settlement
- [ ] Paper sim sur historique BBO
- [ ] Kill-switch
- [ ] Journal décisionnel (debug)

---

## 15. Ce que ce papier n'est pas

- Pas une copie des seuils privés PolyTutor / `@vega7`
- Pas une garantie d'EV positive
- Pas un substitut à la lecture des règles de résolution du contrat
- Pas du Near-Resolution (late 95–99¢ hold) ni du Paired Hedge (YES+NO matchés)

---

## 16. Prochaine étape concrète sur ton stack

Dans `TradeInterface` :

1. Brancher ce design sur `binance-provider` + ton client CLOB Polymarket
2. Implémenter d'abord **Market-State + Exit engine** (souvent le vrai edge)
3. Ajouter un signal dislocation minimal
4. Tourner en paper sur BTC 5m pendant N sessions avant micro-live

Si tu veux la suite : je peux déduire de ton code actuel (connectors, order manager, data model) un **plan de fichiers / interfaces** adaptés à ton repo, ou un squelette TypeScript/Python de la state machine.

---

*Document généré pour implémentation personnelle — calibrer avant tout capital réel.*
