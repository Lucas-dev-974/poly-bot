#!/usr/bin/env python3
"""
Fetch OHLC 15min data from Binance for the last 3 months.

Requires: python-binance, pandas, python-dotenv
Install: pip install python-binance pandas python-dotenv

Python version: 3.13 (latest available)
"""

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
from binance.client import Client
from binance.enums import HistoricalKlinesType
from dotenv import load_dotenv

# Load environment variables from .env if present
load_dotenv()

# Binance API credentials (optional for public data, but rate limits apply)
API_KEY = os.getenv("BINANCE_API_KEY")
API_SECRET = os.getenv("BINANCE_API_SECRET")

# Configuration
SYMBOL = "BTCUSDT"  # Change to desired trading pair
INTERVAL = Client.KLINE_INTERVAL_15MINUTE
OUTPUT_DIR = Path(__file__).parent / "data"
OUTPUT_DIR.mkdir(exist_ok=True)

# Calculate 3 months ago (approximately 90 days)
END_TIME = datetime.now()
START_TIME = END_TIME - timedelta(days=90)

OUTPUT_FILE = OUTPUT_DIR / f"{SYMBOL}_15m_{START_TIME.strftime('%Y%m%d')}_{END_TIME.strftime('%Y%m%d')}.csv"


def fetch_klines(client: Client, symbol: str, interval: str, start: datetime, end: datetime) -> list:
    """
    Fetch klines (candlestick data) from Binance.
    Binance limits to 1000 klines per request, so we paginate.
    """
    all_klines = []
    current_start = start

    while current_start < end:
        klines = client.get_historical_klines(
            symbol=symbol,
            interval=interval,
            start_str=current_start.strftime("%Y-%m-%d %H:%M:%S"),
            end_str=end.strftime("%Y-%m-%d %H:%M:%S"),
            klines_type=HistoricalKlinesType.SPOT,
            limit=1000,
        )
        if not klines:
            break
        all_klines.extend(klines)
        # Next batch starts after the last fetched kline's close time
        last_close_time = klines[-1][6]  # Close time in ms
        current_start = datetime.fromtimestamp(last_close_time / 1000) + timedelta(milliseconds=1)
        print(f"Fetched {len(klines)} klines, total: {len(all_klines)}, next start: {current_start}")

    return all_klines


def klines_to_dataframe(klines: list) -> pd.DataFrame:
    """Convert raw Binance klines to a clean pandas DataFrame."""
    columns = [
        "open_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "close_time",
        "quote_asset_volume",
        "number_of_trades",
        "taker_buy_base_volume",
        "taker_buy_quote_volume",
        "ignore",
    ]
    df = pd.DataFrame(klines, columns=columns)

    # Convert timestamps to datetime
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    df["close_time"] = pd.to_datetime(df["close_time"], unit="ms")

    # Convert numeric columns
    numeric_cols = [
        "open",
        "high",
        "low",
        "close",
        "volume",
        "quote_asset_volume",
        "taker_buy_base_volume",
        "taker_buy_quote_volume",
    ]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df["number_of_trades"] = df["number_of_trades"].astype(int)

    # Set open_time as index
    df.set_index("open_time", inplace=True)
    df.sort_index(inplace=True)

    # Keep only OHLCV columns for a clean dataset
    df = df[["open", "high", "low", "close", "volume"]]

    return df


def main():
    print(f"Python version: {sys.version}")
    print(f"Fetching {SYMBOL} 15m klines from {START_TIME} to {END_TIME}")

    # Initialize Binance client (no credentials needed for public data)
    client = Client(API_KEY, API_SECRET) if API_KEY and API_SECRET else Client()

    try:
        klines = fetch_klines(client, SYMBOL, INTERVAL, START_TIME, END_TIME)
        if not klines:
            print("No data fetched. Check symbol/interval.")
            sys.exit(1)

        df = klines_to_dataframe(klines)

        # Save to CSV
        df.to_csv(OUTPUT_FILE)
        print(f"Saved {len(df)} rows to {OUTPUT_FILE}")
        print(f"Date range: {df.index.min()} to {df.index.max()}")
        print(f"Columns: {list(df.columns)}")
        print(df.head())
        print(df.tail())

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()