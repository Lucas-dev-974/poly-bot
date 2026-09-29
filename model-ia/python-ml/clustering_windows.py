#!/usr/bin/env python3
"""
Clustering for multiple window sizes (5 and 10 candles) on BTCUSDT 15m data.
Outputs results to dedicated text files and saves clustered CSVs.
"""

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# Ensure packages
def _ensure_package(pkg_name, pip_name=None):
    try:
        __import__(pkg_name)
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", pip_name or pkg_name])
        print(f"Installed {pip_name or pkg_name}")

_ensure_package("ta")
_ensure_package("sklearn")
_ensure_package("kneed")
_ensure_package("joblib")

import ta
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from kneed import KneeLocator
import joblib

DATA_PATH = Path(__file__).parent / "data" / "BTCUSDT_15m_20260628_20260926.csv"
if not DATA_PATH.exists():
    sys.exit(f"Data file not found: {DATA_PATH}")

print(f"Loading data from {DATA_PATH}")
df_raw = pd.read_csv(DATA_PATH, parse_dates=["open_time"])
print(f"Loaded {len(df_raw)} rows")

required = ["open", "high", "low", "close", "volume"]
if not all(col in df_raw.columns for col in required):
    sys.exit("Missing OHLCV columns")

# Compute technical indicators (same for all windows)
df = df_raw.copy()
df["rsi"] = ta.momentum.RSIIndicator(df["close"], window=14).rsi()
macd = ta.trend.MACD(df["close"])
df["macd"] = macd.macd()
df["macd_signal"] = macd.macd_signal()
df["macd_hist"] = macd.macd_diff()
df.dropna(inplace=True)
print(f"After indicators and dropna: {len(df)} rows")

# Target: next candle direction (1 if up)
df["next_up"] = (df["close"].shift(-1) > df["open"].shift(-1)).astype(int)
df = df[:-1].copy()  # drop last row
print(f"After target creation: {len(df)} rows")

feature_cols = ["open", "high", "low", "close", "volume", "rsi", "macd", "macd_signal", "macd_hist"]
missing = [c for c in feature_cols if c not in df.columns]
if missing:
    sys.exit(f"Missing feature columns: {missing}")

window_sizes = [5, 10]
results_summary = {}

for ws in window_sizes:
    print(f"\n=== Processing window size = {ws} ===")
    X_list = []
    y_list = []
    for i in range(ws - 1, len(df)):
        window = df.iloc[i - ws + 1 : i + 1][feature_cols].values  # shape (ws, n_features)
        X_list.append(window.flatten())
        y_list.append(df.iloc[i]["next_up"])
    X = np.array(X_list)
    y = np.array(y_list)
    print(f"Samples: {X.shape[0]}, features per sample: {X.shape[1]} ({ws} candles * {len(feature_cols)} features)")

    # Standardize
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Elbow method to find optimal k
    max_clusters = 10
    inertias = []
    K_range = range(2, max_clusters + 1)
    for k in K_range:
        kmeans = KMeans(n_clusters=k, random_state=42, n_init="auto")
        kmeans.fit(X_scaled)
        inertias.append(kmeans.inertia_)
    kneeloc = KneeLocator(list(K_range), inertias, curve="convex", direction="decreasing")
    optimal_k = kneeloc.elbow if kneeloc.elbow else len(K_range)//2 + 2
    print(f"Elbow suggests optimal clusters: {optimal_k}")

    # Fit final model
    final_kmeans = KMeans(n_clusters=optimal_k, random_state=42, n_init="auto")
    cluster_labels = final_kmeans.fit_predict(X_scaled)

    # Align with dataframe
    df_samples = df.iloc[ws - 1 :].copy()
    df_samples["cluster"] = cluster_labels

    # Per-cluster stats
    cluster_stats = []
    for cl in range(optimal_k):
        sub = df_samples[df_samples["cluster"] == cl]
        if len(sub) == 0:
            continue
        up_cnt = sub["next_up"].sum()
        total = len(sub)
        up_ratio = up_cnt / total if total > 0 else 0
        pred_up = 1 if up_ratio > 0.5 else 0
        acc = up_ratio if pred_up == 1 else 1 - up_ratio
        cluster_stats.append({
            "cluster": cl,
            "size": total,
            "up": up_cnt,
            "down": total - up_cnt,
            "up_ratio": up_ratio,
            "majority": "up" if pred_up == 1 else "down",
            "accuracy": acc
        })

    # Overall accuracy (majority per cluster)
    total_correct = sum(stat["size"] * stat["accuracy"] for stat in cluster_stats)
    overall_acc = total_correct / len(df_samples) if len(df_samples) > 0 else 0

    # Store results
    results_summary[ws] = {
        "samples": len(df_samples),
        "features": X.shape[1],
        "optimal_clusters": optimal_k,
        "overall_accuracy": overall_acc,
        "cluster_stats": cluster_stats
    }

    # Save clustered CSV
    out_csv = Path(__file__).parent / "data" / f"BTCUSDT_15m_clustered_w{ws}.csv"
    df_samples.to_csv(out_csv, index=False)
    print(f"Saved clustered data to {out_csv}")

    # Save model and scaler
    model_dir = Path(__file__).parent / "models"
    model_dir.mkdir(exist_ok=True)
    joblib.dump(final_kmeans, model_dir / f"kmeans_w{ws}.pkl")
    joblib.dump(scaler, model_dir / f"scaler_w{ws}.pkl")
    print(f"Saved model and scaler for window {ws} to {model_dir}")

    # Write dedicated result file
    result_file = Path(__file__).parent / f"clustering_results_window{ws}.txt"
    with open(result_file, "w", encoding="utf-8") as f:
        f.write(f"Clustering Results for Window Size = {ws} candles\n")
        f.write("="*50 + "\n")
        f.write(f"Number of samples: {len(df_samples)}\n")
        f.write(f"Features per sample: {X.shape[1]} ({ws} candles × {len(feature_cols)} features)\n")
        f.write(f"Optimal number of clusters (Elbow): {optimal_k}\n")
        f.write(f"Overall accuracy (majority per cluster): {overall_acc:.2%}\n\n")
        f.write("Per-cluster statistics:\n")
        for stat in cluster_stats:
            f.write(
                f"  Cluster {stat['cluster']}: size={stat['size']}, "
                f"up={stat['up']}/{stat['size']} ({stat['up_ratio']:.2%}), "
                f"majority={stat['majority']}, accuracy={stat['accuracy']:.2%}\n"
            )
    print(f"Saved detailed results to {result_file}")

# Print summary to console
print("\n===== SUMMARY ACROSS WINDOW SIZES =====")
for ws, res in results_summary.items():
    print(f"Window {ws}: samples={res['samples']}, features={res['features']}, "
          f"clusters={res['optimal_clusters']}, overall accuracy={res['overall_accuracy']:.2%}")

print("\nDone.")