# -*- coding: utf-8 -*-
"""Study B — variables résumées + HDBSCAN (B1 descriptive full window, B2 tradable t=300)."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.cluster import HDBSCAN
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    AUDITS, STAKE, FEE, apply_bh_to_rows, benjamini_hochberg, chronological_split,
    count_favorite_flips, depth_imbalance, edge_verdict, favorite_ask,
    favorite_side_from_mid, load_ticks, load_windows, pnl_taker, resample_1s,
    slope_last, summarize_cluster_stats, write_json, write_text,
)

OUT = AUDITS / "B-hdbscan"
MIN_CLUSTER_SIZES = [10, 20, 40]
MIN_SAMPLES = [5, 10]


def window_summary_features(ticks: pd.DataFrame, window_ids: list, t_end: int) -> pd.DataFrame:
    """Summary features on [0, t_end] past-only (or full window if t_end=899)."""
    grouped = {wid: g for wid, g in ticks.groupby("window_id", sort=False)}
    rows = []
    for wid in window_ids:
        g = grouped.get(wid)
        if g is None or len(g) == 0:
            continue
        g = g[g["elapsed_sec"] <= t_end + 1e-9]
        if len(g) < 5:
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
        rs = resample_1s(elapsed, vals, t_end)
        mid = rs["mid_up"]
        ask_up = rs["ask_up"]
        ask_down = rs["ask_down"]
        # favorite ask series
        fav_ask_s = np.where(mid >= 0.5, ask_up, ask_down)
        cur_mid = float(mid[-1])
        fav = favorite_side_from_mid(cur_mid)
        fav_ask = favorite_ask(float(ask_up[-1]), float(ask_down[-1]), cur_mid)
        imb_s = np.array([
            depth_imbalance(rs["depth_bid_up"][i], rs["depth_ask_up"][i]) -
            depth_imbalance(rs["depth_bid_down"][i], rs["depth_ask_down"][i])
            for i in range(len(mid))
        ])
        time_fav_ge_70 = float(np.mean(fav_ask_s >= 0.70)) if len(fav_ask_s) else 0.0
        rows.append({
            "window_id": wid,
            "vol_mid": float(np.nanstd(mid)),
            "fav_flips": count_favorite_flips(mid),
            "max_fav_ask": float(np.nanmax(fav_ask_s)),
            "min_fav_ask": float(np.nanmin(fav_ask_s)),
            "slope_mid": slope_last(mid, min(60, t_end)),
            "time_fav_ask_ge_70": time_fav_ge_70,
            "mean_spread_up": float(np.nanmean(rs["spread_up"])),
            "end_spread_up": float(rs["spread_up"][-1]),
            "mean_spread_down": float(np.nanmean(rs["spread_down"])),
            "end_spread_down": float(rs["spread_down"][-1]),
            "mean_ask_sum": float(np.nanmean(rs["ask_sum"])),
            "end_ask_sum": float(rs["ask_sum"][-1]),
            "mean_depth_imb": float(np.nanmean(imb_s)),
            "end_depth_imb": float(imb_s[-1]),
            "range_mid": float(np.nanmax(mid) - np.nanmin(mid)),
            "mid_up_t": cur_mid,
            "favorite": fav,
            "favorite_ask": fav_ask,
            "ask_up_t": float(ask_up[-1]),
            "ask_down_t": float(ask_down[-1]),
            "fav_wins": int(
                (fav == "Up" and int(g["up_won"].iloc[-1]) == 1)
                or (fav == "Down" and int(g["up_won"].iloc[-1]) == 0)
            ),
            "up_won": int(g["up_won"].iloc[-1]),
            "_mid_curve": mid.copy(),
        })
    return pd.DataFrame(rows)


FEAT_COLS = [
    "vol_mid", "fav_flips", "max_fav_ask", "min_fav_ask", "slope_mid",
    "time_fav_ask_ge_70", "mean_spread_up", "end_spread_up",
    "mean_spread_down", "end_spread_down", "mean_ask_sum", "end_ask_sum",
    "mean_depth_imb", "end_depth_imb", "range_mid", "mid_up_t",
]


def run_economics(df: pd.DataFrame, labels: np.ndarray, cid: int, side: str) -> dict:
    m = labels == cid
    sub = df.loc[m]
    pnls, entries, wins, n = [], [], 0, 0
    for _, r in sub.iterrows():
        if side == "up":
            ask, won = r["ask_up_t"], r["up_won"] == 1
        elif side == "down":
            ask, won = r["ask_down_t"], r["up_won"] == 0
        else:
            ask, won = r["favorite_ask"], r["fav_wins"] == 1
        if not np.isfinite(ask) or ask <= 0:
            continue
        n += 1
        entries.append(ask)
        pnls.append(pnl_taker(ask, bool(won)))
        if won:
            wins += 1
    if n == 0:
        return {"n": 0, "wr": None, "avg_entry": None, "pnl": None, "be_wr": None}
    avg_e = float(np.mean(entries))
    return {"n": n, "wr": wins / n, "avg_entry": avg_e, "pnl": float(np.sum(pnls)),
            "avg_pnl": float(np.mean(pnls)), "be_wr": avg_e, "stake": STAKE, "fee": FEE}


def assign_holdout_hdbscan(Xs_tr, lab_tr, Xs_ho):
    """Nearest train medoid (point closest to cluster mean) for non-noise clusters."""
    clusters = sorted(c for c in set(lab_tr) if c >= 0)
    if not clusters:
        return np.full(len(Xs_ho), -1, dtype=int)
    medoids = []
    ids = []
    for c in clusters:
        pts = Xs_tr[lab_tr == c]
        mean = pts.mean(axis=0)
        d = np.linalg.norm(pts - mean, axis=1)
        medoids.append(pts[int(np.argmin(d))])
        ids.append(c)
    medoids = np.vstack(medoids)
    # also compute noise threshold: max dist to own medoid on train * 1.5, else noise
    max_d = []
    for i, c in enumerate(ids):
        pts = Xs_tr[lab_tr == c]
        dd = np.linalg.norm(pts - medoids[i], axis=1)
        max_d.append(float(np.percentile(dd, 95)) if len(dd) else 1.0)
    from sklearn.metrics import pairwise_distances
    D = pairwise_distances(Xs_ho, medoids)
    nn = np.argmin(D, axis=1)
    lab = np.array([ids[j] for j in nn], dtype=int)
    for i in range(len(lab)):
        if D[i, nn[i]] > max_d[nn[i]] * 1.5:
            lab[i] = -1
    return lab


def profile_clusters(df, labels, feat_cols):
    out = {}
    for c in sorted(set(labels)):
        if c < 0:
            continue
        m = labels == c
        out[int(c)] = {col: float(df.loc[m, col].mean()) for col in feat_cols}
        out[int(c)]["n"] = int(m.sum())
    return out


def run_variant(name, descriptive, t_end, ticks, windows, train_ids, hold_ids, split_meta):
    print(f"\n=== Variant {name} t_end={t_end} descriptive={descriptive} ===")
    feat = window_summary_features(ticks, list(windows["window_id"]), t_end)
    feat = feat.merge(windows[["window_id", "window_start"]], on="window_id", how="left")
    feat = feat.sort_values("window_start").reset_index(drop=True)
    df_tr = feat.loc[feat["window_id"].isin(train_ids)].reset_index(drop=True)
    df_ho = feat.loc[feat["window_id"].isin(hold_ids)].reset_index(drop=True)
    X_tr = np.nan_to_num(df_tr[FEAT_COLS].to_numpy(float), nan=0.0)
    X_ho = np.nan_to_num(df_ho[FEAT_COLS].to_numpy(float), nan=0.0)
    scaler = StandardScaler()
    Xs_tr = scaler.fit_transform(X_tr)
    Xs_ho = scaler.transform(X_ho)

    y_up_tr = df_tr["up_won"].to_numpy(int)
    y_up_ho = df_ho["up_won"].to_numpy(int)
    y_fav_tr = df_tr["fav_wins"].to_numpy(int)
    y_fav_ho = df_ho["fav_wins"].to_numpy(int)
    base_up_tr, base_up_ho = float(y_up_tr.mean()), float(y_up_ho.mean())
    base_fav_tr, base_fav_ho = float(y_fav_tr.mean()), float(y_fav_ho.mean())

    variant = {
        "name": name,
        "descriptive": descriptive,
        "tradable": not descriptive,
        "t_end": t_end,
        "n_train": len(df_tr),
        "n_holdout": len(df_ho),
        "baseline_up_train": base_up_tr,
        "baseline_up_holdout": base_up_ho,
        "baseline_fav_train": base_fav_tr,
        "baseline_fav_holdout": base_fav_ho,
        "configs": [],
    }

    best_cfg_for_plot = None
    best_noise = 1.0

    for mcs in MIN_CLUSTER_SIZES:
        for ms in MIN_SAMPLES:
            if ms > mcs:
                continue
            clusterer = HDBSCAN(min_cluster_size=mcs, min_samples=ms, metric="euclidean")
            lab_tr = clusterer.fit_predict(Xs_tr)
            n_clusters = len(set(lab_tr) - {-1})
            noise_share = float(np.mean(lab_tr == -1))
            if descriptive:
                lab_ho = np.full(len(Xs_ho), -1)  # not assigned for descriptive
            else:
                lab_ho = assign_holdout_hdbscan(Xs_tr, lab_tr, Xs_ho)

            print(f"  mcs={mcs} ms={ms}: clusters={n_clusters} noise={noise_share:.2f}")

            profiles = profile_clusters(df_tr, lab_tr, FEAT_COLS)
            cfg = {
                "min_cluster_size": mcs,
                "min_samples": ms,
                "n_clusters": n_clusters,
                "noise_share_train": noise_share,
                "noise_share_holdout": float(np.mean(lab_ho == -1)) if len(lab_ho) else None,
                "profiles_train": profiles,
                "targets": {},
            }

            for target_name, ytr, yho, btr, bho in [
                ("up_won", y_up_tr, y_up_ho, base_up_tr, base_up_ho),
                ("fav_wins", y_fav_tr, y_fav_ho, base_fav_tr, base_fav_ho),
            ]:
                cids = sorted(c for c in set(lab_tr) if c >= 0)
                tr_rows = summarize_cluster_stats(lab_tr, ytr, btr, cids)
                apply_bh_to_rows(tr_rows)
                if descriptive:
                    ho_rows = []
                else:
                    ho_rows = summarize_cluster_stats(lab_ho, yho, bho, cids)
                ho_by = {r["cluster"]: r for r in ho_rows}
                details = []
                for tr in tr_rows:
                    cid = tr["cluster"]
                    ho = ho_by.get(cid)
                    side = ("up" if tr["direction"] == "above" else "down") if target_name == "up_won" else "favorite"
                    eco_ho = run_economics(df_ho, lab_ho, cid, side) if not descriptive else {}
                    eco_tr = run_economics(df_tr, lab_tr, cid, side)
                    avg_e = eco_ho.get("avg_entry") if eco_ho else None
                    if descriptive:
                        verd = {"edge": False, "reason": "variante descriptive (look-ahead) — non tradable"}
                    elif target_name == "up_won":
                        hold_row_trade = {
                            "n": eco_ho.get("n") or 0,
                            "wr": eco_ho.get("wr") if eco_ho.get("wr") is not None else float("nan"),
                            "direction": tr["direction"],
                        }
                        raw_ok = ho is not None and ho["n"] >= 20 and ho["direction"] == tr["direction"]
                        verd = edge_verdict(tr, hold_row_trade if raw_ok else None, avg_e)
                        if not raw_ok and tr.get("bh_reject"):
                            verd = {"edge": False, "reason": "holdout: n<20 ou direction différente",
                                    "train_sig_bh": True, "holdout_n": ho["n"] if ho else 0,
                                    "holdout_wr": ho["wr"] if ho else None, "avg_entry": avg_e}
                    else:
                        verd = edge_verdict(tr, ho, avg_e)
                    details.append({
                        "cluster": cid, "train": tr, "holdout": ho, "side": side,
                        "economics_holdout": eco_ho, "economics_train": eco_tr, "verdict": verd,
                    })
                cfg["targets"][target_name] = details

            variant["configs"].append(cfg)
            if n_clusters >= 2 and noise_share < best_noise:
                best_noise = noise_share
                best_cfg_for_plot = (mcs, ms, lab_tr, df_tr, Xs_tr)

    # plots
    if best_cfg_for_plot is not None:
        mcs, ms, lab_tr, df_tr, Xs_tr = best_cfg_for_plot
        # PCA
        Z = PCA(n_components=2, random_state=42).fit_transform(Xs_tr)
        fig, axes = plt.subplots(1, 2, figsize=(12, 5))
        cmap_lab = lab_tr.copy().astype(float)
        axes[0].scatter(Z[:, 0], Z[:, 1], c=cmap_lab, cmap="tab10", s=14, alpha=0.75)
        axes[0].set_title(f"{name} PCA (couleur=cluster HDBSCAN mcs={mcs})")
        axes[1].scatter(Z[:, 0], Z[:, 1], c=df_tr["up_won"], cmap="coolwarm", s=14, alpha=0.75)
        axes[1].set_title(f"{name} PCA (couleur=up_won)")
        fig.tight_layout()
        fig.savefig(OUT / f"scatter_pca_{name}.png", dpi=120)
        plt.close(fig)

        # UMAP optional
        try:
            import umap
            reducer = umap.UMAP(n_components=2, random_state=42, n_neighbors=15, min_dist=0.1)
            Zu = reducer.fit_transform(Xs_tr)
            fig, axes = plt.subplots(1, 2, figsize=(12, 5))
            axes[0].scatter(Zu[:, 0], Zu[:, 1], c=cmap_lab, cmap="tab10", s=14, alpha=0.75)
            axes[0].set_title(f"{name} UMAP (cluster)")
            axes[1].scatter(Zu[:, 0], Zu[:, 1], c=df_tr["up_won"], cmap="coolwarm", s=14, alpha=0.75)
            axes[1].set_title(f"{name} UMAP (up_won)")
            fig.tight_layout()
            fig.savefig(OUT / f"scatter_umap_{name}.png", dpi=120)
            plt.close(fig)
        except Exception as e:
            print(f"UMAP skip: {e}")

        # mean curves
        fig, ax = plt.subplots(figsize=(10, 5))
        for c in sorted(set(lab_tr)):
            if c < 0:
                continue
            m = lab_tr == c
            curves = np.stack(df_tr.loc[m, "_mid_curve"].values)
            ax.plot(np.arange(curves.shape[1]), np.nanmean(curves, axis=0), label=f"C{c} n={m.sum()}")
        ax.axhline(0.5, color="gray", ls="--", lw=0.8)
        ax.set_title(f"{name} courbes mid_up moyennes (train)")
        ax.set_xlabel("elapsed_sec"); ax.set_ylabel("mid_up")
        ax.set_ylim(0, 1); ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(OUT / f"curves_{name}_train.png", dpi=120)
        plt.close(fig)

    return variant, feat


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    windows = load_windows()
    train_w, hold_w, split_meta = chronological_split(windows, 0.70)
    train_ids, hold_ids = set(train_w["window_id"]), set(hold_w["window_id"])
    print("Loading ticks...")
    ticks = load_ticks()
    print(f"ticks={len(ticks)}")

    b1, _ = run_variant("B1_full", True, 899, ticks, windows, train_ids, hold_ids, split_meta)
    b2, _ = run_variant("B2_t300", False, 300, ticks, windows, train_ids, hold_ids, split_meta)

    # Global BH on B2 only (tradable tests)
    flat = []
    for cfg in b2["configs"]:
        for target, details in cfg["targets"].items():
            for cl in details:
                flat.append({
                    "mcs": cfg["min_cluster_size"], "ms": cfg["min_samples"],
                    "target": target, "cluster": cl["cluster"],
                    "pvalue": cl["train"]["pvalue"], "ref": cl,
                })
    rej = benjamini_hochberg([f["pvalue"] for f in flat], 0.05)
    edges = []
    n_sig = 0
    for f, ok in zip(flat, rej):
        f["ref"]["train"]["bh_reject_global"] = bool(ok)
        tr = dict(f["ref"]["train"]); tr["bh_reject"] = bool(ok)
        ho = f["ref"]["holdout"]
        eco = f["ref"]["economics_holdout"] or {}
        avg_e = eco.get("avg_entry")
        if f["target"] == "up_won":
            hold_row_trade = {"n": eco.get("n") or 0,
                              "wr": eco.get("wr") if eco.get("wr") is not None else float("nan"),
                              "direction": tr["direction"]}
            raw_ok = ho is not None and ho["n"] >= 20 and ho["direction"] == tr["direction"]
            verd = edge_verdict(tr, hold_row_trade if raw_ok else None, avg_e)
            if not raw_ok and ok:
                verd = {"edge": False, "reason": "holdout: n<20 ou direction différente",
                        "train_sig_bh": True, "holdout_n": ho["n"] if ho else 0,
                        "holdout_wr": ho["wr"] if ho else None, "avg_entry": avg_e}
        else:
            verd = edge_verdict(tr, ho, avg_e)
        f["ref"]["verdict_global"] = verd
        if ok:
            n_sig += 1
        if verd.get("edge"):
            edges.append({
                "mcs": f["mcs"], "ms": f["ms"], "target": f["target"],
                "cluster": f["cluster"], "train": tr, "holdout": ho,
                "economics_holdout": eco, "verdict": verd, "side": f["ref"]["side"],
            })

    # Also BH for B1 descriptive (structure only, no edges)
    flat1 = []
    for cfg in b1["configs"]:
        for target, details in cfg["targets"].items():
            for cl in details:
                flat1.append(cl["train"]["pvalue"])
                cl["train"]["bh_reject_global"] = False
    rej1 = benjamini_hochberg(flat1, 0.05)
    i = 0
    for cfg in b1["configs"]:
        for target, details in cfg["targets"].items():
            for cl in details:
                cl["train"]["bh_reject_global"] = bool(rej1[i]); i += 1

    results = {
        "split": split_meta,
        "fee_note": "FEE=0 (pas de modèle hold-to-resolution générique; repricingFeesRoundtrip=0.002 ignoré)",
        "B1": b1,
        "B2": b2,
        "B2_n_tests": len(flat),
        "B2_n_bh_sig": n_sig,
        "B2_edges": edges,
    }
    write_json(OUT / "results.json", results)
    write_text(OUT / "RAPPORT.md", build_report(results, edges))
    print(f"B2 edges={len(edges)} BH-sig={n_sig}  done in {time.time()-t0:.1f}s")


def build_report(results, edges) -> str:
    sm = results["split"]
    b1, b2 = results["B1"], results["B2"]
    lines = []
    lines.append("# Étude B — Variables résumées + HDBSCAN\n")
    lines.append("## Données\n")
    lines.append("- Fichiers: `btc15_ticks_complete_…_28j.csv` / `btc15_windows_complete_…_28j.csv`")
    lines.append("- Période: **2026-09-08 → 2026-10-05**, 677 fenêtres (Up 345 / Down 332)")
    lines.append(f"- Train n={sm['n_train']} ({sm['train_start']} → {sm['train_end']}), P(Up)={sm['baseline_up_train']:.3f}")
    lines.append(f"- Holdout n={sm['n_holdout']} ({sm['holdout_start']} → {sm['holdout_end']}), P(Up)={sm['baseline_up_holdout']:.3f}")
    lines.append("- Prix book Up/Down uniquement; FEE=0\n")

    lines.append("## Méthode\n")
    lines.append("- Features résumées: vol mid_up, flips favori, max/min favorite ask, slope, time share fav ask≥0.70, mean/end spreads, mean/end ask_sum, mean/end depth imbalance, range mid, mid_up final")
    lines.append("- Standardisation train; HDBSCAN grille min_cluster_size∈{10,20,40} × min_samples∈{5,10}")
    lines.append("- **B1**: horizon [0,899) — **descriptif / look-ahead**, non tradable")
    lines.append("- **B2**: horizon [0,300], décision à 300s — tradable; holdout assigné au médoïde train le plus proche (sinon noise)")
    lines.append("- Edge (B2 seulement): BH train + même sens holdout n≥20 + WR > ask moyen\n")

    lines.append("## B1 — Descriptif (look-ahead, NON tradable)\n")
    lines.append("> Attention: features sur la fenêtre entière → fuite d'information. Sert uniquement à décrire la structure.\n")
    for cfg in b1["configs"]:
        lines.append(f"### mcs={cfg['min_cluster_size']} ms={cfg['min_samples']}: "
                     f"{cfg['n_clusters']} clusters, noise={cfg['noise_share_train']:.1%}")
        if cfg["profiles_train"]:
            lines.append("Profils (moyennes features train) — aperçu mid_up_t / vol / flips:")
            lines.append("| C | n | mid_up_t | vol | flips | range | time≥0.70 |")
            lines.append("|--:|--:|---------:|----:|------:|------:|----------:|")
            for c, p in cfg["profiles_train"].items():
                lines.append(f"| {c} | {p['n']} | {p['mid_up_t']:.3f} | {p['vol_mid']:.4f} | "
                             f"{p['fav_flips']:.1f} | {p['range_mid']:.3f} | {p['time_fav_ask_ge_70']:.2f} |")
        for target, details in cfg["targets"].items():
            if not details:
                continue
            lines.append(f"\nCible `{target}`:")
            lines.append("| C | n | WR | p | BH |")
            lines.append("|--:|--:|---:|--:|:--:|")
            for cl in details:
                tr = cl["train"]
                lines.append(f"| {tr['cluster']} | {tr['n']} | {tr['wr']:.3f} | {tr['pvalue']:.2e} | "
                             f"{'oui' if tr.get('bh_reject_global') else 'non'} |")
        lines.append("")

    lines.append("## B2 — Tradable (décision t=300s)\n")
    lines.append(f"- Tests clusters: {results['B2_n_tests']}, BH-sig train: {results['B2_n_bh_sig']}, edges: {len(edges)}\n")
    for cfg in b2["configs"]:
        lines.append(f"### mcs={cfg['min_cluster_size']} ms={cfg['min_samples']}: "
                     f"{cfg['n_clusters']} clusters, noise_train={cfg['noise_share_train']:.1%}, "
                     f"noise_holdout={cfg.get('noise_share_holdout')}")
        for target, details in cfg["targets"].items():
            lines.append(f"\n#### Cible `{target}`\n")
            lines.append("| C | n_tr | WR_tr | p | BH | n_ho | WR_ho | côté | entry | PnL_ho | Edge |")
            lines.append("|--:|-----:|------:|--:|:--:|-----:|------:|:----:|------:|-------:|:----:|")
            for cl in details:
                tr, ho, eco = cl["train"], cl.get("holdout") or {}, cl.get("economics_holdout") or {}
                verd = cl.get("verdict_global") or cl.get("verdict") or {}
                entry = eco.get("avg_entry")
                pnl = eco.get("pnl")
                lines.append(
                    f"| {tr['cluster']} | {tr['n']} | {tr['wr']:.3f} | {tr['pvalue']:.2e} | "
                    f"{'oui' if tr.get('bh_reject_global') else 'non'} | {ho.get('n','')} | "
                    f"{ho.get('wr', float('nan')):.3f} | {cl.get('side')} | "
                    f"{entry if entry is not None else float('nan'):.3f} | "
                    f"{pnl if pnl is not None else float('nan'):.2f} | "
                    f"{'OUI' if verd.get('edge') else 'non'} |"
                )
        lines.append("")

    lines.append("## Verdict edge (B2)\n")
    if not edges:
        lines.append("**Aucun edge économique robuste** sur B2: soit pas de signal BH sur train, "
                     "soit non répliqué holdout, soit WR ≤ prix d'entrée implicite.\n")
    else:
        for e in edges:
            eco = e["economics_holdout"]
            lines.append(f"- mcs={e['mcs']} ms={e['ms']} {e['target']} C{e['cluster']}: "
                         f"n={eco.get('n')} WR={eco.get('wr'):.3f} entry={eco.get('avg_entry'):.3f} "
                         f"PnL=${eco.get('pnl'):.2f}")
        lines.append("")

    lines.append("## Limites\n")
    lines.append("- B1 look-ahead → ne pas trader")
    lines.append("- HDBSCAN + assignation holdout heuristique (médoïde); noise souvent élevé")
    lines.append("- Petite taille d'échantillon; BH conservateur")
    lines.append("- Comparer WR au ask, pas seulement à la baseline P(Up)\n")

    lines.append("## Conclusion et prochaines étapes\n")
    if edges:
        lines.append("Des edges B2 existent sous le protocole strict; valider en paper trading sur la config retenue.")
    else:
        lines.append("HDBSCAN sur résumés [0,300] ne livre pas d'edge holdout contre le prix implicite.")
        lines.append("Prochaine étape: supervisé calibré (logistic / GBM) sur les mêmes features avec isotonic et EV vs ask, "
                     "ou focus sur régimes de spread/ask_sum plutôt que clustering non supervisé.")
    lines.append("\n---\n*Généré par `scripts/research/clustering-v2/study_b_hdbscan.py` — aucun commit.*\n")
    return "\n".join(lines)


if __name__ == "__main__":
    main()