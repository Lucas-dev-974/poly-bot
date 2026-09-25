import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api, type SimEngineState, type SimConfigPatch, type SimTrade, type SimRestingOrder } from "../api/client";
import type { SimulatedPosition } from "../types";
import { ActiveMarkets } from "../components/panels/ActiveMarkets";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { ConfirmModal } from "../components/modals/ConfirmModal";
import {
  allPresetsForStrategy,
  STRATEGY_ENGINE_OPTIONS,
  type StrategyId,
} from "../config/strategyPresets";
import { SIM_5M_STRATEGIES, SIM_5M_FILTER_FIELDS, type Sim5mStrategyDef } from "../config/sim5mStrategies";
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
import {
  deleteUserPreset,
  loadUserPresets,
  saveUserPreset,
  type UserPreset,
} from "../utils/user-presets";
import { useEventSource } from "../hooks/useEventSource";
import { useInterval } from "../hooks/useInterval";
import { dispatchEvent } from "../stores/dispatcher";
import { markets } from "../stores/marketStore";
import {
  replaceSimLists,
  simBalance,
  simConfigState,
  simEffectiveConfig,
  setSimEffectiveConfig,
  simOpenPositions,
  setSimConfigState,
  setSimOpenPositions,
  setSimEngineStats,
  simResolvedPositions,
  simStats,
} from "../stores/simStore";
import { countdown, fmtPrice, fmtShares, fmtUsd, pct, timeStr } from "../utils/format";
import { addLog } from "../stores/logStore";
import { pushError } from "../stores/toastStore";

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pnlClass(pnl: number): string {
  if (pnl > 0) return "pnl-pos";
  if (pnl < 0) return "pnl-neg";
  return "";
}

/** Classe du countdown selon l'urgence (miroir des seuils ActiveMarkets). */
function countdownClass(windowEnd: number, now: number): string {
  const left = windowEnd * 1000 - now;
  if (left <= 5 * 60 * 1000) return "am-countdown--hot";
  if (left <= 15 * 60 * 1000) return "am-countdown--warm";
  return "";
}

/** Titre du marché pour un tokenId (lookup dans le store markets SSE). */
function marketTitleForToken(tokenId: string): string {
  for (const m of Object.values(markets)) {
    if (m.books.some((b) => b.tokenId === tokenId)) return m.title;
  }
  return tokenId.length > 14 ? `${tokenId.slice(0, 14)}…` : tokenId;
}

/**
 * Bid live d'un tokenId (store markets SSE). Appelée dans le JSX d'une ligne :
 * les lectures du store sont trackées → la cellule se met à jour à chaque tick.
 */
function liveBidForToken(tokenId: string): number | null {
  for (const m of Object.values(markets)) {
    const book = m.books.find((b) => b.tokenId === tokenId);
    if (book?.bestBid != null) return book.bestBid;
  }
  return null;
}

/** P&L non réalisé d'une position ouverte, au prix de sortie (bid live). */
function unrealizedPnl(p: SimulatedPosition): number | null {
  const bid = liveBidForToken(p.tokenId);
  if (bid == null) return null;
  return (bid - p.fillPrice) * p.size;
}

export function SimulationPage(): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const [sending, setSending] = createSignal(false);
  // Copie de travail de la config papier (formulaire moteur/preset/capital).
  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [presetId, setPresetId] = createSignal<string>("");
  const [capitalInput, setCapitalInput] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);
  // Onglet de la section historique : positions résolues | journal des ordres.
  const [historyTab, setHistoryTab] = createSignal<"resolved" | "journal">("resolved");
  // Ordres en attente (resting GTC), hydratés via /api/sim/state puis /api/sim/resting.
  const [resting, setResting] = createSignal<SimRestingOrder[]>([]);
  // Journal des ordres (sim_trades), hydraté à l'ouverture puis rafraîchi au tick 10s.
  const [journal, setJournal] = createSignal<SimTrade[]>([]);
  // Ordre de tri des listes : plus récent d'abord par défaut.
  const [reverseOrder, setReverseOrder] = createSignal(true);

  // SSE → dispatcher (simStore + marketStore pour « Marché actif »)
  useEventSource(dispatchEvent);

  // Tick 1s (countdowns).
  useInterval(() => setNow(Date.now()), 1000);

  // Sync REST 10s : fallback si SSE perdu + refresh journal/resting.
  useInterval(() => {
    void api
      .simPositions("open")
      .then((data) => setSimOpenPositions(data.positions))
      .catch(() => {});
    void api
      .simTrades(300)
      .then((data) => setJournal(data.trades))
      .catch(() => {});
    void api
      .simResting("")
      .then((data) => setResting(data.resting))
      .catch(() => {});
  }, 10_000);

  async function loadInitialState(): Promise<void> {
    try {
      const data = await api.simState();
      applyState(data.state);
      setSimEffectiveConfig(data.effectiveConfig ?? null);
      replaceSimLists(data.open, data.resolved);
      setResting(data.resting ?? []);
      setJournal(data.trades ?? []);
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
   * select 5m, panneau Paramètres) — mutualise control-bar / panneau 5m.
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
      if (!res.ok) throw new Error(res.error ?? "Échec de la réinitialisation");
      await loadInitialState();
      replaceSimLists([], []);
      addLog("Simulation réinitialisée (capital + positions + journal)");
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  const presets = createMemo(() => allPresetsForStrategy(engine(), []));
  const currentPreset = createMemo(() => presets().find((p) => p.id === presetId()));

  // ── Sélection rapide des 3 stratégies 5m (presets du backtest audits/5min-strategies).
  // Chaque carte = (moteur antiflip-revert, preset 5m). "Active" = config de travail
  // du moteur sim correspond à ce preset. Une seule position à la fois : les 3
  // variantes sont mutuellement exclusives au niveau du moteur sim (un preset à la
  // fois), mais restent combinables en multi-moteurs via le live.
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

  async function activateSim5mStrategy(def: Sim5mStrategyDef): Promise<void> {
    if (sending()) return;
    setSending(true);
    try {
      // 1. Appliquer le preset au moteur sim (swap à chaud, sans toucher au cash).
      const res = await api.simUpdateConfig({
        strategyId: def.strategyId,
        presetId: def.presetId,
      });
      if (!res.ok) throw new Error(res.error ?? "Échec de l'activation");
      // 2. Démarrer la sim si elle est à l'arrêt (activation = prête à trader).
      if (!simConfigState()?.enabled) {
        const start = await api.simControl(true);
        if (!start.ok) throw new Error(start.error ?? "Échec du démarrage");
      }
      await loadInitialState();
      addLog(`Simulation 5m : stratégie ${def.name} activée (marchés 5m uniquement)`);
    } catch (e) {
      pushError("Simulation : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setSending(false);
    }
  }

  // État "modifié" : compare la copie de travail à la config active du moteur.
  const capitalDirty = createMemo(() => {
    const n = Number(capitalInput());
    return Number.isFinite(n) && n > 0 && n !== simConfigState()?.capitalInitial;
  });

  // ── Panneau de configuration 5m : édition des paramètres de la stratégie active.
  // Form déclaratif (configForm.ts) prérempli depuis la config effective du
  // moteur ; « Appliquer » envoie le patch COMPLET (le moteur remplace les
  // settings, engine.applyConfig l.149) ; « Sauver preset » persiste en
  // localStorage (user-presets.ts, clé partagée avec la page Backtest).
  const [sim5mForm, setSim5mForm] = createSignal<ConfigFormState | null>(null);
  const [confirmPresetSave, setConfirmPresetSave] = createSignal(false);
  const [presetName, setPresetName] = createSignal("");
  const [userPresets, setUserPresets] = createSignal<UserPreset[]>([]);

  // Hydrate les presets utilisateur (localStorage) une fois au montage.
  onMount(() => setUserPresets(loadUserPresets()));

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
    const presetId = sim5mActiveId();
    if (!base) {
      lastDerived5mForm = null;
      setSim5mForm(null);
      return;
    }
    void presetId;
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
      saveUserPreset({
        name,
        description: `Preset sim utilisateur — ${strategyShortLabel(form.strategyId)}`,
        strategyId: form.strategyId,
        settings: formToSettings(form),
      });
      setUserPresets(loadUserPresets());
      setPresetName("");
      setConfirmPresetSave(false);
      addLog(`Preset sauvegardé : ${name}`);
    } catch (e) {
      pushError("Panneau paramètres : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    }
  }

  function deleteSim5mPreset(id: string): void {
    deleteUserPreset(id);
    setUserPresets(loadUserPresets());
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
    const list = [...journal()];
    list.sort((a, b) => b.ts - a.ts);
    return reverseOrder() ? list : list.reverse();
  });

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
            Réinitialiser
          </button>
        </div>
      </header>

      {/* Cartes KPI */}
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
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
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
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
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
          <Show when={simStats()} fallback={<span class="sim-kpi-value sim-muted">—</span>}>
            {(s) => (
              <>
                <span class="sim-kpi-value">{fmtUsd(s().openExposure)}</span>
                <span class="sim-kpi-sub">{s().openPositionsCount} positions ouvertes</span>
              </>
            )}
          </Show>
        </div>
      </div>

      {/* Sélecteur dédié : les 5 stratégies 5m (hold A/H/K + TP10/TP20), backtest audits/5min-strategies.
          Le gate "5m uniquement" vit dans le moteur (antiflip5mOnly) : impossible d'ouvrir
          une position papier sur un marché non-5m. Le select reflète l'état réel du moteur
          (valeur = preset actif), un changement déclenche l'activation immédiate. */}
      <div class="sim-5m-select-block">
        <label class="sim-5m-select-label" for="sim-5m-strategy-select">Stratégie 5m</label>
        <select
          id="sim-5m-strategy-select"
          class={sim5mActiveId() ? "sim-5m-select sim-5m-select--active" : "sim-5m-select"}
          disabled={sending()}
          value={sim5mActiveId() ?? ""}
          onChange={(e) => {
            const id = e.currentTarget.value;
            const def = SIM_5M_STRATEGIES.find((s) => s.presetId === id);
            if (def) void activateSim5mStrategy(def);
          }}
        >
          <option value="">— Sélectionner une stratégie 5m —</option>
          <For each={SIM_5M_STRATEGIES}>
            {(def) => (
              <option value={def.presetId}>
                #{def.rank} · {def.name} ({def.tag})
              </option>
            )}
          </For>
        </select>
        <div class="sim-5m-detail">
          <p class="sim-5m-detail-desc">
            {selectedSim5m()?.description ?? "Sélectionnez une stratégie 5m pour voir sa description et ses stats."}
          </p>
          <Show when={selectedSim5m()}>
            {(def) => (
              <>
                <div class="sim-5m-detail-stats">
                  <For each={def().stats}>
                    {(s) => <span class={s.ok ? "ok" : ""}>{s.label} {s.value}</span>}
                  </For>
                </div>
                <Show when={def().warn}>
                  <p class="sim-5m-detail-warn">⚠ {def().warn}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
      <p class="sim-5m-note">
        Ces stratégies proviennent du backtest <code>audits/5min-strategies</code> (836 fenêtres BTC
        Up/Down 5m, 402k ticks). Le moteur <code>antiflip-revert</code> avec preset 5m
        refuse toute entrée sur un marché non-5m — la protection est active en paper trading comme en live.
      </p>

      {/* Panneau de configuration : édition runtime des paramètres de la stratégie
          ACTIVE (tous moteurs). Formulaire prérempli depuis la config effective du
          moteur ; Appliquer envoie le patch complet (le moteur remplace ses
          settings) ; les presets utilisateurs sont persistés en localStorage
          (clé partagée avec la page Backtest). Les sections s'adaptent au moteur :
          communes + spécifiques (strategyFields.ts), filtres 5m actifs/inactifs
          pour antiflip-revert uniquement. */}
      <Show when={sim5mForm() !== null}>
        <div class="sim-5m-config-panel">
          <div class="sim-5m-cp-header">
            <span class="sim-5m-cp-title">Paramètres — {strategyShortLabel(sim5mForm()!.strategyId)}{currentPreset() ? ` · ${currentPreset()?.name}` : ""}</span>
            <div class="sim-5m-cp-actions">
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
        </div>
      </Show>

      {/* Barre de configuration : groupes Stratégie | Capital + actions */}
      <div class="sim-control-bar">
        <div class="sim-cb-group">
          <span class="sim-cb-title">Stratégie</span>
          <div class="sim-cb-fields">
            <label class="sim-field">
              Moteur
              <select
                value={engine()}
                disabled={sending()}
                onChange={(e) => {
                  const id = e.currentTarget.value as StrategyId;
                  void changeEngine(id);
                }}
              >
                <For each={STRATEGY_ENGINE_OPTIONS}>
                  {(opt) => <option value={opt.id}>{opt.label}</option>}
                </For>
              </select>
            </label>
            <label class="sim-field">
              Preset
              <select
                value={presetId()}
                disabled={sending()}
                onChange={(e) => {
                  void changePreset(e.currentTarget.value);
                }}
              >
                <option value="">Aucun preset</option>
                <For each={presets()}>
                  {(p) => (
                    <option value={p.id}>
                      {p.isUser ? "★ " : ""}{p.name}
                    </option>
                  )}
                </For>
              </select>
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

      <div class="grid">
        {/* Positions ouvertes */}
        <Panel title={`Positions ouvertes (${simOpenPositions().length})`}>
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
        <Panel title={`Ordres en attente (${resting().length})`}>
          <Show
            when={resting().length > 0}
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
                <For each={resting()}>
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
        <Panel title="Marché actif (temps réel)">
          <ActiveMarkets now={now()} />
        </Panel>
      </div>

      {/* Historique à onglets : positions résolues | journal des ordres */}
      <div class="sim-history">
        <div class="panel">
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
            Journal des ordres ({journal().length})
          </button>
          <label class="sim-tab-toggle" title="Inverser l'ordre d'affichage">
            <input
              type="checkbox"
              checked={reverseOrder()}
              onChange={(e) => setReverseOrder(e.currentTarget.checked)}
            />
            Plus récent d'abord
          </label>
        </div>

        <Show when={historyTab() === "resolved"} fallback={
          /* Onglet journal : chaque ordre simulé (rempli ou non) */
          <Show
            when={sortedJournal().length > 0}
            fallback={<EmptyState text="Aucun ordre simulé pour l'instant." />}
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
                </tr>
              </thead>
              <tbody>
                <For each={sortedJournal()}>
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
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        }>
          {/* Onglet positions résolues */}
          <Show
            when={sortedResolved().length > 0}
            fallback={<EmptyState text="Aucune position résolue pour l'instant." />}
          >
            <table class="sim-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th>Fill</th>
                  <th>Vente</th>
                  <th>Size</th>
                  <th>P&L</th>
                  <th>Résolu</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <For each={sortedResolved()}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>{p.eventTitle}</td>
                      <td>{p.outcome}</td>
                      <td>{p.kind}</td>
                      <td>{fmtPrice(p.fillPrice)}</td>
                      <td>{p.sellPrice != null ? fmtPrice(p.sellPrice) : "—"}</td>
                      <td>{fmtShares(p.size)}</td>
                      <td class={pnlClass(p.pnl ?? 0)}>{fmtUsd(p.pnl ?? 0)}</td>
                      <td>{timeStr(p.resolvedAt ?? p.windowEnd * 1000)}</td>
                      <td>{p.status}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </div>
      </div>

      <ConfirmModal
        open={confirmReset()}
        title="Réinitialiser la simulation ?"
        message="Le capital revient à la valeur initiale et toutes les positions/ordres simulés sont effacés. Irréversible."
        confirmLabel="Réinitialiser"
        onConfirm={() => void doReset()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}