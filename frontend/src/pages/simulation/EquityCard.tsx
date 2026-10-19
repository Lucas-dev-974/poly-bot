/**
 * Carte « Courbe de capital » de la page Simulation — SVG (area + ligne +
 * grille + marqueurs de résolution échantillonnés colorés au signe du delta
 * + point courant pulsé) et colonne de stats dérivées (utils/equity.ts).
 *
 * Données : SimEquity.stats (Accessor) fourni par useSimEquity.
 */
import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { EquityStats } from "../../utils/equity";
import { EmptyState } from "../../components/ui/EmptyState";
import { fmtUsdCompact } from "./ui";
import { pnlClass } from "../simPageHelpers";
import { fmtUsd } from "../../utils/format";

const W = 640;
const PADX = 8;
const PADY = 10;

/** Courbe SVG (area + ligne + grille + marques + point courant). */
function EquityChart(props: { stats: Accessor<EquityStats>; height?: number }): JSX.Element {
  const geo = createMemo(() => {
    const pts = props.stats().points;
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.v);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = hi - lo || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const H = props.height ?? 172;
    const pt = (i: number): [number, number] => [
      PADX + (W - 2 * PADX) * (i / (pts.length - 1)),
      PADY + (H - 2 * PADY) * (1 - (pts[i].v - lo) / (hi - lo)),
    ];
    return { pts, lo, hi, H, pt };
  });
  const linePath = createMemo(() => {
    const g = geo();
    if (!g) return "";
    let d = "";
    for (let i = 0; i < g.pts.length; i++) {
      const p = g.pt(i);
      d += (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1);
    }
    return d;
  });
  const areaPath = createMemo(() => {
    const g = geo();
    if (!g || !linePath()) return "";
    return `${linePath()}L${W - PADX} ${g.H - 2}L${PADX} ${g.H - 2}Z`;
  });
  const grid = createMemo(() => {
    const g = geo();
    if (!g) return [];
    const mid = (g.lo + g.hi) / 2;
    const yFor = (v: number): number =>
      PADY + (g.H - 2 * PADY) * (1 - (v - g.lo) / (g.hi - g.lo));
    return [
      { y: yFor(g.hi - 4), v: g.hi - 4 },
      { y: yFor(mid), v: mid },
      { y: yFor(g.lo + 4), v: g.lo + 4 },
    ];
  });
  /** Marqueurs résolus : au plus 12, colorés au signe du delta. */
  const markers = createMemo(() => {
    const g = geo();
    if (!g) return [];
    const n = g.pts.length;
    const count = Math.min(12, n);
    const out: Array<{ x: number; y: number; pos: boolean }> = [];
    for (let k = 0; k < count; k++) {
      const i = Math.round((k * (n - 1)) / Math.max(1, count - 1));
      const prev = i > 0 ? g.pts[i - 1].v : g.pts[0].v;
      const p = g.pt(i);
      out.push({ x: p[0], y: p[1], pos: g.pts[i].v >= prev });
    }
    return out;
  });
  const last = createMemo(() => {
    const g = geo();
    if (!g) return null;
    return g.pt(g.pts.length - 1);
  });
  return (
    <svg viewBox={`0 0 ${W} 172`} preserveAspectRatio="none" class="sim2-eq-svg" aria-hidden="true">
      <defs>
        <linearGradient id="sim2EqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity=".22" />
          <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <For each={grid()}>
        {(g) => (
          <>
            <line
              x1={PADX}
              x2={W - PADX}
              y1={g.y.toFixed(1)}
              y2={g.y.toFixed(1)}
              stroke="var(--border)"
              stroke-dasharray="3 5"
            />
            <text class="sim2-axis" x={W - PADX} y={(g.y - 4).toFixed(1)} text-anchor="end">
              {fmtUsdCompact(g.v)}
            </text>
          </>
        )}
      </For>
      <path d={areaPath()} fill="url(#sim2EqFill)" />
      <path d={linePath()} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />
      <For each={markers()}>
        {(m) => (
          <circle
            cx={m.x.toFixed(1)}
            cy={m.y.toFixed(1)}
            r="3.2"
            fill={m.pos ? "var(--green)" : "var(--red)"}
            stroke="var(--panel)"
            stroke-width="1.6"
          />
        )}
      </For>
      <Show when={last()} keyed>
        {(l) => (
          <circle
            class="sim2-eq-lastdot"
            cx={l[0].toFixed(1)}
            cy={l[1].toFixed(1)}
            r="4"
            fill="var(--accent)"
            stroke="var(--bg)"
            stroke-width="2"
          />
        )}
      </Show>
    </svg>
  );
}

export function EquityCard(props: { stats: Accessor<EquityStats> }): JSX.Element {
  return (
    <section class="sim2-card">
      <div class="sim2-card-h">
        <h2>Courbe de capital</h2>
        <span class="sim2-card-note">
          réalisé, depuis reset
          <Show when={props.stats().truncated}> · 200 dernières résolutions</Show>
        </span>
        <span class="sim2-card-spacer" />
        <span class="sim2-card-note">
          <span class="pos">●</span> gain
          <span class="neg" style={{ "margin-left": "8px" }}>●</span> perte
        </span>
      </div>
      <Show
        when={props.stats().points.length >= 2}
        fallback={
          <div class="sim2-card-b">
            <EmptyState text="La courbe apparaît dès la première position résolue (capital initial + P&L cumulé)." />
          </div>
        }
      >
        <div class="sim2-equity">
          <div class="sim2-eq-chartwrap">
            <EquityChart stats={props.stats} />
          </div>
          <div class="sim2-eq-stats">
            <div class="sim2-eq-stat">
              <small>Max drawdown</small>
              <b class={`num ${pnlClass(-props.stats().maxDrawdown)}`}>
                −{fmtUsd(props.stats().maxDrawdown).slice(1)}
              </b>
            </div>
            <div class="sim2-eq-stat">
              <small>Meilleure série</small>
              <b class="num">+{props.stats().bestStreak} wins</b>
            </div>
            <div class="sim2-eq-stat">
              <small>Gain moyen</small>
              <b class={`num ${pnlClass(props.stats().avgWin ?? 0)}`}>
                {props.stats().avgWin != null ? fmtUsd(props.stats().avgWin) : "—"}
              </b>
            </div>
            <div class="sim2-eq-stat">
              <small>Perte moyenne</small>
              <b class={`num ${pnlClass(props.stats().avgLoss ?? 0)}`}>
                {props.stats().avgLoss != null ? fmtUsd(props.stats().avgLoss) : "—"}
              </b>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}