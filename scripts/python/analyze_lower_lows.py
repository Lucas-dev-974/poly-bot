#!/usr/bin/env python3
"""
Analyse des lower-lows (plus-bas consécutifs) sur les marchés BTC 15min.

Détecte les séquences de plus-bas confirmés selon la logique du fav-band strategy :
- Un swing = chute >= minSwing (défaut 5¢)
- Un plus-bas se fige quand le rebond remonte d'au moins retraceRatio du drop (défaut 25%), 
  borné entre 1 tick et minSwing
- Suite de lower-lows consécutifs = lowerLows++
- Reprise au-dessus du dernier high structurel = reset
"""

import sqlite3
import sys
from dataclasses import dataclass
from typing import List, Optional, Tuple
import json

# Paramètres (alignés sur fav-band-strategy.ts)
PRICE_TICK_CENTS = 1
MIN_SWING_CENTS = 5      # favBandExitMinLowerHighDrop = 0.05
RETRACE_RATIO = 0.25     # favBandExitRetraceRatio = 0.25
CONSECUTIVE_REQUIRED = 3 # favBandExitConsecutive = 3
LOOKBACK_MS = 120000     # favBandExitLookbackMs = 120000


@dataclass
class LowerLowEvent:
    """Un événement lower-low détecté."""
    market_slug: str
    outcome_index: int          # 0=Up, 1=Down
    outcome: str                # "Up" ou "Down"
    sequence_id: int            # ID de la séquence
    low_number: int             # 1er, 2ème, 3ème lower-low
    low_price: float            # Prix du plus-bas (en cents/100)
    low_ts: int                 # Timestamp du plus-bas
    bounce_price: float         # Prix du rebond qui a confirmé
    bounce_ts: int              # Timestamp du rebond
    drop_cents: int             # Amplitude de la chute (cents)
    bounce_cents: int           # Amplitude du rebond (cents)
    required_bounce_cents: int  # Rebond requis pour confirmation


@dataclass
class MarketAnalysis:
    """Analyse complète d'un marché."""
    market_slug: str
    total_ticks_up: int
    total_ticks_down: int
    lower_lows_up: List[LowerLowEvent]
    lower_lows_down: List[LowerLowEvent]
    max_sequence_up: int
    max_sequence_down: int
    price_after_last_low_up: Optional[Tuple[float, int]]  # (price, ts) après le dernier LL
    price_after_last_low_down: Optional[Tuple[float, int]]


def price_to_cents(price: float) -> int:
    return int(round(price * 100))


def required_bounce_cents(drop_c: int, min_swing_c: int, ratio: float, 
                          lowest_low_c: Optional[int], cur_low_c: int) -> int:
    """Calcule le rebond requis pour confirmer un plus-bas."""
    if lowest_low_c is not None and lowest_low_c - cur_low_c >= min_swing_c:
        return PRICE_TICK_CENTS
    cap = max(PRICE_TICK_CENTS, min_swing_c)
    proportional = int(round(ratio * drop_c))
    return min(cap, max(PRICE_TICK_CENTS, proportional))


def analyze_market(conn: sqlite3.Connection, slug: str) -> MarketAnalysis:
    """Analyse un marché pour détecter les lower-lows sur Up et Down."""
    
    # Récupérer tous les ticks ordonnés
    cursor = conn.execute("""
        SELECT ts, outcomeIndex, bestAsk, bestBid
        FROM book_snapshots 
        WHERE eventSlug = ?
        ORDER BY ts
    """, (slug,))
    
    ticks_by_outcome = {0: [], 1: []}
    for ts, oi, ask, bid in cursor.fetchall():
        if ask is not None and bid is not None:
            # Utiliser mid price pour l'analyse
            mid = (ask + bid) / 2
            ticks_by_outcome[oi].append((ts, mid, ask, bid))
    
    results = {}
    
    for oi in [0, 1]:
        ticks = ticks_by_outcome[oi]
        if len(ticks) < 10:
            results[oi] = []
            continue
        
        # État de détection (reprend la logique fav-band-strategy.ts)
        phase = "down"  # "down" ou "up"
        last_high_c = price_to_cents(ticks[0][1])  # structure high (BOS level)
        leg_high_c = last_high_c                   # origine du down-leg courant
        lowest_low_c: Optional[int] = None         # plus-bas le plus bas confirmé
        last_swing_low_c: Optional[int] = None     # dernier plus-bas confirmé
        cur_extreme_c = last_high_c                # min courant (down) ou max (up)
        lower_lows = 0
        last_event_ts: Optional[int] = None
        sequence_id = 0
        
        events: List[LowerLowEvent] = []
        
        for ts, mid, ask, bid in ticks:
            ask_c = price_to_cents(mid)  # on utilise mid pour l'analyse
            
            # Decay: séquence incomplète sans nouvel événement dans lookback
            if (lower_lows > 0 and lower_lows < CONSECUTIVE_REQUIRED 
                and last_event_ts is not None 
                and ts - last_event_ts > LOOKBACK_MS):
                lower_lows = 0
                last_event_ts = None
                # Note: on ne reset pas la structure, juste le compteur
            
            if phase == "down":
                if ask_c >= last_high_c:
                    # Reprise du structure high = reset complet
                    last_high_c = ask_c
                    leg_high_c = ask_c
                    cur_extreme_c = ask_c
                    if lowest_low_c is not None:
                        lowest_low_c = None
                        last_swing_low_c = None
                        lower_lows = 0
                        last_event_ts = None
                    continue
                
                cur_extreme_c = min(cur_extreme_c, ask_c)
                drop_c = leg_high_c - cur_extreme_c
                bounce_c = ask_c - cur_extreme_c
                
                if drop_c < MIN_SWING_CENTS:
                    continue
                
                needed = required_bounce_cents(
                    drop_c, MIN_SWING_CENTS, RETRACE_RATIO, 
                    lowest_low_c, cur_extreme_c
                )
                
                if bounce_c >= needed:
                    # Confirme un plus-bas
                    confirm_low(ask_c, ts, drop_c, bounce_c, needed, 
                               oi, slug, events, sequence_id, lower_lows, 
                               lowest_low_c, last_swing_low_c, last_event_ts)
                    
                    # Mettre à jour l'état
                    if lowest_low_c is None or cur_extreme_c < lowest_low_c:
                        lower_lows += 1
                        last_event_ts = ts
                        lowest_low_c = cur_extreme_c
                        sequence_id += 1
                    last_swing_low_c = cur_extreme_c
                    
                    phase = "up"
                    cur_extreme_c = ask_c
            
            else:  # phase == "up"
                if ask_c >= last_high_c:
                    # Reprise complète du structure high
                    phase = "down"
                    last_high_c = ask_c
                    leg_high_c = ask_c
                    cur_extreme_c = ask_c
                    lowest_low_c = None
                    last_swing_low_c = None
                    lower_lows = 0
                    last_event_ts = None
                    continue
                
                cur_extreme_c = max(cur_extreme_c, ask_c)
                
                # Failed bounce / continuation: break du dernier plus-bas
                if last_swing_low_c is not None and ask_c < last_swing_low_c:
                    phase = "down"
                    leg_high_c = cur_extreme_c
                    cur_extreme_c = ask_c
        
        results[oi] = events
    
    # Analyser le comportement post-lower-low
    price_after_up = analyze_post_behavior(ticks_by_outcome[0], results[0])
    price_after_down = analyze_post_behavior(ticks_by_outcome[1], results[1])
    
    return MarketAnalysis(
        market_slug=slug,
        total_ticks_up=len(ticks_by_outcome[0]),
        total_ticks_down=len(ticks_by_outcome[1]),
        lower_lows_up=results[0],
        lower_lows_down=results[1],
        max_sequence_up=max([e.low_number for e in results[0]], default=0),
        max_sequence_down=max([e.low_number for e in results[1]], default=0),
        price_after_last_low_up=price_after_up,
        price_after_last_low_down=price_after_down,
    )


def confirm_low(ask_c: int, ts: int, drop_c: int, bounce_c: int, needed: int,
                oi: int, slug: str, events: List[LowerLowEvent], 
                sequence_id: int, lower_lows: int,
                lowest_low_c: Optional[int], last_swing_low_c: Optional[int],
                last_event_ts: Optional[int]):
    """Enregistre un lower-low confirmé."""
    # Déterminer le numéro dans la séquence
    low_number = lower_lows + 1 if (lowest_low_c is None or ask_c < lowest_low_c) else lower_lows
    
    events.append(LowerLowEvent(
        market_slug=slug,
        outcome_index=oi,
        outcome="Up" if oi == 0 else "Down",
        sequence_id=sequence_id,
        low_number=low_number,
        low_price=ask_c / 100.0,
        low_ts=ts,
        bounce_price=(ask_c + bounce_c) / 100.0,
        bounce_ts=ts,  # approximatif - le bounce s'est produit avant ce ts
        drop_cents=drop_c,
        bounce_cents=bounce_c,
        required_bounce_cents=needed,
    ))


def analyze_post_behavior(ticks: List[Tuple], events: List[LowerLowEvent]) -> Optional[Tuple[float, int]]:
    """Analyse le prix après le dernier lower-low."""
    if not events or not ticks:
        return None
    
    last_event = events[-1]
    # Trouver le prix à la fin du marché (dernier tick)
    if ticks:
        last_tick = ticks[-1]
        return (last_tick[1], last_tick[0])  # (price, ts)
    return None


def print_market_analysis(ma: MarketAnalysis):
    """Affiche l'analyse d'un marché."""
    print(f"\n{'='*80}")
    print(f"MARCHÉ: {ma.market_slug}")
    print(f"  Ticks Up: {ma.total_ticks_up}, Down: {ma.total_ticks_down}")
    print(f"  Max séquences - Up: {ma.max_sequence_up}, Down: {ma.max_sequence_down}")
    
    for outcome_name, events in [("UP", ma.lower_lows_up), ("DOWN", ma.lower_lows_down)]:
        if not events:
            print(f"  {outcome_name}: Aucun lower-low détecté")
            continue
        
        print(f"  {outcome_name}: {len(events)} lower-lows détectés")
        for e in events:
            print(f"    LL#{e.low_number} (seq {e.sequence_id}): "
                  f"low={e.low_price:.3f} @ {e.low_ts}, "
                  f"drop={e.drop_cents}¢, bounce={e.bounce_cents}¢ (req={e.required_bounce_cents}¢)")
    
    # Post-comportement
    if ma.price_after_last_low_up:
        p, ts = ma.price_after_last_low_up
        print(f"  Prix final Up: {p:.3f} @ {ts}")
    if ma.price_after_last_low_down:
        p, ts = ma.price_after_last_low_down
        print(f"  Prix final Down: {p:.3f} @ {ts}")


def main():
    db_path = "C:/Users/lcsystem/Desktop/TradeInterface/polymarket-github/polymarket-reverse-arbitrage-bot/data/bot-live.db"
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Lister tous les marchés BTC 15min
    cursor.execute("""
        SELECT DISTINCT eventSlug 
        FROM book_snapshots 
        WHERE eventSlug LIKE 'btc-updown-15m-%'
        ORDER BY eventSlug
    """)
    slugs = [row[0] for row in cursor.fetchall()]
    print(f"Marchés BTC 15min trouvés: {len(slugs)}")
    
    # Analyser tous les marchés
    all_analyses: List[MarketAnalysis] = []
    
    for i, slug in enumerate(slugs):
        ma = analyze_market(conn, slug)
        all_analyses.append(ma)
        if i < 5 or ma.max_sequence_up >= 3 or ma.max_sequence_down >= 3:
            print_market_analysis(ma)
        if i % 50 == 0 and i > 0:
            print(f"  Progression: {i}/{len(slugs)}")
    
    conn.close()
    
    # Statistiques globales
    print(f"\n{'='*80}")
    print("STATISTIQUES GLOBALES")
    print(f"{'='*80}")
    
    total_markets = len(all_analyses)
    markets_with_ll_up = sum(1 for m in all_analyses if m.lower_lows_up)
    markets_with_ll_down = sum(1 for m in all_analyses if m.lower_lows_down)
    markets_with_ll_any = sum(1 for m in all_analyses if m.lower_lows_up or m.lower_lows_down)
    
    total_ll_up = sum(len(m.lower_lows_up) for m in all_analyses)
    total_ll_down = sum(len(m.lower_lows_down) for m in all_analyses)
    
    seq3_up = sum(1 for m in all_analyses if m.max_sequence_up >= 3)
    seq3_down = sum(1 for m in all_analyses if m.max_sequence_down >= 3)
    seq2_up = sum(1 for m in all_analyses if m.max_sequence_up >= 2)
    seq2_down = sum(1 for m in all_analyses if m.max_sequence_down >= 2)
    
    print(f"Marchés totaux: {total_markets}")
    print(f"Marchés avec lower-lows Up: {markets_with_ll_up} ({markets_with_ll_up/total_markets*100:.1f}%)")
    print(f"Marchés avec lower-lows Down: {markets_with_ll_down} ({markets_with_ll_down/total_markets*100:.1f}%)")
    print(f"Marchés avec lower-lows (quelconque): {markets_with_ll_any} ({markets_with_ll_any/total_markets*100:.1f}%)")
    print(f"Total lower-lows Up: {total_ll_up}")
    print(f"Total lower-lows Down: {total_ll_down}")
    print(f"Marchés avec séquence >= 2 Up: {seq2_up} ({seq2_up/total_markets*100:.1f}%)")
    print(f"Marchés avec séquence >= 2 Down: {seq2_down} ({seq2_down/total_markets*100:.1f}%)")
    print(f"Marchés avec séquence >= 3 Up: {seq3_up} ({seq3_up/total_markets*100:.1f}%)")
    print(f"Marchés avec séquence >= 3 Down: {seq3_down} ({seq3_down/total_markets*100:.1f}%)")
    
    # Distribution des longueurs de séquences
    print("\nDistribution des séquences (max par marché):")
    for side_name, max_seq_attr in [("Up", "max_sequence_up"), ("Down", "max_sequence_down")]:
        dist = {}
        for m in all_analyses:
            v = getattr(m, max_seq_attr)
            dist[v] = dist.get(v, 0) + 1
        print(f"  {side_name}: " + ", ".join(f"{k}→{v}" for k, v in sorted(dist.items())))
    
    # Comportement post-lower-low
    print("\nAnalyse post-lower-low (prix à la fin du marché vs dernier lower-low):")
    for side_name, events_attr, price_after_attr in [
        ("Up", "lower_lows_up", "price_after_last_low_up"),
        ("Down", "lower_lows_down", "price_after_last_low_down")
    ]:
        higher = 0
        lower = 0
        same = 0
        for m in all_analyses:
            events = getattr(m, events_attr)
            price_after = getattr(m, price_after_attr)
            if events and price_after:
                last_low_price = events[-1].low_price
                final_price = price_after[0]
                if final_price > last_low_price + 0.005:
                    higher += 1
                elif final_price < last_low_price - 0.005:
                    lower += 1
                else:
                    same += 1
        total = higher + lower + same
        if total > 0:
            print(f"  {side_name}: Remonté >0.5¢: {higher} ({higher/total*100:.1f}%), "
                  f"Continuer chute >0.5¢: {lower} ({lower/total*100:.1f}%), "
                  f"Stable: {same} ({same/total*100:.1f}%)")
    
    # Exporter les résultats détaillés en JSON
    output = {
        "params": {
            "min_swing_cents": MIN_SWING_CENTS,
            "retrace_ratio": RETRACE_RATIO,
            "consecutive_required": CONSECUTIVE_REQUIRED,
            "lookback_ms": LOOKBACK_MS,
        },
        "summary": {
            "total_markets": total_markets,
            "markets_with_ll_up": markets_with_ll_up,
            "markets_with_ll_down": markets_with_ll_down,
            "markets_with_ll_any": markets_with_ll_any,
            "total_ll_up": total_ll_up,
            "total_ll_down": total_ll_down,
            "seq2_up": seq2_up,
            "seq2_down": seq2_down,
            "seq3_up": seq3_up,
            "seq3_down": seq3_down,
        },
        "markets": []
    }
    
    for ma in all_analyses:
        output["markets"].append({
            "slug": ma.market_slug,
            "ticks_up": ma.total_ticks_up,
            "ticks_down": ma.total_ticks_down,
            "max_seq_up": ma.max_sequence_up,
            "max_seq_down": ma.max_sequence_down,
            "ll_count_up": len(ma.lower_lows_up),
            "ll_count_down": len(ma.lower_lows_down),
            "ll_events_up": [
                {
                    "seq": e.sequence_id,
                    "num": e.low_number,
                    "low_price": e.low_price,
                    "low_ts": e.low_ts,
                    "drop_cents": e.drop_cents,
                    "bounce_cents": e.bounce_cents,
                    "req_bounce": e.required_bounce_cents,
                } for e in ma.lower_lows_up
            ],
            "ll_events_down": [
                {
                    "seq": e.sequence_id,
                    "num": e.low_number,
                    "low_price": e.low_price,
                    "low_ts": e.low_ts,
                    "drop_cents": e.drop_cents,
                    "bounce_cents": e.bounce_cents,
                    "req_bounce": e.required_bounce_cents,
                } for e in ma.lower_lows_down
            ],
            "final_price_up": ma.price_after_last_low_up[0] if ma.price_after_last_low_up else None,
            "final_price_down": ma.price_after_last_low_down[0] if ma.price_after_last_low_down else None,
        })
    
    with open("lower_low_analysis.json", "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\nRésultats détaillés exportés dans lower_low_analysis.json")


if __name__ == "__main__":
    main()