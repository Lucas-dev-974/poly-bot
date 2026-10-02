import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function CheapSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Jambe cheap (underdog)</h4>
      <p class="cfg-section__desc">
        {props.form().strategyId === "reverse"
          ? "Grille de limit BUY maker sur l'underdog, un niveau par tick dans [cheap min, cheap max]. Chaque niveau est indépendant du hedge."
          : "Un seul bid GTC maker à min(bestAsk, cheapBuyMax, pairLockMax − hedge). Après fill, le hedge utilise le prix fillé (pas ce bid) : si fillPrice + hedge > pairLockMax, pas de hedge — le cheap reste directionnel."}
      </p>
      <div class="cfg-grid">
        <Field
          label="Cheap min"
          hint="Ne pas lifter un ask déjà sous ce plancher"
        >
          <NumberInput
            value={props.form().cheapBuyMin}
            min={0.01}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("cheapBuyMin", v)}
          />
        </Field>
        <Field
          label="Cheap max"
          hint="Plafond du bid ; le lock peut le caler plus bas"
        >
          <NumberInput
            value={props.form().cheapBuyMax}
            min={0.01}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("cheapBuyMax", v)}
          />
        </Field>
        <Field
          label="Cheap order (USDC)"
          hint={
            props.form().strategyId === "barbell"
              ? "Budget par ordre cheap (barbell)"
              : props.form().strategyId === "reverse"
                ? "Budget par ordre cheap (reverse)"
                : "Budget par ordre cheap (arb)"
          }
        >
          <NumberInput
            value={
              props.form().strategyId === "barbell"
                ? props.form().barbellCheapOrderUsdc
                : props.form().strategyId === "reverse"
                  ? props.form().reverseCheapOrderUsdc
                  : props.form().cheapOrderUsdc
            }
            min={0.1}
            step={0.1}
            onInput={(v) =>
              props.update(
                props.form().strategyId === "barbell"
                  ? "barbellCheapOrderUsdc"
                  : props.form().strategyId === "reverse"
                    ? "reverseCheapOrderUsdc"
                    : "cheapOrderUsdc",
                v,
              )
            }
          />
        </Field>
        <Show when={props.form().strategyId === "arb" || props.form().strategyId.startsWith("custom:")}>
          <Field
            label="Pair lock max"
            hint="Entrée : bid + hedge ≤ lock. Après fill : fillPrice + hedge ≤ lock, sinon pas de hedge (0.90–0.99)"
          >
            <NumberInput
              value={props.form().pairLockMax}
              min={0.90}
              max={0.99}
              step={0.01}
              onInput={(v) => props.update("pairLockMax", v)}
            />
          </Field>
          <Field
            label="Ask-lock dual-FOK"
            hint="N'entrer que si ask_cheap + ask_expensive ≤ lock ; prend les deux asks en FOK (pas de jambe maker seule)."
          >
            <label class="cfg-check">
              <input
                type="checkbox"
                checked={props.form().arbAskLockOnly}
                onChange={(e) => props.update("arbAskLockOnly", e.currentTarget.checked)}
              />
              Activer ask-lock
            </label>
          </Field>
          <Show when={props.form().arbAskLockOnly}>
            <Field
              label="Ask-sum max (optionnel)"
              hint="Plafond ask+ask plus serre que pairLockMax. Vide = pairLockMax."
            >
              <NumberInput
                value={props.form().arbAskSumMax}
                min={0.90}
                max={0.99}
                step={0.01}
                onInput={(v) => props.update("arbAskSumMax", v)}
              />
            </Field>
            <Field
              label="Min elapsed sec"
              hint="N entrer qu apres N secondes depuis windowStart. Vide = off."
            >
              <NumberInput
                value={props.form().arbAskLockMinElapsedSec}
                min={0}
                max={900}
                step={1}
                onInput={(v) => props.update("arbAskLockMinElapsedSec", v)}
              />
            </Field>
            <Field
              label="Max imbalance"
              hint="Skip si |ask_c - ask_e| > seuil. Vide = off."
            >
              <NumberInput
                value={props.form().arbAskLockMaxImbalance}
                min={0}
                max={1}
                step={0.01}
                onInput={(v) => props.update("arbAskLockMaxImbalance", v)}
              />
            </Field>
          </Show>
        </Show>
      </div>
    </div>
  );
}
