#!/usr/bin/env python3
"""
Clustering script to identify patterns in 3-candle windows (OHLC + technical indicators)
that predict next candle direction (up/down) for BTCUSDT 15m data.
"""

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Try to import technical analysis libs; install if missing
def _ensure_package(pkg_name, pip_name=None):
    try:
        __import__(pkg_name)
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", pip_name or pkg_name])
        print(f"Installed {pip_name or pkg_name}")

_ensure_package("ta")  # Technical Analysis Library
_ensure_package("sklearn")  # scikit-learn
_ensure_package("kneed")  # For elbow detection

import ta
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from kneed import KneeLocator


DATA_PATH = Path(__file__).parent / "data" / "BTCUSDT_15m_20260628_20260926.csv"
if not DATA_PATH.exists():
    sys.exit(f"Data file not found: {DATA_PATH}")

print(f"Loading data from {DATA_PATH}")
df = pd.read_csv(DATA_PATH, parse_dates=["open_time"])
print(f"Loaded {len(df)} rows")

# Ensure required columns exist
required = ["open", "high", "low", "close", "volume"]
if not all(col in df.columns for col in required):
    sys.exit("Missing OHLCV columns")

# Compute technical indicators
# RSI
df["rsi"] = ta.momentum.RSIIndicator(df["close"], window=14).rsi()
# MACD
macd = ta.trend.MACD(df["close"])
df["macd"] = macd.macd()
df["macd_signal"] = macd.macd_signal()
df["macd_hist"] = macd.macd_diff()

# Drop rows with NaN due to indicators
df.dropna(inplace=True)
print(f"After indicator calculation and dropna: {len(df)} rows")

# Define features per candle
feature_cols = ["open", "high", "low", "close", "volume", "rsi", "macd", "macd_signal", "macd_hist"]
# Ensure all exist
missing = [c for c in feature_cols if c not in df.columns]
if missing:
    sys.exit(f"Missing feature columns: {missing}")

# Create target: next candle direction (1 if up (close > open), 0 if down)
df["next_up"] = (df["close"].shift(-1) > df["open"].shift(-1)).astype(int)
# Drop last row because no next candle
df = df[:-1].copy()
print(f"After creating target and dropping last: {len(df)} rows")

# Create sliding windows of size 3
window_size = 3
X_list = []
y_list = []

for i in range(window_size - 1, len(df)):
    window = df.iloc[i - window_size + 1 : i + 1][feature_cols].values  # shape (3, n_features)
    X_list.append(window.flatten())  # flatten to 1D
    y_list.append(df.iloc[i]["next_up"])

X = np.array(X_list)
y = np.array(y_list)
print(f"Created {X.shape[0]} samples with {X.shape[1]} features each")

# Standardize features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# Determine optimal number of clusters using Elbow method
max_clusters = 10
inertias = []
K_range = range(2, max_clusters + 1)
for k in K_range:
    kmeans = KMeans(n_clusters=k, random_state=42, n_init="auto")
    kmeans.fit(X_scaled)
    inertias.append(kmeans.inertia_)

# Find elbow point using KneeLocator
kneeloc = KneeLocator(list(K_range), inertias, curve="convex", direction="decreasing")
optimal_k = kneeloc.elbow if kneeloc.elbow else len(K_range)//2 + 2  # fallback
print(f"Elbow method suggests optimal clusters: {optimal_k}")

# Fit final KMeans with optimal k
final_kmeans = KMeans(n_clusters=optimal_k, random_state=42, n_init="auto")
cluster_labels = final_kmeans.fit_predict(X_scaled)

# Add cluster labels to dataframe (align with samples)
df_samples = df.iloc[window_size - 1 :].copy()
df_samples["cluster"] = cluster_labels

# Evaluate predictive power per cluster
cluster_stats = []
for cl in range(optimal_k):
    cluster_data = df_samples[df_samples["cluster"] == cl]
    if len(cluster_data) == 0:
        continue
    up_count = cluster_data["next_up"].sum()
    total = len(cluster_data)
    up_ratio = up_count / total if total > 0 else 0
    # Majority class prediction
    pred_up = 1 if up_ratio > 0.5 else 0
    accuracy = (up_ratio if pred_up == 1 else 1 - up_ratio)
    cluster_stats.append(
        {
            "cluster": cl,
            "size": total,
            "up_count": up_count,
            "down_count": total - up_count,
            "up_ratio": up_ratio,
            "majority_pred": "up" if pred_up == 1 else "down",
            "accuracy": accuracy,
        }
    )

# Overall accuracy if we predict per cluster majority
total_correct = sum(stat["size"] * stat["accuracy"] for stat in cluster_stats)
overall_accuracy = total_correct / len(df_samples) if len(df_samples) > 0 else 0

print("\n=== Clustering Results ===")
print(f"Number of clusters: {optimal_k}")
print(f"Total samples: {len(df_samples)}")
print("\nPer-cluster statistics:")
for stat in cluster_stats:
    print(
        f"Cluster {stat['cluster']}: size={stat['size']}, "
        f"up={stat['up_count']}/{stat['size']} ({stat['up_ratio']:.2%}), "
        f"majority={stat['majority_pred']}, accuracy={stat['accuracy']:.2%}"
    )
print(f"\nOverall accuracy (predicting majority per cluster): {overall_accuracy:.2%}")

# Optionally save the model and scaler
import joblib

model_dir = Path(__file__).parent / "models"
model_dir.mkdir(exist_ok=True)
joblib.dump(final_kmeans, model_dir / "kmeans_model.pkl")
joblib.dump(scaler, model_dir / "scaler.pkl")
print(f"\nModel and scaler saved to {model_dir}")

# Save clustered dataframe for inspection
out_csv = Path(__file__).parent / "data" / "BTCUSDT_15m_clustered.csv"
df_samples.to_csv(out_csv, index=False)
print(f"Clustered data saved to {out_csv}")