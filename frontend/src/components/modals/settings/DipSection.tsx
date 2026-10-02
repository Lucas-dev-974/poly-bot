import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Field, NumberInput, Toggle } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function DipSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée dip-revert</h4>
      <p class="cfg-section__desc">
        Stratégie directionnelle mean-reversion : FOK buy du{" "}
        <strong>favori</strong> après une <strong>chute intra-fenêtre</strong>{" "}
        puis un <strong>début de rebond</strong>, et hold jusqu&apos;à la
        résolution — pas de hedge. Le marché sur-pénalise temporairement le
        favori après une secousse ; la clôture revient à la tendance
        (WR empirique ~64 % vs ~52 % favori moyen, sur 231 fenêtres).
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask favori min"
          hint="Borne basse de la bande d'entrée du favori (défaut 0.55)."
        >
          <NumberInput
            value={props.form().dipRevertBandMin}
            min={0.3}
            max={0.9}
            step={0.01}
            onInput={(v) => props.update("dipRevertBandMin", v)}
          />
        </Field>
        <Field
          label="Ask favori max"
          hint="Borne haute (défaut 0.65). Au-delà, le favori est « sûr » : le dip est structurel, pas une opportunité."
        >
          <NumberInput
            value={props.form().dipRevertBandMax}
            min={0.4}
            max={0.95}
            step={0.01}
            onInput={(v) => props.update("dipRevertBandMax", v)}
          />
        </Field>
        <Field
          label="Min drop"
          hint="Chute minimum de l'ask favori sur la fenêtre lookback (défaut 0.03 = 3¢)."
        >
          <NumberInput
            value={props.form().dipRevertMinDrop}
            min={0.001}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("dipRevertMinDrop", v)}
          />
        </Field>
        <Field
          label="Drop lookback (ms)"
          hint="Fenêtre glissante où mesurer la chute (défaut 60000 = 60 s)."
        >
          <NumberInput
            value={props.form().dipRevertDropLookbackMs}
            min={1000}
            max={300000}
            step={1000}
            onInput={(v) => props.update("dipRevertDropLookbackMs", v)}
          />
        </Field>
        <Field
          label="Min elapsed (sec)"
          hint="Attendre N secondes depuis le début de la fenêtre avant d'entrer (défaut 180)."
        >
          <NumberInput
            value={props.form().dipRevertMinElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("dipRevertMinElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec, opt)"
          hint="Vide = jusqu'à la close / minutesBeforeClose."
        >
          <NumberInput
            value={props.form().dipRevertMaxElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("dipRevertMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du favori à l'entrée (défaut 0.04). Liquidité."
        >
          <NumberInput
            value={props.form().dipRevertMaxSpread}
            min={0}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("dipRevertMaxSpread", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le favori (défaut 15). Taille = budget / ask, plafonnée par max shares."
        >
          <NumberInput
            value={props.form().dipRevertOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("dipRevertOrderUsdc", v)}
          />
        </Field>
      </div>
      <div style={{ "margin-top": "0.75rem" }}>
        <Toggle
          label="Take-profit (sortie anticipée)"
          hint="Vendre le favori détenu (FOK SELL au bid) quand son propre ask atteint le seuil, au lieu de hold jusqu'à la résolution. Désactivé : hold intégral (comportement par défaut)."
          checked={props.form().dipRevertExitTakeProfitEnabled}
          onChange={(v) => props.update("dipRevertExitTakeProfitEnabled", v)}
        />
        <Show when={props.form().dipRevertExitTakeProfitEnabled}>
          <div class="cfg-grid" style={{ "margin-top": "0.5rem" }}>
            <Field
              label="Take-profit ask"
              hint="Seuil sur l'ask du favori DÉTENU (défaut 0.85). Doit être > ask max de la bande d'entrée. Un FOK tué (profondeur) garde la position jusqu'à la résolution."
            >
              <NumberInput
                value={props.form().dipRevertExitWinAsk}
                min={0.6}
                max={0.99}
                step={0.01}
                onInput={(v) => props.update("dipRevertExitWinAsk", v)}
              />
            </Field>
          </div>
        </Show>
      </div>
      <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
        Risque / exposition : onglet Risque (max shares, max exposure).
        Fenêtre de trading : onglet Fenêtre.
      </p>
    </div>
  );
}
