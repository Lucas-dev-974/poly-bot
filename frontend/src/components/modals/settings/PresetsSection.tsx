import type { JSX } from "solid-js";
import { Show, For } from "solid-js";
import { Field } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";
import { STRATEGY_ENGINE_OPTIONS, type StrategyPreset } from "../../../config/strategyPresets";
import type { StrategyEngineSummary } from "../../../api/client";

export function PresetsSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
  customEngines: () => StrategyEngineSummary[];
  enginePresets: () => StrategyPreset[];
  matchingPresetId: () => string | null;
  matchingPreset: () => StrategyPreset | null;
  dirty: () => boolean;
  applyPreset: (preset: StrategyPreset) => void;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Profils</h4>
      <p class="cfg-section__desc">
        Choisis le moteur, éventuellement un profil, puis Enregistrer.
        Ça écrit data/bot-settings.json (la config active). Tu peux encore
        ajuster les champs dans les autres onglets. Les stratégies custom se
        configurent par chart dans <a href="/strategy-editor">l'éditeur</a>.
      </p>
      <Field label="Moteur">
        <select
          class="cfg-input"
          value={props.form().strategyId}
          onChange={(e) =>
            props.update(
              "strategyId",
              e.currentTarget.value as ConfigFormState["strategyId"],
            )
          }
        >
          <For each={STRATEGY_ENGINE_OPTIONS}>
            {(option) => <option value={option.id}>{option.label}</option>}
          </For>
          <For each={props.customEngines()}>
            {(engine) => (
              <option value={engine.id}>{engine.name} ({engine.id})</option>
            )}
          </For>
        </select>
      </Field>
      <div class="cfg-presets__list">
        <For each={props.enginePresets()}>
          {(preset) => (
            <button
              type="button"
              class={`cfg-preset${props.matchingPresetId() === preset.id ? " cfg-preset--active" : ""}`}
              onClick={() => props.applyPreset(preset)}
            >
              <span class="cfg-preset__name">{preset.name}</span>
              <span class="cfg-preset__desc">{preset.description}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.enginePresets().length === 0}>
        <p class="cfg-presets__hint">Aucun profil pour ce moteur</p>
      </Show>
      <Show when={props.matchingPreset() && props.dirty()}>
        <p class="cfg-presets__hint">
          Profil « {props.matchingPreset()?.name} » chargé — Enregistrer pour l’activer.
        </p>
      </Show>
      <Show when={props.matchingPreset() && !props.dirty()}>
        <p class="cfg-presets__hint">Profil actif : {props.matchingPreset()?.name}</p>
      </Show>
    </div>
  );
}
