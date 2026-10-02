import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Field, NumberInput } from "./SettingsFields";
import type { ConfigFormState } from "../../../utils/configForm";
import type { SettingsFormUpdate } from "./settingsSectionProps";

export function FavSection(props: {
  form: () => ConfigFormState;
  update: SettingsFormUpdate;
}): JSX.Element {
  return (
    <div class="cfg-section">
      <h4>Entrée fav-band</h4>
      <p class="cfg-section__desc">
        Stratégie directionnelle : FOK buy du <strong>favori</strong> quand son ask
        est dans la bande calibrée, après un délai minimum dans la fenêtre.
        Pas de hedge — hold jusqu&apos;à résolution. Distinct de ask-lock (arb)
        et de edge-lead (pas de confirm / pas de jambe cheap).
      </p>
      <div class="cfg-grid">
        <Field
          label="Ask favori min"
          hint="Borne basse de la bande d&apos;entrée (défaut 0.70). En dessous : trop cher en risque / hors edge empirique."
        >
          <NumberInput
            value={props.form().favBandAskMin}
            min={0.5}
            max={0.95}
            step={0.01}
            onInput={(v) => props.update("favBandAskMin", v)}
          />
        </Field>
        <Field
          label="Ask favori max"
          hint="Borne haute (défaut 0.85). Au-dessus : favoris « sûrs » souvent surcotés (EV négative en backtest)."
        >
          <NumberInput
            value={props.form().favBandAskMax}
            min={0.55}
            max={0.99}
            step={0.01}
            onInput={(v) => props.update("favBandAskMax", v)}
          />
        </Field>
        <Field
          label="Min elapsed (sec)"
          hint="Attendre N secondes depuis le début de la fenêtre 15m avant d&apos;entrer (défaut 200)."
        >
          <NumberInput
            value={props.form().favBandMinElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("favBandMinElapsedSec", v)}
          />
        </Field>
        <Field
          label="Max elapsed (sec, opt)"
          hint="Vide = jusqu&apos;à la close / minutesBeforeClose. Sinon coupe les entrées trop tardives."
        >
          <NumberInput
            value={props.form().favBandMaxElapsedSec}
            min={0}
            max={900}
            step={1}
            onInput={(v) => props.update("favBandMaxElapsedSec", v)}
          />
        </Field>
        <Field
          label="Order size (USDC)"
          hint="Budget FOK sur le favori. Taille = budget / ask, plafonnée par max shares."
        >
          <NumberInput
            value={props.form().favBandOrderUsdc}
            min={0.1}
            step={0.1}
            onInput={(v) => props.update("favBandOrderUsdc", v)}
          />
        </Field>
      </div>
      <div class="cfg-section" style={{ "margin-top": "1rem" }}>
        <h4>Hedge inverse (optionnel)</h4>
        <p class="cfg-section__desc">
          Après le fill du favori, un <strong>GTC reposé</strong> est posté à la
          limite sur le token <strong>opposé</strong>. Il se remplit
          <strong> incrémentalement</strong> quand l&apos;ask de l&apos;inverse
          descend à la limite (fills partiels persistants, jamais annulé).
          Exemple : favori acheté 0.70 → GTC à 0.20 sur l&apos;inverse pour
          2× les shares du favori.
        </p>
        <div class="cfg-grid">
          <label class="cfg-check" title="Active la jambe inverse (GTC reposé sur le token opposé).">
            <input
              type="checkbox"
              checked={props.form().favBandInverseEnabled}
              onChange={(e) => props.update("favBandInverseEnabled", e.currentTarget.checked)}
            />
            <span>Hedge inverse activé</span>
          </label>
          <Show when={props.form().favBandInverseEnabled}>
            <Field
              label="Limite GTC inverse"
              hint="Prix de pose du GTC sur le token opposé (défaut 0.20). Ne se remplit que si l'ask inverse descend à ce niveau."
            >
              <NumberInput
                value={props.form().favBandInverseAskMax}
                min={0.01}
                max={0.49}
                step={0.01}
                onInput={(v) => props.update("favBandInverseAskMax", v)}
              />
            </Field>
            <Field
              label="Ratio shares inverse"
              hint="Shares de l'inverse par share du favori fillé (défaut 2 = le double). Plafonné par le budget et max shares."
            >
              <NumberInput
                value={props.form().favBandInverseShareRatio}
                min={0.1}
                step={0.1}
                onInput={(v) => props.update("favBandInverseShareRatio", v)}
              />
            </Field>
            <Field
              label="Budget inverse (USDC)"
              hint="Plafond USDC de l'ordre GTC inverse (défaut 15). Doit permettre ≥ 5 shares au pire prix."
            >
              <NumberInput
                value={props.form().favBandInverseOrderUsdc}
                min={0.1}
                step={0.1}
                onInput={(v) => props.update("favBandInverseOrderUsdc", v)}
              />
            </Field>
          </Show>
        </div>
      </div>

      <div class="cfg-section" style={{ "margin-top": "1rem" }}>
        <h4>Filtre whipsaw</h4>
        <p class="cfg-section__desc">
          Détection de régime agité (flips du favori, range d&apos;ask, série de pertes).
          Backtest BTC 15m : la <strong>pause après pertes</strong> aide le drawdown ;
          les gates score/flips en dur baissent souvent le PnL — laisse-les vides sauf besoin.
        </p>
        <div class="cfg-grid">
          <label class="cfg-check" title="Active pause / score / flips sur les entrées fav-band.">
            <input
              type="checkbox"
              checked={props.form().favBandWhipsawEnabled}
              onChange={(e) => props.update("favBandWhipsawEnabled", e.currentTarget.checked)}
            />
            <span>Filtre whipsaw activé</span>
          </label>
          <Show when={props.form().favBandWhipsawEnabled}>
            <Field
              label="Pause après N pertes"
              hint="Après N lost d'affilée, skip les prochaines fenêtres (vide = pause off). Défaut recherche : 3."
            >
              <NumberInput
                value={props.form().favBandWhipsawPauseAfterLosses}
                min={1}
                max={20}
                step={1}
                onInput={(v) => props.update("favBandWhipsawPauseAfterLosses", v)}
              />
            </Field>
            <Field
              label="Fenêtres de pause"
              hint="Cooldownree de pause = N x 15 min (horloge), defaut 8. Independant du multi-marches."
            >
              <NumberInput
                value={props.form().favBandWhipsawPauseWindows}
                min={1}
                max={48}
                step={1}
                onInput={(v) => props.update("favBandWhipsawPauseWindows", v)}
              />
            </Field>
            <Field
              label="Score max (0–100)"
              hint="Skip si score ≥ seuil. Vide = gate off (recommandé)."
            >
              <NumberInput
                value={props.form().favBandWhipsawMaxScore}
                min={0}
                max={100}
                step={1}
                onInput={(v) => props.update("favBandWhipsawMaxScore", v)}
              />
            </Field>
            <Field
              label="Max flips intra-fenêtre"
              hint="Skip si flips favori ≥ N dans la fenêtre. Vide = gate off (recommandé)."
            >
              <NumberInput
                value={props.form().favBandWhipsawMaxIntraFlips}
                min={1}
                max={20}
                step={1}
                onInput={(v) => props.update("favBandWhipsawMaxIntraFlips", v)}
              />
            </Field>
          </Show>
        </div>
      </div>

      <div class="cfg-section" style={{ "margin-top": "1rem" }}>
        <h4>Filtre imbalance carnet</h4>
        <p class="cfg-section__desc">
          Avant chaque entrée fav-band, vérifie la <strong>pression du carnet fusionné</strong>{" "}
          (bids Up + asks Down vs asks Up + bids Down, 3 niveaux, signée vers le favori acheté).
          Entrée autorisée seulement si la pression reste au-dessus du plancher pendant N ticks
          consécutifs — évite les pièges « prix qui tient, carnet qui déserte ». Backtest BTC 15m :
          plancher −0.1 / 2 ticks → PnL +9.7&nbsp;%, drawdown −17&nbsp;%.
        </p>
        <div class="cfg-grid">
          <label class="cfg-check" title="Vérifie la pression du carnet fusionné avant chaque entrée fav-band.">
            <input
              type="checkbox"
              checked={props.form().favBandImbalanceEnabled}
              onChange={(e) => props.update("favBandImbalanceEnabled", e.currentTarget.checked)}
            />
            <span>Filtre imbalance activé</span>
          </label>
          <Show when={props.form().favBandImbalanceEnabled}>
            <Field
              label="Plancher cross (−1..1)"
              hint="Entrée seulement si pression croisée ≥ plancher aux N derniers ticks. Recommandation recherche : −0.1."
            >
              <NumberInput
                value={props.form().favBandImbalanceCrossMin}
                min={-0.99}
                max={0.99}
                step={0.05}
                onInput={(v) => props.update("favBandImbalanceCrossMin", v)}
              />
            </Field>
            <Field
              label="Ticks de persistance"
              hint="Nombre de mesures consécutives au-dessus du plancher requises (vide = défaut 2). 1 tick = vulnérable au spoofing."
            >
              <NumberInput
                value={props.form().favBandImbalanceTicks}
                min={1}
                max={10}
                step={1}
                onInput={(v) => props.update("favBandImbalanceTicks", v)}
              />
            </Field>
            <Field
              label="Spread max favori (optionnel)"
              hint="Skip si spread L1 du favori ≥ ce seuil (vide = off). Ex : 0.04. Complète le filtre anti-carnet-troué."
            >
              <NumberInput
                value={props.form().favBandImbalanceMaxSpread}
                min={0.01}
                max={0.2}
                step={0.01}
                onInput={(v) => props.update("favBandImbalanceMaxSpread", v)}
              />
            </Field>
          </Show>
        </div>
      </div>

      <div class="cfg-section" style={{ "margin-top": "1rem" }}>
        <h4>Sortie dégradation (optionnelle)</h4>
        <p class="cfg-section__desc">
          Après le fill, si le favori <strong>détenu</strong> imprime une séquence de
          <strong>plus-bas confirmés</strong> (swing ≥ min, figé par un rebond — pas un
          50&nbsp;% figé : le retracement est borné, un waterfall se confirme au tick),
          la position est <strong>vendue en FOK au bid</strong> au lieu d&apos;être tenue
          jusqu&apos;à la résolution. Reprise au-dessus du plus-haut de structure =
          reset. Option : acheter le token <strong>inverse</strong> juste après (switch).
        </p>
        <div class="cfg-grid">
          <label class="cfg-check" title="Vend la position quand le favori détenu imprime N plus-bas de plus en plus bas.">
            <input
              type="checkbox"
              checked={props.form().favBandExitEnabled}
              onChange={(e) => props.update("favBandExitEnabled", e.currentTarget.checked)}
            />
            <span>Sortie dégradation activée</span>
          </label>
          <Show when={props.form().favBandExitEnabled}>
            <Field
              label="Swing min (plus-bas)"
              hint="Amplitude minimum d'une jambe pour figer un plus-bas (défaut 0.05 = 5¢). En dessous = bruit de carnet."
            >
              <NumberInput
                value={props.form().favBandExitMinLowerHighDrop}
                min={0.005}
                step={0.005}
                onInput={(v) => props.update("favBandExitMinLowerHighDrop", v)}
              />
            </Field>
            <Field
              label="Retracement de confirmation"
              hint="Part de la chute à remonter pour figer le plus-bas (0.50 = 50 %, défaut 0.25). Borné à [1 tick, swing min] : un gros dump n'attend pas un retrace Fibonacci. 0 = n'importe quel tick de rebond. Un plus-bas suivant (sous le précédent) se confirme dès 1 tick."
            >
              <NumberInput
                value={props.form().favBandExitRetraceRatio}
                min={0}
                max={1}
                step={0.05}
                onInput={(v) => props.update("favBandExitRetraceRatio", v)}
              />
            </Field>
            <Field
              label="Plus-bas consécutifs"
              hint="Nombre de plus-bas de plus en plus bas avant de sortir (défaut 3)."
            >
              <NumberInput
                value={props.form().favBandExitConsecutive}
                min={2}
                max={10}
                step={1}
                onInput={(v) => props.update("favBandExitConsecutive", v)}
              />
            </Field>
            <Field
              label="Lookback (ms)"
              hint="Fenêtre glissante : la séquence de plus-bas doit rester récente (défaut 120000 = 120 s). Sans nouveau plus-bas dans la fenêtre, le compteur est réinitialisé."
            >
              <NumberInput
                value={props.form().favBandExitLookbackMs}
                min={5000}
                step={1000}
                onInput={(v) => props.update("favBandExitLookbackMs", v)}
              />
            </Field>
            <Field
              label="Min elapsed (sec)"
              hint="Ne sortir qu'après N secondes de fenêtre (0 = toujours actif)."
            >
              <NumberInput
                value={props.form().favBandExitMinElapsedSec}
                min={0}
                max={900}
                step={1}
                onInput={(v) => props.update("favBandExitMinElapsedSec", v)}
              />
            </Field>
            <label class="cfg-check" title="Ne sort que si l'ask détenu est sous le prix d'entrée (une sortie au-dessus = gain, pas une dégradation).">
              <input
                type="checkbox"
                checked={props.form().favBandExitLossOnly}
                onChange={(e) => props.update("favBandExitLossOnly", e.currentTarget.checked)}
              />
              <span>Uniquement en perte</span>
            </label>
            <label class="cfg-check" title="Juste après la vente de sortie, FOK buy du token opposé à son ask courant (switch de côté).">
              <input
                type="checkbox"
                checked={props.form().favBandExitSwitchEnabled}
                onChange={(e) => props.update("favBandExitSwitchEnabled", e.currentTarget.checked)}
              />
              <span>Acheter l&apos;inverse après la sortie</span>
            </label>
            <Show when={props.form().favBandExitSwitchEnabled}>
              <Field
                label="Budget switch (USDC)"
                hint="Plafond USDC du FOK sur le token opposé (défaut 15). Requiert max positions par côté ≥ 2 (onglet Risque)."
              >
                <NumberInput
                  value={props.form().favBandExitSwitchOrderUsdc}
                  min={0.1}
                  step={0.1}
                  onInput={(v) => props.update("favBandExitSwitchOrderUsdc", v)}
                />
              </Field>
            </Show>
          </Show>
        </div>
      </div>
      <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
        Risque / exposition : onglet Risque (max shares, max exposure).
        Fenêtre de trading : onglet Fenêtre.
      </p>
    </div>
  );
}
