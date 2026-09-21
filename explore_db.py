import sqlite3

# Explorer la base de données locale
conn = sqlite3.connect("C:/Users/lcsystem/Desktop/TradeInterface/polymarket-github/polymarket-reverse-arbitrage-bot/data/bot.db")
cursor = conn.cursor()

# Lister les tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
print("Tables:", [row[0] for row in cursor.fetchall()])

# Schéma book_snapshots
cursor.execute("PRAGMA table_info(book_snapshots)")
print("\nbook_snapshots schema:")
for row in cursor.fetchall():
    print(row)

# Compter les événements
cursor.execute("SELECT COUNT(*) FROM book_snapshots")
print(f"\nTotal book_snapshots: {cursor.fetchone()[0]}")

# Lister les eventSlugs
cursor.execute("SELECT DISTINCT eventSlug FROM book_snapshots ORDER BY eventSlug")
slugs = [row[0] for row in cursor.fetchall()]
print(f"\nEvent slugs ({len(slugs)}):")
for s in slugs[:20]:
    print(f"  {s}")

# Pour un slug BTC 15m, regarder les données
btc_slugs = [s for s in slugs if 'btc-updown-15m' in s]
if btc_slugs:
    slug = btc_slugs[0]
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
    
    # Afficher les premiers ticks pour Up
    cursor.execute("""
        SELECT ts, bestAsk, bestBid, bestAskSize, bestBidSize
        FROM book_snapshots 
        WHERE eventSlug = ? AND outcomeIndex = 0
        ORDER BY ts
        LIMIT 20
    """, (slug,))
    print(f"\nFirst 20 ticks for Up (outcomeIndex=0):")
    for row in cursor.fetchall():
        print(f"  ts={row[0]} ask={row[1]} bid={row[2]} askSize={row[3]} bidSize={row[4]}")

conn.close()