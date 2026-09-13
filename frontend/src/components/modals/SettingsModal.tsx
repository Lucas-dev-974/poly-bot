import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { STRATEGY_ENGINE_OPTIONS, STRATEGY_PRESETS, engineUsesEdge, presetsForStrategy, type StrategyPreset } from "../../config/strategyPresets";
import { setConfig } from "../../stores/botStore";
import type { BotConfig } from "../../types";
import type { StrategyEngineSummary } from "../../api/client";
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

type SectionId = "presets" | "markets" | "cheap" | "hedge" | "edge" | "risk" | "window";

interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  desc: string;
}

const SECTIONS: SectionDef[] = [
  { id: "presets", label: "Profils", icon: "▣", desc: "Moteur et packs de paramètres" },
  { id: "markets", label: "Marchés", icon: "◉", desc: "Marchés surveillés et cadence de scan" },
  { id: "cheap", label: "Jambe cheap", icon: "▾", desc: "Bid maker underdog et verrou de paire" },
  { id: "hedge", label: "Jambe hedge", icon: "▴", desc: "Hedge après fill cheap" },
  { id: "edge", label: "Jambe edge", icon: "▴", desc: "Bande de confirmation edge-lead" },
  { id: "risk", label: "Risque", icon: "◆", desc: "Limites de taille, positions et exposition" },
  { id: "window", label: "Fenêtre", icon: "◷", desc: "Plage de trading avant clôture" },
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
  const [activeSection, setActiveSection] = createSignal<SectionId>("presets");
  const [customEngines, setCustomEngines] = createSignal<StrategyEngineSummary[]>([]);

  createEffect(() => {
    if (props.open) {
      const next = configToForm(props.config);
      setForm(next);
      setBaseline(next);
      setSaveError(null);
      setActiveSection("presets");
      void api.strategyList().then((res) => {
        setCustomEngines(res.engines.filter((engine) => !engine.native));
      }).catch(() => {
        setCustomEngines([]);
      });
    }
  });

  const selectedCustom = createMemo(() =>
    customEngines().find((engine) => engine.id === form().strategyId),
  );
  const usesEdge = createMemo(() =>
    engineUsesEdge(form().strategyId, selectedCustom()?.leadsWithEdge),
  );
  const errors = createMemo(() =>
    validateConfigForm(form(), false, {
      leadsWithEdge: selectedCustom()?.leadsWithEdge,
    }),
  );
  const dirty = createMemo(() => !formsEqual(form(), baseline()));
  const matchingPresetId = createMemo(() => {
    const current = form();
    for (const preset of presetsForStrategy(current.strategyId)) {
      const filled = configToForm({
        ...props.config,
        arbAskLockOnly: false,
        arbAskSumMax: null,
        ...preset.settings,
        strategyId: preset.strategyId,
      });
      if (formsEqual(filled, current)) return preset.id;
    }
    return null;
  });
  const matchingPreset = createMemo(() =>
    STRATEGY_PRESETS.find((preset) => preset.id === matchingPresetId()) ?? null,
  );
  const enginePresets = createMemo(() => presetsForStrategy(form().strategyId));

  function update<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setSaveError(null);
  }

  function applyPreset(preset: StrategyPreset): void {
    // Explicit arb ask-lock defaults: classic presets omit the keys; spreading
    // live config would keep a previous arbAskLockOnly=true (ghost sticky).
    setForm(
      configToForm({
        ...props.config,
        arbAskLockOnly: false,
        arbAskSumMax: null,
        ...preset.settings,
        strategyId: preset.strategyId,
      }),
    );
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

          <div class="cfg-presets">
            <span class="cfg-presets__label">Moteur</span>
            <select
              class="cfg-input"
              value={form().strategyId}
              onChange={(e) =>
                update("strategyId", e.currentTarget.value as ConfigFormState["strategyId"])
              }
            >
              <For each={STRATEGY_ENGINE_OPTIONS}>
                {(option) => <option value={option.id}>{option.label}</option>}
              </For>
              <For each={customEngines()}>
                {(engine) => (
                  <option value={engine.id}>{engine.name} ({engine.id})</option>
                )}
              </For>
            </select>
            <span class="cfg-presets__label">Profil stratégie</span>
            <div class="cfg-presets__list">
              <For each={enginePresets()}>
                {(preset) => (
                  <button
                    type="button"
                    class={`cfg-preset${matchingPresetId() === preset.id ? " cfg-preset--active" : ""}`}
                    onClick={() => applyPreset(preset)}
                  >
                    <span class="cfg-preset__name">{preset.name}</span>
                    <span class="cfg-preset__desc">{preset.description}</span>
                  </button>
                )}
              </For>
            </div>
            <Show when={enginePresets().length === 0}>
              <p class="cfg-presets__hint">Aucun profil pour ce moteur</p>
            </Show>
            <Show when={matchingPreset() && dirty()}>
              <p class="cfg-presets__hint">
                Profil « {matchingPreset()?.name} » chargé dans le formulaire.
                Enregistrer pour l’écrire dans data/bot-settings.json.
              </p>
            </Show>
            <Show when={matchingPreset() && !dirty()}>
              <p class="cfg-presets__hint">
                Profil actif : {matchingPreset()?.name}
              </p>
            </Show>
          </div>

          {/* Corps : sidebar + contenu */}
          <div class="cfg-body">
            <nav class="cfg-sidebar">
              <For each={SECTIONS}>
                {(s) => (
                  <Show
                    when={
                      !(
                        usesEdge() &&
                        (s.id === "cheap" || s.id === "hedge")
                      ) &&
                      !(
                        !usesEdge() &&
                        s.id === "edge"
                      )
                    }
                  >
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
              <Show when={activeSection() === "presets"}>
                <div class="cfg-section">
                  <h4>Profils</h4>
                  <p class="cfg-section__desc">
                    Choisis le moteur, éventuellement un profil, puis Enregistrer.
                    Ça écrit data/bot-settings.json (la config active). Tu peux encore
                    ajuster les champs dans les autres onglets. Les stratégies custom se
                    configurent par chart dans <a href="/strategy-editor">l'éditeur</a>.
                  </p>
                  <Field label="Moteur">
                    <select
                      class="cfg-input"
                      value={form().strategyId}
                      onChange={(e) =>
                        update(
                          "strategyId",
                          e.currentTarget.value as ConfigFormState["strategyId"],
                        )
                      }
                    >
                      <For each={STRATEGY_ENGINE_OPTIONS}>
                        {(option) => <option value={option.id}>{option.label}</option>}
                      </For>
                      <For each={customEngines()}>
                        {(engine) => (
                          <option value={engine.id}>{engine.name} ({engine.id})</option>
                        )}
                      </For>
                    </select>
                  </Field>
                  <div class="cfg-presets__list">
                    <For each={enginePresets()}>
                      {(preset) => (
                        <button
                          type="button"
                          class={`cfg-preset${matchingPresetId() === preset.id ? " cfg-preset--active" : ""}`}
                          onClick={() => applyPreset(preset)}
                        >
                          <span class="cfg-preset__name">{preset.name}</span>
                          <span class="cfg-preset__desc">{preset.description}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={enginePresets().length === 0}>
                    <p class="cfg-presets__hint">Aucun profil pour ce moteur</p>
                  </Show>
                  <Show when={matchingPreset() && dirty()}>
                    <p class="cfg-presets__hint">
                      Profil « {matchingPreset()?.name} » chargé — Enregistrer pour l’activer.
                    </p>
                  </Show>
                  <Show when={matchingPreset() && !dirty()}>
                    <p class="cfg-presets__hint">Profil actif : {matchingPreset()?.name}</p>
                  </Show>
                </div>
              </Show>

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
                    <Field
                      label="Poll interval (ms)"
                      hint={
                        usesEdge() && Number(form().pollIntervalMs) > 2000
                          ? `Poll lent : ~${form().edgeConfirmSamples} ticks × ${form().pollIntervalMs}ms pour confirmer (défaut 5 × 1s = 5s)`
                          : "Minimum 500 ms"
                      }
                    >
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
                    {form().strategyId === "reverse"
                      ? "Grille de limit BUY maker sur l'underdog, un niveau par tick dans [cheap min, cheap max]. Chaque niveau est indépendant du hedge."
                      : "Un seul bid GTC maker à min(bestAsk, cheapBuyMax, pairLockMax − hedge). Après fill, le hedge utilise le prix fillé (pas ce bid) : si fillPrice + hedge > pairLockMax, pas de hedge — le cheap reste directionnel."}
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
                    <Show when={form().strategyId === "arb" || form().strategyId.startsWith("custom:")}>
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
                    <Field
                      label="Ask-lock dual-FOK"
                      hint="N'entrer que si ask_cheap + ask_expensive ≤ lock ; prend les deux asks en FOK (pas de jambe maker seule)."
                    >
                      <label class="cfg-check">
                        <input
                          type="checkbox"
                          checked={form().arbAskLockOnly}
                          onChange={(e) => update("arbAskLockOnly", e.currentTarget.checked)}
                        />
                        Activer ask-lock
                      </label>
                    </Field>
                    <Show when={form().arbAskLockOnly}>
                      <Field
                        label="Ask-sum max (optionnel)"
                        hint="Plafond ask+ask plus serré que pairLockMax. Vide = pairLockMax."
                      >
                        <NumberInput
                          value={form().arbAskSumMax}
                          min={0.90}
                          max={0.99}
                          step={0.01}
                          onInput={(v) => update("arbAskSumMax", v)}
                        />
                      </Field>
                    </Show>
                    </Show>
                  </div>
                </div>
              </Show>

              {/* ---- Jambe hedge ---- */}
              <Show when={activeSection() === "hedge"}>
                <div class="cfg-section">
                  <h4>Jambe hedge (favorite)</h4>
                  <p class="cfg-section__desc">
                    {form().strategyId === "reverse"
                      ? "Grille de limit BUY maker sur le favori, posée en même temps que le cheap (pas après fill). Niveaux dans [hedge min, hedge max], budget par niveau."
                      : form().strategyId === "barbell"
                      ? "Hedge au ratio cheap/hedge uniquement après un cheap rempli, si l'ask favori est dans [hedgeMin, hedgeMax]. Pas de verrou de profit — variance plus élevée."
                      : "Hedge 1:1 uniquement après un cheap rempli, si l'ask favori est dans [hedgeMin, hedgeMax] et si fillPrice + min(ask, hedgeMax) ≤ pairLockMax. La bande est nécessaire, pas suffisante."}
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
                      hint={
                        form().strategyId === "reverse"
                          ? "Budget USDC par niveau de la grille favori (indépendant du cheap)."
                          : "Cap secondaire. Taille = 1:1 du cheap rempli non couvert. Sous 5 parts au prix hedge (≈ 4.75 USDC à 0.95) : aucun hedge. Trop petit = paire partielle"
                      }
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
                      hint={
                        form().strategyId === "reverse"
                          ? "GTC : grille maker posée avec le cheap, sans attendre un fill. FOK = taker immédiat (peu adapté au reverse)."
                          : "FOK et GTC : seulement après fill cheap. FOK = taker immédiat ; GTC = restant au min(ask, hedgeMax)"
                      }
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
                    <Show when={form().strategyId === "barbell"}>
                    <Field
                      label="Ratio hedge"
                      hint="Parts hedge ciblées = cheap rempli × ratio. (0, 1]. Défaut 0.5."
                    >
                      <NumberInput
                        value={form().barbellHedgeRatio}
                        min={0.01}
                        max={1}
                        step={0.05}
                        onInput={(v) => update("barbellHedgeRatio", v)}
                      />
                    </Field>
                    </Show>
                  </div>
                  <div class="cfg-divider" />
                  <Show when={form().strategyId !== "arb"}>
                  <Toggle
                    label="Activer le hedge expensive"
                    hint="Désactivé : cheap = directionnel. Activé : hedge après fill (barbell/reverse)."
                    checked={form().enableExpensiveHedge}
                    onChange={(v) => update("enableExpensiveHedge", v)}
                  />
                  </Show>
                  <Show when={form().strategyId === "reverse"}>
                    <Toggle
                      label="Expensive après cheap fill"
                      hint="N'émettre / placer un ordre expensive qu'après qu'au moins un cheap de la paire a été fillé."
                      checked={form().requireCheapFillBeforeExpensive}
                      onChange={(v) => update("requireCheapFillBeforeExpensive", v)}
                    />
                    <div class="cfg-divider" />
                    <p class="cfg-section__desc">
                      Phase 2 — contrôles de risque reverse (désactivés par défaut).
                    </p>
                    <Toggle
                      label="Cancel cheap hors bande"
                      hint="Annule les GTC cheap resting si l'ask underdog sort de [cheapBuyMin, cheapBuyMax]."
                      checked={form().reverseCancelCheapOffBand}
                      onChange={(v) => update("reverseCancelCheapOffBand", v)}
                    />
                    <Toggle
                      label="Défense cheap si favori hors max"
                      hint="FOK SELL du cheap non couvert quand l'ask favori dépasse expensiveBuyMax."
                      checked={form().reverseDefendEnabled}
                      onChange={(v) => update("reverseDefendEnabled", v)}
                    />
                    <Toggle
                      label="Cap hedge ≤ cheap fillé"
                      hint="Le cumul des tailles hedge ne dépasse pas filledCheap − filledExpensive."
                      checked={form().reverseHedgeCapToFilledCheap}
                      onChange={(v) => update("reverseHedgeCapToFilledCheap", v)}
                    />
                    <Field
                      label="Max niveaux grille"
                      hint="Nombre max de niveaux maker par jambe. Vide = illimité."
                    >
                      <NumberInput
                        value={form().reverseMaxGridLevels}
                        min={1}
                        step={1}
                        onInput={(v) => update("reverseMaxGridLevels", v)}
                      />
                    </Field>
                  </Show>

                </div>
              </Show>

              {/* ---- Jambe edge (edge-lead) ---- */}
              <Show when={activeSection() === "edge"}>
                <div class="cfg-section">
                  <h4>Jambe edge (favori)</h4>
                  <p class="cfg-section__desc">
                    Edge-lead : on confirme N ticks que l'ask du favori reste dans
                    la bande et monte, on achète l'edge en GTC, on attend le fill,
                    puis on poste le cheap au best ask live (bande cheap, budget
                    cheap indépendant).
                  </p>
                  <div class="cfg-grid">
                    <Field label="Edge band min" hint="Ask favori minimum de la bande de confirmation">
                      <NumberInput
                        value={form().edgeBandMin}
                        min={0.5}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("edgeBandMin", v)}
                      />
                    </Field>
                    <Field label="Edge band max" hint="Ask favori maximum de la bande de confirmation">
                      <NumberInput
                        value={form().edgeBandMax}
                        min={0.5}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("edgeBandMax", v)}
                      />
                    </Field>
                    <Field label="Ticks de confirmation" hint="Nombre de ticks consécutifs valides avant d'acheter l'edge (défaut 5)">
                      <NumberInput
                        value={form().edgeConfirmSamples}
                        min={2}
                        step={1}
                        onInput={(v) => update("edgeConfirmSamples", v)}
                      />
                    </Field>
                    <Field label="Drop max / tick" hint="Drop tick-à-tick max toléré dans la série (défaut 0.01)">
                      <NumberInput
                        value={form().edgeMaxDownTick}
                        min={0.001}
                        max={0.1}
                        step={0.001}
                        onInput={(v) => update("edgeMaxDownTick", v)}
                      />
                    </Field>
                    <Field label="Cheap band min" hint="Ask cheap min (ex. 0.04). Hors bande : pas de POST, et cancel d'un GTC cheap resting">
                      <NumberInput
                        value={form().edgeCheapBandMin}
                        min={0.01}
                        max={0.49}
                        step={0.01}
                        onInput={(v) => update("edgeCheapBandMin", v)}
                      />
                    </Field>
                    <Field label="Cheap band max" hint="Ask cheap max (ex. 0.14). GTC au best ask si dans la bande ; cancel + re-post s'il sort puis rentre">
                      <NumberInput
                        value={form().edgeCheapBandMax}
                        min={0.01}
                        max={0.49}
                        step={0.01}
                        onInput={(v) => update("edgeCheapBandMax", v)}
                      />
                    </Field>
                    <Field
                      label="Mode de sizing"
                      hint="Shares = nombre fixe par side. pUSD = budget USDC par side. Dynamique = comportement actuel (budgets + confirmation). La confirmation et les bandes restent appliquées dans tous les modes."
                    >
                      <select
                        class="cfg-input"
                        value={form().edgeSizingMode}
                        onChange={(e) =>
                          update(
                            "edgeSizingMode",
                            e.currentTarget.value as ConfigFormState["edgeSizingMode"],
                          )
                        }
                      >
                        <option value="dynamic">Dynamique (budgets USDC)</option>
                        <option value="pusd">pUSD (budget USDC fixe)</option>
                        <option value="shares">Shares (nombre fixe)</option>
                      </select>
                    </Field>
                    <Show when={form().edgeSizingMode === "shares"}>
                      <Field label="Shares edge" hint="Nombre fixe de shares de l'ordre favori (≥ 5)">
                        <NumberInput
                          value={form().edgeSharesEdge}
                          min={5}
                          step={1}
                          onInput={(v) => update("edgeSharesEdge", v)}
                        />
                      </Field>
                      <Field label="Shares cheap" hint="Nombre fixe de shares de l'ordre cheap (≥ 5)">
                        <NumberInput
                          value={form().edgeSharesCheap}
                          min={5}
                          step={1}
                          onInput={(v) => update("edgeSharesCheap", v)}
                        />
                      </Field>
                    </Show>
                    <Show when={form().edgeSizingMode !== "shares"}>
                      <Field label="Budget edge (USDC)" hint="Taille edge = budget / prix edge, plafonnée par max shares edge. Indépendant du cheap">
                        <NumberInput
                          value={form().edgeOrderUsdc}
                          min={1}
                          step={1}
                          onInput={(v) => update("edgeOrderUsdc", v)}
                        />
                      </Field>
                      <Field label="Max shares edge" hint="Plafond de shares de l'ordre favori. Le cheap reste plafonné par Max shares / ordre">
                        <NumberInput
                          value={form().maxShareEdge}
                          min={1}
                          step={1}
                          onInput={(v) => update("maxShareEdge", v)}
                        />
                      </Field>
                      <Field label="Budget cheap (USDC)" hint="Taille cheap = budget / ask cheap, seulement après fill edge. Pas de 1:1 en shares">
                        <NumberInput
                          value={form().edgeCheapOrderUsdc}
                          min={1}
                          step={1}
                          onInput={(v) => update("edgeCheapOrderUsdc", v)}
                        />
                      </Field>
                    </Show>
                    <Toggle
                      label="Vendre l'edge si perte"
                      hint="Vendre le favori nu (FOK SELL) si aucun cheap fillé et en perte soutenue"
                      checked={form().edgeSellExpensiveEnabled}
                      onChange={(v) => update("edgeSellExpensiveEnabled", v)}
                    />
                    <Show when={form().edgeSellExpensiveEnabled}>
                      <Field label="Vente edge après (min)" hint="Âge du marché (min depuis l'ouverture) avant déclenchement (défaut 8)">
                        <NumberInput
                          value={form().edgeSellExpensiveAfterMin}
                          min={0}
                          step={1}
                          onInput={(v) => update("edgeSellExpensiveAfterMin", v)}
                        />
                      </Field>
                      <Field label="Perte edge (%)" hint="Perte % sous le prix de fill pour déclencher (ex. 10 = -10%)">
                        <NumberInput
                          value={form().edgeSellExpensiveLossPct}
                          min={0.1}
                          step={1}
                          onInput={(v) => update("edgeSellExpensiveLossPct", v)}
                        />
                      </Field>
                      <Field label="Fenêtre perte edge (ms)" hint="Durée de perte continue requise avant la vente (défaut 10000)">
                        <NumberInput
                          value={form().edgeSellExpensiveLossWindowMs}
                          min={100}
                          step={100}
                          onInput={(v) => update("edgeSellExpensiveLossWindowMs", v)}
                        />
                      </Field>
                    </Show>
                  </div>
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
                    <Field label="Max shares / ordre" hint="Plafond cheap (arb/barbell : tout ordre). Edge-lead : jambe cheap seulement">
                      <NumberInput
                        value={form().maxSharesPerOrder}
                        min={1}
                        step={1}
                        onInput={(v) => update("maxSharesPerOrder", v)}
                      />
                    </Field>
                    <Field label="Max shares edge" hint="Plafond de shares de l'ordre favori (edge-lead). Ignoré par arb/barbell">
                      <NumberInput
                        value={form().maxShareEdge}
                        min={1}
                        step={1}
                        onInput={(v) => update("maxShareEdge", v)}
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