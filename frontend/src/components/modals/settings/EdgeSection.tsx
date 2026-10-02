import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Field, NumberInput, Toggle } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function EdgeSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Jambe edge (favori)</h4>
      <p class="cfg-section__desc">
        Edge-lead : on confirme N ticks que l'ask du favori reste dans
        la bande et monte, on achète l'edge en GTC, on attend le fill,
        puis on poste le cheap au best ask live (bande cheap, budget
        cheap indépendant).
      </p>
      <div class="cfg-grid">
        <Field label="Edge band min" hint="Ask favori minimum de la bande de confirmation">
          <NumberInput
            value={props.form().edgeBandMin}
            min={0.5}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("edgeBandMin", v)}
          />
        </Field>
        <Field label="Edge band max" hint="Ask favori maximum de la bande de confirmation">
          <NumberInput
            value={props.form().edgeBandMax}
            min={0.5}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("edgeBandMax", v)}
          />
        </Field>
        <Field label="Ticks de confirmation" hint="Nombre de ticks consécutifs valides avant d'acheter l'edge (défaut 5)">
          <NumberInput
            value={props.form().edgeConfirmSamples}
            min={2}
            step={1}
            onInput={(v) => props.update("edgeConfirmSamples", v)}
          />
        </Field>
        <Field label="Drop max / tick" hint="Drop tick-à-tick max toléré dans la série (défaut 0.01)">
          <NumberInput
            value={props.form().edgeMaxDownTick}
            min={0.001}
            max={0.1}
            step={0.001}
            onInput={(v) => props.update("edgeMaxDownTick", v)}
          />
        </Field>
        <Field label="Cheap band min" hint="Ask cheap min (ex. 0.04). Hors bande : pas de POST, et cancel d'un GTC cheap resting">
          <NumberInput
            value={props.form().edgeCheapBandMin}
            min={0.01}
            max={0.49}
            step={0.01}
            onInput={(v) => props.update("edgeCheapBandMin", v)}
          />
        </Field>
        <Field label="Cheap band max" hint="Ask cheap max (ex. 0.14). GTC au best ask si dans la bande ; cancel + re-post s'il sort puis rentre">
          <NumberInput
            value={props.form().edgeCheapBandMax}
            min={0.01}
            max={0.49}
            step={0.01}
            onInput={(v) => props.update("edgeCheapBandMax", v)}
          />
        </Field>
        <Field
          label="Mode de sizing"
          hint="Shares = nombre fixe par side. pUSD = budget USDC par side. Dynamique = comportement actuel (budgets + confirmation). La confirmation et les bandes restent appliquées dans tous les modes."
        >
          <select
            class="cfg-input"
            value={props.form().edgeSizingMode}
            onChange={(e) =>
              props.update(
                "edgeSizingMode",
                e.currentTarget.value as ConfigFormState["edgeSizingMode"],
              )
            }
          >
            <option value="dynamic">Dynamique (budgets USDC)</option>
            <option value="pusd">pUSD (budget USDC fixe)</option>
            <option value="shares">Shares (nombre fixe)</option>
          </select>
        </Field>
        <Show when={props.form().edgeSizingMode === "shares"}>
          <Field label="Shares edge" hint="Nombre fixe de shares de l'ordre favori (≥ 5)">
            <NumberInput
              value={props.form().edgeSharesEdge}
              min={5}
              step={1}
              onInput={(v) => props.update("edgeSharesEdge", v)}
            />
          </Field>
          <Field label="Shares cheap" hint="Nombre fixe de shares de l'ordre cheap (≥ 5)">
            <NumberInput
              value={props.form().edgeSharesCheap}
              min={5}
              step={1}
              onInput={(v) => props.update("edgeSharesCheap", v)}
            />
          </Field>
        </Show>
        <Show when={props.form().edgeSizingMode !== "shares"}>
          <Field label="Budget edge (USDC)" hint="Taille edge = budget / prix edge, plafonnée par max shares edge. Indépendant du cheap">
            <NumberInput
              value={props.form().edgeOrderUsdc}
              min={1}
              step={1}
              onInput={(v) => props.update("edgeOrderUsdc", v)}
            />
          </Field>
          <Field label="Max shares edge" hint="Plafond de shares de l'ordre favori. Le cheap reste plafonné par Max shares / ordre">
            <NumberInput
              value={props.form().maxShareEdge}
              min={1}
              step={1}
              onInput={(v) => props.update("maxShareEdge", v)}
            />
          </Field>
          <Field label="Budget cheap (USDC)" hint="Taille cheap = budget / ask cheap, seulement après fill edge. Pas de 1:1 en shares">
            <NumberInput
              value={props.form().edgeCheapOrderUsdc}
              min={1}
              step={1}
              onInput={(v) => props.update("edgeCheapOrderUsdc", v)}
            />
          </Field>
        </Show>
        <Toggle
          label="Vendre l'edge si perte"
          hint="Vendre le favori nu (FOK SELL) si aucun cheap fillé et en perte soutenue"
          checked={props.form().edgeSellExpensiveEnabled}
          onChange={(v) => props.update("edgeSellExpensiveEnabled", v)}
        />
        <Show when={props.form().edgeSellExpensiveEnabled}>
          <Field label="Vente edge après (min)" hint="Âge du marché (min depuis l'ouverture) avant déclenchement (défaut 8)">
            <NumberInput
              value={props.form().edgeSellExpensiveAfterMin}
              min={0}
              step={1}
              onInput={(v) => props.update("edgeSellExpensiveAfterMin", v)}
            />
          </Field>
          <Field label="Perte edge (%)" hint="Perte % sous le prix de fill pour déclencher (ex. 10 = -10%)">
            <NumberInput
              value={props.form().edgeSellExpensiveLossPct}
              min={0.1}
              step={1}
              onInput={(v) => props.update("edgeSellExpensiveLossPct", v)}
            />
          </Field>
          <Field label="Fenêtre perte edge (ms)" hint="Durée de perte continue requise avant la vente (défaut 10000)">
            <NumberInput
              value={props.form().edgeSellExpensiveLossWindowMs}
              min={100}
              step={100}
              onInput={(v) => props.update("edgeSellExpensiveLossWindowMs", v)}
            />
          </Field>
        </Show>
      </div>
    </div>
  );
}
