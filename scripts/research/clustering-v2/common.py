# -*- coding: utf-8 -*-
"""Shared utilities for clustering-v2 studies A and B."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.preprocessing import StandardScaler

PROJECT = Path(r"C:\Users\lcsystem\Desktop\TradeInterface\polymarket-github\polymarket-reverse-arbitrage-bot")
DATA_DIR = PROJECT / "data" / "datasets" / "btc15-clustering"
TICKS_CSV = DATA_DIR / "btc15_ticks_complete_2026-09-08_to_2026-10-05_28j.csv"
WINDOWS_CSV = DATA_DIR / "btc15_windows_complete_2026-09-08_to_2026-10-05_28j.csv"
SCRIPTS_DIR = PROJECT / "scripts" / "research" / "clustering-v2"
AUDITS = PROJECT / "audits" / "clustering-v2"
STAKE = 4.0  # flat USD stake
# Only fee constant in src/ is repricingFeesRoundtrip=0.002 (strategy-specific mid-exit).
# Hold-to-resolution taker sim: no general fee model → fees = 0.
FEE = 0.0


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def write_json(path: Path, obj: Any) -> None:
    write_text(path, json.dumps(obj, indent=2, ensure_ascii=False, default=_json_default))


def _json_default(o: Any) -> Any:
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (pd.Timestamp,)):
        return o.isoformat()
    raise TypeError(type(o))


def wilson_ci(k: int, n: int, z: float = 1.96) -> Tuple[float, float]:
    if n <= 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((centre - margin) / den, (centre + margin) / den)


def binom_pvalue(k: int, n: int, p0: float) -> float:
    """Two-sided exact binomial test vs baseline p0."""
    if n <= 0 or not (0 < p0 < 1):
        return float("nan")
    # scipy >=1.10: binomtest
    try:
        res = stats.binomtest(k, n, p0, alternative="two-sided")
        return float(res.pvalue)
    except Exception:
        return float(stats.binom_test(k, n, p0, alternative="two-sided"))


def benjamini_hochberg(pvals: List[float], alpha: float = 0.05) -> List[bool]:
    m = len(pvals)
    if m == 0:
        return []
    indexed = sorted(enumerate(pvals), key=lambda x: (math.inf if (x[1] is None or (isinstance(x[1], float) and math.isnan(x[1]))) else x[1]))
    reject = [False] * m
    max_i = -1
    for rank, (idx, p) in enumerate(indexed, start=1):
        if p is None or (isinstance(p, float) and math.isnan(p)):
            continue
        if p <= alpha * rank / m:
            max_i = rank
    for rank, (idx, p) in enumerate(indexed, start=1):
        if rank <= max_i:
            reject[idx] = True
    return reject


def load_windows() -> pd.DataFrame:
    w = pd.read_csv(WINDOWS_CSV)
    w["window_start"] = pd.to_datetime(w["window_start"], utc=True)
    w["window_end"] = pd.to_datetime(w["window_end"], utc=True)
    w = w.sort_values("window_start").reset_index(drop=True)
    w["up_won"] = w["up_won"].astype(int)
    return w


def load_ticks(usecols: Optional[List[str]] = None) -> pd.DataFrame:
    cols = usecols or [
        "window_id", "elapsed_sec", "best_bid_up", "best_ask_up",
        "depth_bid_up", "depth_ask_up", "best_bid_down", "best_ask_down",
        "depth_bid_down", "depth_ask_down", "mid_up", "mid_down",
        "ask_sum", "spread_up", "spread_down", "up_won",
    ]
    t = pd.read_csv(TICKS_CSV, usecols=cols)
    t = t.sort_values(["window_id", "elapsed_sec"]).reset_index(drop=True)
    return t


def chronological_split(windows: pd.DataFrame, train_frac: float = 0.70) -> Tuple[pd.DataFrame, pd.DataFrame, Dict]:
    n = len(windows)
    n_train = int(round(n * train_frac))
    # ensure at least 1 in each
    n_train = max(1, min(n - 1, n_train))
    train = windows.iloc[:n_train].copy()
    hold = windows.iloc[n_train:].copy()
    meta = {
        "n_total": n,
        "n_train": len(train),
        "n_holdout": len(hold),
        "train_start": str(train["window_start"].iloc[0]),
        "train_end": str(train["window_start"].iloc[-1]),
        "holdout_start": str(hold["window_start"].iloc[0]),
        "holdout_end": str(hold["window_start"].iloc[-1]),
        "baseline_up_train": float(train["up_won"].mean()),
        "baseline_up_holdout": float(hold["up_won"].mean()),
    }
    return train, hold, meta


def resample_1s(elapsed: np.ndarray, values: Dict[str, np.ndarray], t_max: int) -> Dict[str, np.ndarray]:
    """Last-value resample on integer seconds [0, t_max], forward-fill only (past data)."""
    grid = np.arange(0, t_max + 1, dtype=float)
    # floor elapsed to int second for last-value within each second, then ffill
    out = {}
    el = elapsed.astype(float)
    mask = el <= t_max + 1e-9
    el = el[mask]
    if len(el) == 0:
        for k in values:
            out[k] = np.full_like(grid, np.nan, dtype=float)
        return out
    sec = np.floor(el).astype(int)
    sec = np.clip(sec, 0, t_max)
    for k, arr in values.items():
        a = arr[mask].astype(float)
        last = np.full(t_max + 1, np.nan, dtype=float)
        # later ticks overwrite earlier in same second → last value
        for s, v in zip(sec, a):
            if np.isfinite(v):
                last[s] = v
            elif not np.isfinite(last[s]):
                last[s] = v
        # forward fill
        idx = np.where(np.isfinite(last))[0]
        if len(idx) == 0:
            out[k] = last
            continue
        # backfill only the leading NaNs with first valid (still past — first tick at <=5s)
        first = idx[0]
        last[:first] = last[first]
        for i in range(first + 1, t_max + 1):
            if not np.isfinite(last[i]):
                last[i] = last[i - 1]
        out[k] = last
    return out


def favorite_side_from_mid(mid_up: float) -> str:
    if not np.isfinite(mid_up):
        return "Up"
    return "Up" if mid_up >= 0.5 else "Down"


def favorite_ask(ask_up: float, ask_down: float, mid_up: float) -> float:
    if favorite_side_from_mid(mid_up) == "Up":
        return float(ask_up) if np.isfinite(ask_up) else float("nan")
    return float(ask_down) if np.isfinite(ask_down) else float("nan")


def count_favorite_flips(mid_series: np.ndarray) -> int:
    sides = (mid_series >= 0.5).astype(int)
    # ignore nan
    valid = np.isfinite(mid_series)
    if valid.sum() < 2:
        return 0
    s = sides[valid]
    return int(np.sum(s[1:] != s[:-1]))


def slope_last(series: np.ndarray, seconds: int = 60) -> float:
    n = len(series)
    if n < 2:
        return 0.0
    w = min(seconds, n)
    y = series[-w:]
    if np.sum(np.isfinite(y)) < 2:
        return 0.0
    x = np.arange(w, dtype=float)
    m = np.isfinite(y)
    if m.sum() < 2:
        return 0.0
    coef = np.polyfit(x[m], y[m], 1)
    return float(coef[0])


def depth_imbalance(bid: float, ask: float) -> float:
    if not (np.isfinite(bid) and np.isfinite(ask)):
        return 0.0
    s = bid + ask
    if s <= 0:
        return 0.0
    return float((bid - ask) / s)


def pnl_taker(entry_ask: float, won: bool, stake: float = STAKE, fee: float = FEE) -> float:
    """Spend `stake` USD at ask (taker), hold to resolution, $1/share payout."""
    if not np.isfinite(entry_ask) or entry_ask <= 0:
        return float("nan")
    cost = stake * (1.0 + fee)  # fee on notional if any
    shares = stake / entry_ask
    if won:
        return shares * 1.0 - cost
    return -cost


def summarize_cluster_stats(
    labels: np.ndarray,
    y: np.ndarray,
    baseline: float,
    cluster_ids: Optional[List[int]] = None,
) -> List[Dict]:
    rows = []
    ids = cluster_ids if cluster_ids is not None else sorted(set(int(x) for x in labels if int(x) >= 0))
    for cid in ids:
        m = labels == cid
        n = int(m.sum())
        k = int(y[m].sum()) if n else 0
        wr = k / n if n else float("nan")
        lo, hi = wilson_ci(k, n)
        p = binom_pvalue(k, n, baseline)
        rows.append({
            "cluster": int(cid),
            "n": n,
            "k": k,
            "wr": wr,
            "wilson_lo": lo,
            "wilson_hi": hi,
            "pvalue": p,
            "direction": "above" if (n and wr > baseline) else ("below" if n else "na"),
        })
    return rows


def apply_bh_to_rows(rows: List[Dict], alpha: float = 0.05) -> List[Dict]:
    pvals = [r["pvalue"] for r in rows]
    rej = benjamini_hochberg(pvals, alpha=alpha)
    for r, ok in zip(rows, rej):
        r["bh_reject"] = bool(ok)
    return rows


def edge_verdict(
    train_row: Dict,
    hold_row: Optional[Dict],
    avg_entry: Optional[float],
    min_hold_n: int = 20,
) -> Dict:
    """Edge iff BH-sig on train AND same direction on holdout n>=20 AND WR beats entry price."""
    out = {
        "edge": False,
        "reason": "",
        "train_sig_bh": bool(train_row.get("bh_reject")),
        "holdout_n": int(hold_row["n"]) if hold_row else 0,
        "holdout_wr": hold_row["wr"] if hold_row else None,
        "avg_entry": avg_entry,
    }
    if not train_row.get("bh_reject"):
        out["reason"] = "non significatif sur train (BH)"
        return out
    if hold_row is None or hold_row["n"] < min_hold_n:
        out["reason"] = f"holdout n<{min_hold_n}"
        return out
    if train_row["direction"] != hold_row["direction"]:
        out["reason"] = "direction holdout différente du train"
        return out
    # WR must beat average entry (implied prob) in the traded direction
    # If direction above baseline for P(Up) and we buy Up, need hold_wr > avg_entry
    # For favorite-wins target, same: WR_fav > avg favorite ask
    if avg_entry is None or not np.isfinite(avg_entry):
        out["reason"] = "prix d'entrée manquant"
        return out
    if hold_row["wr"] <= avg_entry:
        out["reason"] = f"WR holdout {hold_row['wr']:.3f} <= prix entrée {avg_entry:.3f} (pas d'edge économique)"
        return out
    # also require WR outside baseline on holdout (same direction)
    out["edge"] = True
    out["reason"] = "edge: BH train + même sens holdout + WR > prix entrée"
    return out


print("common module ok")