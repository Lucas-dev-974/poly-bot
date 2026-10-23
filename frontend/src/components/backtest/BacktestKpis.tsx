/**
 * Rangée KPI de la page Backtest — le résumé global qui manquait :
 * dataset enregistré, P&L cumulé, meilleur run, volume de rejets.
 * Données : stores backtestStore (windows + runs) — aucun fetch propre ;
 * la page déclenche déjà le chargement au montage.
 *
 * Agrégats calculés sur les runs RETENUS par le backend (prune 20 derniers
 * runs, src/backtest/job.ts) : les libellés le rappellent.
 */
import { createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { runs, windows } from "../../stores/backtestStore";
import { Sim2Kpis, type Sim2KpiCard } from "../ui/Sim2Kpi";
import { pnlClass } from "../../utils/display";
import { fmtCount, fmtUsd } from "../../utils/format";
import type { BacktestRunSummary } from "../../types";

function dayKey(windowStart: number): string {
  const d = new Date(windowStart * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Agg = {
  pnl: number;
  withPnl: number;
  best: { id: string; strategy: string; pnl: number; capitalStart: number; capitalEnd: number; fills: number } | null;
  rejects: number;
  fills: number;
};

function aggregate(runsList: readonly BacktestRunSummary[]): Agg {
  let pnl = 0;
  let withPnl = 0;
  let rejects = 0;
  let fills = 0;
  let best: Agg["best"] = null;
  for (const r of runsList) {
    const res = r.result;
    if (!res) continue;
    if (res.pnl != null) {
      pnl += res.pnl;
      withPnl += 1;
      if (!best || res.pnl > best.pnl) {
        best = {
          id: r.id,
          strategy: res.strategyId,
          pnl: res.pnl,
          capitalStart: res.capitalStart,
          capitalEnd: res.capitalEnd,
          fills: res.fillCount,
        };
      }
    }
    rejects += res.rejectCount ?? 0;
    fills += res.fillCount ?? 0;
  }
  return { pnl, withPnl, best, rejects, fills };
}

export function BacktestKpis(): JSX.Element {
  // Dataset côté stock (fenêtres passant les règles de complétude actuelles,
  // non filtrées par date/timeframe/marché — ces filtres n'affectent que la vue).
  const dataset = createMemo(() => {
    const list = windows();
    const days = new Set<string>();
    const tf = new Map<string, number>();
    for (const w of list) {
      days.add(dayKey(w.windowStart));
      const m = w.eventSlug.match(/-updown-(\d+[mh])-/);
      if (m) tf.set(m[1], (tf.get(m[1]) ?? 0) + 1);
    }
    const tfSplit = [...tf.entries()]
      .sort((a, b) => Number(a[0].replace(/[mh]/, "")) - Number(b[0].replace(/[mh]/, "")))
      .map(([k, n]) => `${k} ${fmtCount(n)}`)
      .join(" · ");
    return { count: list.length, days: days.size, tfSplit };
  });

  const agg = createMemo(() => aggregate(runs()));

  // La sous-ligne sert aussi de title (troncature par ellipsis possible).
  const subDataset = (): string =>
    dataset().count === 0
      ? "chargement…"
      : `${dataset().days} j${dataset().tfSplit ? ` · ${dataset().tfSplit}` : ""}`;

  // Cartes : liste construite SANS lecture réactive (objets stables, <For>
  // ne remonte jamais) — la réactivité vit dans les accessors.
  const cards: readonly Sim2KpiCard[] = [
    {
      label: "Fenêtres",
      value: () => fmtCount(dataset().count),
      sub: subDataset,
      subTitle: subDataset,
    },
    {
      label: "P&L cumulé",
      value: () => fmtUsd(agg().pnl),
      valueClass: () => pnlClass(agg().pnl),
      sub: () => `${agg().withPnl} run${agg().withPnl > 1 ? "s" : ""} avec P&L · 20 derniers runs`,
      subTitle: () => `${agg().withPnl} run${agg().withPnl > 1 ? "s" : ""} avec P&L · 20 derniers runs`,
    },
    {
      label: "Meilleur run",
      value: () => {
        const b = agg().best;
        return b ? fmtUsd(b.pnl) : "—";
      },
      valueClass: () => "acc",
      sub: () => {
        const b = agg().best;
        return b
          ? `${b.strategy} · capital ${fmtUsd(b.capitalStart)} → ${fmtUsd(b.capitalEnd)}`
          : "aucun run";
      },
      subTitle: () => {
        const b = agg().best;
        return b
          ? `${b.strategy} · capital ${fmtUsd(b.capitalStart)} → ${fmtUsd(b.capitalEnd)}`
          : "aucun run";
      },
      hl: true,
    },
    {
      label: "Ordres rejetés",
      value: () => fmtCount(agg().rejects),
      valueClass: () => (agg().rejects > 0 ? "neg" : ""),
      sub: () => {
        const ratio = agg().fills > 0 ? agg().rejects / agg().fills : 0;
        return `fills ${fmtCount(agg().fills)}${ratio > 0 ? ` · ×${ratio.toFixed(1).replace(".", ",")}` : ""}`;
      },
      subTitle: () => {
        const ratio = agg().fills > 0 ? agg().rejects / agg().fills : 0;
        return `fills ${fmtCount(agg().fills)}${ratio > 0 ? ` · ×${ratio.toFixed(1).replace(".", ",")}` : ""}`;
      },
    },
  ];

  return <Sim2Kpis cards={() => cards} class="bt-kpis" />;
}