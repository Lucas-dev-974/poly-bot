import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function FlipConfirmSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée flip-confirm</h4>
      <p class="cfg-section__desc">
        Stratégie directionnelle momentum : un flip d&apos;identité{" "}
        <strong>PRÉCOCE</strong> est informationnel (vrai déséquilibre). On
        achète le <strong>NOUVEAU favori</strong> (0.55-0.65) dans la fenêtre
        d&apos;entrée [120s, 180s], flip frais de moins de 90s, hold jusqu&apos;à
        la résolution — pas de hedge. Backtest calibré : +$389, WR 66.5 %,
        t-stat 2.44. Les entrées après 180s s&apos;effondrent (flips tardifs =
        bruit) : ne pas élargir la fenêtre.
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask nouveau favori min"
          hint="Borne basse de la bande d'entrée du nouveau favori (défaut 0.55)."
        >
          <NumberInput
            value={props.form().flipConfirmBandMin}
            min={0.4}
            max={0.8}
            step={0.01}
            onInput={(v) => props.update("flipConfirmBandMin", v)}
          />
        </Field>
        <Field
          label="Ask nouveau favori max"
          hint="Borne haute (défaut 0.65). Au-delà, le nouveau favori est déjà certitude : le ré-ajustement a eu lieu."
        >
          <NumberInput
            value={props.form().flipConfirmBandMax}
            min={0.45}
            max={0.9}
            step={0.01}
            onInput={(v) => props.update("flipConfirmBandMax", v)}
          />
        </Field>
        <Field
          label="Flip lookback (ms)"
          hint="Le flip doit dater de moins de N ms avant l'entrée (défaut 90000 = 90s)."
        >
          <NumberInput
            value={props.form().flipConfirmFlipLookbackMs}
            min={1000}
            max={300000}
            step={1000}
            onInput={(v) => props.update("flipConfirmFlipLookbackMs", v)}
          />
        </Field>
        <Field
          label="Min elapsed (sec)"
          hint="Début de la fenêtre d'entrée (défaut 120)."
        >
          <NumberInput
            value={props.form().flipConfirmMinElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("flipConfirmMinElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec, opt)"
          hint="Fin de la fenêtre d'entrée (défaut 180). Les entrées après 180s sont en perte : ne pas élargir sans re-backtester."
        >
          <NumberInput
            value={props.form().flipConfirmMaxElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("flipConfirmMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du favori à l'entrée (défaut 0.05). Liquidité."
        >
          <NumberInput
            value={props.form().flipConfirmMaxSpread}
            min={0}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("flipConfirmMaxSpread", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le nouveau favori (défaut 15)."
        >
          <NumberInput
            value={props.form().flipConfirmOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("flipConfirmOrderUsdc", v)}
          />
        </Field>
      </div>
      <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
        Risque / exposition : onglet Risque (max shares, max exposure).
        Fenêtre de trading : onglet Fenêtre.
      </p>
    </div>
  );
}
