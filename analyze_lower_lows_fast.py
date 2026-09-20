#!/usr/bin/env python3
"""
Analyse des lower-lows (plus-bas consécutifs) sur les marchés BTC 15min - VERSION OPTIMISÉE.
"""

import sqlite3
import json
from dataclasses import dataclass
from typing import List, Optional, Tuple

# Paramètres (alignés sur fav-band-strategy.ts)
PRICE_TICK_CENTS = 1
MIN_SWING_CENTS = 5      # favBandExitMinLowerHighDrop = 0.05
RETRACE_RATIO = 0.25     # favBandExitRetraceRatio = 0.25
CONSECUTIVE_REQUIRED = 3 # favBandExitConsecutive = 3
LOOKBACK_MS = 120000     # favBandExitLookbackMs = 120000


def price_to_cents(price: float) -> int:
    return int(round(price * 100))


def required_bounce_cents(drop_c: int, min_swing_c: int, ratio: float, 
                          lowest_low_c: Optional[int], cur_low_c: int) -> int:
    if lowest_low_c is not None and lowest_low_c - cur_low_c >= min_swing_c:
        return PRICE_TICK_CENTS
    cap = max(PRICE_TICK_CENTS, min_swing_c)
    proportional = int(round(ratio * drop_c))
    return min(cap, max(PRICE_TICK_CENTS, proportional))


def analyze_ticks(ticks: List[Tuple]) -> Tuple[List[dict], Optional[Tuple[float, int]]]:
    """Analyse une liste de ticks pour un outcome donné."""
    if len(ticks) < 10:
        return [], None
    
    # État
    phase = "down"
    last_high_c = price_to_cents(ticks[0][1])
    leg_high_c = last_high_c
    lowest_low_c: Optional[int] = None
    last_swing_low_c: Optional[int] = None
    cur_extreme_c = last_high_c
    lower_lows = 0
    last_event_ts: Optional[int] = None
    sequence_id = 0
    
    events = []
    
    for ts, mid, ask, bid in ticks:
        ask_c = price_to_cents(mid)
        
        # Decay
        if (lower_lows > 0 and lower_lows < CONSECUTIVE_REQUIRED 
            and last_event_ts is not None 
            and ts - last_event_ts > LOOKBACK_MS):
            lower_lows = 0
            last_event_ts = None
        
        if phase == "down":
            if ask_c >= last_high_c:
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
            
            needed = required_bounce_cents(drop_c, MIN_SWING_CENTS, RETRACE_RATIO, 
                                          lowest_low_c, cur_extreme_c)
            
            if bounce_c >= needed:
                # Confirme un plus-bas
                low_number = lower_lows + 1 if (lowest_low_c is None or cur_extreme_c < lowest_low_c) else lower_lows
                
                events.append({
                    "sequence_id": sequence_id,
                    "low_number": low_number,
                    "low_price": cur_extreme_c / 100.0,
                    "low_ts": ts,
                    "bounce_price": (cur_extreme_c + bounce_c) / 100.0,
                    "drop_cents": drop_c,
                    "bounce_cents": bounce_c,
                    "required_bounce_cents": needed,
                })
                
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
            
            if last_swing_low_c is not None and ask_c < last_swing_low_c:
                phase = "down"
                leg_high_c = cur_extreme_c
                cur_extreme_c = ask_c
    
    # Prix final
    final_price = ticks[-1][1] if ticks else None
    final_ts = ticks[-1][0] if ticks else None
    
    return events, (final_price, final_ts) if final_price else None


def main():
    db_path = "C:/Users/lcsystem/Desktop/TradeInterface/polymarket-github/polymarket-reverse-arbitrage-bot/data/bot-live.db"
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Lister tous les marchés BTC 15min (prendre les 100 plus récents pour test rapide)
    cursor.execute("""
        SELECT DISTINCT eventSlug 
        FROM book_snapshots 
        WHERE eventSlug LIKE 'btc-updown-15m-%'
        ORDER BY eventSlug DESC
        LIMIT 100
    """)
    slugs = [row[0] for row in cursor.fetchall()]
    print(f"Marchés BTC 15min à analyser: {len(slugs)}")
    
    all_results = []
    
    for i, slug in enumerate(slugs):
        # Récupérer tous les ticks d'un coup par outcome
        cursor.execute("""
            SELECT ts, 
                   (bestAsk + bestBid) / 2.0 as mid,
                   bestAsk, bestBid
            FROM book_snapshots 
            WHERE eventSlug = ? AND bestAsk IS NOT NULL AND bestBid IS NOT NULL
            ORDER BY ts
        """, (slug,))
        
        rows = cursor.fetchall()
        
        ticks_by_outcome = {0: [], 1: []}
        for ts, mid, ask, bid in rows:
            ticks_by_outcome[0 if ask < bid else (1 if ask > bid else 0)].append((ts, mid, ask, bid))
            # Note: on ne peut pas déterminer l'outcomeIndex sans jointure, 
            # mais on peut séparer par prix relatif
            # Pour simplifier, on utilise outcomeIndex depuis la table
        
        # Meilleure approche: requête par outcomeIndex
        cursor.execute("""
            SELECT ts, (bestAsk + bestBid) / 2.0 as mid, bestAsk, bestBid
            FROM book_snapshots 
            WHERE eventSlug = ? AND outcomeIndex = 0 AND bestAsk IS NOT NULL AND bestBid IS NOT NULL
            ORDER BY ts
        """, (slug,))
        ticks_up = cursor.fetchall()
        
        cursor.execute("""
            SELECT ts, (bestAsk + bestBid) / 2.0 as mid, bestAsk, bestBid
            FROM book_snapshots 
            WHERE eventSlug = ? AND outcomeIndex = 1 AND bestAsk IS NOT NULL AND bestBid IS NOT NULL
            ORDER BY ts
        """, (slug,))
        ticks_down = cursor.fetchall()
        
        events_up, final_up = analyze_ticks(ticks_up)
        events_down, final_down = analyze_ticks(ticks_down)
        
        max_seq_up = max([e["low_number"] for e in events_up], default=0)
        max_seq_down = max([e["low_number"] for e in events_down], default=0)
        
        all_results.append({
            "slug": slug,
            "ticks_up": len(ticks_up),
            "ticks_down": len(ticks_down),
            "max_seq_up": max_seq_up,
            "max_seq_down": max_seq_down,
            "ll_count_up": len(events_up),
            "ll_count_down": len(events_down),
            "events_up": events_up,
            "events_down": events_down,
            "final_price_up": final_up[0] if final_up else None,
            "final_price_down": final_down[0] if final_down else None,
        })
        
        if i < 10 or max_seq_up >= 3 or max_seq_down >= 3:
            print(f"\n{slug}:")
            print(f"  Up: {len(ticks_up)} ticks, {len(events_up)} LL, max_seq={max_seq_up}")
            for e in events_up:
                print(f"    LL#{e['low_number']} (seq{e['sequence_id']}): low={e['low_price']:.3f}, drop={e['drop_cents']}¢, bounce={e['bounce_cents']}¢ (req={e['required_bounce_cents']}¢)")
            print(f"  Down: {len(ticks_down)} ticks, {len(events_down)} LL, max_seq={max_seq_down}")
            for e in events_down:
                print(f"    LL#{e['low_number']} (seq{e['sequence_id']}): low={e['low_price']:.3f}, drop={e['drop_cents']}¢, bounce={e['bounce_cents']}¢ (req={e['required_bounce_cents']}¢)")
            if final_up:
                print(f"  Final Up: {final_up[0]:.3f}")
            if final_down:
                print(f"  Final Down: {final_down[0]:.3f}")
        
        if i % 20 == 0 and i > 0:
            print(f"  Progression: {i}/{len(slugs)}")
    
    conn.close()
    
    # Stats globales
    total = len(all_results)
    markets_ll_up = sum(1 for r in all_results if r["ll_count_up"] > 0)
    markets_ll_down = sum(1 for r in all_results if r["ll_count_down"] > 0)
    markets_ll_any = sum(1 for r in all_results if r["ll_count_up"] > 0 or r["ll_count_down"] > 0)
    
    total_ll_up = sum(r["ll_count_up"] for r in all_results)
    total_ll_down = sum(r["ll_count_down"] for r in all_results)
    
    seq3_up = sum(1 for r in all_results if r["max_seq_up"] >= 3)
    seq3_down = sum(1 for r in all_results if r["max_seq_down"] >= 3)
    seq2_up = sum(1 for r in all_results if r["max_seq_up"] >= 2)
    seq2_down = sum(1 for r in all_results if r["max_seq_down"] >= 2)
    
    print(f"\n{'='*60}")
    print("STATISTIQUES (échantillon 100 marchés)")
    print(f"{'='*60}")
    print(f"Marchés: {total}")
    print(f"Avec LL Up: {markets_ll_up} ({markets_ll_up/total*100:.1f}%)")
    print(f"Avec LL Down: {markets_ll_down} ({markets_ll_down/total*100:.1f}%)")
    print(f"Avec LL (quelconque): {markets_ll_any} ({markets_ll_any/total*100:.1f}%)")
    print(f"Total LL Up: {total_ll_up}")
    print(f"Total LL Down: {total_ll_down}")
    print(f"Séquence >= 2 Up: {seq2_up} ({seq2_up/total*100:.1f}%)")
    print(f"Séquence >= 2 Down: {seq2_down} ({seq2_down/total*100:.1f}%)")
    print(f"Séquence >= 3 Up: {seq3_up} ({seq3_up/total*100:.1f}%)")
    print(f"Séquence >= 3 Down: {seq3_down} ({seq3_down/total*100:.1f}%)")
    
    # Post-comportement
    print("\nPost-comportement (prix final vs dernier LL):")
    for side, events_key, final_key in [("Up", "events_up", "final_price_up"), 
                                          ("Down", "events_down", "final_price_down")]:
        higher = lower = same = 0
        for r in all_results:
            events = r[events_key]
            final = r[final_key]
            if events and final:
                last_ll = events[-1]["low_price"]
                if final > last_ll + 0.005:
                    higher += 1
                elif final < last_ll - 0.005:
                    lower += 1
                else:
                    same += 1
        tot = higher + lower + same
        if tot > 0:
            print(f"  {side}: Remonté: {higher} ({higher/tot*100:.1f}%), "
                  f"Chute: {lower} ({lower/tot*100:.1f}%), Stable: {same} ({same/tot*100:.1f}%)")
    
    # Sauvegarder
    output = {
        "params": {"min_swing_cents": MIN_SWING_CENTS, "retrace_ratio": RETRACE_RATIO,
                   "consecutive_required": CONSECUTIVE_REQUIRED, "lookback_ms": LOOKBACK_MS},
        "summary": {"total_markets": total, "markets_with_ll_up": markets_ll_up,
                    "markets_with_ll_down": markets_ll_down, "markets_with_ll_any": markets_ll_any,
                    "total_ll_up": total_ll_up, "total_ll_down": total_ll_down,
                    "seq2_up": seq2_up, "seq2_down": seq2_down,
                    "seq3_up": seq3_up, "seq3_down": seq3_down},
        "markets": all_results
    }
    
    with open("lower_low_analysis_sample.json", "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\nRésultats sauvés dans lower_low_analysis_sample.json")


if __name__ == "__main__":
    main()