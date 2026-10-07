# Audit + backtest runner officiel — open-entry & flip-confirm (BTC 15m)

Date : 2026-10-07 · DB : `data/bot-live.db` (2.5 Go, freshness OK : ticks sub-minute) ·
Univers : fenêtres `btc-updown-15m-*` complètes (801+/60 s, bornes inclusives, résolutions requises, `completeOnly`).

## 1. Audit

### Données (BTC 15m, 30 jours enregistrés)
- 2 338 fenêtres BTC 15m uniques, 2 190 résolues ; **1 282 complètes** (801 ticks / gap ≤ 60 s) → univers du runner.
- **Trous de complétude signalés** : 2026-09-19 → 2026-10-01 quasi vide (0 fenêtre complète — enregistrement incomplet), sauf 10-02..10-07 qui re-quotent à ~96/jour. Le PnL global mélange donc deux blocs *disjoints* (09-08..09-18 et 10-02..10-07) — splits obligatoires.
- Le 15m est déjà multi-timeframe côté infra (durée dérivée du slug) ; les params moteur restent calibrés 15m — rien à re-calibrer pour cet audit.

### Engines (code-only)
- `open-entry` et `flip-confirm` : tous deux **registered dans `STRATEGY_IDS`**, factory `src/strategy/registry.ts:28/31`, `leadsWithEdge=false`, presets `config/presets/{open-entry,flip-confirm}.json` cohérents avec les defaults de `src/config.ts`.
- open-entry : `usesDefendAsExit=true` (SL via pipeline defend), state par paire purgé — wiring conforme au blueprint d'implémentation.
- flip-confirm : pas d'exit (hold to resolution), flip hystérésis, bande 0.55-0.65 — conforme au rapport 2026-09-15.
- Base de test : `tests/helpers.ts` porte les clés flipConfirm/openEntry à jour ; `tests/open-entry.test.ts` 16/16, `tests/new-strats.test.ts` 27/27, `tests/strategy.test.ts` 24/24, `tests/backtest-engine.test.ts` 7/7 → **0 fail**, `npm run build` OK (exit 0).

## 2. Backtest runner officiel (config = presets)

| Config | fills | WR | PnL | t (18 j) | rejects | Notes |
|---|---:|---:|---:|---:|---:|---|
| **open-entry** (SL dual-scale) | 1592 | 34.3 % | **+$423.45** | +1.73 | 0 | SELL defend = 631 (SL actif) |
| **open-entry hold-ref** (SL off) | 961 | 62.6 % | +$407.91 | +1.08 | 0 | refs par jour divergent → SL = lissage |
| **flip-confirm** | 580 | 59.0 % | **+$31.64** | +0.11 | 0 | hold intégral, 0 SELL defend (attendu) |

- **Invariants** : rejets=0 partout, par jour (somme)==pnl exactement pour les deux, unresolved=0.
- **PnL % (borne sup. du notional déployé ≤$15/fill)** : open-entry +1.8 %, hold +2.8 %, flip-confirm +0.4 % — le % de l'index (`+14 %`) était calculé sur le notional *sim* de la fenêtre d'origine, à ne pas réutiliser ici.

### Splits par bloc (le gap de données interdit le PnL global comme verdict)
```
bloc                flip-confirm   open-entry(SL)   hold-ref
P1 09-08..09-15    $279.34 (08-15)    +$335.07        +$417.49
P1 fin 09-16..09-19  −$116.8 (16-19)   −$5.34 (08-19)  −$52.27 (08-19)
P2 10-02..10-07      −$192.73          +$93.72         +$42.69
```
- **flip-confirm s'effondre en octobre** : 15/18 des fenêtres complètes 10-02..10-07 sont négatives pour WR vs 09 ; P1 + $279 → P2 −$193. Le signal n'a pas survécu au changement de régime.
- **open-entry tient beaucoup mieux** : hold-ref positif des deux côtés (+$268 / −$208), SL lisse (631 SELL defend, aucune fenêtre où SL<hold n'est catastrophique).

## 3. Verdicts
1. **open-entry** : le edge tiendrait sur le bloc octobre (hold-ref +$408 vs P1 +$268, SL tient le DD à 6 j négatifs). Verdict nuancé : PnL positif sur les deux blocs, mais la période gap 09-19..10-01 fait 13/18 de la variance de l'univers — à ne pas interpréter comme un régime continu.
2. **flip-confirm** : **l'échantillon 2026-09-15 (+$389 / WR 66.5 %) ne reproduit pas** — sur l'univers étendu à 18 jours le PnL retombe à +$31.64 (t 0.11) : le signal était probablement ré-gime-dépendant (semaine du 08-15/09). Ne pas trader en l'état sans re-calibration du band/lookback sur le nouveau régime.
3. **Robustesse** : 0 rejects, invariants comptables sains, univers exactement calibré sur le loader officiel (book_snapshots bornes inclusives, 801+/60s, résolutions requises). Le gap 09-19..10-01 est un artefact d'enregistrement — ni un ni l'autre n'a échantillonné ces fenêtres, il n'y a PAS d'edge mesurable dessus.

## 4. Réserves
- Un seul actif, 18 jours effectifs, ~3 blocs de régime macro. Le split-half open-entry hold (+/− de part et d'autre du gap) est le seul test de robustesse raisonnable ici, et il est positif.
- flip-confirm : le WR 66.5 % vs 59 % ici + P1 re-quoté ($279 vs $389) suggère aussi que la calibration runner du 09-15 était un peu optimiste (l'univers courant contient plus de fenêtres).
- Les SL open-entry **dégradent WR et PnL unitaire** (34 % vs 62 % WR) mais lissent le PnL/jour (std 57.80 vs 89.31) — trade-off à arbitrer explicitement avec le drawdown max voulu (voir le rapport d'implémentation 2026-09-19).

## 5. Artefacts
- `audits/backtest/flip-confirm/flip-confirm-official-runner-1791344351988.json` (nouveau script `scripts/research/flip-confirm/official-runner.mts`)
- `audits/backtest/open-entry/open-entry-wiring-runner-1791344817782.json` (re-run `scripts/research/open-entry/wiring-runner.mts`)