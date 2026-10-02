import type { JSX } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function AntiflipSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée antiflip-revert</h4>
      <p class="cfg-section__desc">
        Stratégie directionnelle de sur-réaction : quand le favori{" "}
        <strong>FLIPPE</strong> (identité du leader inversée), le marché
        sur-réagit. On achète l&apos;<strong>ANCIEN favori</strong> (le déchu)
        dans les 90s suivant le flip, hold jusqu&apos;à la résolution — pas de
        hedge. Le flip doit être frais et le nouveau favori incertain
        (0.45-0.65). Backtest calibré : +$623, WR 52.2 %, t-stat 2.74.
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask déchu min"
          hint="Borne basse de la bande d'entrée du favori déchu (défaut 0.35)."
        >
          <NumberInput
            value={props.form().antiflipBandMin}
            min={0.2}
            max={0.6}
            step={0.01}
            onInput={(v) => props.update("antiflipBandMin", v)}
          />
        </Field>
        <Field
          label="Ask déchu max"
          hint="Borne haute (défaut 0.45). Au-delà, le déchu n'est pas assez replacé : pas de sur-réaction à capter."
        >
          <NumberInput
            value={props.form().antiflipBandMax}
            min={0.25}
            max={0.65}
            step={0.01}
            onInput={(v) => props.update("antiflipBandMax", v)}
          />
        </Field>
        <Field
          label="Floor déchu (opt)"
          hint="Plancher de prix du déchu (défaut 0.40). Vide = désactivé. Évite d'acheter des loteries à 0.20 qui ne rebondissent pas."
        >
          <NumberInput
            value={props.form().antiflipDeposedAskMin}
            min={0.05}
            max={0.6}
            step={0.01}
            onInput={(v) => props.update("antiflipDeposedAskMin", v)}
          />
        </Field>
        <Field
          label="Flip lookback (ms)"
          hint="Fenêtre max depuis le flip pour entrer (défaut 90000 = 90s). Au-delà, le marché a digéré le retournement : l'edge disparaît."
        >
          <NumberInput
            value={props.form().antiflipFlipLookbackMs}
            min={1000}
            max={300000}
            step={1000}
            onInput={(v) => props.update("antiflipFlipLookbackMs", v)}
          />
        </Field>
        <Field
          label="Min elapsed (sec)"
          hint="Le flip doit survenir après N secondes de fenêtre (défaut 240). Les flips précoces appartiennent à flip-confirm."
        >
          <NumberInput
            value={props.form().antiflipMinElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("antiflipMinElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec, opt)"
          hint="Vide = jusqu'à la close / minutesBeforeClose."
        >
          <NumberInput
            value={props.form().antiflipMaxElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("antiflipMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max spread"
          hint="Spread max du token déchu à l'entrée (défaut 0.05). Liquidité."
        >
          <NumberInput
            value={props.form().antiflipMaxSpread}
            min={0}
            max={0.2}
            step={0.005}
            onInput={(v) => props.update("antiflipMaxSpread", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le déchu (défaut 15). Taille = budget / ask, plafonnée par max shares. WR 52% : variance par trade élevée, sizing prudent."
        >
          <NumberInput
            value={props.form().antiflipOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("antiflipOrderUsdc", v)}
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
