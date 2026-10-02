import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function OpenEntrySection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée open-entry</h4>
      <p class="cfg-section__desc">
        À l&apos;ouverture (t≈0.5s) le marché est <strong>fair</strong>{" "}
        (somme des asks ≈ 1.01) et sans inclinaison mesurable —
        l&apos;edge vit dans le <strong>favori qui émerge</strong>{" "}
        (écart up/down de 0.10 à p50 6 s). On achète le 1er favori
        menant de 0.15 dans les 300 premières secondes, marché ouvert
        fair (askSum ≤ 1.02). Sortie : SL à double échelle (structurel
        = flip adverse confirmé + dégât prix ; tardif &gt; 300 s = petit
        dégât suffit), hold to resolution sinon. Backtest calibré
        runner officiel : hold $365 / SL $330 — les SL réduisent le
        drawdown mais coûtent de l&apos;espérance à sizing runner (L1) ;
        activez-les si la volatilité du PnL compte plus que la moyenne.
      </p>
      <div class="cfg-grid">
        <Field
          label="Lean trigger"
          hint="Écart up/down min du favori (défaut 0.15). Trop bas = signal noyé dans le bruit (0.12 isolé : t=0.06)."
        >
          <NumberInput
            value={props.form().openEntryLeanTrigger}
            min={0.01}
            max={0.5}
            step={0.01}
            onInput={(v) => props.update("openEntryLeanTrigger", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec)"
          hint="Fenêtre d'entrée : [0, N] secondes (défaut 300). Le trigger est atteint à p50 ~20s."
        >
          <NumberInput
            value={props.form().openEntryMaxElapsedSec}
            min={1}
            max={900}
            step={1}
            onInput={(v) => props.update("openEntryMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Fair ask sum max"
          hint="Somme des asks au 1er tick (défaut 1.02). Marché ouvert fair — pas d'arbitrage d'ouverture."
        >
          <NumberInput
            value={props.form().openEntryFairAskSumMax}
            min={1.001}
            max={1.2}
            step={0.01}
            onInput={(v) => props.update("openEntryFairAskSumMax", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du favori à l'entrée (défaut 0.04). Liquidité."
        >
          <NumberInput
            value={props.form().openEntryMaxSpread}
            min={0}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("openEntryMaxSpread", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le favori (défaut 15)."
        >
          <NumberInput
            value={props.form().openEntryOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("openEntryOrderUsdc", v)}
          />
        </Field>
        <Field
          label="SL actif"
          hint="Stop-loss dual-scale on/off (défaut on). Off = hold intégral."
        >
          <select
            class="cfg-input"
            value={props.form().openEntrySlEnabled ? "on" : "off"}
            onChange={(e) =>
              props.update("openEntrySlEnabled", e.currentTarget.value === "on")
            }
          >
            <option value="on">On (SL dual-scale)</option>
            <option value="off">Off (hold intégral)</option>
          </select>
        </Field>
        <Field
          label="SL struct : flip dist"
          hint="L'autre jambe mène de >= X (défaut 0.20) pour armer le SL structurel."
        >
          <NumberInput
            value={props.form().openEntrySlStructFlipDist}
            min={0.01}
            max={1}
            step={0.01}
            onInput={(v) => props.update("openEntrySlStructFlipDist", v)}
          />
        </Field>
        <Field
          label="SL struct : confirm (sec)"
          hint="Le flip doit durer >= N secondes (défaut 20) — coupe les faux retournements."
        >
          <NumberInput
            value={props.form().openEntrySlStructConfirmSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("openEntrySlStructConfirmSec", v)}
          />
        </Field>
        <Field
          label="SL struct : dégât"
          hint="ET le prix tenu a perdu >= X (défaut 0.10) — jamais le flip seul."
        >
          <NumberInput
            value={props.form().openEntrySlStructDist}
            min={0.01}
            max={1}
            step={0.01}
            onInput={(v) => props.update("openEntrySlStructDist", v)}
          />
        </Field>
        <Field
          label="SL tardif : après (sec)"
          hint="Passé N secondes (défaut 300), un petit dégât suffit."
        >
          <NumberInput
            value={props.form().openEntrySlLateAfterSec}
            min={1}
            max={900}
            step={1}
            onInput={(v) => props.update("openEntrySlLateAfterSec", v)}
          />
        </Field>
        <Field
          label="SL tardif : dégât"
          hint="Petit dégât tardif (défaut 0.06, ≤ dégât structurel). La thèse a eu le temps de se vérifier."
        >
          <NumberInput
            value={props.form().openEntrySlLateDist}
            min={0.01}
            max={1}
            step={0.01}
            onInput={(v) => props.update("openEntrySlLateDist", v)}
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
