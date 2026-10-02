import type { JSX } from "solid-js";
import { Show } from "solid-js";

/* ---------- petits composants de champ ---------- */

export function Field(props: {
  label: string;
  hint?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="cfg-field">
      <span class="cfg-field__label">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="cfg-field__hint">{props.hint}</span>
      </Show>
    </label>
  );
}

/** Interrupteur (toggle) pour les booléens. */
export function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label class="cfg-toggle">
      <span class="cfg-toggle__text">
        <span class="cfg-toggle__label">{props.label}</span>
        <Show when={props.hint}>
          <span class="cfg-toggle__hint">{props.hint}</span>
        </Show>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        class={`cfg-switch${props.checked ? " cfg-switch--on" : ""}`}
        onClick={() => props.onChange(!props.checked)}
      >
        <span class="cfg-switch__knob" />
      </button>
    </label>
  );
}

export function NumberInput(props: {
  value: string;
  min?: number;
  max?: number;
  step?: number;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <input
      class="cfg-input"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}
