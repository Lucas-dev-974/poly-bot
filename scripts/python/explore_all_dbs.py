import sqlite3
import sys

def explore_db(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [row[0] for row in cursor.fetchall()]
    print(f"=== {db_path} ===")
    print(f"Tables: {tables}")
    
    if 'book_snapshots' in tables:
        cursor.execute("PRAGMA table_info(book_snapshots)")
        print("book_snapshots schema:")
        for row in cursor.fetchall():
            print(f"  {row}")
        
        cursor.execute("SELECT COUNT(*) FROM book_snapshots")
        count = cursor.fetchone()[0]
        print(f"Total book_snapshots: {count}")
        
        if count > 0:
            cursor.execute("SELECT DISTINCT eventSlug FROM book_snapshots ORDER BY eventSlug")
            slugs = [row[0] for row in cursor.fetchall()]
            print(f"Event slugs ({len(slugs)}):")
            for s in slugs[:30]:
                print(f"  {s}")
            
            btc_slugs = [s for s in slugs if 'btc-updown-15m' in s]
            for slug in btc_slugs[:3]:
                print(f"\nAnalyzing {slug}:")
                cursor.execute("""
                    SELECT outcomeIndex, COUNT(*) as cnt, MIN(ts) as min_ts, MAX(ts) as max_ts,
                           MIN(bestAsk) as min_ask, MAX(bestAsk) as max_ask,
                           MIN(bestBid) as min_bid, MAX(bestBid) as max_bid
                    FROM book_snapshots 
                    WHERE eventSlug = ?
                    GROUP BY outcomeIndex
                """, (slug,))
                for row in cursor.fetchall():
                    print(f"  outcomeIndex={row[0]}: {row[1]} ticks, ts={row[2]}..{row[3]}, ask={row[4]}..{row[5]}, bid={row[6]}..{row[7]}")
    
    conn.close()

# Explorer plusieurs DBs
for db in [
    "data/bot.db",
    "data/bot-live.db", 
    "data/bot-fixsmoke.db",
    "data/bot-arb-audit.db",
    "data/bot-asklock-probe.db",
    "data/_strat-compare-1789326396145.db",
    "data/_calib-newstrats-1789459088477.db",
]:
    try:
        explore_db(db)
    except Exception as e:
        print(f"Error with {db}: {e}")