import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function MarketsSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
  usesEdge: () => boolean;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Marchés surveillés</h4>
      <p class="cfg-section__desc">
        Préfixes de slug Polymarket et intervalle de scan du CLOB.
      </p>
      <div class="cfg-grid">
        <Field
          label="Préfixes de slug (CSV)"
          hint="Ex. btc-updown-15m, eth-updown-15m"
        >
          <input
            class="cfg-input"
            type="text"
            value={props.form().marketSlugPrefixes}
            onInput={(e) => props.update("marketSlugPrefixes", e.currentTarget.value)}
          />
        </Field>
        <Field
          label="Poll interval (ms)"
          hint={
            props.usesEdge() && Number(props.form().pollIntervalMs) > 2000
              ? `Poll lent : ~${props.form().edgeConfirmSamples} ticks × ${props.form().pollIntervalMs}ms pour confirmer (défaut 5 × 1s = 5s)`
              : "Minimum 500 ms"
          }
        >
          <NumberInput
            value={props.form().pollIntervalMs}
            min={500}
            step={100}
            onInput={(v) => props.update("pollIntervalMs", v)}
          />
        </Field>
      </div>
    </div>
  );
}
