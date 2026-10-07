# -*- coding: utf-8 -*-
import json
from pathlib import Path

ROOT = Path(r"C:\Users\lcsystem\Desktop\TradeInterface\polymarket-github\polymarket-reverse-arbitrage-bot")
A = ROOT / "audits" / "clustering-v2" / "A-par-moments"
B = ROOT / "audits" / "clustering-v2" / "B-hdbscan"
OUT = ROOT / "audits" / "clustering-v2"
da = json.loads((A / "results.json").read_text(encoding="utf-8"))
db = json.loads((B / "results.json").read_text(encoding="utf-8"))
sm = da["split"]
edges = da["edges"]
best = {}
for e in edges:
    eco = e["economics_holdout"]
    key = (e["t"], e["method"], e["target"], e["side"])
    if key not in best or (eco.get("pnl") or -1e9) > (best[key]["economics_holdout"].get("pnl") or -1e9):
        best[key] = e
ranked = sorted(best.values(), key=lambda e: e["economics_holdout"].get("pnl") or -1e9, reverse=True)

L = []
L.append("# Synthèse — Clustering v2 (BTC 15m Polymarket)\n")
L.append("## Données\n")
L.append("- Période: **2026-09-08 → 2026-10-05** (28 j), fenêtres complètes (gaps ≤5s)")
L.append(f"- N={sm['n_total']} (Up 345 / Down 332)")
L.append(f"- Train n={sm['n_train']} ({sm['train_start']} → {sm['train_end']}), P(Up)={sm['baseline_up_train']:.3f}")
L.append(f"- Holdout n={sm['n_holdout']} ({sm['holdout_start']} → {sm['holdout_end']}), P(Up)={sm['baseline_up_holdout']:.3f}")
L.append("- Prix book Up/Down uniquement (pas de spot BTC); **FEE=0** (seul fee repo: repricingFeesRoundtrip=0.002, ignoré)\n")
L.append("## Étude A — Clustering par moments\n")
L.append(f"- Tests: {da['n_tests_global']} ; BH-sig train: {da['n_bh_significant_train']} ; edges complets: **{len(edges)}** (configs corrélées)")
L.append(f"- Edges uniques approx. (t, méthode, cible, côté): **{len(ranked)}**\n")
L.append("### Meilleurs edges holdout (par PnL)\n")
L.append("| t | méthode | k | cible | C | côté | n_ho | WR_ho | entry | PnL | p(train) |")
L.append("|--:|:--------|--:|:------|--:|:----:|-----:|------:|------:|----:|---------:|")
for e in ranked[:12]:
    eco = e["economics_holdout"]
    tr = e["train"]
    L.append(
        f"| {e['t']} | {e['method']} | {e['k']} | {e['target']} | {e['cluster']} | {e['side']} | "
        f"{eco['n']} | {eco['wr']:.3f} | {eco['avg_entry']:.3f} | {eco['pnl']:.2f} | {tr['pvalue']:.2e} |"
    )
L.append("\nRapport détaillé: `audits/clustering-v2/A-par-moments/RAPPORT.md`\n")
L.append("## Étude B — HDBSCAN résumés\n")
L.append("- **B1** [0,899): descriptif look-ahead — 2 clusters, noise ~11–17% ; **non tradable**")
L.append("- **B2** [0,300] tradable: surtout du bruit (noise 79–100%); mcs=10/ms=5 → 2 clusters")
L.append(f"- B2: tests={db['B2_n_tests']}, BH-sig={db['B2_n_bh_sig']}, **edges=0**\n")
L.append("Rapport: `audits/clustering-v2/B-hdbscan/RAPPORT.md`\n")
L.append("## Verdict global\n")
L.append(
    "L'étude A détecte des écarts économiques **marginaux** sur holdout pour certains clusters "
    "(souvent des régimes où mid_up/ask sont déjà informatifs). Les n_ho sont petits (20–40), "
    "les configs se chevauchent, et le PnL cumulé reste modeste (quelques $ à dizaines de $ "
    "sur ~20–40 trades à stake $4)."
)
L.append("L'étude B (HDBSCAN) **ne confirme aucun edge** tradable à t=300.")
L.append(
    "**Conclusion prudente:** pas de signal clustering robuste et scalable ; "
    "les « edges » A sont fragiles hors-échantillon et sous forte multiplicité.\n"
)
L.append("## Prochaine étape recommandée\n")
L.append("1. Réduire la multiplicité: fixer t=300, KMeans k=3–6, une seule cible.")
L.append("2. Supervisé calibré (proba vs ask) avec EV explicite plutôt que clustering non supervisé.")
L.append("3. Ou bandes simples (fav ask ∈ [0.55, 0.70] à t=300) avec le même protocole holdout/BH/économie.\n")
L.append("---\n*Aucun commit. Scripts: `scripts/research/clustering-v2/`*\n")
(OUT / "SYNTHESE.md").write_text("\n".join(L), encoding="utf-8", newline="\n")
print("OK", len(ranked), "unique edges; B2 edges", len(db.get("B2_edges", [])))
# top 3 for report-back
for e in ranked[:5]:
    eco = e["economics_holdout"]
    print(
        f"TOP t={e['t']} {e['method']} k={e['k']} {e['target']} C{e['cluster']} "
        f"n={eco['n']} WR={eco['wr']:.3f} entry={eco['avg_entry']:.3f} "
        f"PnL={eco['pnl']:.2f} p={e['train']['pvalue']:.2e} BH=yes"
    )