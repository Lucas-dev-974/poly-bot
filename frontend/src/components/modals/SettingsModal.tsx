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
import { SECTIONS, type SectionId } from "./settings/settingsSections";
import { PresetsSection } from "./settings/PresetsSection";
import { MarketsSection } from "./settings/MarketsSection";
import { CheapSection } from "./settings/CheapSection";
import { HedgeSection } from "./settings/HedgeSection";
import { EdgeSection } from "./settings/EdgeSection";
import { FavSection } from "./settings/FavSection";
import { DipSection } from "./settings/DipSection";
import { AntiflipSection } from "./settings/AntiflipSection";
import { FlipConfirmSection } from "./settings/FlipConfirmSection";
import { EarlyConvictionSection } from "./settings/EarlyConvictionSection";
import { EarlyLowSection } from "./settings/EarlyLowSection";
import { OpenEntrySection } from "./settings/OpenEntrySection";
import { RepricingSection } from "./settings/RepricingSection";
import { RiskSection } from "./settings/RiskSection";
import { WindowSection } from "./settings/WindowSection";

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
                <PresetsSection
                  form={form}
                  update={update}
                  customEngines={customEngines}
                  enginePresets={enginePresets}
                  matchingPresetId={matchingPresetId}
                  matchingPreset={matchingPreset}
                  dirty={dirty}
                  applyPreset={applyPreset}
                />
              </Show>

              {/* ---- Marchés ---- */}
              <Show when={activeSection() === "markets"}>
                <MarketsSection
                  form={form}
                  update={update}
                  usesEdge={usesEdge}
                />
              </Show>

              {/* ---- Jambe cheap ---- */}
              <Show when={activeSection() === "cheap"}>
                <CheapSection form={form} update={update} />
              </Show>

              {/* ---- Jambe hedge ---- */}
              <Show when={activeSection() === "hedge"}>
                <HedgeSection form={form} update={update} />
              </Show>

              {/* ---- Jambe edge (edge-lead) ---- */}
              <Show when={activeSection() === "edge"}>
                <EdgeSection form={form} update={update} />
              </Show>

              {/* ---- Risque ---- */}

              {/* ---- Entrée fav-band ---- */}
              <Show when={activeSection() === "fav"}>
                <FavSection form={form} update={update} />
              </Show>

              {/* ---- Entrée dip-revert ---- */}
              <Show when={activeSection() === "dip"}>
                <DipSection form={form} update={update} />
              </Show>

              {/* ---- Entrée antiflip-revert ---- */}
              <Show when={activeSection() === "antiflip"}>
                <AntiflipSection form={form} update={update} />
              </Show>

              {/* ---- Entrée flip-confirm ---- */}
              <Show when={activeSection() === "flipconf"}>
                <FlipConfirmSection form={form} update={update} />
              </Show>

              {/* ---- Entrée early-conviction ---- */}
              <Show when={activeSection() === "earlyconv"}>
                <EarlyConvictionSection form={form} update={update} />
              </Show>

              {/* ---- Entrée early-low ---- */}
              <Show when={activeSection() === "earlylow"}>
                <EarlyLowSection form={form} update={update} />
              </Show>

              {/* ---- Entrée open-entry ---- */}
              <Show when={activeSection() === "openentry"}>
                <OpenEntrySection form={form} update={update} />
              </Show>


              {/* ---- Probability-repricing ---- */}
              <Show when={activeSection() === "repricing"}>
                <RepricingSection form={form} update={update} />
              </Show>

              <Show when={activeSection() === "risk"}>
                <RiskSection form={form} update={update} />
              </Show>

              {/* ---- Fenêtre ---- */}
              <Show when={activeSection() === "window"}>
                <WindowSection form={form} update={update} />
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


