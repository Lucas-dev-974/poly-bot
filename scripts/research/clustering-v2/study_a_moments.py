# -*- coding: utf-8 -*-
"""Study A — clustering par moments (point-in-time, no look-ahead)."""
from __future__ import annotations

from typing import Dict, List, Tuple
import sys
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.metrics import pairwise_distances, silhouette_score
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    AUDITS, STAKE, FEE, apply_bh_to_rows, chronological_split, count_favorite_flips,
    depth_imbalance, edge_verdict, favorite_ask, favorite_side_from_mid, load_ticks,
    load_windows, pnl_taker, resample_1s, slope_last, summarize_cluster_stats,
    write_json, write_text, wilson_ci, binom_pvalue,
)

OUT = AUDITS / "A-par-moments"
DECISION_TIMES = [120, 300, 450, 600]
K_RANGE = list(range(3, 11))
BIN_SEC = 5


def build_features_for_t(ticks: pd.DataFrame, window_ids: list, t: int) -> pd.DataFrame:
    """Past-only features at decision time t for each window."""
    rows = []
    # pre-group for speed
    grouped = {wid: g for wid, g in ticks.groupby("window_id", sort=False)}
    n_bins = t // BIN_SEC + 1
    for wid in window_ids:
        g = grouped.get(wid)
        if g is None or len(g) == 0:
            continue
        g = g[g["elapsed_sec"] <= t + 1e-9]
        if len(g) == 0:
            continue
        elapsed = g["elapsed_sec"].to_numpy()
        vals = {
            "mid_up": g["mid_up"].to_numpy(),
            "ask_up": g["best_ask_up"].to_numpy(),
            "ask_down": g["best_ask_down"].to_numpy(),
            "ask_sum": g["ask_sum"].to_numpy(),
            "spread_up": g["spread_up"].to_numpy(),
            "spread_down": g["spread_down"].to_numpy(),
            "depth_bid_up": g["depth_bid_up"].to_numpy(),
            "depth_ask_up": g["depth_ask_up"].to_numpy(),
            "depth_bid_down": g["depth_bid_down"].to_numpy(),
            "depth_ask_down": g["depth_ask_down"].to_numpy(),
        }
        rs = resample_1s(elapsed, vals, t)
        mid = rs["mid_up"]
        # downsample to 5s bins (last value of each bin)
        bins = []
        for b in range(n_bins):
            idx = min(b * BIN_SEC, t)
            bins.append(mid[idx])
        cur_mid = float(mid[-1])
        cur_ask_up = float(rs["ask_up"][-1])
        cur_ask_down = float(rs["ask_down"][-1])
        fav = favorite_side_from_mid(cur_mid)
        fav_ask = favorite_ask(cur_ask_up, cur_ask_down, cur_mid)
        imb_up = depth_imbalance(rs["depth_bid_up"][-1], rs["depth_ask_up"][-1])
        imb_down = depth_imbalance(rs["depth_bid_down"][-1], rs["depth_ask_down"][-1])
        vol = float(np.nanstd(mid)) if np.isfinite(mid).sum() > 1 else 0.0
        flips = count_favorite_flips(mid)
        mx = float(np.nanmax(mid))
        mn = float(np.nanmin(mid))
        sl = slope_last(mid, 60)
        feat = {
            "window_id": wid,
            "mid_up_t": cur_mid,
            "favorite": fav,
            "favorite_ask": fav_ask,
            "ask_up_t": cur_ask_up,
            "ask_down_t": cur_ask_down,
            "ask_sum_t": float(rs["ask_sum"][-1]),
            "spread_up_t": float(rs["spread_up"][-1]),
            "spread_down_t": float(rs["spread_down"][-1]),
            "imb_up": imb_up,
            "imb_down": imb_down,
            "vol_mid": vol,
            "fav_flips": flips,
            "max_mid": mx,
            "min_mid": mn,
            "slope_60": sl,
            "fav_wins": int(
                (fav == "Up" and int(g["up_won"].iloc[-1]) == 1)
                or (fav == "Down" and int(g["up_won"].iloc[-1]) == 0)
            ),
            "up_won": int(g["up_won"].iloc[-1]),
        }
        for i, v in enumerate(bins):
            feat[f"mid_bin_{i}"] = float(v) if np.isfinite(v) else 0.5
        # store curve for plots
        feat["_mid_curve"] = mid.copy()
        rows.append(feat)
    return pd.DataFrame(rows)


FEATURE_SUMMARY = [
    "mid_up_t", "favorite_ask", "ask_sum_t", "spread_up_t", "spread_down_t",
    "imb_up", "imb_down", "vol_mid", "fav_flips", "max_mid", "min_mid", "slope_60",
]


def feature_matrix(df: pd.DataFrame, t: int) -> Tuple[np.ndarray, List[str]]:
    n_bins = t // BIN_SEC + 1
    bin_cols = [f"mid_bin_{i}" for i in range(n_bins)]
    cols = FEATURE_SUMMARY + bin_cols
    X = df[cols].to_numpy(dtype=float)
    X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
    return X, cols


def assign_nearest_centroid(X: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    d = pairwise_distances(X, centroids)
    return np.argmin(d, axis=1)


def cluster_means_curves(df: pd.DataFrame, labels: np.ndarray, t: int, title: str, path: Path):
    fig, ax = plt.subplots(figsize=(10, 5))
    for cid in sorted(set(labels)):
        m = labels == cid
        curves = np.stack(df.loc[m, "_mid_curve"].values)
        mean_c = np.nanmean(curves, axis=0)
        ax.plot(np.arange(t + 1), mean_c, label=f"C{cid} (n={m.sum()})")
    ax.axhline(0.5, color="gray", ls="--", lw=0.8)
    ax.set_xlabel("elapsed_sec")
    ax.set_ylabel("mid_up (moyenne cluster)")
    ax.set_title(title)
    ax.legend(fontsize=8, ncol=2)
    ax.set_ylim(0, 1)
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def run_economics(df_hold: pd.DataFrame, labels_hold: np.ndarray, cid: int, side_mode: str) -> Dict:
    """
    side_mode: 'up' buy Up; 'down' buy Down; 'favorite' buy favorite at t.
    """
    m = labels_hold == cid
    sub = df_hold.loc[m]
    pnls = []
    entries = []
    wins = 0
    n = 0
    for _, r in sub.iterrows():
        if side_mode == "up":
            ask = r["ask_up_t"]
            won = bool(r["up_won"] == 1)
        elif side_mode == "down":
            ask = r["ask_down_t"]
            won = bool(r["up_won"] == 0)
        else:
            ask = r["favorite_ask"]
            won = bool(r["fav_wins"] == 1)
        if not np.isfinite(ask) or ask <= 0:
            continue
        n += 1
        entries.append(ask)
        pnls.append(pnl_taker(ask, won))
        if won:
            wins += 1
    if n == 0:
        return {"n": 0, "wr": None, "avg_entry": None, "pnl": None, "be_wr": None}
    avg_e = float(np.mean(entries))
    return {
        "n": n,
        "wr": wins / n,
        "avg_entry": avg_e,
        "pnl": float(np.sum(pnls)),
        "avg_pnl": float(np.mean(pnls)),
        "be_wr": avg_e,
        "stake": STAKE,
        "fee": FEE,
    }


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    print("Loading windows...")
    windows = load_windows()
    train_w, hold_w, split_meta = chronological_split(windows, 0.70)
    train_ids = set(train_w["window_id"])
    hold_ids = set(hold_w["window_id"])
    print(f"Windows: {len(windows)} train={len(train_w)} hold={len(hold_w)}")
    print("Loading ticks (may take a minute)...")
    ticks = load_ticks()
    print(f"Ticks: {len(ticks)}  elapsed={time.time()-t0:.1f}s")

    all_results = {
        "split": split_meta,
        "decision_times": DECISION_TIMES,
        "k_range": K_RANGE,
        "fee_note": "Aucun modèle de fee général hold-to-resolution dans src/; repricingFeesRoundtrip=0.002 ignoré. FEE=0.",
        "by_t": {},
    }
    report_sections = []

    for t in DECISION_TIMES:
        print(f"\n=== Decision t={t}s ===")
        feat = build_features_for_t(ticks, list(windows["window_id"]), t)
        feat = feat.merge(windows[["window_id", "window_start"]], on="window_id", how="left")
        feat = feat.sort_values("window_start").reset_index(drop=True)
        is_train = feat["window_id"].isin(train_ids)
        is_hold = feat["window_id"].isin(hold_ids)
        df_tr = feat.loc[is_train].reset_index(drop=True)
        df_ho = feat.loc[is_hold].reset_index(drop=True)
        X_tr, cols = feature_matrix(df_tr, t)
        X_ho, _ = feature_matrix(df_ho, t)
        scaler = StandardScaler()
        Xs_tr = scaler.fit_transform(X_tr)
        Xs_ho = scaler.transform(X_ho)

        y_up_tr = df_tr["up_won"].to_numpy(dtype=int)
        y_up_ho = df_ho["up_won"].to_numpy(dtype=int)
        y_fav_tr = df_tr["fav_wins"].to_numpy(dtype=int)
        y_fav_ho = df_ho["fav_wins"].to_numpy(dtype=int)
        base_up_tr = float(y_up_tr.mean())
        base_up_ho = float(y_up_ho.mean())
        base_fav_tr = float(y_fav_tr.mean())
        base_fav_ho = float(y_fav_ho.mean())

        t_result = {
            "t": t,
            "n_train": len(df_tr),
            "n_holdout": len(df_ho),
            "baseline_up_train": base_up_tr,
            "baseline_up_holdout": base_up_ho,
            "baseline_fav_train": base_fav_tr,
            "baseline_fav_holdout": base_fav_ho,
            "methods": {},
        }

        for method in ["kmeans", "ward"]:
            method_res = {"configs": [], "best_k_silhouette": None, "silhouettes": {}}
            sil_scores = {}
            for k in K_RANGE:
                if method == "kmeans":
                    model = KMeans(n_clusters=k, random_state=42, n_init=10)
                    lab_tr = model.fit_predict(Xs_tr)
                    centroids = model.cluster_centers_
                    lab_ho = assign_nearest_centroid(Xs_ho, centroids)
                else:
                    model = AgglomerativeClustering(n_clusters=k, linkage="ward")
                    lab_tr = model.fit_predict(Xs_tr)
                    # centroids = mean of train clusters
                    centroids = np.vstack([Xs_tr[lab_tr == c].mean(axis=0) for c in range(k)])
                    lab_ho = assign_nearest_centroid(Xs_ho, centroids)

                try:
                    sil = float(silhouette_score(Xs_tr, lab_tr))
                except Exception:
                    sil = float("nan")
                sil_scores[k] = sil

                # Collect all cluster stats for both targets — BH across ALL clusters of this (t,method,k,target)
                for target_name, ytr, yho, base_tr, base_ho in [
                    ("up_won", y_up_tr, y_up_ho, base_up_tr, base_up_ho),
                    ("fav_wins", y_fav_tr, y_fav_ho, base_fav_tr, base_fav_ho),
                ]:
                    tr_rows = summarize_cluster_stats(lab_tr, ytr, base_tr, list(range(k)))
                    ho_rows = summarize_cluster_stats(lab_ho, yho, base_ho, list(range(k)))
                    apply_bh_to_rows(tr_rows)
                    ho_by = {r["cluster"]: r for r in ho_rows}

                    cluster_details = []
                    for tr in tr_rows:
                        cid = tr["cluster"]
                        ho = ho_by.get(cid)
                        # economics: choose side from train direction
                        if target_name == "up_won":
                            side = "up" if tr["direction"] == "above" else "down"
                        else:
                            side = "favorite"
                        eco_ho = run_economics(df_ho, lab_ho, cid, side)
                        eco_tr = run_economics(df_tr, lab_tr, cid, side)
                        avg_entry_ho = eco_ho.get("avg_entry")
                        # For edge check: WR of the *predicted outcome* vs entry
                        # hold_row wr should be WR of the traded side
                        if target_name == "up_won":
                            # recompute hold WR for traded side
                            hold_wr_trade = eco_ho.get("wr")
                            hold_n_trade = eco_ho.get("n") or 0
                            hold_row_trade = {
                                "n": hold_n_trade,
                                "wr": hold_wr_trade if hold_wr_trade is not None else float("nan"),
                                "direction": tr["direction"],  # same direction assumed for trade
                            }
                            # also require raw P(Up) direction outside baseline on holdout
                            raw_ok = ho is not None and ho["n"] >= 20 and ho["direction"] == tr["direction"]
                            verd = edge_verdict(tr, hold_row_trade if raw_ok else None, avg_entry_ho)
                            if not raw_ok and tr.get("bh_reject"):
                                verd["reason"] = "holdout: n<20 ou direction P(Up) différente"
                                verd["edge"] = False
                        else:
                            verd = edge_verdict(tr, ho, avg_entry_ho)

                        cluster_details.append({
                            "cluster": cid,
                            "train": tr,
                            "holdout": ho,
                            "side": side,
                            "economics_holdout": eco_ho,
                            "economics_train": eco_tr,
                            "verdict": verd,
                        })

                    method_res["configs"].append({
                        "k": k,
                        "silhouette": sil,
                        "target": target_name,
                        "clusters": cluster_details,
                    })

                print(f"  {method} k={k} sil={sil:.4f}")

            method_res["silhouettes"] = sil_scores
            best_k = max(sil_scores, key=lambda kk: sil_scores[kk] if np.isfinite(sil_scores[kk]) else -1)
            method_res["best_k_silhouette"] = best_k
            t_result["methods"][method] = method_res

            # plot mean curves for best k (up_won configs)
            if method == "kmeans":
                model = KMeans(n_clusters=best_k, random_state=42, n_init=10)
                lab_tr = model.fit_predict(Xs_tr)
                cluster_means_curves(
                    df_tr, lab_tr, t,
                    f"Study A t={t}s KMeans k={best_k} (train) — courbes mid_up moyennes",
                    OUT / f"curves_t{t}_kmeans_k{best_k}_train.png",
                )

        all_results["by_t"][str(t)] = t_result

        # Build markdown section for this t
        sec = [f"## Décision t = {t} s\n"]
        sec.append(f"- Fenêtres features: train={len(df_tr)}, holdout={len(df_ho)}")
        sec.append(f"- Baseline P(Up) train={base_up_tr:.3f}, holdout={base_up_ho:.3f}")
        sec.append(f"- Baseline P(fav wins) train={base_fav_tr:.3f}, holdout={base_fav_ho:.3f}")
        sec.append(f"- Meilleur k (silhouette): KMeans={t_result['methods']['kmeans']['best_k_silhouette']}, Ward={t_result['methods']['ward']['best_k_silhouette']}\n")
        report_sections.append("\n".join(sec))

    # Global BH across ALL tested cluster hypotheses (all t, method, k, target, cluster)
    print("\nApplying global BH correction across all tests...")
    flat = []
    for t_str, t_res in all_results["by_t"].items():
        for method, mres in t_res["methods"].items():
            for cfg in mres["configs"]:
                for cl in cfg["clusters"]:
                    flat.append({
                        "t": int(t_str),
                        "method": method,
                        "k": cfg["k"],
                        "target": cfg["target"],
                        "cluster": cl["cluster"],
                        "pvalue": cl["train"]["pvalue"],
                        "ref": cl,
                    })
    pvals = [f["pvalue"] for f in flat]
    from common import benjamini_hochberg
    rej = benjamini_hochberg(pvals, alpha=0.05)
    n_sig = 0
    edges = []
    for f, ok in zip(flat, rej):
        f["ref"]["train"]["bh_reject_global"] = bool(ok)
        # recompute verdict with global BH
        tr = dict(f["ref"]["train"])
        tr["bh_reject"] = bool(ok)
        ho = f["ref"]["holdout"]
        eco = f["ref"]["economics_holdout"]
        avg_e = eco.get("avg_entry") if eco else None
        if f["target"] == "up_won":
            hold_row_trade = {
                "n": eco.get("n") or 0,
                "wr": eco.get("wr") if eco.get("wr") is not None else float("nan"),
                "direction": tr["direction"],
            }
            raw_ok = ho is not None and ho["n"] >= 20 and ho["direction"] == tr["direction"]
            verd = edge_verdict(tr, hold_row_trade if raw_ok else None, avg_e)
            if not raw_ok and ok:
                verd = {"edge": False, "reason": "holdout: n<20 ou direction P(Up) différente",
                        "train_sig_bh": True, "holdout_n": ho["n"] if ho else 0,
                        "holdout_wr": ho["wr"] if ho else None, "avg_entry": avg_e}
        else:
            verd = edge_verdict(tr, ho, avg_e)
        f["ref"]["verdict_global"] = verd
        if ok:
            n_sig += 1
        if verd.get("edge"):
            edges.append({
                "t": f["t"], "method": f["method"], "k": f["k"], "target": f["target"],
                "cluster": f["cluster"], "train": tr, "holdout": ho,
                "economics_holdout": eco, "verdict": verd, "side": f["ref"]["side"],
            })

    all_results["n_tests_global"] = len(flat)
    all_results["n_bh_significant_train"] = n_sig
    all_results["edges"] = edges

    write_json(OUT / "results.json", all_results)
    print(f"Edges found: {len(edges)} / tests={len(flat)} BH-sig train={n_sig}")

    # Scatter PCA for one representative config
    from sklearn.decomposition import PCA
    t_demo = 300
    feat = build_features_for_t(ticks, list(windows["window_id"]), t_demo)
    feat = feat.merge(windows[["window_id", "window_start"]], on="window_id", how="left")
    feat = feat.sort_values("window_start").reset_index(drop=True)
    is_train = feat["window_id"].isin(train_ids)
    df_tr = feat.loc[is_train].reset_index(drop=True)
    X_tr, _ = feature_matrix(df_tr, t_demo)
    Xs = StandardScaler().fit_transform(X_tr)
    best_k = all_results["by_t"]["300"]["methods"]["kmeans"]["best_k_silhouette"]
    lab = KMeans(n_clusters=best_k, random_state=42, n_init=10).fit_predict(Xs)
    pca = PCA(n_components=2, random_state=42)
    Z = pca.fit_transform(Xs)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    sc0 = axes[0].scatter(Z[:, 0], Z[:, 1], c=lab, cmap="tab10", s=12, alpha=0.7)
    axes[0].set_title(f"PCA train t=300 KMeans k={best_k} (couleur=cluster)")
    axes[0].set_xlabel("PC1"); axes[0].set_ylabel("PC2")
    sc1 = axes[1].scatter(Z[:, 0], Z[:, 1], c=df_tr["up_won"], cmap="coolwarm", s=12, alpha=0.7)
    axes[1].set_title("PCA train t=300 (couleur=up_won)")
    axes[1].set_xlabel("PC1"); axes[1].set_ylabel("PC2")
    fig.tight_layout()
    fig.savefig(OUT / "scatter_pca_t300_train.png", dpi=120)
    plt.close(fig)

    # Build French report
    md = build_report(all_results, split_meta, edges)
    write_text(OUT / "RAPPORT.md", md)
    print(f"Done Study A in {time.time()-t0:.1f}s → {OUT}")


def build_report(all_results, split_meta, edges) -> str:
    lines = []
    lines.append("# Étude A — Clustering par moments (point-in-time)\n")
    lines.append("## Données\n")
    lines.append("- Fichier ticks: `data/datasets/btc15-clustering/btc15_ticks_complete_2026-09-08_to_2026-10-05_28j.csv`")
    lines.append("- Fichier fenêtres: `btc15_windows_complete_2026-09-08_to_2026-10-05_28j.csv`")
    lines.append("- Période: **2026-09-08 → 2026-10-05** (28 j), fenêtres complètes (gaps ≤5s)")
    lines.append(f"- N fenêtres: **{split_meta['n_total']}** (Up 345 / Down 332)")
    lines.append(f"- Split chronologique ~70/30 par `window_start`:")
    lines.append(f"  - Train: n={split_meta['n_train']}, {split_meta['train_start']} → {split_meta['train_end']}, P(Up)={split_meta['baseline_up_train']:.3f}")
    lines.append(f"  - Holdout: n={split_meta['n_holdout']}, {split_meta['holdout_start']} → {split_meta['holdout_end']}, P(Up)={split_meta['baseline_up_holdout']:.3f}")
    lines.append("- Contrainte: **uniquement** prix book Up/Down (pas de spot BTC)")
    lines.append("- Fees: aucun modèle hold-to-resolution générique dans `src/` (seul `repricingFeesRoundtrip=0.002` spécifique) → **FEE=0**\n")

    lines.append("## Méthode\n")
    lines.append("- Temps de décision t ∈ {120, 300, 450, 600} s")
    lines.append("- Features passées uniquement (`elapsed_sec ≤ t`): resample 1s last-value + ffill, downsample bins 5s de `mid_up`, + résumés (mid, favorite ask, ask_sum, spreads, imbalance profondeur, vol, flips favori, max/min, slope 60s)")
    lines.append("- Standardisation fit sur train; KMeans (k=3..10) et Agglomerative Ward; k choisi par silhouette train (tous k reportés)")
    lines.append("- Assignation holdout: centroïde le plus proche")
    lines.append("- Cibles: `up_won` et `favorite_at_t wins`")
    lines.append("- Stats: n, WR, IC Wilson 95%, p binomial vs baseline, correction Benjamini-Hochberg **globale** sur tous les tests")
    lines.append("- Edge si: significatif train après BH **et** même direction holdout n≥20 **et** WR > prix d'entrée moyen (ask)")
    lines.append("- Économie: taker, achat du côté prédit au ask à t, hold to resolution, stake $4, payout $1/share\n")

    lines.append("## Configurations testées\n")
    lines.append(f"- {len(DECISION_TIMES)} temps × 2 méthodes × {len(K_RANGE)} k × 2 cibles × k clusters ≈ **{all_results['n_tests_global']}** tests (clusters individuels)")
    lines.append(f"- Significatifs train (BH global α=0.05): **{all_results['n_bh_significant_train']}**")
    lines.append(f"- Edges retenus (critères complets): **{len(edges)}**\n")

    lines.append("## Résultats par temps de décision\n")
    for t in DECISION_TIMES:
        tr = all_results["by_t"][str(t)]
        lines.append(f"### t = {t} s\n")
        lines.append(f"- Baseline P(Up) train={tr['baseline_up_train']:.3f} / holdout={tr['baseline_up_holdout']:.3f}")
        lines.append(f"- Baseline P(fav wins) train={tr['baseline_fav_train']:.3f} / holdout={tr['baseline_fav_holdout']:.3f}")
        for method in ["kmeans", "ward"]:
            mres = tr["methods"][method]
            lines.append(f"- **{method}**: meilleur k silhouette={mres['best_k_silhouette']} (scores: " +
                         ", ".join(f"k{k}={mres['silhouettes'][k]:.3f}" for k in K_RANGE) + ")")
            # table for best k, both targets
            bk = mres["best_k_silhouette"]
            for cfg in mres["configs"]:
                if cfg["k"] != bk:
                    continue
                lines.append(f"\n#### {method} k={bk} — cible `{cfg['target']}`\n")
                lines.append("| Cluster | n_tr | WR_tr | IC95 | p | BH | n_ho | WR_ho | sens_ho | côté | entry_ho | PnL_ho | Edge |")
                lines.append("|--------:|-----:|------:|------|---:|:--:|-----:|------:|:-------:|:----:|---------:|-------:|:----:|")
                for cl in cfg["clusters"]:
                    trr = cl["train"]
                    ho = cl["holdout"] or {}
                    eco = cl["economics_holdout"] or {}
                    verd = cl.get("verdict_global") or cl.get("verdict") or {}
                    lo = trr.get("wilson_lo")
                    hi = trr.get("wilson_hi")
                    ic = f"[{lo:.2f},{hi:.2f}]" if lo == lo else "—"
                    bh = "oui" if trr.get("bh_reject_global") else "non"
                    edge = "OUI" if verd.get("edge") else "non"
                    lines.append(
                        f"| {trr['cluster']} | {trr['n']} | {trr['wr']:.3f} | {ic} | {trr['pvalue']:.2e} | {bh} | "
                        f"{ho.get('n','')} | {ho.get('wr', float('nan')):.3f} | {ho.get('direction','')} | {cl.get('side','')} | "
                        f"{eco.get('avg_entry') if eco.get('avg_entry') is not None else float('nan'):.3f} | "
                        f"{eco.get('pnl') if eco.get('pnl') is not None else float('nan'):.2f} | {edge} |"
                    )
                lines.append("")

    lines.append("## Verdict edge\n")
    if not edges:
        lines.append("**Aucun cluster ne satisfait les critères d'edge complets** (BH train + même sens holdout n≥20 + WR > prix d'entrée).")
        lines.append("Des clusters peuvent être statistiquement déviants vs baseline P(Up), mais l'écart ne bat pas le prix implicite du ask au moment de décision — ou ne se réplique pas hors échantillon.\n")
    else:
        lines.append(f"**{len(edges)} edge(s) retenu(s):**\n")
        for e in edges:
            eco = e["economics_holdout"]
            lines.append(
                f"- t={e['t']} {e['method']} k={e['k']} cible={e['target']} C{e['cluster']}: "
                f"n_ho={eco.get('n')} WR={eco.get('wr'):.3f} entry={eco.get('avg_entry'):.3f} "
                f"PnL=${eco.get('pnl'):.2f} (stake ${STAKE}/trade, fee={FEE})"
            )
        lines.append("")

    lines.append("## Économie (rappel)\n")
    lines.append("- Achat taker au ask à t, hold jusqu'à résolution, stake plat $4, payout $1/share")
    lines.append("- Break-even WR ≈ prix d'entrée moyen")
    lines.append("- Un cluster « favori gagne 75% » n'est **pas** un edge si le favori coûte 0.75\n")

    lines.append("## Limites\n")
    lines.append("- 677 fenêtres seulement; holdout ~30% → clusters fins ont n_ho souvent <20")
    lines.append("- Multiplicité élevée (centaines de tests) → BH très conservateur")
    lines.append("- Features book only; pas de microstructure latente / flow externe")
    lines.append("- Assignation holdout par centroïde (Ward n'a pas de predict natif)")
    lines.append("- Pas de coûts de latence / partial fills\n")

    lines.append("## Conclusion et prochaines étapes\n")
    if edges:
        lines.append("Quelques configurations franchissent le filtre edge; prioriser une validation forward (paper) sur ces (t, méthode, k, cluster) uniquement, avec taille d'échantillon plus large.")
    else:
        lines.append("À ce stade, le clustering point-in-time ne révèle **pas** d'edge économique robuste hors-échantillon contre le prix implicite.")
        lines.append("Prochaine étape recommandée: (1) réduire la multiplicité (fixer t=300 et une seule méthode), (2) features plus sparses / sélectionnées, (3) étudier des bandes de prix (fav ask ∈ [0.55,0.70]) plutôt que clusters non supervisés purs.")
    lines.append("\n---\n*Généré par `scripts/research/clustering-v2/study_a_moments.py` — aucun commit.*\n")
    return "\n".join(lines)


if __name__ == "__main__":
    main()