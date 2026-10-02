import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function EarlyLowSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée early-low</h4>
      <p class="cfg-section__desc">
        Dans les <strong>2,5 premières minutes</strong> d&apos;un marché 15m,{" "}
        si un token UP/DOWN descend sous <strong>0.12</strong>, achat{" "}
        <strong>1$</strong> (FOK) puis <strong>hold intégral</strong> jusqu&apos;à
        la résolution (config optimisée 2026-09-29, multi-split : l&apos;exit
        wait-and-see 0.40 détruit de la valeur — off par défaut). 15m uniquement.
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask min (bande d'achat)"
          hint="Plancher optionnel (0 = off). L'achat exige ask < cap."
        >
          <NumberInput
            value={props.form().earlyLowBuyAskMin}
            min={0}
            max={0.5}
            step={0.01}
            onInput={(v) => props.update("earlyLowBuyAskMin", v)}
          />
        </Field>
        <Field
          label="Ask max (cap décote)"
          hint="Le token décoté doit coter SOUS ce cap (défaut 0.12 = 12¢)."
        >
          <NumberInput
            value={props.form().earlyLowBuyAskMax}
            min={0}
            max={0.49}
            step={0.01}
            onInput={(v) => props.update("earlyLowBuyAskMax", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec)"
          hint="Fenêtre d'entrée : [0, N] secondes (défaut 150 = 2,5 min)."
        >
          <NumberInput
            value={props.form().earlyLowMaxElapsedSec}
            min={1}
            max={900}
            step={1}
            onInput={(v) => props.update("earlyLowMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du token ciblé à l'entrée (défaut 0.06). Liquidité."
        >
          <NumberInput
            value={props.form().earlyLowMaxSpread}
            min={0}
            max={0.3}
            step={0.01}
            onInput={(v) => props.update("earlyLowMaxSpread", v)}
          />
        </Field>
        <Field
          label="Budget (USDC)"
          hint="Budget FOK du token décoté (défaut 1)."
        >
          <NumberInput
            value={props.form().earlyLowOrderUsdc}
            min={0.5}
            step={0.5}
            onInput={(v) => props.update("earlyLowOrderUsdc", v)}
          />
        </Field>
      </div>
      <div class="cfg-grid" style={{ "margin-top": "0.75rem" }}>
        <Field
          label="Exit wait-and-see actif"
          hint="Off par défaut = hold intégral (optimisé 2026-09-29). Actif = observe à 0.40 puis vend au premier fléchissement."
        >
          <select
            class="cfg-input"
            value={props.form().earlyLowExitEnabled ? "on" : "off"}
            onChange={(e) =>
              props.update("earlyLowExitEnabled", e.currentTarget.value === "on")
            }
          >
            <option value="on">Actif</option>
            <option value="off">Désactivé (hold résolution)</option>
          </select>
        </Field>
        <Field
          label="Seuil d'armement exit"
          hint="L'ask du token TENU qui déclenche l'observation (défaut 0.40)."
        >
          <NumberInput
            value={props.form().earlyLowExitAsk}
            min={0}
            max={1}
            step={0.01}
            onInput={(v) => props.update("earlyLowExitAsk", v)}
          />
        </Field>
        <Field
          label="Progression min / tick"
          hint="Hold tant que l'ask monte d'au moins N entre deux ticks (défaut 0 = seul le tick plat/baisse coupe). Stagnation/baisse = SELL."
        >
          <NumberInput
            value={props.form().earlyLowExitMomentumMin}
            min={0}
            max={0.1}
            step={0.001}
            onInput={(v) => props.update("earlyLowExitMomentumMin", v)}
          />
        </Field>
        <Field
          label="15m uniquement"
          hint="Refuse les marchés non-15m (défaut actif)."
        >
          <select
            class="cfg-input"
            value={props.form().earlyLow15mOnly ? "on" : "off"}
            onChange={(e) =>
              props.update("earlyLow15mOnly", e.currentTarget.value === "on")
            }
          >
            <option value="on">15m uniquement</option>
            <option value="off">Toutes durées</option>
          </select>
        </Field>
      </div>
      <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
        Risque / exposition : onglet Risque (max shares, max exposure).
        Fenêtre de trading : onglet Fenêtre.
      </p>
    </div>
  );
}
