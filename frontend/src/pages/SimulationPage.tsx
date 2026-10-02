import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { useTableWindow } from "../hooks/useTableWindow";
import type { JSX } from "solid-js";
import { api, type SimEngineState, type SimConfigPatch } from "../api/client";
import { countdownClass, pnlClass, toMessage } from "./simPageHelpers";
import type { ChartTarget, SimulatedPosition } from "../types";
import { ActiveMarkets } from "../components/panels/ActiveMarkets";
import { SimWhipsawStatus } from "../components/panels/SimWhipsawStatus";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { ConfirmModal } from "../components/modals/ConfirmModal";
import { CollapsibleSection, CollapseChevron, isCollapsed, writeCollapsed } from "../components/ui/Collapsible";
import { LazyMarketHistoryModal } from "../components/modals/LazyMarketHistoryModal";
import {
  simTradeToChartTarget,
  simulatedPositionToChartTarget,
} from "../utils/chart-target-adapters";
import {
  allPresetsForStrategy,
  type StrategyId,
} from "../config/strategyPresets";
import { EngineSelect, PresetSelect } from "../components/strategy/EnginePresetSelects";
import { SIM_5M_STRATEGIES, SIM_5M_FILTER_FIELDS } from "../config/sim5mStrategies";
import {
  COMMON_PARAM_SECTIONS,
  paramSectionsFor,
  strategyShortLabel,
  type ParamFieldDef,
} from "../config/strategyFields";
import {
  applySettingsToForm,
  configToForm,
  fieldErrors,
  formToSettings,
  type ConfigFormState,
} from "../utils/configForm";
import { useAdaptiveSync } from "../hooks/useAdaptiveSync";
import { useClock, clockNow } from "../stores/clockStore";
import {
  userPresets,
  commitUserPreset,
  removeUserPreset,
} from "../stores/userPresetsStore";
import { liveBidForToken, marketTitleForToken } from "../stores/marketStore";
import {
  replaceSimLists,
  replaceSimRestingAndJournal,
  simBalance,
  simConfigState,
  simEffectiveConfig,
  setSimEffectiveConfig,
  simOpenPositions,
  setSimConfigState,
  setSimOpenPositions,
  setSimEngineStats,
  simResolvedPositions,
  simEngineStats,
  simResting,
  setSimResting,
  simJournal,
  setSimJournal,
} from "../stores/simStore";
import { countdown, fmtPrice, fmtShares, fmtUsd, pct, timeStr } from "../utils/format";
import { addLog } from "../stores/logStore";
import { pushError } from "../stores/toastStore";
import "../styles/sim.css";


/** P&L non réalisé d'une position ouverte, au prix de sortie (bid live). */
function unrealizedPnl(p: SimulatedPosition): number | null {
  const bid = liveBidForToken(p.tokenId);
  if (bid == null) return null;
  return (bid - p.fillPrice) * p.size;
}

export function SimulationPage(): JSX.Element {
  // Horloge globale partagée (tick 1 s) — countdowns.
  useClock();
  const now = clockNow;
  const [sending, setSending] = createSignal(false);
  // Copie de travail de la config papier (formulaire moteur/preset/capital).
  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [presetId, setPresetId] = createSignal<string>("");
  const [capitalInput, setCapitalInput] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);
  // Presets utilisateur : store réactif partagé (localStorage hydraté au boot,
  // mutations via commitUserPreset/removeUserPreset).
  // Onglet de la section historique : positions résolues | journal des ordres.
  const [historyTab, setHistoryTab] = createSignal<"resolved" | "journal">("resolved");
  // Ordres en attente (resting GTC) + journal : centralisés dans simStore
  // (survivent à la navigation, partagés avec le dispatcher).
  // Ordre de tri des listes : plus récent d'abord par défaut.
  const [reverseOrder, setReverseOrder] = createSignal(true);

  // Dialog graphique d'historique de marché (MarketHistoryModal) : cible issue
  // d'une position résolue ou d'une ligne du journal des ordres.
  const [chartTarget, setChartTarget] = createSignal<ChartTarget | null>(null);

  // Sync REST adaptative (2 vitesses) : 60 s si SSE vivant, 10 s si perdu
  // (le SSE est replay=0 → le REST est le seul réconciliateur après coupure).
  useAdaptiveSync(
    () => {
      void api
        .simPositions("open")
        .then((data) => setSimOpenPositions(data.positions))
        .catch(() => {});
      void api
        .simTrades(300)
        .then((data) => setSimJournal(data.trades))
        .catch(() => {});
      void api
        .simResting("")
        .then((data) => setSimResting(data.resting))
        .catch(() => {});
    },
    { fastMs: 10_000, slowMs: 60_000 },
  );

  async function loadInitialState(): Promise<void> {
    try {
      const data = await api.simState();
      applyState(data.state);
      setSimEffectiveConfig(data.effectiveConfig ?? null);
      replaceSimLists(data.open, data.resolved);
      replaceSimRestingAndJournal(data.resting ?? [], data.trades ?? []);
      if (data.state.stats) setSimEngineStats(data.state.stats);
    } catch {
      addLog("Simulation : chargement de l'état impossible", undefined, true);
    }
  }

  function applyState(state: SimEngineState): void {
    setEngine(state.strategyId as StrategyId);
    setPresetId(state.presetId ?? "");
    setCapitalInput(String(state.capitalInitial));
    setSimConfigState({
      enabled: state.enabled,
      strategyId: state.strategyId,
      presetId: state.presetId,
      capitalInitial: state.capitalInitial,
    });
  }

  async function toggleEngine(): Promise<void> {
    const next = !simConfigState()?.enabled;
    setSending(true);
    try {
      const res = await api.simControl(next);
      if (!res.ok) throw new Error(res.error ?? "Échec du changement d'état");
      setSimConfigState((c) => (c ? { ...c, enabled: next } : c));
      addLog(next ? "Simulation démarrée" : "Simulation arrêtée");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  async function saveConfig(): Promise<void> {
    // Le bouton ne gère plus QUE le capital (les selects moteur/preset
    // s'appliquent immédiatement via changeEngine/changePreset). N'envoyer
    // QUE `capital` : un `strategyId`/`presetId` sans settings purgerait les
    // settings édités via le panneau Paramètres (engine.applyConfig :
    // preset explicite sans settings = REPLACE tout).
    const payload: SimConfigPatch = {};
    // Capital envoyé UNIQUEMENT si modifié : côté moteur, `capital` remplace
    // le cash courant (correction manuelle). L'envoyer systématiquement
    // écraserait le cash courant (pertes/gains) à chaque enregistrement.
    const capital = Number(capitalInput());
    if (Number.isFinite(capital) && capital > 0 && capital !== simConfigState()?.capitalInitial) {
      payload.capital = capital;
    }
    await pushConfigPatch(payload);
  }

  /**
   * Applique un patch config au moteur + recharge l'état (config effective,
   * panneau Paramètres) — mutualise control-bar / panneau Paramètres.
   */
  async function pushConfigPatch(payload: SimConfigPatch): Promise<void> {
    setSending(true);
    try {
      const res = await api.simUpdateConfig(payload);
      if (!res.ok) throw new Error(res.error ?? "Échec de l'enregistrement");
      await loadInitialState();
      addLog("Configuration de simulation enregistrée");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  /** Changement de moteur (control-bar) : applique immédiatement + preset par défaut. */
  async function changeEngine(id: StrategyId): Promise<void> {
    setEngine(id);
    const first = allPresetsForStrategy(id, [])[0];
    setPresetId(first?.id ?? "");
    await pushConfigPatch({ strategyId: id, presetId: first?.id ?? null });
  }

  /** Changement de preset (control-bar) : applique immédiatement. */
  async function changePreset(id: string): Promise<void> {
    setPresetId(id);
    await pushConfigPatch({ strategyId: engine(), presetId: id || null });
  }

  async function doReset(): Promise<void> {
    setConfirmReset(false);
    setSending(true);
    try {
      const res = await api.simReset();
      if (!res.ok) throw new Error(res.error ?? "Echec de la reinitialisation");
      await loadInitialState();
      const n = res.archived ?? 0;
      addLog(
        n > 0
          ? `Positions résolues archivées (${n}) puis vidées — positions ouvertes conservées`
          : "Aucune position résolue à archiver — positions ouvertes conservées",
      );
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  const presets = createMemo(() => allPresetsForStrategy(engine(), []));
  const currentPreset = createMemo(() => presets().find((p) => p.id === presetId()));

  // ── Détails 5m : identification du preset 5m actif (moteur antiflip-revert)
  // pour le panneau Paramètres — sélectionné via le select Preset de la barre
  // Configuration moteur (les presets 5m sont dans STRATEGY_PRESETS).
  const sim5mActiveId = createMemo(() => {
    const c = simConfigState();
    if (!c || c.strategyId !== "antiflip-revert" || !c.presetId) return null;
    return SIM_5M_STRATEGIES.some((s) => s.presetId === c.presetId) ? c.presetId : null;
  });
  const selectedSim5m = createMemo(() => {
    const id = sim5mActiveId();
    return SIM_5M_STRATEGIES.find((s) => s.presetId === id) ?? null;
  });

  /** Champs « filtres » INACTIFS pour la stratégie courante = tous les champs
   * de SIM_5M_FILTER_FIELDS moins les actifs. Affichés en section repliable. */
  const [showInactiveFilters, setShowInactiveFilters] = createSignal(false);
  const sim5mInactiveFields = createMemo(() => {
    const active = new Set(selectedSim5m()?.activeFields ?? []);
    return (Object.keys(SIM_5M_FILTER_FIELDS) as Array<keyof typeof SIM_5M_FILTER_FIELDS>)
      .filter((f) => !active.has(f));
  });

  /** Step HTML selon le champ (TP = fraction, prix = centimes, floors = 0.01). */
  function sim5mFieldStep(field: keyof typeof SIM_5M_FILTER_FIELDS): string {
    return field === "antiflipTakeProfitPct" ? "0.05" : "0.01";
  }

  // État "modifié" : compare la copie de travail à la config active du moteur.
  const capitalDirty = createMemo(() => {
    const n = Number(capitalInput());
    return Number.isFinite(n) && n > 0 && n !== simConfigState()?.capitalInitial;
  });

  // ── Panneau Paramètres : édition des paramètres de la stratégie active.
  // Form déclaratif (configForm.ts) prérempli depuis la config effective du
  // moteur ; « Appliquer » envoie le patch COMPLET (le moteur remplace les
  // settings, engine.applyConfig l.149) ; « Sauver preset » persiste en
  // localStorage (user-presets.ts, clé partagée avec la page Backtest).
  const [sim5mForm, setSim5mForm] = createSignal<ConfigFormState | null>(null);
  const [confirmPresetSave, setConfirmPresetSave] = createSignal(false);
  const [presetName, setPresetName] = createSignal("");

  // Pliage du panneau Paramètres : header toujours visible (titre + boutons
  // Réinitialiser/Appliquer), corps du formulaire pliable. État persisté via
  // le même store localStorage que les autres sections (clé "sim-settings").
  const [settingsCollapsed, setSettingsCollapsed] = createSignal(isCollapsed("sim-settings"));
  function toggleSettings(): void {
    const next = !settingsCollapsed();
    setSettingsCollapsed(next);
    writeCollapsed("sim-settings", next);
  }

  // Formulaire = config effective + settings courants du panneau.
  // GÉNÉRIQUE pour toutes les stratégies : le panneau s'affiche dès que la
  // config effective est disponible, quel que soit le moteur actif.
  const sim5mBase = createMemo(() => {
    const base = simEffectiveConfig();
    if (!base) return null;
    return base;
  });
  const sim5mFormErrors = createMemo(() => (sim5mForm() ? fieldErrors(sim5mForm()!, true) : {}));
  const sim5mHasErrors = createMemo(() => Object.keys(sim5mFormErrors()).length > 0);

  /** Re-remplit le form dès que la config effective CHANGE DE CONTENU
   * (preset/strategy switché depuis le select, la barre de contrôle ou un
   * autre onglet). Empreinte obligatoire : le SSE simConfig rediffuse la
   * config effective sur Démarrer/Arrêter (setEnabled) et Reset — nouvelle
   * référence JSON mais contenu identique — et sans empreinte ces events
   * écraseraient les éditions non appliquées du panneau. */
  let lastDerived5mForm: string | null = null;
  createEffect(() => {
    const base = sim5mBase();
    if (!base) {
      lastDerived5mForm = null;
      setSim5mForm(null);
      return;
    }
    const next = configToForm(base);
    const fingerprint = JSON.stringify(next);
    if (fingerprint === lastDerived5mForm) return;
    lastDerived5mForm = fingerprint;
    setSim5mForm(next);
  });

  function updateSim5mField<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setSim5mForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Setter brut pour le rendu générique (cast nécessaire : unions / booleans). */
  function updateSim5mFieldRaw(key: string, value: string | boolean): void {
    setSim5mForm((f) => (f ? ({ ...f, [key]: value } as ConfigFormState) : f));
  }

  /** Erreur du champ (lecture réactive inline). */
  const fieldError = (key: keyof ConfigFormState): string | undefined =>
    (sim5mFormErrors() as Partial<Record<keyof ConfigFormState, string>>)[key];

  /**
   * Composant générique d'un champ de paramètre (number/text/checkbox/select).
   * IMPORTANT SolidJS : toutes les lectures de signaux (sim5mForm, sending,
   * errors) sont INLINE dans les expressions JSX — les capturer en variables
   * avant le JSX figerait les attributs (value/disabled) au rendu initial.
   */
  function SimParamField(props: { field: ParamFieldDef }): JSX.Element {
    return (
      <label class="sim-5m-field sim-5m-field-active" title={props.field.hint ?? props.field.label}>
        {props.field.label}
        <Show
          when={props.field.type === "checkbox"}
          fallback={
            <Show
              when={props.field.type === "select"}
              fallback={
                <input
                  type={props.field.type === "text" ? "text" : "number"}
                  step={props.field.step}
                  min={props.field.min}
                  max={props.field.max}
                  placeholder={props.field.placeholder}
                  classList={{ "input-error": !!fieldError(props.field.key) }}
                  disabled={sending()}
                  value={String(sim5mForm()?.[props.field.key] ?? "")}
                  onInput={(e) => updateSim5mFieldRaw(props.field.key as string, e.currentTarget.value)}
                />
              }
            >
              <select
                classList={{ "input-error": !!fieldError(props.field.key) }}
                disabled={sending()}
                value={String(sim5mForm()?.[props.field.key] ?? "")}
                onChange={(e) => updateSim5mFieldRaw(props.field.key as string, e.currentTarget.value)}
              >
                <For each={props.field.options ?? []}>
                  {(opt) => <option value={opt.value}>{opt.label}</option>}
                </For>
              </select>
            </Show>
          }
        >
          <input
            type="checkbox"
            class="sim-5m-check"
            disabled={sending()}
            checked={Boolean(sim5mForm()?.[props.field.key])}
            onInput={(e) => updateSim5mFieldRaw(props.field.key as string, e.currentTarget.checked)}
          />
        </Show>
        <Show when={fieldError(props.field.key)}>
          <span class="field-error">{fieldError(props.field.key)}</span>
        </Show>
      </label>
    );
  }

  function resetSim5mForm(): void {
    const base = sim5mBase();
    if (base) setSim5mForm(configToForm(base));
  }

  async function applySim5mSettings(): Promise<void> {
    const form = sim5mForm();
    if (!form || sending()) return;
    const errors = fieldErrors(form, true);
    if (Object.keys(errors).length > 0) {
      pushError("Panneau paramètres : corrigez les champs invalides", { group: "sim-error", replaceGroup: true });
      return;
    }
    setSending(true);
    try {
      // presetId = preset COURANT du moteur (pas sim5mActiveId : celui-ci est
      // null pour les moteurs non-antiflip et un null explicite purgerait le
      // preset actif côté engine.applyConfig).
      const res = await api.simUpdateConfig({
        strategyId: form.strategyId,
        presetId: simConfigState()?.presetId ?? null,
        settings: formToSettings(form),
      });
      if (!res.ok) throw new Error(res.error ?? "Échec de l'application");
      await loadInitialState();
      addLog("Panneau paramètres : paramètres appliqués au moteur paper");
    } catch (e) {
      pushError("Panneau paramètres : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  async function saveSim5mPreset(): Promise<void> {
    const form = sim5mForm();
    const name = presetName().trim();
    if (!form || !name || sending()) return;
    const errors = fieldErrors(form, true);
    if (Object.keys(errors).length > 0) {
      pushError("Panneau paramètres : corrigez les champs invalides avant de sauvegarder", { group: "sim-error", replaceGroup: true });
      return;
    }
    try {
      commitUserPreset({
        name,
        description: `Preset sim utilisateur — ${strategyShortLabel(form.strategyId)}`,
        strategyId: form.strategyId,
        settings: formToSettings(form),
      });
      setPresetName("");
      setConfirmPresetSave(false);
      addLog(`Preset sauvegardé : ${name}`);
    } catch (e) {
      pushError("Panneau paramètres : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    }
  }

  function deleteSim5mPreset(id: string): void {
    removeUserPreset(id);
    addLog("Preset utilisateur supprimé");
  }
  // Avec l'application immédiate des selects (changeEngine/changePreset),
  // seul le capital reste un champ différé : le bouton « Enregistrer config »
  // ne s'active que pour lui.
  const configDirty = createMemo(() => capitalDirty());

  onMount(() => {
    void loadInitialState();
  });

  // Listes triées : "Plus récent d'abord" trié explicitement (le store peut
  // contenir un mélange hydratation REST + events SSE insérés en queue).
  const sortedResolved = createMemo(() => {
    const list = [...simResolvedPositions()];
    list.sort((a, b) => (b.resolvedAt ?? b.windowEnd * 1000) - (a.resolvedAt ?? a.windowEnd * 1000));
    return reverseOrder() ? list : list.reverse();
  });

  const sortedJournal = createMemo(() => {
    const list = [...simJournal()];
    list.sort((a, b) => b.ts - a.ts);
    return reverseOrder() ? list : list.reverse();
  });

  const journalWindow = useTableWindow(() => sortedJournal().length, { rowHeight: 34, maxHeightPx: 480 });
  const resolvedWindow = useTableWindow(() => sortedResolved().length, { rowHeight: 34, maxHeightPx: 480 });

  return (
    <div class="page simulation-page">
      {/* Header : retour + titre + badge + actions */}
      <header class="sim-header">
        <div class="sim-header-left">
          <a class="btn sim-back" href="/">
            ← Dashboard
          </a>
          <h1>Simulation live</h1>
          <Show when={simConfigState()} fallback={<span class="sim-muted">chargement…</span>}>
            {(c) => (
              <span class={`sim-badge ${c().enabled ? "on" : "off"}`}>
                {c().enabled ? "EN COURS" : "À L'ARRÊT"}
              </span>
            )}
          </Show>
        </div>
        <div class="sim-header-actions">
          <button
            class="btn btn-primary"
            onClick={() => void toggleEngine()}
            disabled={sending()}
          >
            {simConfigState()?.enabled ? "Arrêter" : "Démarrer"}
          </button>
          <button class="btn danger" onClick={() => setConfirmReset(true)}>
            Archiver résolues
          </button>
        </div>
      </header>

      {/* Cartes KPI (section pliable, état persisté) */}
      <CollapsibleSection id="sim-kpis" title="Capital & P&L (KPI)">
      <div class="sim-kpis">
        <div class="sim-kpi sim-kpi-capital">
          <span class="sim-kpi-label">Capital total</span>
          <Show when={simBalance()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(b) => (
              <>
                <span class="sim-kpi-value">{fmtUsd(b().total)}</span>
                <span class="sim-kpi-sub">
                  cash {fmtUsd(b().cash)} · positions {fmtUsd(b().positionsValue)}
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">P&L réalisé</span>
          <Show when={simEngineStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <div class="sim-kpi-pnl-row">
                <span class={`sim-kpi-value ${pnlClass(s().realizedPnl)}`}>
                  {fmtUsd(s().realizedPnl)}
                </span>
                <span
                  class={`sim-kpi-latent ${s().unrealizedPnl > 0 ? "pos" : s().unrealizedPnl < 0 ? "neg" : ""}`}
                  title="P&L latent des positions ouvertes (bid live)"
                >
                  {s().unrealizedPnl >= 0 ? "+" : "−"}
                  {fmtUsd(Math.abs(s().unrealizedPnl)).slice(1)} latent
                </span>
              </div>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">Winrate</span>
          <Show when={simEngineStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <>
                <span class="sim-kpi-value">{Math.round(s().winRate * 100)}%</span>
                <span class="sim-kpi-sub">
                  {s().wins}G / {s().losses}P · {s().resolvedPositionsCount} résolues
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="sim-kpi">
          <span class="sim-kpi-label">Exposition ouverte</span>
          <Show when={simEngineStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <>
                <span class="sim-kpi-value">{fmtUsd(s().openExposure)}</span>
                <span class="sim-kpi-sub">{s().openPositionsCount} positions ouvertes</span>
              </>
            )}
          </Show>
        </div>
      </div>
      </CollapsibleSection>

      {/* Panneau de configuration : édition runtime des paramètres de la stratégie
          ACTIVE (tous moteurs). Formulaire prérempli depuis la config effective du
          moteur ; Appliquer envoie le patch complet (le moteur remplace ses
          settings) ; les presets utilisateurs sont persistés en localStorage
          (clé partagée avec la page Backtest). Les sections s'adaptent au moteur :
          communes + spécifiques (strategyFields.ts), filtres 5m actifs/inactifs
          pour antiflip-revert uniquement. */}
      <Show when={sim5mForm() !== null}>
        <div class="sim-5m-config-panel">
          <div class="sim-5m-cp-header" role="button" tabindex={0} aria-expanded={!settingsCollapsed()} onClick={() => toggleSettings()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSettings(); } }}>
            <span class="sim-5m-cp-title">
              <CollapseChevron open={!settingsCollapsed()} />
              Paramètres — {strategyShortLabel(sim5mForm()!.strategyId)}{currentPreset() ? ` · ${currentPreset()?.name}` : ""}
            </span>
            <div class="sim-5m-cp-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <button
                class="btn btn-ghost"
                disabled={sending()}
                onClick={() => resetSim5mForm()}
              >
                Réinitialiser
              </button>
              <button
                class="btn btn-primary"
                disabled={sending() || sim5mHasErrors()}
                onClick={() => void applySim5mSettings()}
              >
                Appliquer au moteur
              </button>
            </div>
          </div>

          <Show when={!settingsCollapsed()}>
          {/* ── Paramètres communs à tous les moteurs (marchés, garde-fous, fenêtre, sim) ── */}
          <For each={COMMON_PARAM_SECTIONS}>
            {(section) => (
              <div class="sim-5m-cp-section">
                <span class="sim-5m-cp-subtitle">{section.title}</span>
                <div class="sim-5m-cp-grid">
                  <For each={section.fields}>
                    {(field) => <SimParamField field={field} />}
                  </For>
                </div>
              </div>
            )}
          </For>

          {/* ── Sections spécifiques au moteur sélectionné ── */}
          <For each={paramSectionsFor(sim5mForm()!.strategyId)}>
            {(section) => (
              <div class="sim-5m-cp-section">
                <span class="sim-5m-cp-subtitle">{section.title}</span>
                <div class="sim-5m-cp-grid">
                  <For each={section.fields}>
                    {(field) => <SimParamField field={field} />}
                  </For>
                </div>
              </div>
            )}
          </For>

          {/* ── Filtres 5m ACTIFS de la stratégie sélectionnée (moteur antiflip-revert uniquement) ── */}
          <Show when={sim5mForm()!.strategyId === "antiflip-revert" && selectedSim5m()?.activeFields.length}>
            <div class="sim-5m-cp-section">
              <span class="sim-5m-cp-subtitle">
                Filtres actifs — {selectedSim5m()?.name}
              </span>
              <div class="sim-5m-cp-grid">
                <For each={selectedSim5m()?.activeFields ?? []}>
                  {(field) => (
                    <label class="sim-5m-field sim-5m-field-active">
                      {SIM_5M_FILTER_FIELDS[field]}
                      <input
                        type="number"
                        step={sim5mFieldStep(field)}
                        min="0"
                        classList={{ "input-error": !!sim5mFormErrors()[field] }}
                        disabled={sending()}
                        onInput={(e) => updateSim5mField(field, e.currentTarget.value)}
                        value={sim5mForm()![field]}
                      />
                      <Show when={sim5mFormErrors()[field]}>
                        <span class="field-error">{sim5mFormErrors()[field]}</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* ── Filtres 5m inactifs (section avancée repliable) ── */}
          <Show when={sim5mForm()!.strategyId === "antiflip-revert" && sim5mInactiveFields().length > 0}>
            <div class="sim-5m-cp-section">
              <button
                type="button"
                class="btn btn-ghost sim-5m-cp-collapse"
                onClick={() => setShowInactiveFilters((v) => !v)}
              >
                {showInactiveFilters() ? "▾" : "▸"} Filtres inactifs ({sim5mInactiveFields().length})
              </button>
              <Show when={showInactiveFilters()}>
                <div class="sim-5m-cp-grid">
                  <For each={sim5mInactiveFields()}>
                    {(field) => (
                      <label class="sim-5m-field sim-5m-field-inactive">
                        {SIM_5M_FILTER_FIELDS[field]}
                        <input
                          type="number"
                          step={sim5mFieldStep(field)}
                          min="0"
                          classList={{ "input-error": !!sim5mFormErrors()[field] }}
                          disabled={sending()}
                          onInput={(e) => updateSim5mField(field, e.currentTarget.value)}
                          value={sim5mForm()![field]}
                        />
                        <Show when={sim5mFormErrors()[field]}>
                          <span class="field-error">{sim5mFormErrors()[field]}</span>
                        </Show>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          {/* ── Presets utilisateur ── */}
          <div class="sim-5m-cp-presets">
            <span class="sim-5m-cp-subtitle">Presets utilisateur</span>
            <Show
              when={confirmPresetSave()}
              fallback={
                <button
                  class="btn btn-ghost"
                  disabled={sending() || sim5mHasErrors()}
                  onClick={() => setConfirmPresetSave(true)}
                >
                  + Sauvegarder l'état courant comme preset
                </button>
              }
            >
              <div class="sim-5m-preset-save">
                <input
                  type="text"
                  placeholder="Nom du preset"
                  value={presetName()}
                  disabled={sending()}
                  onInput={(e) => setPresetName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveSim5mPreset();
                    if (e.key === "Escape") setConfirmPresetSave(false);
                  }}
                />
                <button class="btn btn-primary" disabled={!presetName().trim() || sending()} onClick={() => void saveSim5mPreset()}>
                  Enregistrer
                </button>
                <button class="btn btn-ghost" onClick={() => setConfirmPresetSave(false)}>Annuler</button>
              </div>
            </Show>
            <Show when={userPresets().length > 0}>
              <div class="sim-5m-preset-list">
                <For each={userPresets().filter((p) => p.strategyId === sim5mForm()!.strategyId)}>
                  {(p) => (
                    <div class="sim-5m-preset-item">
                      <span class="sim-5m-preset-name" title={p.description}>{p.name}</span>
                      <div class="sim-5m-preset-actions">
                        <button
                          class="btn btn-ghost"
                          title="Charger dans le formulaire"
                          disabled={sending()}
                          onClick={() => {
                            const base = sim5mBase();
                            if (base) setSim5mForm(applySettingsToForm(base, p.settings));
                          }}
                        >
                          Charger
                        </button>
                        <button class="btn btn-ghost btn-danger" onClick={() => deleteSim5mPreset(p.id)}>
                          Suppr.
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
          </Show>
        </div>
      </Show>

      {/* Barre de configuration : groupes Stratégie | Capital + actions */}
      <CollapsibleSection id="sim-config-bar" title="Configuration moteur (stratégie & capital)">
      <div class="sim-control-bar">
        <div class="sim-cb-group">
          <span class="sim-cb-title">Stratégie</span>
          <div class="sim-cb-fields">
            <label class="sim-field">
              Moteur
              <EngineSelect
                value={engine()}
                disabled={sending()}
                onChange={(id) => {
                  void changeEngine(id);
                }}
              />
            </label>
            <label class="sim-field">
              Preset
              <PresetSelect
                value={presetId()}
                disabled={sending()}
                onChange={(id) => {
                  void changePreset(id);
                }}
                presets={presets()}
                emptyLabel="Aucun preset"
              />
            </label>
          </div>
          <Show when={currentPreset()}>
            {(p) => <p class="sim-cb-hint">{p().description}</p>}
          </Show>
        </div>
        <div class="sim-cb-divider" />
        <div class="sim-cb-group">
          <span class="sim-cb-title">Capital</span>
          <div class="sim-cb-fields">
            <label class="sim-field">
              Capital initial
              <span class="sim-field-control">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={capitalInput()}
                  onInput={(e) => setCapitalInput(e.currentTarget.value)}
                />
                <span class="sim-field-unit">pUSD</span>
              </span>
            </label>
          </div>
          <Show when={capitalDirty()}>
            <p class="sim-cb-hint warn">
              Modifié : l'enregistrement remplace le cash courant ({fmtUsd(simBalance()?.cash ?? 0)}).
            </p>
          </Show>
        </div>
        <div class="sim-cb-actions">
          <Show when={capitalDirty()}>
            <button
              class="btn sim-cb-revert"
              type="button"
              onClick={() => setCapitalInput(String(simConfigState()?.capitalInitial ?? ""))}
            >
              Annuler
            </button>
          </Show>
          <button
            class={`btn ${configDirty() ? "btn-primary" : ""}`}
            onClick={() => void saveConfig()}
            disabled={sending() || !configDirty()}
            title={configDirty() ? "Appliquer le capital au moteur de simulation" : "Aucune modification à enregistrer"}
          >
            Enregistrer config
          </button>
        </div>
      </div>
      </CollapsibleSection>

      {/* Filtre whipsaw (paper) : statut + pause + reset — moteur sim fav-band.
          Masqué si le moteur sim actif n'est pas fav-band (status null). */}
      <div class="sim-whipsaw">
        <SimWhipsawStatus />
      </div>

      <div class="grid">
        {/* Positions ouvertes */}
        <Panel
          title={`Positions ouvertes (${simOpenPositions().length})`}
          collapsible
          collapsibleId="sim-open-positions"
        >
          <Show
            when={simOpenPositions().length > 0}
            fallback={<EmptyState text="Aucune position papier ouverte." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Moteur</th>
                  <th>Fill</th>
                  <th>Size</th>
                  <th>Coût</th>
                  <th>P&L en cours</th>
                  <th>Fin de fenêtre</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                <For each={simOpenPositions()}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>{p.eventTitle}</td>
                      <td>{p.outcome}</td>
                      <td>{p.kind}</td>
                      <td>{p.strategyId ?? "—"}</td>
                      <td>{fmtPrice(p.fillPrice)}</td>
                      <td>{fmtShares(p.size)}</td>
                      <td>{fmtUsd(p.cost)}</td>
                      <td class={pnlClass(unrealizedPnl(p) ?? 0)}>
                        <Show when={unrealizedPnl(p) != null} fallback="—">
                          {fmtUsd(unrealizedPnl(p)!)}
                          <Show when={p.cost > 0}>
                            <span class="sim-pnl-pct"> ({pct((unrealizedPnl(p)! / p.cost) * 100)})</span>
                          </Show>
                        </Show>
                      </td>
                      <td class={countdownClass(p.windowEnd, now())}>
                        {countdown(p.windowEnd, now())}
                      </td>
                      <td>{p.orderType ?? "GTC"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Panel>

        {/* Ordres en attente (GTC papier non encore remplis) */}
        <Panel
          title={`Ordres en attente (${simResting().length})`}
          collapsible
          collapsibleId="sim-resting-orders"
        >
          <Show
            when={simResting().length > 0}
            fallback={<EmptyState text="Aucun ordre GTC en attente." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Limite</th>
                  <th>Taille</th>
                  <th>Coût</th>
                  <th>Fin de fenêtre</th>
                </tr>
              </thead>
              <tbody>
                <For each={simResting()}>
                  {(o) => (
                    <tr class="sim-resting-row" title={o.key}>
                      <td>{marketTitleForToken(o.tokenId)}</td>
                      <td>{o.outcome}</td>
                      <td>{o.kind}</td>
                      <td>{fmtPrice(o.limitPrice)}</td>
                      <td>{fmtShares(o.size)}</td>
                      <td>{fmtUsd(o.cost)}</td>
                      <td class={countdownClass(o.windowEnd, now())}>
                        {countdown(o.windowEnd, now())}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Panel>
      </div>

      {/* Marché actif (temps réel, réutilise marketStore alimenté par SSE) */}
      <div class="sim-active-markets">
        <Panel title="Marché actif (temps réel)" collapsible collapsibleId="sim-active-markets">
          <ActiveMarkets now={now()} />
        </Panel>
      </div>

      {/* Historique à onglets : positions résolues | journal des ordres */}
      <div class="sim-history">
        <CollapsibleSection id="sim-history" boxed title="Historique — positions résolues | journal des ordres">
          <div class="sim-tabs">
          <button
            class={`sim-tab ${historyTab() === "resolved" ? "active" : ""}`}
            onClick={() => setHistoryTab("resolved")}
          >
            Positions résolues ({simResolvedPositions().length})
          </button>
          <button
            class={`sim-tab ${historyTab() === "journal" ? "active" : ""}`}
            onClick={() => setHistoryTab("journal")}
          >
            Journal des ordres ({simJournal().length})
          </button>
          <label class="sim-tab-toggle" title="Inverser l'ordre d'affichage">
            <input
              type="checkbox"
              checked={reverseOrder()}
              onChange={(e) => setReverseOrder(e.currentTarget.checked)}
            />
            Plus récent d'abord
          </label>
          <button
            class="btn danger sim-tab-archive"
            type="button"
            disabled={sending() || simResolvedPositions().length === 0}
            title="Archiver les positions résolues en DB puis vider cette liste (ouvertes intactes)"
            onClick={() => setConfirmReset(true)}
          >
            Archiver résolues
          </button>
        </div>

        <Show when={historyTab() === "resolved"} fallback={
          /* Onglet journal : chaque ordre simulé (rempli ou non) */
          <Show
            when={sortedJournal().length > 0}
            fallback={<EmptyState text="Aucun ordre simulé pour l'instant." />}
          >
            <div
              class="sim-table-scroll"
              ref={journalWindow.setRef}
              onScroll={journalWindow.onScroll}
              style={journalWindow.scrollerStyle()}
            >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Heure</th>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Côté</th>
                  <th>Limite</th>
                  <th>Fill</th>
                  <th>Taille</th>
                  <th>Type</th>
                  <th>P&L</th>
                  <th>Graph</th>
                </tr>
              </thead>
              <tbody>
                  <Show when={journalWindow.active() && journalWindow.padTop() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${journalWindow.padTop()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
                <For each={journalWindow.slice(sortedJournal())}>
                  {(t) => (
                    <tr
                      class={t.filled ? "" : "sim-resting-row"}
                      title={t.reason ?? undefined}
                    >
                      <td>{timeStr(t.ts)}</td>
                      <td>{t.eventSlug}</td>
                      <td>{t.outcome}</td>
                      <td>{t.kind}</td>
                      <td class={t.side === "BUY" ? "ok" : "err"}>{t.side}</td>
                      <td>{fmtPrice(t.limitPrice)}</td>
                      <td>{t.fillPrice != null ? fmtPrice(t.fillPrice) : "—"}</td>
                      <td>{fmtShares(t.size)}</td>
                      <td>{t.orderType ?? "—"}</td>
                      <td class={pnlClass(t.pnl ?? 0)}>
                        {t.pnl != null ? fmtUsd(t.pnl) : "—"}
                      </td>
                      <td>
                        <button
                          class="chart-btn"
                          type="button"
                          title="Voir le graphique du marché avec les points d'entrée/sortie"
                          onClick={() => setChartTarget(simTradeToChartTarget(t))}
                        >
                          📊
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
                  <Show when={journalWindow.active() && journalWindow.padBottom() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${journalWindow.padBottom()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
              </tbody>
            </table>
            </div>
          </Show>
        }>
          {/* Onglet positions résolues */}
          <Show
            when={sortedResolved().length > 0}
            fallback={<EmptyState text="Aucune position résolue pour l'instant." />}
          >
            <div
              class="sim-table-scroll"
              ref={resolvedWindow.setRef}
              onScroll={resolvedWindow.onScroll}
              style={resolvedWindow.scrollerStyle()}
            >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Moteur</th>
                  <th>Fill</th>
                  <th>Vente</th>
                  <th>Size</th>
                  <th>P&L</th>
                  <th>Résolu</th>
                  <th>Status</th>
                  <th>Graph</th>
                </tr>
              </thead>
              <tbody>
                  <Show when={resolvedWindow.active() && resolvedWindow.padTop() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${resolvedWindow.padTop()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
                <For each={resolvedWindow.slice(sortedResolved())}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>{p.eventTitle}</td>
                      <td>{p.outcome}</td>
                      <td>{p.kind}</td>
                      <td>{p.strategyId ?? "—"}</td>
                      <td>{fmtPrice(p.fillPrice)}</td>
                      <td>{p.sellPrice != null ? fmtPrice(p.sellPrice) : "—"}</td>
                      <td>{fmtShares(p.size)}</td>
                      <td class={pnlClass(p.pnl ?? 0)}>{fmtUsd(p.pnl ?? 0)}</td>
                      <td>{timeStr(p.resolvedAt ?? p.windowEnd * 1000)}</td>
                      <td>{p.status}</td>
                      <td>
                        <button
                          class="chart-btn"
                          type="button"
                          title="Voir le graphique du marché avec les points d'entrée/sortie"
                          onClick={() => setChartTarget(simulatedPositionToChartTarget(p))}
                        >
                          📊
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
                  <Show when={resolvedWindow.active() && resolvedWindow.padBottom() > 0}>
                    <tr aria-hidden="true">
                      <td colspan="11" style={{ height: `${resolvedWindow.padBottom()}px`, padding: "0", border: "none" }} />
                    </tr>
                  </Show>
              </tbody>
            </table>
            </div>
          </Show>
        </Show>
        </CollapsibleSection>
      </div>

      <ConfirmModal
        open={confirmReset()}
        title="Archiver les positions résolues ?"
        message="Les positions résolues sont copiées dans l'archive DB puis retirées de la liste. Les positions ouvertes, ordres en attente et le capital restent intacts."
        confirmLabel="Archiver & vider"
        onConfirm={() => void doReset()}
        onCancel={() => setConfirmReset(false)}
      />

      {/* Dialog graphique : historique de prix du marché + markers entrée/sortie */}
      <Show when={chartTarget()}>
        {(t) => (
          <LazyMarketHistoryModal target={t()} onClose={() => setChartTarget(null)} />
        )}
      </Show>
    </div>
  );
}