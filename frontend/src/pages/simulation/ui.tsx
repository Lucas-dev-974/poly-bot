/**
 * Composants de présentation purs de la page Simulation (aucun état métier,
 * aucune requête). Partagés entre les cartes de la page (KPI, historique,
 * flux). SolidJS : les lectures de signaux restent inline dans le JSX des
 * consommateurs — ces composants sont sans état.
 */
import type { JSX } from "solid-js";

/** Clamp [0,1]. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Jauge circulaire (winrate…). value ∈ [0,1]. */
export function RingGauge(props: { value: number; label: string; class?: string }): JSX.Element {
  const C = 2 * Math.PI * 16;
  return (
    <svg class={props.class} viewBox="0 0 40 40" width="52" height="52" role="img" aria-label={String(props.label)}>
      <circle cx="20" cy="20" r="16" fill="none" stroke="var(--panel-3)" stroke-width="5" />
      <circle
        cx="20"
        cy="20"
        r="16"
        fill="none"
        stroke="var(--green)"
        stroke-width="5"
        stroke-dasharray={`${(clamp01(props.value) * C).toFixed(1)} ${C.toFixed(1)}`}
        stroke-linecap="round"
        transform="rotate(-90 20 20)"
      />
      <text x="20" y="24" text-anchor="middle" font-size="10" fill="var(--text)" class="sim2-mono">
        {props.label}
      </text>
    </svg>
  );
}

/** Micro-sparkline (KPI capital), polyline mono-couleur, viewBox 100×20. */
export function MicroSpark(props: { values: readonly number[]; class?: string }): JSX.Element {
  return (
    <svg
      class={props.class}
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      width="100%"
      height="20"
      aria-hidden="true"
    >
      <path
        d={polylinePath(props.values, 100, 20, 2)}
        fill="none"
        stroke="var(--accent)"
        stroke-width="1.6"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Chemin polyline d'une série de valeurs (sparkline), viewBox w×h. */
export function polylinePath(values: readonly number[], w: number, h: number, pad: number): string {
  if (values.length === 0) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = (w - 2 * pad) / Math.max(1, values.length - 1);
  return values
    .map((val, i) => {
      const x = pad + step * i;
      const y = pad + (h - 2 * pad) * (1 - (val - lo) / span);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
}

/** Bouton icône graphique (classe .chart-btn globale, style existant). */
export function GraphButton(props: { title: string; onClick: () => void }): JSX.Element {
  return (
    <button class="chart-btn" type="button" title={props.title} onClick={props.onClick}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M3 17l6-7 4 4 8-9M3 21h18" />
      </svg>
    </button>
  );
}

/** Chip d'outcome : UP (vert) / DOWN (rouge) / neutre. */
export function OutcomeChip(props: { label: string }): JSX.Element {
  const up = props.label.toUpperCase() === "UP";
  const down = props.label.toUpperCase() === "DOWN";
  return (
    <span class="sim2-outcome" classList={{ "sim2-outcome-up": up, "sim2-outcome-down": down }}>
      {(up || down) && <i aria-hidden="true" />}
      {props.label}
    </span>
  );
}