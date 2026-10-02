import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Field, NumberInput, Toggle } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function HedgeSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Jambe hedge (favorite)</h4>
      <p class="cfg-section__desc">
        {props.form().strategyId === "reverse"
          ? "Grille de limit BUY maker sur le favori, posée en même temps que le cheap (pas après fill). Niveaux dans [hedge min, hedge max], budget par niveau."
          : props.form().strategyId === "barbell"
            ? "Hedge au ratio cheap/hedge uniquement après un cheap rempli, si l'ask favori est dans [hedgeMin, hedgeMax]. Pas de verrou de profit — variance plus élevée."
            : "Hedge 1:1 uniquement après un cheap rempli, si l'ask favori est dans [hedgeMin, hedgeMax] et si fillPrice + min(ask, hedgeMax) ≤ pairLockMax. La bande est nécessaire, pas suffisante."}
      </p>
      <div class="cfg-grid">
        <Field
          label="Hedge min"
          hint="Ask favori minimum. En dessous : pas un hedge ; cheap resting annulé ; cheap fillé non dumpé"
        >
          <NumberInput
            value={props.form().expensiveBuyMin}
            min={0.01}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("expensiveBuyMin", v)}
          />
        </Field>
        <Field
          label="Hedge max"
          hint="Ask favori maximum. Au-dessus : pas de nouveau cheap ; cheap nu vendu (FOK SELL)"
        >
          <NumberInput
            value={props.form().expensiveBuyMax}
            min={0.01}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("expensiveBuyMax", v)}
          />
        </Field>
        <Field
          label="Plafond hedge (USDC)"
          hint={
            props.form().strategyId === "reverse"
              ? "Budget USDC par niveau de la grille favori (indépendant du cheap)."
              : "Cap secondaire. Taille = 1:1 du cheap rempli non couvert. Sous 5 parts au prix hedge (≈ 4.75 USDC à 0.95) : aucun hedge. Trop petit = paire partielle"
          }
        >
          <NumberInput
            value={props.form().expensiveOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("expensiveOrderUsdc", v)}
          />
        </Field>
        <Field
          label="Type d'ordre hedge"
          hint={
            props.form().strategyId === "reverse"
              ? "GTC : grille maker posée avec le cheap, sans attendre un fill. FOK = taker immédiat (peu adapté au reverse)."
              : "FOK et GTC : seulement après fill cheap. FOK = taker immédiat ; GTC = restant au min(ask, hedgeMax)"
          }
        >
          <select
            class="cfg-input"
            value={props.form().expensiveOrderType}
            onChange={(e) =>
              props.update("expensiveOrderType", e.currentTarget.value as "FOK" | "GTC")
            }
          >
            <option value="FOK">FOK — Fill or Kill</option>
            <option value="GTC">GTC — Good Till Cancelled</option>
          </select>
        </Field>
        <Show when={props.form().strategyId === "barbell"}>
          <Field
            label="Ratio hedge"
            hint="Parts hedge ciblées = cheap rempli × ratio. (0, 1]. Défaut 0.5."
          >
            <NumberInput
              value={props.form().barbellHedgeRatio}
              min={0.01}
              max={1}
              step={0.05}
              onInput={(v) => props.update("barbellHedgeRatio", v)}
            />
          </Field>
        </Show>
      </div>
      <div class="cfg-divider" />
      <Show when={props.form().strategyId !== "arb" && props.form().strategyId !== "fav-band"}>
        <Toggle
          label="Activer le hedge expensive"
          hint="Désactivé : cheap = directionnel. Activé : hedge après fill (barbell/reverse)."
          checked={props.form().enableExpensiveHedge}
          onChange={(v) => props.update("enableExpensiveHedge", v)}
        />
      </Show><Show when={props.form().strategyId === "reverse"}>
        <Toggle
          label="Expensive après cheap fill"
          hint="N'émettre / placer un ordre expensive qu'après qu'au moins un cheap de la paire a été fillé."
          checked={props.form().requireCheapFillBeforeExpensive}
          onChange={(v) => props.update("requireCheapFillBeforeExpensive", v)}
        />
        <div class="cfg-divider" />
        <p class="cfg-section__desc">
          Phase 2 — contrôles de risque reverse (désactivés par défaut).
        </p>
        <Toggle
          label="Cancel cheap hors bande"
          hint="Annule les GTC cheap resting si l'ask underdog sort de [cheapBuyMin, cheapBuyMax]."
          checked={props.form().reverseCancelCheapOffBand}
          onChange={(v) => props.update("reverseCancelCheapOffBand", v)}
        />
        <Toggle
          label="Défense cheap si favori hors max"
          hint="FOK SELL du cheap non couvert quand l'ask favori dépasse expensiveBuyMax."
          checked={props.form().reverseDefendEnabled}
          onChange={(v) => props.update("reverseDefendEnabled", v)}
        />
        <Toggle
          label="Cap hedge ≤ cheap fillé"
          hint="Le cumul des tailles hedge ne dépasse pas filledCheap − filledExpensive."
          checked={props.form().reverseHedgeCapToFilledCheap}
          onChange={(v) => props.update("reverseHedgeCapToFilledCheap", v)}
        />
        <Field
          label="Max niveaux grille"
          hint="Nombre max de niveaux maker par jambe. Vide = illimité."
        >
          <NumberInput
            value={props.form().reverseMaxGridLevels}
            min={1}
            step={1}
            onInput={(v) => props.update("reverseMaxGridLevels", v)}
          />
        </Field>
      </Show>

    </div>
  );
}
