import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function RiskSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Limites de risque</h4>
      <p class="cfg-section__desc">
        Plafonds de taille, de positions simultanées et d'exposition
        globale pour contenir le risque.
      </p>
      <div class="cfg-grid">
        <Field label="Max shares / ordre" hint="Plafond cheap (arb/barbell : tout ordre). Edge-lead : jambe cheap seulement">
          <NumberInput
            value={props.form().maxSharesPerOrder}
            min={1}
            step={1}
            onInput={(v) => props.update("maxSharesPerOrder", v)}
          />
        </Field>
        <Field label="Max shares edge" hint="Plafond de shares de l'ordre favori (edge-lead). Ignoré par arb/barbell">
          <NumberInput
            value={props.form().maxShareEdge}
            min={1}
            step={1}
            onInput={(v) => props.update("maxShareEdge", v)}
          />
        </Field>
        <Field label="Max positions / côté" hint="Par market window">
          <NumberInput
            value={props.form().maxOpenPositionsPerSide}
            min={1}
            step={1}
            onInput={(v) => props.update("maxOpenPositionsPerSide", v)}
          />
        </Field>
        <Field label="Max exposition (USDC)" hint="Cap global fills + GTC resting">
          <NumberInput
            value={props.form().maxExposureUsdc}
            min={1}
            step={1}
            onInput={(v) => props.update("maxExposureUsdc", v)}
          />
        </Field>
      </div>
    </div>
  );
}
