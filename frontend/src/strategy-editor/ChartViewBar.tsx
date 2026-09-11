import type { JSX } from "solid-js";

export function ChartViewBar(props: {
  tooltipEnabled: boolean;
  showYes: boolean;
  showNo: boolean;
  onToggleTooltip: () => void;
  onToggleYes: () => void;
  onToggleNo: () => void;
}): JSX.Element {
  return (
    <div class="se-viewbar">
      <span class="se-viewbar-title">Affichage</span>
      <button
        type="button"
        class={`btn se-viewbar-btn${props.tooltipEnabled ? " is-on" : ""}`}
        title="Prix au survol"
        onClick={props.onToggleTooltip}
      >
        Tooltip prix
      </button>
      <span class="se-viewbar-sep" />
      <span class="se-viewbar-label">Courbes</span>
      <button
        type="button"
        class={`btn se-viewbar-btn is-yes${props.showYes ? " is-on" : ""}`}
        title="Token Yes (Up)"
        onClick={props.onToggleYes}
      >
        Yes
      </button>
      <button
        type="button"
        class={`btn se-viewbar-btn is-no${props.showNo ? " is-on" : ""}`}
        title="Token No (Down)"
        onClick={props.onToggleNo}
      >
        No
      </button>
    </div>
  );
}
