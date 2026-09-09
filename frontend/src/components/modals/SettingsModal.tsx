import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { setConfig } from "../../stores/botStore";
import type { BotConfig } from "../../types";
import {
  configToForm,
  formToPatch,
  formsEqual,
  validateConfigForm,
  type ConfigFormState,
} from "../../utils/configForm";

/* ---------- petits composants de champ ---------- */

function Field(props: {
  label: string;
  hint?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="cfg-field">
      <span class="cfg-field__label">{props.label}</span>
      {props.children}
      <Show when={props.hint}>
        <span class="cfg-field__hint">{props.hint}</span>
      </Show>
    </label>
  );
}

/** Interrupteur (toggle) pour les booléens. */
function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label class="cfg-toggle">
      <span class="cfg-toggle__text">
        <span class="cfg-toggle__label">{props.label}</span>
        <Show when={props.hint}>
          <span class="cfg-toggle__hint">{props.hint}</span>
        </Show>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        class={`cfg-switch${props.checked ? " cfg-switch--on" : ""}`}
        onClick={() => props.onChange(!props.checked)}
      >
        <span class="cfg-switch__knob" />
      </button>
    </label>
  );
}

function NumberInput(props: {
  value: string;
  min?: number;
  max?: number;
  step?: number;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <input
      class="cfg-input"
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
}

/* ---------- définition des sections ---------- */

type SectionId = "markets" | "cheap" | "hedge" | "risk" | "window" | "sim";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  desc: string;
}

const SECTIONS: SectionDef[] = [
  { id: "markets", label: "Marchés", icon: "◉", desc: "Marchés surveillés et cadence de scan" },
  { id: "cheap", label: "Jambe cheap", icon: "▾", desc: "Bid maker underdog et verrou de paire" },
  { id: "hedge", label: "Jambe hedge", icon: "▴", desc: "Hedge 1:1 après fill cheap" },
  { id: "risk", label: "Risque", icon: "◆", desc: "Limites de taille, positions et exposition" },
  { id: "window", label: "Fenêtre", icon: "◷", desc: "Plage de trading avant clôture" },
  { id: "sim", label: "Simulation", icon: "▦", desc: "Paramètres du dry-run" },
];

/* ---------- composant principal ---------- */

export function SettingsModal(props: {
  open: boolean;
  config: BotConfig;
  onClose: () => void;
  onSaved: () => void;
  onDirtyClose: () => void;
}): JSX.Element {
  const [form, setForm] = createSignal<ConfigFormState>(configToForm(props.config));
  const [baseline, setBaseline] = createSignal<ConfigFormState>(configToForm(props.config));
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [activeSection, setActiveSection] = createSignal<SectionId>("markets");

  createEffect(() => {
    if (props.open) {
      const next = configToForm(props.config);
      setForm(next);
      setBaseline(next);
      setSaveError(null);
      setActiveSection("markets");
    }
  });

  const errors = createMemo(() => validateConfigForm(form(), props.config.dryRun));
  const dirty = createMemo(() => !formsEqual(form(), baseline()));

  function update<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setSaveError(null);
  }

  function handleClose(): void {
    if (dirty()) {
      props.onDirtyClose();
      return;
    }
    props.onClose();
  }

  async function handleSave(): Promise<void> {
    if (errors().length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch = formToPatch(form(), props.config);
      if (Object.keys(patch).length === 0) {
        props.onClose();
        return;
      }
      const res = await api.updateConfig(patch);
      if (!res.ok || !res.config) {
        throw new Error(res.error || "Échec de la sauvegarde");
      }
      setConfig(res.config);
      const next = configToForm(res.config);
      setForm(next);
      setBaseline(next);
      props.onSaved();
      props.onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="modal-overlay"
        onClick={handleClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") handleClose();
        }}
      >
        <div class="modal cfg-modal" onClick={(e) => e.stopPropagation()}>
          {/* En-tête */}
          <header class="cfg-header">
            <div class="cfg-header__title">
              <h3>Configuration</h3>
              <span class="cfg-header__sub">
                {dirty() ? "Modifications non enregistrées" : "Enregistré dans data/bot-settings.json"}
              </span>
            </div>
            <button class="cfg-close" type="button" onClick={handleClose} aria-label="Fermer">
              ✕
            </button>
          </header>

          {/* Corps : sidebar + contenu */}
          <div class="cfg-body">
            <nav class="cfg-sidebar">
              <For each={SECTIONS}>
                {(s) => (
                  <Show when={!(s.id === "sim" && !props.config.dryRun)}>
                    <button
                      type="button"
                      class={`cfg-nav${activeSection() === s.id ? " cfg-nav--active" : ""}`}
                      onClick={() => setActiveSection(s.id)}
                    >
                      <span class="cfg-nav__icon">{s.icon}</span>
                      <span class="cfg-nav__text">
                        <span class="cfg-nav__label">{s.label}</span>
                        <span class="cfg-nav__desc">{s.desc}</span>
                      </span>
                    </button>
                  </Show>
                )}
              </For>
            </nav>

            <div class="cfg-content">
              {/* ---- Marchés ---- */}
              <Show when={activeSection() === "markets"}>
                <div class="cfg-section">
                  <h4>Marchés surveillés</h4>
                  <p class="cfg-section__desc">
                    Préfixes de slug Polymarket et intervalle de scan du CLOB.
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Préfixes de slug (CSV)"
                      hint="Ex. btc-updown-15m, eth-updown-15m"
                    >
                      <input
                        class="cfg-input"
                        type="text"
                        value={form().marketSlugPrefixes}
                        onInput={(e) => update("marketSlugPrefixes", e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Poll interval (ms)" hint="Minimum 500 ms">
                      <NumberInput
                        value={form().pollIntervalMs}
                        min={500}
                        step={100}
                        onInput={(v) => update("pollIntervalMs", v)}
                      />
                    </Field>
                  </div>
                </div>
              </Show>

              {/* ---- Jambe cheap ---- */}
              <Show when={activeSection() === "cheap"}>
                <div class="cfg-section">
                  <h4>Jambe cheap (underdog)</h4>
                  <p class="cfg-section__desc">
                    Un seul bid GTC maker à min(bestAsk, cheapBuyMax, pairLockMax − hedge).
                    Après fill, le hedge utilise le prix fillé (pas ce bid) : si
                    fillPrice + hedge &gt; pairLockMax, pas de hedge — le cheap reste
                    directionnel.
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Cheap min"
                      hint="Ne pas lifter un ask déjà sous ce plancher"
                    >
                      <NumberInput
                        value={form().cheapBuyMin}
                        min={0.01}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("cheapBuyMin", v)}
                      />
                    </Field>
                    <Field
                      label="Cheap max"
                      hint="Plafond du bid ; le lock peut le caler plus bas"
                    >
                      <NumberInput
                        value={form().cheapBuyMax}
                        min={0.01}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("cheapBuyMax", v)}
                      />
                    </Field>
                    <Field label="Cheap order (USDC)" hint="Budget par ordre cheap">
                      <NumberInput
                        value={form().cheapOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("cheapOrderUsdc", v)}
                      />
                    </Field>
                    <Field
                      label="Pair lock max"
                      hint="Entrée : bid + hedge ≤ lock. Après fill : fillPrice + hedge ≤ lock, sinon pas de hedge (0.90–0.99)"
                    >
                      <NumberInput
                        value={form().pairLockMax}
                        min={0.90}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("pairLockMax", v)}
                      />
                    </Field>
                  </div>
                </div>
              </Show>

              {/* ---- Jambe hedge ---- */}
              <Show when={activeSection() === "hedge"}>
                <div class="cfg-section">
                  <h4>Jambe hedge (favorite)</h4>
                  <p class="cfg-section__desc">
                    Hedge 1:1 uniquement après un cheap rempli, si l'ask favori est
                    dans <code>[hedgeMin, hedgeMax]</code> et si fillPrice + min(ask,
                    hedgeMax) ≤ pairLockMax. La bande est nécessaire, pas suffisante.
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Hedge min"
                      hint="Ask favori minimum. En dessous : pas un hedge ; cheap resting annulé ; cheap fillé non dumpé"
                    >
                      <NumberInput
                        value={form().expensiveBuyMin}
                        min={0.01}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("expensiveBuyMin", v)}
                      />
                    </Field>
                    <Field
                      label="Hedge max"
                      hint="Ask favori maximum. Au-dessus : pas de nouveau cheap ; cheap nu vendu (FOK SELL)"
                    >
                      <NumberInput
                        value={form().expensiveBuyMax}
                        min={0.01}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("expensiveBuyMax", v)}
                      />
                    </Field>
                    <Field
                      label="Plafond hedge (USDC)"
                      hint="Cap secondaire. Taille = 1:1 du cheap rempli non couvert. Sous 5 parts au prix hedge (≈ 4.75 USDC à 0.95) : aucun hedge. Trop petit = paire partielle"
                    >
                      <NumberInput
                        value={form().expensiveOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("expensiveOrderUsdc", v)}
                      />
                    </Field>
                    <Field
                      label="Type d'ordre hedge"
                      hint="FOK et GTC : seulement après fill cheap. FOK = taker immédiat ; GTC = restant au min(ask, hedgeMax)"
                    >
                      <select
                        class="cfg-input"
                        value={form().expensiveOrderType}
                        onChange={(e) =>
                          update("expensiveOrderType", e.currentTarget.value as "FOK" | "GTC")
                        }
                      >
                        <option value="FOK">FOK — Fill or Kill</option>
                        <option value="GTC">GTC — Good Till Cancelled</option>
                      </select>
                    </Field>
                  </div>
                  <div class="cfg-divider" />
                  <Toggle
                    label="Activer le hedge expensive"
                    hint="Désactivé : cheap = directionnel. Activé : cheap aussi directionnel si le lock n'est plus atteignable après fill."
                    checked={form().enableExpensiveHedge}
                    onChange={(v) => update("enableExpensiveHedge", v)}
                  />
                </div>
              </Show>

              {/* ---- Risque ---- */}
              <Show when={activeSection() === "risk"}>
                <div class="cfg-section">
                  <h4>Limites de risque</h4>
                  <p class="cfg-section__desc">
                    Plafonds de taille, de positions simultanées et d'exposition
                    globale pour contenir le risque.
                  </p>
                  <div class="cfg-grid">
                    <Field label="Max shares / ordre">
                      <NumberInput
                        value={form().maxSharesPerOrder}
                        min={1}
                        step={1}
                        onInput={(v) => update("maxSharesPerOrder", v)}
                      />
                    </Field>
                    <Field label="Max positions / côté" hint="Par market window">
                      <NumberInput
                        value={form().maxOpenPositionsPerSide}
                        min={1}
                        step={1}
                        onInput={(v) => update("maxOpenPositionsPerSide", v)}
                      />
                    </Field>
                    <Field label="Max exposition (USDC)" hint="Cap global fills + GTC resting">
                      <NumberInput
                        value={form().maxExposureUsdc}
                        min={1}
                        step={1}
                        onInput={(v) => update("maxExposureUsdc", v)}
                      />
                    </Field>
                  </div>
                </div>
              </Show>

              {/* ---- Fenêtre ---- */}
              <Show when={activeSection() === "window"}>
                <div class="cfg-section">
                  <h4>Fenêtre de trading</h4>
                  <p class="cfg-section__desc">
                    Restreint le trading à une plage de minutes avant la clôture du
                    marché 15m.
                  </p>
                  <div class="cfg-grid">
                    <Field label="Minutes avant clôture (min)">
                      <NumberInput
                        value={form().minutesBeforeCloseMin}
                        min={0}
                        max={15}
                        step={1}
                        onInput={(v) => update("minutesBeforeCloseMin", v)}
                      />
                    </Field>
                    <Field label="Minutes avant clôture (max)">
                      <NumberInput
                        value={form().minutesBeforeCloseMax}
                        min={0}
                        max={15}
                        step={1}
                        onInput={(v) => update("minutesBeforeCloseMax", v)}
                      />
                    </Field>
                    <Field
                      label="Ne pas acheter si &lt; X min restantes"
                      hint="Laisser vide pour désactiver"
                    >
                      <NumberInput
                        value={form().minMinutesBeforeCloseToBuy}
                        min={0}
                        max={15}
                        step={1}
                        onInput={(v) => update("minMinutesBeforeCloseToBuy", v)}
                      />
                    </Field>
                  </div>
                </div>
              </Show>

              {/* ---- Simulation ---- */}
              <Show when={activeSection() === "sim" && props.config.dryRun}>
                <div class="cfg-section">
                  <h4>Simulation (dry-run)</h4>
                  <p class="cfg-section__desc">
                    Paramètres du broker simulé. Ignorés en mode live.
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Capital simulé (USDC)"
                      hint="Appliqué au prochain reset DB"
                    >
                      <NumberInput
                        value={form().simulatedCapital}
                        min={1}
                        step={1}
                        onInput={(v) => update("simulatedCapital", v)}
                      />
                    </Field>
                    <Field label="Probabilité de fill (non marketable)">
                      <NumberInput
                        value={form().simFillProbabilityNonMarketable}
                        min={0}
                        max={1}
                        step={0.01}
                        onInput={(v) => update("simFillProbabilityNonMarketable", v)}
                      />
                    </Field>
                    <Field label="Délai résolution (s)">
                      <NumberInput
                        value={form().simResolveDelaySeconds}
                        min={0}
                        step={1}
                        onInput={(v) => update("simResolveDelaySeconds", v)}
                      />
                    </Field>
                    <Field label="Intervalle retry résolution (ms)">
                      <NumberInput
                        value={form().simResolveRetryIntervalMs}
                        min={500}
                        step={100}
                        onInput={(v) => update("simResolveRetryIntervalMs", v)}
                      />
                    </Field>
                    <Field label="Max retries résolution">
                      <NumberInput
                        value={form().simResolveMaxRetries}
                        min={0}
                        step={1}
                        onInput={(v) => update("simResolveMaxRetries", v)}
                      />
                    </Field>
                    <Field label="Max retry attempts">
                      <NumberInput
                        value={form().simMaxRetryAttempts}
                        min={1}
                        step={1}
                        onInput={(v) => update("simMaxRetryAttempts", v)}
                      />
                    </Field>
                    <Field label="Fallback résolution">
                      <select
                        class="cfg-input"
                        value={form().simResolveFallback}
                        onChange={(e) =>
                          update(
                            "simResolveFallback",
                            e.currentTarget.value as "none" | "probabilistic",
                          )
                        }
                      >
                        <option value="none">none</option>
                        <option value="probabilistic">probabilistic</option>
                      </select>
                    </Field>
                    <Field label="Random seed" hint="Vide = aléatoire">
                      <input
                        class="cfg-input"
                        type="text"
                        value={form().simRandomSeed}
                        onInput={(e) => update("simRandomSeed", e.currentTarget.value)}
                      />
                    </Field>
                  </div>
                  <div class="cfg-divider" />
                  <Toggle
                    label="Exiger une paire couverte"
                    hint="Avec le hedge activé, déjà le cas : pas de nouveau cheap sans favori dans la bande. Ne garantit pas que le hedge fill."
                    checked={form().simRequireCoveredPair}
                    onChange={(v) => update("simRequireCoveredPair", v)}
                  />
                </div>
              </Show>

              {/* Erreurs */}
              <Show when={errors().length > 0}>
                <div class="cfg-errors">
                  <For each={errors()}>{(msg) => <p>{msg}</p>}</For>
                </div>
              </Show>
              <Show when={saveError()}>
                <div class="cfg-errors">
                  <p>{saveError()}</p>
                </div>
              </Show>
            </div>
          </div>

          {/* Pied de page */}
          <footer class="cfg-footer">
            <div class="cfg-footer__info">
              <Show when={dirty()}>
                <span class="cfg-badge cfg-badge--dirty">Non enregistré</span>
              </Show>
              <Show when={!dirty()}>
                <span class="cfg-badge cfg-badge--clean">À jour</span>
              </Show>
            </div>
            <div class="cfg-footer__actions">
              <button class="btn" type="button" onClick={handleClose} disabled={saving()}>
                Annuler
              </button>
              <button
                class="btn btn-primary"
                type="button"
                onClick={() => void handleSave()}
                disabled={saving() || errors().length > 0 || !dirty()}
              >
                {saving() ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Show>
  );
}