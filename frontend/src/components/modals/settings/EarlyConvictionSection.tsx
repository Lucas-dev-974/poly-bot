import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function EarlyConvictionSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée early-conviction</h4>
      <p class="cfg-section__desc">
        Stratégie la plus simple, sans mémoire : un marché qui se fixe{" "}
        <strong>instantanément</strong> est un trend unilatéral. On achète le{" "}
        <strong>favori</strong> (0.60-0.80) dès les 45 premières secondes,
        hold jusqu&apos;à la résolution — pas de hedge, aucun état de flip à
        tracker. Backtest calibré : +$330, WR 67.6 %, DD $82 le plus bas.
        t-stat 1.93 : sous le seuil 2.0, signal prometteur mais moins établi.
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask favori min"
          hint="Seuil de conviction (défaut 0.60). Ne pas baisser à 0.55 : le même achat à 0.55 s'effondre (WR 55 %, -202)."
        >
          <NumberInput
            value={props.form().earlyConvictionAskMin}
            min={0.5}
            max={0.9}
            step={0.01}
            onInput={(v) => props.update("earlyConvictionAskMin", v)}
          />
        </Field>
        <Field
          label="Ask favori max"
          hint="Borne haute (défaut 0.80). Au-delà, la certitude est déjà payée trop cher (EV négative)."
        >
          <NumberInput
            value={props.form().earlyConvictionAskMax}
            min={0.55}
            max={0.95}
            step={0.01}
            onInput={(v) => props.update("earlyConvictionAskMax", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec)"
          hint="Fenêtre de détection : [0, N] secondes (défaut 45). Au-delà, l'entrée appartient à d'autres moteurs (fav-band, dip-revert)."
        >
          <NumberInput
            value={props.form().earlyConvictionMaxElapsedSec}
            min={1}
            max={900}
            step={1}
            onInput={(v) => props.update("earlyConvictionMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du favori à l'entrée (défaut 0.05). Liquidité."
        >
          <NumberInput
            value={props.form().earlyConvictionMaxSpread}
            min={0}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("earlyConvictionMaxSpread", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le favori (défaut 15)."
        >
          <NumberInput
            value={props.form().earlyConvictionOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("earlyConvictionOrderUsdc", v)}
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
