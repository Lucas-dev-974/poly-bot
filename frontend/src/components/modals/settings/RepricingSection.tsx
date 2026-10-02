import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function RepricingSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Probability-repricing</h4>
      <p class="cfg-section__desc">
        Path trade intramarket (pas settlement). Mode C : dislocation
        ask vs historique court CLOB (z-score) + cheapness ; mode A
        optionnel. Entry FOK au ask si tau / spread / edge_est OK.
        Exits sur bid exécutable : TP abs/rel, stop, time-stop,
        tau_force, spread_max_exit. Pas de hedge.
      </p>
      <h5 style={{ "margin-top": "0.75rem" }}>Entrée</h5>
      <div class="cfg-grid">
        <Field label="Tau min (sec)" hint="Temps restant minimum avant close pour entrer (défaut 90).">
          <NumberInput value={props.form().repricingTauMinSec} min={1} max={900} step={1} onInput={(v) => props.update("repricingTauMinSec", v)} />
        </Field>
        <Field label="Spread max" hint="Spread max à l'entrée (défaut 0.03).">
          <NumberInput value={props.form().repricingSpreadMax} min={0} max={0.5} step={0.005} onInput={(v) => props.update("repricingSpreadMax", v)} />
        </Field>
        <Field label="P entry max" hint="Ask max pour entrer — cheapness (défaut 0.22).">
          <NumberInput value={props.form().repricingPEntryMax} min={0.01} max={1} step={0.01} onInput={(v) => props.update("repricingPEntryMax", v)} />
        </Field>
        <Field label="Edge min" hint="Edge estimé minimum après fees/slip (défaut 0.025).">
          <NumberInput value={props.form().repricingEdgeMin} min={0} max={1} step={0.005} onInput={(v) => props.update("repricingEdgeMin", v)} />
        </Field>
        <Field label="Order size (USDC)" hint="Budget FOK à l'entrée (défaut 15).">
          <NumberInput value={props.form().repricingOrderUsdc} min={0.1} step={0.1} onInput={(v) => props.update("repricingOrderUsdc", v)} />
        </Field>
        <Field label="Dislocation min" hint="Z-score min vs historique CLOB (défaut 1.0).">
          <NumberInput value={props.form().repricingDislocationMin} min={0.1} step={0.1} onInput={(v) => props.update("repricingDislocationMin", v)} />
        </Field>
        <Field label="History window (ms)" hint="Fenêtre historique ask CLOB (défaut 15000).">
          <NumberInput value={props.form().repricingHistoryWindowMs} min={1000} step={500} onInput={(v) => props.update("repricingHistoryWindowMs", v)} />
        </Field>
        <Field label="Feed max age (ms)" hint="Âge max du book / signal (défaut 250).">
          <NumberInput value={props.form().repricingFeedMaxAgeMs} min={50} step={10} onInput={(v) => props.update("repricingFeedMaxAgeMs", v)} />
        </Field>
        <Field label="Signal TTL (ms)" hint="Durée de vie du signal (défaut 3000).">
          <NumberInput value={props.form().repricingSignalTtlMs} min={100} step={100} onInput={(v) => props.update("repricingSignalTtlMs", v)} />
        </Field>
      </div>
      <h5 style={{ "margin-top": "0.75rem" }}>Sortie (bid)</h5>
      <div class="cfg-grid">
        <Field label="Target abs" hint="Take-profit absolu en prix (défaut 0.06).">
          <NumberInput value={props.form().repricingTargetAbs} min={0.01} max={1} step={0.01} onInput={(v) => props.update("repricingTargetAbs", v)} />
        </Field>
        <Field label="Target rel" hint="Take-profit relatif (0 = off, défaut 0).">
          <NumberInput value={props.form().repricingTargetRel} min={0} max={5} step={0.05} onInput={(v) => props.update("repricingTargetRel", v)} />
        </Field>
        <Field label="Stop abs" hint="Stop-loss absolu (défaut 0.08).">
          <NumberInput value={props.form().repricingStopAbs} min={0.01} max={1} step={0.01} onInput={(v) => props.update("repricingStopAbs", v)} />
        </Field>
        <Field label="Hold max (sec)" hint="Time-stop (défaut 120).">
          <NumberInput value={props.form().repricingHoldMaxSec} min={1} step={1} onInput={(v) => props.update("repricingHoldMaxSec", v)} />
        </Field>
        <Field label="Tau force exit (sec)" hint="Force exit si tau < N (défaut 25, < tau min).">
          <NumberInput value={props.form().repricingTauForceExitSec} min={1} max={900} step={1} onInput={(v) => props.update("repricingTauForceExitSec", v)} />
        </Field>
        <Field label="Spread max exit" hint="Spread max pour tenter une exit (défaut 0.05).">
          <NumberInput value={props.form().repricingSpreadMaxExit} min={0} max={0.5} step={0.005} onInput={(v) => props.update("repricingSpreadMaxExit", v)} />
        </Field>
        <Field label="Late window (sec)" hint="Fenêtre tardive avant close (défaut 45).">
          <NumberInput value={props.form().repricingLateWindowSec} min={1} step={1} onInput={(v) => props.update("repricingLateWindowSec", v)} />
        </Field>
      </div>
      <h5 style={{ "margin-top": "0.75rem" }}>Risque / mode A</h5>
      <div class="cfg-grid">
        <Field label="Mode A" hint="Reversion mode A optionnel (défaut off).">
          <select
            class="cfg-input"
            value={props.form().repricingModeAEnabled ? "on" : "off"}
            onChange={(e) =>
              props.update("repricingModeAEnabled", e.currentTarget.value === "on")
            }
          >
            <option value="off">Off (mode C seul)</option>
            <option value="on">On (mode A + C)</option>
          </select>
        </Field>
        <Field label="Notional max / market" hint="Plafond notionnel USDC par marché (défaut 30).">
          <NumberInput value={props.form().repricingNotionalMaxPerMarket} min={0.1} step={1} onInput={(v) => props.update("repricingNotionalMaxPerMarket", v)} />
        </Field>
        <Field label="Fees roundtrip" hint="Frais aller-retour estimés (défaut 0.002).">
          <NumberInput value={props.form().repricingFeesRoundtrip} min={0} max={0.1} step={0.001} onInput={(v) => props.update("repricingFeesRoundtrip", v)} />
        </Field>
        <Field label="Slip entry buffer" hint="Buffer slippage entrée (défaut 0.005).">
          <NumberInput value={props.form().repricingSlipEntryBuffer} min={0} max={0.1} step={0.001} onInput={(v) => props.update("repricingSlipEntryBuffer", v)} />
        </Field>
        <Field label="Slip exit buffer" hint="Buffer slippage sortie (défaut 0.005).">
          <NumberInput value={props.form().repricingSlipExitBuffer} min={0} max={0.1} step={0.001} onInput={(v) => props.update("repricingSlipExitBuffer", v)} />
        </Field>
      </div>
      <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
        Risque / exposition globale : onglet Risque (max shares, max exposure).
        Fenêtre de trading : onglet Fenêtre.
      </p>
    </div>
  );
}
