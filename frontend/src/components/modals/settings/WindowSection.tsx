import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function WindowSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Fenêtre de trading</h4>
      <p class="cfg-section__desc">
        Restreint le trading à une plage de minutes avant la clôture du
        marché 15m.
      </p>
      <div class="cfg-grid">
        <Field label="Minutes avant clôture (min)">
          <NumberInput
            value={props.form().minutesBeforeCloseMin}
            min={0}
            max={15}
            step={1}
            onInput={(v) => props.update("minutesBeforeCloseMin", v)}
          />
        </Field>
        <Field label="Minutes avant clôture (max)">
          <NumberInput
            value={props.form().minutesBeforeCloseMax}
            min={0}
            max={15}
            step={1}
            onInput={(v) => props.update("minutesBeforeCloseMax", v)}
          />
        </Field>
        <Field
          label="Ne pas acheter si &lt; X min restantes"
          hint="Laisser vide pour désactiver"
        >
          <NumberInput
            value={props.form().minMinutesBeforeCloseToBuy}
            min={0}
            max={15}
            step={1}
            onInput={(v) => props.update("minMinutesBeforeCloseToBuy", v)}
          />
        </Field>
      </div>
    </div>
  );
}
