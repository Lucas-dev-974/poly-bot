import { For, type JSX } from "solid-js";
import {
  STRATEGY_ENGINE_OPTIONS,
  type AnyPreset,
  type StrategyId,
} from "../../config/strategyPresets";

export type CustomEngineOption = { id: string; name: string };

/** Built-in + optional custom engine <select> options (shared Backtest / Settings / Sim). */
export function EngineSelect(props: {
  value: string;
  onChange: (id: StrategyId) => void;
  customEngines?: CustomEngineOption[];
  disabled?: boolean;
  class?: string;
  id?: string;
}): JSX.Element {
  return (
    <select
      id={props.id}
      class={props.class}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value as StrategyId)}
    >
      <For each={STRATEGY_ENGINE_OPTIONS}>
        {(option) => <option value={option.id}>{option.label}</option>}
      </For>
      <For each={props.customEngines ?? []}>
        {(engine) => (
          <option value={engine.id}>
            {engine.name} ({engine.id})
          </option>
        )}
      </For>
    </select>
  );
}

/** Preset <select> with empty option + optional user-star prefix (Backtest / Sim). */
export function PresetSelect(props: {
  value: string;
  onChange: (id: string) => void;
  presets: AnyPreset[];
  emptyLabel?: string;
  disabled?: boolean;
  class?: string;
  id?: string;
}): JSX.Element {
  return (
    <select
      id={props.id}
      class={props.class}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    >
      <option value="">{props.emptyLabel ?? "Personnalisé"}</option>
      <For each={props.presets}>
        {(p) => (
          <option value={p.id}>
            {p.isUser ? "\u2605 " : ""}
            {p.name}
          </option>
        )}
      </For>
    </select>
  );
}
