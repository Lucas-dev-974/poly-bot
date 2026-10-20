/**
 * Carte « Courbe de capital » de la page Simulation — SVG responsive
 * (viewBox mesuré par ResizeObserver : coordonnées = px réels, aucun
 * étirement du texte), area + ligne + grille graduée à ticks « propres »,
 * labels de temps (début / milieu / fin), marqueurs de résolution
 * échantillonnés colorés au signe du delta, point courant pulsé, crosshair
 * et tooltip de survol (date, capital, delta vs résolution précédente),
 * plus la colonne de stats dérivées (utils/equity.ts).
 *
 * Données : SimEquity.stats (Accessor) fourni par useSimEquity.
 */
import type { JSX } from "solid-js";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import type { EquityStats } from "../../utils/equity";
import { EmptyState } from "../../components/ui/EmptyState";
import { dateTimeStr, fmtUsd, fmtUsdCompact } from "../../utils/format";
import { pnlClass } from "../simPageHelpers";

const H = 172;
/** Marge horizontale du tracé. */
const PADX = 8;
/** Pad haut de la zone tracée (en dessous : bandes réservées aux labels temps). */
const PADY = 12;
const PADB = 20;
const PLOT_BOTTOM = H - PADB;
/** Largeur viewBox de repli avant la première mesure ResizeObserver. */
const FALLBACK_W = 640;
/** Demi-largeur estimée du tooltip, pour le clamp horizontal dans la carte. */
const TIP_HALF = 80;
/** Écart horizontal minimal (px) pour afficher le label « milieu ». */
const XLABEL_GAP = 100;

/** Ticks gradués « propres » (1/2/2.5/5 × 10^n) couvrant [lo,hi], ~count max. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-3; v += step) {
    ticks.push(Number(v.toFixed(6))); // absorbe les artefacts flottants du pas
  }
  return ticks;
}

interface HoverInfo {
  x: number;
  y: number;
  v: number;
  t: number;
  /** Delta vs point précédent (null au 1er point). */
  delta: number | null;
  /** Largeur de viewBox, pour le clamp du tooltip. */
  w: number;
}

/** Courbe SVG responsive (area + ligne + grille + marques + courant + crosshair). */
function EquityChart(props: { stats: Accessor<EquityStats> }): JSX.Element {
  const [width, setWidth] = createSignal(0);
  const [hoverIdx, setHoverIdx] = createSignal<number | null>(null);
  let wrapEl: HTMLDivElement | undefined;

  // Largeur réelle du conteneur → viewBox 1:1 : la géométrie et le texte
  // (labels axes, tooltip) suivent le redimensionnement sans distorsion.
  onMount(() => {
    if (!wrapEl) return;
    setWidth(wrapEl.clientWidth);
    const ro = new ResizeObserver(() => setWidth(wrapEl?.clientWidth ?? 0));
    ro.observe(wrapEl);
    onCleanup(() => ro.disconnect());
  });

  const viewW = createMemo(() => (width() > 0 ? width() : FALLBACK_W));

  const geo = createMemo(() => {
    const pts = props.stats().points;
    if (pts.length < 2) return null;
    const w = viewW();
    const vals = pts.map((p) => p.v);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = hi - lo || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const plotH = PLOT_BOTTOM - PADY;
    const step = (w - 2 * PADX) / (pts.length - 1);
    const pt = (i: number): [number, number] => [
      PADX + step * i,
      PADY + plotH * (1 - (pts[i].v - lo) / (hi - lo)),
    ];
    return { pts, lo, hi, w, step, plotH, pt };
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
    return `${linePath()}L${(g.w - PADX).toFixed(1)} ${PLOT_BOTTOM}L${PADX} ${PLOT_BOTTOM}Z`;
  });

  /** Grille graduée : y-labels aux ticks « propres », pas aux bornes ±4. */
  const ticks = createMemo(() => {
    const g = geo();
    if (!g) return [];
    return niceTicks(g.lo, g.hi, 3).map((v) => ({
      v,
      y: PADY + g.plotH * (1 - (v - g.lo) / (g.hi - g.lo)),
    }));
  });

  /** 3 labels de temps — début / milieu / fin ; milieu masqué s'il chevauche. */
  const xlabels = createMemo(() => {
    const g = geo();
    if (!g || g.pts.length < 2) return [];
    const n = g.pts.length;
    const firstX = g.pt(0)[0];
    const lastX = g.pt(n - 1)[0];
    const out: Array<{ x: number; label: string; anchor: "start" | "middle" | "end" }> = [
      { x: firstX, label: dateTimeStr(g.pts[0].t), anchor: "start" },
      { x: lastX, label: dateTimeStr(g.pts[n - 1].t), anchor: "end" },
    ];
    if (n >= 3) {
      const midIdx = Math.round((n - 1) / 2);
      const midX = g.pt(midIdx)[0];
      if (Math.min(midX - firstX, lastX - midX) >= XLABEL_GAP) {
        out.splice(1, 0, { x: midX, label: dateTimeStr(g.pts[midIdx].t), anchor: "middle" });
      }
    }
    return out;
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

  const hoverInfo = createMemo(() => {
    const g = geo();
    const i = hoverIdx();
    if (!g || i == null || i >= g.pts.length) return null;
    const [x, y] = g.pt(i);
    const prevV = i > 0 ? g.pts[i - 1].v : null;
    return {
      x,
      y,
      v: g.pts[i].v,
      t: g.pts[i].t,
      delta: prevV != null ? g.pts[i].v - prevV : null,
      w: g.w,
    };
  });

  return (
    <div
      class="sim2-eq-chartwrap"
      ref={(el) => {
        wrapEl = el;
      }}
    >
      <svg
        viewBox={`0 0 ${viewW().toFixed(0)} ${H}`}
        preserveAspectRatio="none"
        class="sim2-eq-svg"
        aria-hidden="true"
        onPointerMove={(ev) => {
          const g = geo();
          if (!g) return;
          const rect = ev.currentTarget.getBoundingClientRect();
          const i = Math.round((ev.clientX - rect.left - PADX) / g.step);
          setHoverIdx(Math.max(0, Math.min(g.pts.length - 1, i)));
        }}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="sim2EqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity=".22" />
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <For each={ticks()}>
          {(t) => (
            <>
              <line
                x1={PADX}
                x2={(viewW() - PADX).toFixed(1)}
                y1={t.y.toFixed(1)}
                y2={t.y.toFixed(1)}
                stroke="var(--border)"
                stroke-dasharray="3 5"
              />
              <text class="sim2-axis" x={(viewW() - PADX).toFixed(1)} y={(t.y - 4).toFixed(1)} text-anchor="end">
                {fmtUsdCompact(t.v)}
              </text>
            </>
          )}
        </For>
        <For each={xlabels()}>
          {(l) => (
            <text class="sim2-axis" x={l.x.toFixed(1)} y={H - 5} text-anchor={l.anchor}>
              {l.label}
            </text>
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
        <Show when={hoverInfo()} keyed>
          {(h) => (
            <>
              <line
                x1={h.x.toFixed(1)}
                x2={h.x.toFixed(1)}
                y1={PADY}
                y2={PLOT_BOTTOM}
                stroke="var(--border)"
                stroke-dasharray="2 3"
              />
              <circle
                cx={h.x.toFixed(1)}
                cy={h.y.toFixed(1)}
                r="3.8"
                fill="var(--accent)"
                stroke="var(--bg)"
                stroke-width="2"
              />
            </>
          )}
        </Show>
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
      <Show when={hoverInfo()} keyed>
        {(h) => (
          <div
            class="sim2-eq-tip"
            style={{ left: `${Math.min(Math.max(h.x, TIP_HALF), h.w - TIP_HALF).toFixed(0)}px` }}
          >
            <small>{dateTimeStr(h.t)}</small>
            <b class="num">{fmtUsd(h.v)}</b>
            <Show when={h.delta != null}>
              <span class={`num ${h.delta! > 0 ? "pnl-pos" : h.delta! < 0 ? "pnl-neg" : ""}`}>
                {h.delta! >= 0 ? "+" : "−"}
                {fmtUsd(Math.abs(h.delta!)).slice(1)}
              </span>
            </Show>
          </div>
        )}
      </Show>
    </div>
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
          <EquityChart stats={props.stats} />
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