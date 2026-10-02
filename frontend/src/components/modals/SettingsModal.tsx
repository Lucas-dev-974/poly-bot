import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { STRATEGY_ENGINE_OPTIONS, STRATEGY_PRESETS, engineUsesEdge, presetsForStrategy, type StrategyPreset } from "../../config/strategyPresets";
import { setConfig } from "../../stores/botStore";
import { clearToasts, pushError, pushInfo, setGroupToasts } from "../../stores/toastStore";
import type { BotConfig } from "../../types";
import type { StrategyEngineSummary } from "../../api/client";
import {
  configToForm,
  formToPatch,
  formsEqual,
  validateConfigForm,
  type ConfigFormState,
} from "../../utils/configForm";
import { Field, NumberInput, Toggle } from "./settings/SettingsFields";
import { SECTIONS, type SectionId } from "./settings/settingsSections";

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
  const isFavBand = createMemo(() => form().strategyId === "fav-band");
  const isDip = createMemo(() => form().strategyId === "dip-revert");
  const isAntiflip = createMemo(() => form().strategyId === "antiflip-revert");
   const isFlipConfirm = createMemo(() => form().strategyId === "flip-confirm");
  const isEarlyConviction = createMemo(() => form().strategyId === "early-conviction");
  const isEarlyLow = createMemo(() => form().strategyId === "early-low");
  const isOpenEntry = createMemo(() => form().strategyId === "open-entry");
  const isRepricing = createMemo(() => form().strategyId === "probability-repricing");
  const isDirectionalHold = createMemo(
    () => isFavBand() || isDip() || isAntiflip() || isFlipConfirm() || isEarlyConviction() || isEarlyLow() || isOpenEntry() || isRepricing(),
  );
  const errors = createMemo(() =>
    validateConfigForm(form(), false, {
      leadsWithEdge: selectedCustom()?.leadsWithEdge,
    }),
  );


  createEffect(() => {
    if (!props.open) {
      // Keep settings-save toasts (success/failure) visible after close.
      clearToasts("settings-validation");
      return;
    }
    setGroupToasts("settings-validation", "error", errors());
  });
  const dirty = createMemo(() => !formsEqual(form(), baseline()));
  const matchingPresetId = createMemo(() => {
    const current = form();
    for (const preset of presetsForStrategy(current.strategyId)) {
      const filled = configToForm({
        ...props.config,
        arbAskLockOnly: false,
        arbAskSumMax: null,
        arbAskLockMinElapsedSec: null,
        arbAskLockMaxImbalance: null,
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
        arbAskLockMinElapsedSec: null,
        arbAskLockMaxImbalance: null,
        enableExpensiveHedge:
          preset.strategyId === "fav-band" || preset.strategyId === "dip-revert" || preset.strategyId === "antiflip-revert" || preset.strategyId === "flip-confirm" || preset.strategyId === "early-conviction" || preset.strategyId === "early-low" || preset.strategyId === "open-entry" || preset.strategyId === "probability-repricing"
            ? false
            : props.config.enableExpensiveHedge,
        ...preset.settings,
        strategyId: preset.strategyId,
        ...(preset.strategyId === "fav-band" || preset.strategyId === "dip-revert" || preset.strategyId === "antiflip-revert" || preset.strategyId === "flip-confirm" || preset.strategyId === "early-conviction" || preset.strategyId === "early-low" || preset.strategyId === "open-entry" || preset.strategyId === "probability-repricing"
          ? { enableExpensiveHedge: false }
          : {}),
      }),
    );
    if (preset.strategyId === "fav-band") setActiveSection("fav");
    else if (preset.strategyId === "dip-revert") setActiveSection("dip");
    else if (preset.strategyId === "antiflip-revert") setActiveSection("antiflip");
    else if (preset.strategyId === "flip-confirm") setActiveSection("flipconf");
    else if (preset.strategyId === "early-conviction") setActiveSection("earlyconv");
    else if (preset.strategyId === "early-low") setActiveSection("earlylow");
    else if (preset.strategyId === "open-entry") setActiveSection("openentry");
    else if (preset.strategyId === "probability-repricing") setActiveSection("repricing");
    else if (preset.strategyId === "edge-lead") setActiveSection("edge");
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
    if (errors().length > 0) {
      setGroupToasts("settings-validation", "error", errors());
      return;
    }
    setSaving(true);
    setSaveError(null);
    clearToasts("settings-save");
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
      clearToasts("settings-validation");
      pushInfo("Configuration enregistrée", { group: "settings-save", replaceGroup: true });
      props.onSaved();
      props.onClose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSaveError(msg);
      pushError(msg, { group: "settings-save", replaceGroup: true });
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
              onChange={(e) => {
                const id = e.currentTarget.value as ConfigFormState["strategyId"];
                update("strategyId", id);
                if (id === "fav-band") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("fav");
                } else if (id === "dip-revert") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("dip");
                } else if (id === "antiflip-revert") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("antiflip");
                } else if (id === "flip-confirm") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("flipconf");
                } else if (id === "early-conviction") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("earlyconv");
                } else if (id === "early-low") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("earlylow");
                } else if (id === "open-entry") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("openentry");
                } else if (id === "probability-repricing") {
                  update("enableExpensiveHedge", false);
                  setActiveSection("repricing");
                } else if (id === "edge-lead") {
                  setActiveSection("edge");
                } else if (
                  activeSection() === "fav" ||
                  activeSection() === "dip" ||
                  activeSection() === "antiflip" ||
                  activeSection() === "flipconf" ||
                  activeSection() === "earlyconv" ||
                  activeSection() === "openentry" ||
                  activeSection() === "repricing" ||
                  activeSection() === "edge"
                ) {
                  setActiveSection("presets");
                }
              }}
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
                        (s.id === "cheap" || s.id === "hedge" || s.id === "fav" || s.id === "dip" || s.id === "antiflip" || s.id === "flipconf" || s.id === "earlyconv" || s.id === "openentry" || s.id === "repricing")
                      ) &&
                      !(
                        isDirectionalHold() &&
                        (s.id === "cheap" || s.id === "hedge" || s.id === "edge")
                      ) &&
                      !(
                        isDip() &&
                        s.id === "fav"
                      ) &&
                      !(
                        !usesEdge() &&
                        !isDirectionalHold() &&
                        s.id === "edge"
                      ) &&
                      !(
                        !isFavBand() &&
                        s.id === "fav"
                      ) &&
                      !(
                        !isDip() &&
                        s.id === "dip"
                      ) &&
                      !(
                        !isAntiflip() &&
                        s.id === "antiflip"
                      ) &&
                      !(
                        !isFlipConfirm() &&
                        s.id === "flipconf"
                      ) &&
                      !(
                        !isEarlyConviction() &&
                        s.id === "earlyconv"
                      ) &&
                      !(
                        !isOpenEntry() &&
                        s.id === "openentry"
                      ) &&
                      !(
                        !isRepricing() &&
                        s.id === "repricing"
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
                    <Field
                      label="Cheap order (USDC)"
                      hint={
                        form().strategyId === "barbell"
                          ? "Budget par ordre cheap (barbell)"
                          : form().strategyId === "reverse"
                            ? "Budget par ordre cheap (reverse)"
                            : "Budget par ordre cheap (arb)"
                      }
                    >
                      <NumberInput
                        value={
                          form().strategyId === "barbell"
                            ? form().barbellCheapOrderUsdc
                            : form().strategyId === "reverse"
                              ? form().reverseCheapOrderUsdc
                              : form().cheapOrderUsdc
                        }
                        min={0.1}
                        step={0.1}
                        onInput={(v) =>
                          update(
                            form().strategyId === "barbell"
                              ? "barbellCheapOrderUsdc"
                              : form().strategyId === "reverse"
                                ? "reverseCheapOrderUsdc"
                                : "cheapOrderUsdc",
                            v,
                          )
                        }
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
                          hint="Plafond ask+ask plus serre que pairLockMax. Vide = pairLockMax."
                        >
                          <NumberInput
                            value={form().arbAskSumMax}
                            min={0.90}
                            max={0.99}
                            step={0.01}
                            onInput={(v) => update("arbAskSumMax", v)}
                          />
                        </Field>
                        <Field
                          label="Min elapsed sec"
                          hint="N entrer qu apres N secondes depuis windowStart. Vide = off."
                        >
                          <NumberInput
                            value={form().arbAskLockMinElapsedSec}
                            min={0}
                            max={900}
                            step={1}
                            onInput={(v) => update("arbAskLockMinElapsedSec", v)}
                          />
                        </Field>
                        <Field
                          label="Max imbalance"
                          hint="Skip si |ask_c - ask_e| > seuil. Vide = off."
                        >
                          <NumberInput
                            value={form().arbAskLockMaxImbalance}
                            min={0}
                            max={1}
                            step={0.01}
                            onInput={(v) => update("arbAskLockMaxImbalance", v)}
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
                  <Show when={form().strategyId !== "arb" && form().strategyId !== "fav-band"}>
                    <Toggle
                      label="Activer le hedge expensive"
                      hint="Désactivé : cheap = directionnel. Activé : hedge après fill (barbell/reverse)."
                      checked={form().enableExpensiveHedge}
                      onChange={(v) => update("enableExpensiveHedge", v)}
                    />
                  </Show><Show when={form().strategyId === "reverse"}>
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

              {/* ---- Entrée fav-band ---- */}
              <Show when={activeSection() === "fav"}>
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
                        value={form().favBandAskMin}
                        min={0.5}
                        max={0.95}
                        step={0.01}
                        onInput={(v) => update("favBandAskMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask favori max"
                      hint="Borne haute (défaut 0.85). Au-dessus : favoris « sûrs » souvent surcotés (EV négative en backtest)."
                    >
                      <NumberInput
                        value={form().favBandAskMax}
                        min={0.55}
                        max={0.99}
                        step={0.01}
                        onInput={(v) => update("favBandAskMax", v)}
                      />
                    </Field>
                    <Field
                      label="Min elapsed (sec)"
                      hint="Attendre N secondes depuis le début de la fenêtre 15m avant d&apos;entrer (défaut 200)."
                    >
                      <NumberInput
                        value={form().favBandMinElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("favBandMinElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec, opt)"
                      hint="Vide = jusqu&apos;à la close / minutesBeforeClose. Sinon coupe les entrées trop tardives."
                    >
                      <NumberInput
                        value={form().favBandMaxElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("favBandMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le favori. Taille = budget / ask, plafonnée par max shares."
                    >
                      <NumberInput
                        value={form().favBandOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("favBandOrderUsdc", v)}
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
                          checked={form().favBandInverseEnabled}
                          onChange={(e) => update("favBandInverseEnabled", e.currentTarget.checked)}
                        />
                        <span>Hedge inverse activé</span>
                      </label>
                      <Show when={form().favBandInverseEnabled}>
                        <Field
                          label="Limite GTC inverse"
                          hint="Prix de pose du GTC sur le token opposé (défaut 0.20). Ne se remplit que si l'ask inverse descend à ce niveau."
                        >
                          <NumberInput
                            value={form().favBandInverseAskMax}
                            min={0.01}
                            max={0.49}
                            step={0.01}
                            onInput={(v) => update("favBandInverseAskMax", v)}
                          />
                        </Field>
                        <Field
                          label="Ratio shares inverse"
                          hint="Shares de l'inverse par share du favori fillé (défaut 2 = le double). Plafonné par le budget et max shares."
                        >
                          <NumberInput
                            value={form().favBandInverseShareRatio}
                            min={0.1}
                            step={0.1}
                            onInput={(v) => update("favBandInverseShareRatio", v)}
                          />
                        </Field>
                        <Field
                          label="Budget inverse (USDC)"
                          hint="Plafond USDC de l'ordre GTC inverse (défaut 15). Doit permettre ≥ 5 shares au pire prix."
                        >
                          <NumberInput
                            value={form().favBandInverseOrderUsdc}
                            min={0.1}
                            step={0.1}
                            onInput={(v) => update("favBandInverseOrderUsdc", v)}
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
                          checked={form().favBandWhipsawEnabled}
                          onChange={(e) => update("favBandWhipsawEnabled", e.currentTarget.checked)}
                        />
                        <span>Filtre whipsaw activé</span>
                      </label>
                      <Show when={form().favBandWhipsawEnabled}>
                        <Field
                          label="Pause après N pertes"
                          hint="Après N lost d'affilée, skip les prochaines fenêtres (vide = pause off). Défaut recherche : 3."
                        >
                          <NumberInput
                            value={form().favBandWhipsawPauseAfterLosses}
                            min={1}
                            max={20}
                            step={1}
                            onInput={(v) => update("favBandWhipsawPauseAfterLosses", v)}
                          />
                        </Field>
                        <Field
                          label="Fenêtres de pause"
                          hint="Cooldownree de pause = N x 15 min (horloge), defaut 8. Independant du multi-marches."
                        >
                          <NumberInput
                            value={form().favBandWhipsawPauseWindows}
                            min={1}
                            max={48}
                            step={1}
                            onInput={(v) => update("favBandWhipsawPauseWindows", v)}
                          />
                        </Field>
                        <Field
                          label="Score max (0–100)"
                          hint="Skip si score ≥ seuil. Vide = gate off (recommandé)."
                        >
                          <NumberInput
                            value={form().favBandWhipsawMaxScore}
                            min={0}
                            max={100}
                            step={1}
                            onInput={(v) => update("favBandWhipsawMaxScore", v)}
                          />
                        </Field>
                        <Field
                          label="Max flips intra-fenêtre"
                          hint="Skip si flips favori ≥ N dans la fenêtre. Vide = gate off (recommandé)."
                        >
                          <NumberInput
                            value={form().favBandWhipsawMaxIntraFlips}
                            min={1}
                            max={20}
                            step={1}
                            onInput={(v) => update("favBandWhipsawMaxIntraFlips", v)}
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
                          checked={form().favBandImbalanceEnabled}
                          onChange={(e) => update("favBandImbalanceEnabled", e.currentTarget.checked)}
                        />
                        <span>Filtre imbalance activé</span>
                      </label>
                      <Show when={form().favBandImbalanceEnabled}>
                        <Field
                          label="Plancher cross (−1..1)"
                          hint="Entrée seulement si pression croisée ≥ plancher aux N derniers ticks. Recommandation recherche : −0.1."
                        >
                          <NumberInput
                            value={form().favBandImbalanceCrossMin}
                            min={-0.99}
                            max={0.99}
                            step={0.05}
                            onInput={(v) => update("favBandImbalanceCrossMin", v)}
                          />
                        </Field>
                        <Field
                          label="Ticks de persistance"
                          hint="Nombre de mesures consécutives au-dessus du plancher requises (vide = défaut 2). 1 tick = vulnérable au spoofing."
                        >
                          <NumberInput
                            value={form().favBandImbalanceTicks}
                            min={1}
                            max={10}
                            step={1}
                            onInput={(v) => update("favBandImbalanceTicks", v)}
                          />
                        </Field>
                        <Field
                          label="Spread max favori (optionnel)"
                          hint="Skip si spread L1 du favori ≥ ce seuil (vide = off). Ex : 0.04. Complète le filtre anti-carnet-troué."
                        >
                          <NumberInput
                            value={form().favBandImbalanceMaxSpread}
                            min={0.01}
                            max={0.2}
                            step={0.01}
                            onInput={(v) => update("favBandImbalanceMaxSpread", v)}
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
                          checked={form().favBandExitEnabled}
                          onChange={(e) => update("favBandExitEnabled", e.currentTarget.checked)}
                        />
                        <span>Sortie dégradation activée</span>
                      </label>
                      <Show when={form().favBandExitEnabled}>
                        <Field
                          label="Swing min (plus-bas)"
                          hint="Amplitude minimum d'une jambe pour figer un plus-bas (défaut 0.05 = 5¢). En dessous = bruit de carnet."
                        >
                          <NumberInput
                            value={form().favBandExitMinLowerHighDrop}
                            min={0.005}
                            step={0.005}
                            onInput={(v) => update("favBandExitMinLowerHighDrop", v)}
                          />
                        </Field>
                        <Field
                          label="Retracement de confirmation"
                          hint="Part de la chute à remonter pour figer le plus-bas (0.50 = 50 %, défaut 0.25). Borné à [1 tick, swing min] : un gros dump n'attend pas un retrace Fibonacci. 0 = n'importe quel tick de rebond. Un plus-bas suivant (sous le précédent) se confirme dès 1 tick."
                        >
                          <NumberInput
                            value={form().favBandExitRetraceRatio}
                            min={0}
                            max={1}
                            step={0.05}
                            onInput={(v) => update("favBandExitRetraceRatio", v)}
                          />
                        </Field>
                        <Field
                          label="Plus-bas consécutifs"
                          hint="Nombre de plus-bas de plus en plus bas avant de sortir (défaut 3)."
                        >
                          <NumberInput
                            value={form().favBandExitConsecutive}
                            min={2}
                            max={10}
                            step={1}
                            onInput={(v) => update("favBandExitConsecutive", v)}
                          />
                        </Field>
                        <Field
                          label="Lookback (ms)"
                          hint="Fenêtre glissante : la séquence de plus-bas doit rester récente (défaut 120000 = 120 s). Sans nouveau plus-bas dans la fenêtre, le compteur est réinitialisé."
                        >
                          <NumberInput
                            value={form().favBandExitLookbackMs}
                            min={5000}
                            step={1000}
                            onInput={(v) => update("favBandExitLookbackMs", v)}
                          />
                        </Field>
                        <Field
                          label="Min elapsed (sec)"
                          hint="Ne sortir qu'après N secondes de fenêtre (0 = toujours actif)."
                        >
                          <NumberInput
                            value={form().favBandExitMinElapsedSec}
                            min={0}
                            max={900}
                            step={1}
                            onInput={(v) => update("favBandExitMinElapsedSec", v)}
                          />
                        </Field>
                        <label class="cfg-check" title="Ne sort que si l'ask détenu est sous le prix d'entrée (une sortie au-dessus = gain, pas une dégradation).">
                          <input
                            type="checkbox"
                            checked={form().favBandExitLossOnly}
                            onChange={(e) => update("favBandExitLossOnly", e.currentTarget.checked)}
                          />
                          <span>Uniquement en perte</span>
                        </label>
                        <label class="cfg-check" title="Juste après la vente de sortie, FOK buy du token opposé à son ask courant (switch de côté).">
                          <input
                            type="checkbox"
                            checked={form().favBandExitSwitchEnabled}
                            onChange={(e) => update("favBandExitSwitchEnabled", e.currentTarget.checked)}
                          />
                          <span>Acheter l&apos;inverse après la sortie</span>
                        </label>
                        <Show when={form().favBandExitSwitchEnabled}>
                          <Field
                            label="Budget switch (USDC)"
                            hint="Plafond USDC du FOK sur le token opposé (défaut 15). Requiert max positions par côté ≥ 2 (onglet Risque)."
                          >
                            <NumberInput
                              value={form().favBandExitSwitchOrderUsdc}
                              min={0.1}
                              step={0.1}
                              onInput={(v) => update("favBandExitSwitchOrderUsdc", v)}
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
              </Show>

              {/* ---- Entrée dip-revert ---- */}
              <Show when={activeSection() === "dip"}>
                <div class="cfg-section">
                  <h4>Entrée dip-revert</h4>
                  <p class="cfg-section__desc">
                    Stratégie directionnelle mean-reversion : FOK buy du{" "}
                    <strong>favori</strong> après une <strong>chute intra-fenêtre</strong>{" "}
                    puis un <strong>début de rebond</strong>, et hold jusqu&apos;à la
                    résolution — pas de hedge. Le marché sur-pénalise temporairement le
                    favori après une secousse ; la clôture revient à la tendance
                    (WR empirique ~64 % vs ~52 % favori moyen, sur 231 fenêtres).
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Ask favori min"
                      hint="Borne basse de la bande d'entrée du favori (défaut 0.55)."
                    >
                      <NumberInput
                        value={form().dipRevertBandMin}
                        min={0.3}
                        max={0.9}
                        step={0.01}
                        onInput={(v) => update("dipRevertBandMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask favori max"
                      hint="Borne haute (défaut 0.65). Au-delà, le favori est « sûr » : le dip est structurel, pas une opportunité."
                    >
                      <NumberInput
                        value={form().dipRevertBandMax}
                        min={0.4}
                        max={0.95}
                        step={0.01}
                        onInput={(v) => update("dipRevertBandMax", v)}
                      />
                    </Field>
                    <Field
                      label="Min drop"
                      hint="Chute minimum de l'ask favori sur la fenêtre lookback (défaut 0.03 = 3¢)."
                    >
                      <NumberInput
                        value={form().dipRevertMinDrop}
                        min={0.001}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("dipRevertMinDrop", v)}
                      />
                    </Field>
                    <Field
                      label="Drop lookback (ms)"
                      hint="Fenêtre glissante où mesurer la chute (défaut 60000 = 60 s)."
                    >
                      <NumberInput
                        value={form().dipRevertDropLookbackMs}
                        min={1000}
                        max={300000}
                        step={1000}
                        onInput={(v) => update("dipRevertDropLookbackMs", v)}
                      />
                    </Field>
                    <Field
                      label="Min elapsed (sec)"
                      hint="Attendre N secondes depuis le début de la fenêtre avant d'entrer (défaut 180)."
                    >
                      <NumberInput
                        value={form().dipRevertMinElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("dipRevertMinElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec, opt)"
                      hint="Vide = jusqu'à la close / minutesBeforeClose."
                    >
                      <NumberInput
                        value={form().dipRevertMaxElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("dipRevertMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du favori à l'entrée (défaut 0.04). Liquidité."
                    >
                      <NumberInput
                        value={form().dipRevertMaxSpread}
                        min={0}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("dipRevertMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le favori (défaut 15). Taille = budget / ask, plafonnée par max shares."
                    >
                      <NumberInput
                        value={form().dipRevertOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("dipRevertOrderUsdc", v)}
                      />
                    </Field>
                  </div>
                  <div style={{ "margin-top": "0.75rem" }}>
                    <Toggle
                      label="Take-profit (sortie anticipée)"
                      hint="Vendre le favori détenu (FOK SELL au bid) quand son propre ask atteint le seuil, au lieu de hold jusqu'à la résolution. Désactivé : hold intégral (comportement par défaut)."
                      checked={form().dipRevertExitTakeProfitEnabled}
                      onChange={(v) => update("dipRevertExitTakeProfitEnabled", v)}
                    />
                    <Show when={form().dipRevertExitTakeProfitEnabled}>
                      <div class="cfg-grid" style={{ "margin-top": "0.5rem" }}>
                        <Field
                          label="Take-profit ask"
                          hint="Seuil sur l'ask du favori DÉTENU (défaut 0.85). Doit être > ask max de la bande d'entrée. Un FOK tué (profondeur) garde la position jusqu'à la résolution."
                        >
                          <NumberInput
                            value={form().dipRevertExitWinAsk}
                            min={0.6}
                            max={0.99}
                            step={0.01}
                            onInput={(v) => update("dipRevertExitWinAsk", v)}
                          />
                        </Field>
                      </div>
                    </Show>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>

              {/* ---- Entrée antiflip-revert ---- */}
              <Show when={activeSection() === "antiflip"}>
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
                        value={form().antiflipBandMin}
                        min={0.2}
                        max={0.6}
                        step={0.01}
                        onInput={(v) => update("antiflipBandMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask déchu max"
                      hint="Borne haute (défaut 0.45). Au-delà, le déchu n'est pas assez replacé : pas de sur-réaction à capter."
                    >
                      <NumberInput
                        value={form().antiflipBandMax}
                        min={0.25}
                        max={0.65}
                        step={0.01}
                        onInput={(v) => update("antiflipBandMax", v)}
                      />
                    </Field>
                    <Field
                      label="Floor déchu (opt)"
                      hint="Plancher de prix du déchu (défaut 0.40). Vide = désactivé. Évite d'acheter des loteries à 0.20 qui ne rebondissent pas."
                    >
                      <NumberInput
                        value={form().antiflipDeposedAskMin}
                        min={0.05}
                        max={0.6}
                        step={0.01}
                        onInput={(v) => update("antiflipDeposedAskMin", v)}
                      />
                    </Field>
                    <Field
                      label="Flip lookback (ms)"
                      hint="Fenêtre max depuis le flip pour entrer (défaut 90000 = 90s). Au-delà, le marché a digéré le retournement : l'edge disparaît."
                    >
                      <NumberInput
                        value={form().antiflipFlipLookbackMs}
                        min={1000}
                        max={300000}
                        step={1000}
                        onInput={(v) => update("antiflipFlipLookbackMs", v)}
                      />
                    </Field>
                    <Field
                      label="Min elapsed (sec)"
                      hint="Le flip doit survenir après N secondes de fenêtre (défaut 240). Les flips précoces appartiennent à flip-confirm."
                    >
                      <NumberInput
                        value={form().antiflipMinElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("antiflipMinElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec, opt)"
                      hint="Vide = jusqu'à la close / minutesBeforeClose."
                    >
                      <NumberInput
                        value={form().antiflipMaxElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("antiflipMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du token déchu à l'entrée (défaut 0.05). Liquidité."
                    >
                      <NumberInput
                        value={form().antiflipMaxSpread}
                        min={0}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("antiflipMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le déchu (défaut 15). Taille = budget / ask, plafonnée par max shares. WR 52% : variance par trade élevée, sizing prudent."
                    >
                      <NumberInput
                        value={form().antiflipOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("antiflipOrderUsdc", v)}
                      />
                    </Field>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>

              {/* ---- Entrée flip-confirm ---- */}
              <Show when={activeSection() === "flipconf"}>
                <div class="cfg-section">
                  <h4>Entrée flip-confirm</h4>
                  <p class="cfg-section__desc">
                    Stratégie directionnelle momentum : un flip d&apos;identité{" "}
                    <strong>PRÉCOCE</strong> est informationnel (vrai déséquilibre). On
                    achète le <strong>NOUVEAU favori</strong> (0.55-0.65) dans la fenêtre
                    d&apos;entrée [120s, 180s], flip frais de moins de 90s, hold jusqu&apos;à
                    la résolution — pas de hedge. Backtest calibré : +$389, WR 66.5 %,
                    t-stat 2.44. Les entrées après 180s s&apos;effondrent (flips tardifs =
                    bruit) : ne pas élargir la fenêtre.
                  </p>
                  <div class="cfg-grid">
                    <Field
                      label="Ask nouveau favori min"
                      hint="Borne basse de la bande d'entrée du nouveau favori (défaut 0.55)."
                    >
                      <NumberInput
                        value={form().flipConfirmBandMin}
                        min={0.4}
                        max={0.8}
                        step={0.01}
                        onInput={(v) => update("flipConfirmBandMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask nouveau favori max"
                      hint="Borne haute (défaut 0.65). Au-delà, le nouveau favori est déjà certitude : le ré-ajustement a eu lieu."
                    >
                      <NumberInput
                        value={form().flipConfirmBandMax}
                        min={0.45}
                        max={0.9}
                        step={0.01}
                        onInput={(v) => update("flipConfirmBandMax", v)}
                      />
                    </Field>
                    <Field
                      label="Flip lookback (ms)"
                      hint="Le flip doit dater de moins de N ms avant l'entrée (défaut 90000 = 90s)."
                    >
                      <NumberInput
                        value={form().flipConfirmFlipLookbackMs}
                        min={1000}
                        max={300000}
                        step={1000}
                        onInput={(v) => update("flipConfirmFlipLookbackMs", v)}
                      />
                    </Field>
                    <Field
                      label="Min elapsed (sec)"
                      hint="Début de la fenêtre d'entrée (défaut 120)."
                    >
                      <NumberInput
                        value={form().flipConfirmMinElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("flipConfirmMinElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec, opt)"
                      hint="Fin de la fenêtre d'entrée (défaut 180). Les entrées après 180s sont en perte : ne pas élargir sans re-backtester."
                    >
                      <NumberInput
                        value={form().flipConfirmMaxElapsedSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("flipConfirmMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du favori à l'entrée (défaut 0.05). Liquidité."
                    >
                      <NumberInput
                        value={form().flipConfirmMaxSpread}
                        min={0}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("flipConfirmMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le nouveau favori (défaut 15)."
                    >
                      <NumberInput
                        value={form().flipConfirmOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("flipConfirmOrderUsdc", v)}
                      />
                    </Field>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>

              {/* ---- Entrée early-conviction ---- */}
              <Show when={activeSection() === "earlyconv"}>
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
                        value={form().earlyConvictionAskMin}
                        min={0.5}
                        max={0.9}
                        step={0.01}
                        onInput={(v) => update("earlyConvictionAskMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask favori max"
                      hint="Borne haute (défaut 0.80). Au-delà, la certitude est déjà payée trop cher (EV négative)."
                    >
                      <NumberInput
                        value={form().earlyConvictionAskMax}
                        min={0.55}
                        max={0.95}
                        step={0.01}
                        onInput={(v) => update("earlyConvictionAskMax", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec)"
                      hint="Fenêtre de détection : [0, N] secondes (défaut 45). Au-delà, l'entrée appartient à d'autres moteurs (fav-band, dip-revert)."
                    >
                      <NumberInput
                        value={form().earlyConvictionMaxElapsedSec}
                        min={1}
                        max={900}
                        step={1}
                        onInput={(v) => update("earlyConvictionMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du favori à l'entrée (défaut 0.05). Liquidité."
                    >
                      <NumberInput
                        value={form().earlyConvictionMaxSpread}
                        min={0}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("earlyConvictionMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le favori (défaut 15)."
                    >
                      <NumberInput
                        value={form().earlyConvictionOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("earlyConvictionOrderUsdc", v)}
                      />
                    </Field>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>

              {/* ---- Entrée early-low ---- */}
              <Show when={activeSection() === "earlylow"}>
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
                        value={form().earlyLowBuyAskMin}
                        min={0}
                        max={0.5}
                        step={0.01}
                        onInput={(v) => update("earlyLowBuyAskMin", v)}
                      />
                    </Field>
                    <Field
                      label="Ask max (cap décote)"
                      hint="Le token décoté doit coter SOUS ce cap (défaut 0.12 = 12¢)."
                    >
                      <NumberInput
                        value={form().earlyLowBuyAskMax}
                        min={0}
                        max={0.49}
                        step={0.01}
                        onInput={(v) => update("earlyLowBuyAskMax", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec)"
                      hint="Fenêtre d'entrée : [0, N] secondes (défaut 150 = 2,5 min)."
                    >
                      <NumberInput
                        value={form().earlyLowMaxElapsedSec}
                        min={1}
                        max={900}
                        step={1}
                        onInput={(v) => update("earlyLowMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du token ciblé à l'entrée (défaut 0.06). Liquidité."
                    >
                      <NumberInput
                        value={form().earlyLowMaxSpread}
                        min={0}
                        max={0.3}
                        step={0.01}
                        onInput={(v) => update("earlyLowMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Budget (USDC)"
                      hint="Budget FOK du token décoté (défaut 1)."
                    >
                      <NumberInput
                        value={form().earlyLowOrderUsdc}
                        min={0.5}
                        step={0.5}
                        onInput={(v) => update("earlyLowOrderUsdc", v)}
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
                        value={form().earlyLowExitEnabled ? "on" : "off"}
                        onChange={(e) =>
                          update("earlyLowExitEnabled", e.currentTarget.value === "on")
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
                        value={form().earlyLowExitAsk}
                        min={0}
                        max={1}
                        step={0.01}
                        onInput={(v) => update("earlyLowExitAsk", v)}
                      />
                    </Field>
                    <Field
                      label="Progression min / tick"
                      hint="Hold tant que l'ask monte d'au moins N entre deux ticks (défaut 0 = seul le tick plat/baisse coupe). Stagnation/baisse = SELL."
                    >
                      <NumberInput
                        value={form().earlyLowExitMomentumMin}
                        min={0}
                        max={0.1}
                        step={0.001}
                        onInput={(v) => update("earlyLowExitMomentumMin", v)}
                      />
                    </Field>
                    <Field
                      label="15m uniquement"
                      hint="Refuse les marchés non-15m (défaut actif)."
                    >
                      <select
                        class="cfg-input"
                        value={form().earlyLow15mOnly ? "on" : "off"}
                        onChange={(e) =>
                          update("earlyLow15mOnly", e.currentTarget.value === "on")
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
              </Show>

              {/* ---- Entrée open-entry ---- */}
              <Show when={activeSection() === "openentry"}>
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
                        value={form().openEntryLeanTrigger}
                        min={0.01}
                        max={0.5}
                        step={0.01}
                        onInput={(v) => update("openEntryLeanTrigger", v)}
                      />
                    </Field>
                    <Field
                      label="Max elapsed (sec)"
                      hint="Fenêtre d'entrée : [0, N] secondes (défaut 300). Le trigger est atteint à p50 ~20s."
                    >
                      <NumberInput
                        value={form().openEntryMaxElapsedSec}
                        min={1}
                        max={900}
                        step={1}
                        onInput={(v) => update("openEntryMaxElapsedSec", v)}
                      />
                    </Field>
                    <Field
                      label="Fair ask sum max"
                      hint="Somme des asks au 1er tick (défaut 1.02). Marché ouvert fair — pas d'arbitrage d'ouverture."
                    >
                      <NumberInput
                        value={form().openEntryFairAskSumMax}
                        min={1.001}
                        max={1.2}
                        step={0.01}
                        onInput={(v) => update("openEntryFairAskSumMax", v)}
                      />
                    </Field>
                    <Field
                      label="Max spread"
                      hint="Spread max du favori à l'entrée (défaut 0.04). Liquidité."
                    >
                      <NumberInput
                        value={form().openEntryMaxSpread}
                        min={0}
                        max={0.2}
                        step={0.005}
                        onInput={(v) => update("openEntryMaxSpread", v)}
                      />
                    </Field>
                    <Field
                      label="Order size (USDC)"
                      hint="Budget FOK sur le favori (défaut 15)."
                    >
                      <NumberInput
                        value={form().openEntryOrderUsdc}
                        min={0.1}
                        step={0.1}
                        onInput={(v) => update("openEntryOrderUsdc", v)}
                      />
                    </Field>
                    <Field
                      label="SL actif"
                      hint="Stop-loss dual-scale on/off (défaut on). Off = hold intégral."
                    >
                      <select
                        class="cfg-input"
                        value={form().openEntrySlEnabled ? "on" : "off"}
                        onChange={(e) =>
                          update("openEntrySlEnabled", e.currentTarget.value === "on")
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
                        value={form().openEntrySlStructFlipDist}
                        min={0.01}
                        max={1}
                        step={0.01}
                        onInput={(v) => update("openEntrySlStructFlipDist", v)}
                      />
                    </Field>
                    <Field
                      label="SL struct : confirm (sec)"
                      hint="Le flip doit durer >= N secondes (défaut 20) — coupe les faux retournements."
                    >
                      <NumberInput
                        value={form().openEntrySlStructConfirmSec}
                        min={0}
                        max={900}
                        step={1}
                        onInput={(v) => update("openEntrySlStructConfirmSec", v)}
                      />
                    </Field>
                    <Field
                      label="SL struct : dégât"
                      hint="ET le prix tenu a perdu >= X (défaut 0.10) — jamais le flip seul."
                    >
                      <NumberInput
                        value={form().openEntrySlStructDist}
                        min={0.01}
                        max={1}
                        step={0.01}
                        onInput={(v) => update("openEntrySlStructDist", v)}
                      />
                    </Field>
                    <Field
                      label="SL tardif : après (sec)"
                      hint="Passé N secondes (défaut 300), un petit dégât suffit."
                    >
                      <NumberInput
                        value={form().openEntrySlLateAfterSec}
                        min={1}
                        max={900}
                        step={1}
                        onInput={(v) => update("openEntrySlLateAfterSec", v)}
                      />
                    </Field>
                    <Field
                      label="SL tardif : dégât"
                      hint="Petit dégât tardif (défaut 0.06, ≤ dégât structurel). La thèse a eu le temps de se vérifier."
                    >
                      <NumberInput
                        value={form().openEntrySlLateDist}
                        min={0.01}
                        max={1}
                        step={0.01}
                        onInput={(v) => update("openEntrySlLateDist", v)}
                      />
                    </Field>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>


              {/* ---- Probability-repricing ---- */}
              <Show when={activeSection() === "repricing"}>
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
                      <NumberInput value={form().repricingTauMinSec} min={1} max={900} step={1} onInput={(v) => update("repricingTauMinSec", v)} />
                    </Field>
                    <Field label="Spread max" hint="Spread max à l'entrée (défaut 0.03).">
                      <NumberInput value={form().repricingSpreadMax} min={0} max={0.5} step={0.005} onInput={(v) => update("repricingSpreadMax", v)} />
                    </Field>
                    <Field label="P entry max" hint="Ask max pour entrer — cheapness (défaut 0.22).">
                      <NumberInput value={form().repricingPEntryMax} min={0.01} max={1} step={0.01} onInput={(v) => update("repricingPEntryMax", v)} />
                    </Field>
                    <Field label="Edge min" hint="Edge estimé minimum après fees/slip (défaut 0.025).">
                      <NumberInput value={form().repricingEdgeMin} min={0} max={1} step={0.005} onInput={(v) => update("repricingEdgeMin", v)} />
                    </Field>
                    <Field label="Order size (USDC)" hint="Budget FOK à l'entrée (défaut 15).">
                      <NumberInput value={form().repricingOrderUsdc} min={0.1} step={0.1} onInput={(v) => update("repricingOrderUsdc", v)} />
                    </Field>
                    <Field label="Dislocation min" hint="Z-score min vs historique CLOB (défaut 1.0).">
                      <NumberInput value={form().repricingDislocationMin} min={0.1} step={0.1} onInput={(v) => update("repricingDislocationMin", v)} />
                    </Field>
                    <Field label="History window (ms)" hint="Fenêtre historique ask CLOB (défaut 15000).">
                      <NumberInput value={form().repricingHistoryWindowMs} min={1000} step={500} onInput={(v) => update("repricingHistoryWindowMs", v)} />
                    </Field>
                    <Field label="Feed max age (ms)" hint="Âge max du book / signal (défaut 250).">
                      <NumberInput value={form().repricingFeedMaxAgeMs} min={50} step={10} onInput={(v) => update("repricingFeedMaxAgeMs", v)} />
                    </Field>
                    <Field label="Signal TTL (ms)" hint="Durée de vie du signal (défaut 3000).">
                      <NumberInput value={form().repricingSignalTtlMs} min={100} step={100} onInput={(v) => update("repricingSignalTtlMs", v)} />
                    </Field>
                  </div>
                  <h5 style={{ "margin-top": "0.75rem" }}>Sortie (bid)</h5>
                  <div class="cfg-grid">
                    <Field label="Target abs" hint="Take-profit absolu en prix (défaut 0.06).">
                      <NumberInput value={form().repricingTargetAbs} min={0.01} max={1} step={0.01} onInput={(v) => update("repricingTargetAbs", v)} />
                    </Field>
                    <Field label="Target rel" hint="Take-profit relatif (0 = off, défaut 0).">
                      <NumberInput value={form().repricingTargetRel} min={0} max={5} step={0.05} onInput={(v) => update("repricingTargetRel", v)} />
                    </Field>
                    <Field label="Stop abs" hint="Stop-loss absolu (défaut 0.08).">
                      <NumberInput value={form().repricingStopAbs} min={0.01} max={1} step={0.01} onInput={(v) => update("repricingStopAbs", v)} />
                    </Field>
                    <Field label="Hold max (sec)" hint="Time-stop (défaut 120).">
                      <NumberInput value={form().repricingHoldMaxSec} min={1} step={1} onInput={(v) => update("repricingHoldMaxSec", v)} />
                    </Field>
                    <Field label="Tau force exit (sec)" hint="Force exit si tau < N (défaut 25, < tau min).">
                      <NumberInput value={form().repricingTauForceExitSec} min={1} max={900} step={1} onInput={(v) => update("repricingTauForceExitSec", v)} />
                    </Field>
                    <Field label="Spread max exit" hint="Spread max pour tenter une exit (défaut 0.05).">
                      <NumberInput value={form().repricingSpreadMaxExit} min={0} max={0.5} step={0.005} onInput={(v) => update("repricingSpreadMaxExit", v)} />
                    </Field>
                    <Field label="Late window (sec)" hint="Fenêtre tardive avant close (défaut 45).">
                      <NumberInput value={form().repricingLateWindowSec} min={1} step={1} onInput={(v) => update("repricingLateWindowSec", v)} />
                    </Field>
                  </div>
                  <h5 style={{ "margin-top": "0.75rem" }}>Risque / mode A</h5>
                  <div class="cfg-grid">
                    <Field label="Mode A" hint="Reversion mode A optionnel (défaut off).">
                      <select
                        class="cfg-input"
                        value={form().repricingModeAEnabled ? "on" : "off"}
                        onChange={(e) =>
                          update("repricingModeAEnabled", e.currentTarget.value === "on")
                        }
                      >
                        <option value="off">Off (mode C seul)</option>
                        <option value="on">On (mode A + C)</option>
                      </select>
                    </Field>
                    <Field label="Notional max / market" hint="Plafond notionnel USDC par marché (défaut 30).">
                      <NumberInput value={form().repricingNotionalMaxPerMarket} min={0.1} step={1} onInput={(v) => update("repricingNotionalMaxPerMarket", v)} />
                    </Field>
                    <Field label="Fees roundtrip" hint="Frais aller-retour estimés (défaut 0.002).">
                      <NumberInput value={form().repricingFeesRoundtrip} min={0} max={0.1} step={0.001} onInput={(v) => update("repricingFeesRoundtrip", v)} />
                    </Field>
                    <Field label="Slip entry buffer" hint="Buffer slippage entrée (défaut 0.005).">
                      <NumberInput value={form().repricingSlipEntryBuffer} min={0} max={0.1} step={0.001} onInput={(v) => update("repricingSlipEntryBuffer", v)} />
                    </Field>
                    <Field label="Slip exit buffer" hint="Buffer slippage sortie (défaut 0.005).">
                      <NumberInput value={form().repricingSlipExitBuffer} min={0} max={0.1} step={0.001} onInput={(v) => update("repricingSlipExitBuffer", v)} />
                    </Field>
                  </div>
                  <p class="cfg-section__desc" style={{ "margin-top": "0.75rem" }}>
                    Risque / exposition globale : onglet Risque (max shares, max exposure).
                    Fenêtre de trading : onglet Fenêtre.
                  </p>
                </div>
              </Show>

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

              {/* Erreurs → toasts (ToastHost) */}
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
                class={`btn btn-primary${errors().length > 0 ? " btn-danger-solid" : ""}`}
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

