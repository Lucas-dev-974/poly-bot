import { Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../api/client";
import type { StrategyEngineSummary } from "../api/client";
import { BacktestFilterBar } from "../components/backtest/BacktestFilterBar";
import { BacktestPresetPanel } from "../components/backtest/BacktestPresetPanel";
import { BacktestResultModal } from "../components/backtest/BacktestResultModal";
import { BacktestRunList } from "../components/backtest/BacktestRunList";
import { StackedMarketChart } from "../components/backtest/StackedMarketChart";
import {
  allPresetsForStrategy,
  findPresetById,
  type AnyPreset,
  type StrategyId,
} from "../config/strategyPresets";
import { navigate, navigateWithQuery } from "../router";
import type { BotConfig } from "../types";
import { settingsForRun } from "../utils/backtest-preset";
import { matchWalletTradesToWindows, type WalletOverlayMark } from "../utils/stacked-chart";
import {
  applySettingsToForm,
  fieldErrors as computeFieldErrors,
  formToSettings,
  formsEqual,
  validateConfigForm,
  type ConfigFormState,
} from "../utils/configForm";
import { config as liveBotConfig, setConfig } from "../stores/botStore";
import {
  series,
  runs,
  loadSeriesFor,
} from "../stores/backtestStore";
import {
  userPresets as sharedUserPresets,
  commitUserPreset,
  removeUserPreset,
} from "../stores/userPresetsStore";
import { useBacktestFilters } from "../hooks/useBacktestFilters";
import { useBacktestRun } from "../hooks/useBacktestRun";
import "../styles/backtest.css";

export function BacktestPage(): JSX.Element {
  const filters = useBacktestFilters();
  const {
    completeOnly,
    setCompleteOnly,
    minTicksOn,
    setMinTicksOn,
    minTicks,
    setMinTicks,
    maxGapOn,
    setMaxGapOn,
    maxGapSec,
    setMaxGapSec,
    edgeOn,
    setEdgeOn,
    edgeSec,
    setEdgeSec,
    cutGaps,
    setCutGaps,
    dateKey,
    setDateKey,
    prefix,
    setPrefix,
    timeframe,
    setTimeframe,
    dates,
    timeframes,
    prefixesForTimeframe,
    filtered,
    completenessPayload,
    reloadWindowsSoon,
    loadWindows,
    disposeFilters,
  } = filters;

  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [customEngines, setCustomEngines] = createSignal<StrategyEngineSummary[]>([]);
  const [historyEngineOnly, setHistoryEngineOnly] = createSignal(true);
  const [presetId, setPresetId] = createSignal<string>("conservative");
  const liveConfig = liveBotConfig;
  const [form, setForm] = createSignal<ConfigFormState | null>(null);
  const [persistence, setPersistence] = createSignal(true);
  const [walletOn, setWalletOn] = createSignal(false);
  const [walletMarks, setWalletMarks] = createSignal<WalletOverlayMark[]>([]);
  const [walletLoading, setWalletLoading] = createSignal(false);
  const [walletConfigured, setWalletConfigured] = createSignal<boolean | undefined>(undefined);
  const [saving, setSaving] = createSignal(false);
  const [saveMsg, setSaveMsg] = createSignal<string | null>(null);
  const [saveErr, setSaveErr] = createSignal<string | null>(null);
  const userPresets = sharedUserPresets;
  const [presetFormSnapshot, setPresetFormSnapshot] = createSignal<ConfigFormState | null>(null);
  const [showSavePresetDialog, setShowSavePresetDialog] = createSignal(false);
  const [presetNameInput, setPresetNameInput] = createSignal("");
  const [presetDescInput, setPresetDescInput] = createSignal("");
  const [lowerLowsResults, setLowerLowsResults] = createSignal<
    Record<string, import("../types").LowerLowAnalysisResult>
  >({});
  const [lowerLowsLoading, setLowerLowsLoading] = createSignal(false);
  const [lowerLowsParams] = createSignal<import("../types").LowerLowParams>({
    minSwingCents: 5,
    retraceRatio: 0.25,
    consecutiveRequired: 3,
    lookbackMs: 120000,
  });
  let walletGen = 0;
  let lowerLowsGen = 0;

  const run = useBacktestRun({
    form,
    dateKey,
    filtered,
    timeframe,
    prefix,
    prefixesForTimeframe,
    completeOnly,
    completenessPayload,
    presetId,
  });
  const {
    progress,
    result,
    positions,
    resultStartedAt,
    dialogOpen,
    setDialogOpen,
    openingId,
    selectedRun,
    setSelectedRun,
    runChartRules,
    chartRunId,
    chartPositions,
    chartLoadingId,
    error,
    setError,
    applying,
    setApplying,
    applyMsg,
    setApplyMsg,
    applyErr,
    setApplyErr,
    loadRuns,
    openRun,
    launch,
    toggleChartRun,
    disposeRun,
  } = run;

  const presets = createMemo(() => allPresetsForStrategy(engine(), userPresets()));
  const canApplySelected = createMemo(() => settingsForRun(selectedRun()) != null);

  const currentPreset = createMemo((): AnyPreset | undefined => {
    const id = presetId();
    if (!id) return undefined;
    return findPresetById(id, userPresets());
  });

  const isDirty = createMemo(() => {
    const f = form();
    const snap = presetFormSnapshot();
    if (!f || !snap) return false;
    return !formsEqual(f, snap);
  });

  const inlineErrors = createMemo(() => {
    const f = form();
    const base = liveConfig();
    if (!f || !base) return {};
    return computeFieldErrors(f, true, {
      leadsWithEdge: f.strategyId === "edge-lead" || f.strategyId.startsWith("custom:"),
    });
  });

  const hasInlineErrors = createMemo(() => Object.keys(inlineErrors()).length > 0);

  function loadPresetIntoForm(id: string, strategyId: StrategyId): void {
    const base = liveConfig();
    const preset = findPresetById(id, userPresets());
    const resolvedId = (preset?.strategyId ?? strategyId) as StrategyId;
    if (!base) {
      const cur = form();
      if (cur) {
        const f = { ...cur, strategyId: resolvedId };
        setForm(f);
        setPresetFormSnapshot(f);
      }
      return;
    }
    if (!preset) {
      const f = applySettingsToForm(base, { strategyId: resolvedId });
      setForm(f);
      setPresetFormSnapshot(f);
      return;
    }
    const f = applySettingsToForm(base, {
      arbAskLockOnly: false,
      arbAskSumMax: null,
      arbAskLockMinElapsedSec: null,
      arbAskLockMaxImbalance: null,
      ...preset.settings,
      strategyId: resolvedId,
    });
    setForm(f);
    setPresetFormSnapshot(f);
  }

  function resetPreset(): void {
    const id = presetId();
    if (!id) return;
    loadPresetIntoForm(id, engine());
    setSaveMsg("Preset rechargé");
    setSaveErr(null);
  }

  function openSavePresetDialog(): void {
    const preset = currentPreset();
    if (preset?.isUser) {
      setPresetNameInput(preset.name);
      setPresetDescInput(preset.description);
    } else {
      setPresetNameInput(preset?.name ? `${preset.name} (copie)` : "Mon preset");
      setPresetDescInput("");
    }
    setShowSavePresetDialog(true);
  }

  function confirmSavePreset(): void {
    const f = form();
    if (!f) return;
    const name = presetNameInput().trim();
    if (!name) return;
    const existing = currentPreset();
    const id = existing?.isUser ? existing.id : undefined;
    try {
      const settings = formToSettings(f);
      const saved = commitUserPreset({
        id,
        name,
        description: presetDescInput().trim(),
        strategyId: f.strategyId,
        settings,
      });
      setPresetId(saved.id);
      setPresetFormSnapshot(f);
      setShowSavePresetDialog(false);
      setSaveMsg(`Preset « ${saved.name} » sauvegardé`);
      setSaveErr(null);
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    }
  }

  function deleteCurrentPreset(): void {
    const preset = currentPreset();
    if (!preset?.isUser) return;
    if (!confirm(`Supprimer le preset « ${preset.name} » ?`)) return;
    removeUserPreset(preset.id);
    setPresetId("");
    setSaveMsg("Preset supprimé");
    setSaveErr(null);
  }

  function updateForm<K extends keyof ConfigFormState>(key: K, value: ConfigFormState[K]): void {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaveMsg(null);
    setSaveErr(null);
  }

  async function savePresetLive(): Promise<void> {
    const f = form();
    const base = liveConfig();
    if (!f || !base) return;
    const errors = validateConfigForm(f, true, {
      leadsWithEdge: f.strategyId === "edge-lead" || f.strategyId.startsWith("custom:"),
    });
    if (errors.length > 0) {
      setSaveErr(errors[0] ?? "Formulaire invalide");
      setSaveMsg(null);
      return;
    }
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    try {
      const res = await api.updateConfig(formToSettings(f));
      if (res.config) {
        setConfig(res.config);
      }
      setSaveMsg("Enregistré pour le live");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function loadLiveIntoForm(): void {
    const base = liveConfig();
    if (!base) return;
    const f = applySettingsToForm(base, { strategyId: base.strategyId ?? engine() });
    setForm(f);
    setPresetFormSnapshot(f);
    setEngine(base.strategyId ?? "arb");
    setPresetId("");
    setSaveMsg("Config live chargée");
    setSaveErr(null);
  }

  async function applySelectedPreset(): Promise<void> {
    const patch = settingsForRun(selectedRun());
    if (!patch) {
      setApplyErr("Preset indisponible pour ce run");
      return;
    }
    setApplying(true);
    setApplyErr(null);
    setApplyMsg(null);
    try {
      const res = await api.updateConfig(patch);
      if (res.config) {
        setConfig(res.config);
        const f = applySettingsToForm(res.config, patch);
        setForm(f);
        setPresetFormSnapshot(f);
        setEngine(patch.strategyId ?? res.config.strategyId ?? "arb");
        setPresetId("");
      }
      setApplyMsg("Preset appliqué au live");
    } catch (err) {
      setApplyErr(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  async function loadWalletTrades(list: import("../types").BacktestWindowMeta[]): Promise<void> {
    const gen = ++walletGen;
    if (list.length === 0) {
      setWalletMarks([]);
      setWalletLoading(false);
      return;
    }
    setWalletLoading(true);
    try {
      const from = Math.min(...list.map((w) => w.windowStart));
      const to = Math.max(...list.map((w) => w.windowEnd));
      const res = await api.backtestWalletTrades(from, to);
      if (gen !== walletGen) return;
      setWalletConfigured(res.configured);
      setWalletMarks(matchWalletTradesToWindows(res.trades, list));
    } catch (err) {
      if (gen !== walletGen) return;
      setWalletMarks([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === walletGen) setWalletLoading(false);
    }
  }

  async function loadLowerLows(slugs: string[]): Promise<void> {
    const gen = ++lowerLowsGen;
    if (slugs.length === 0) {
      setLowerLowsResults({});
      setLowerLowsLoading(false);
      return;
    }
    setLowerLowsLoading(true);
    try {
      const params = lowerLowsParams();
      const res = await api.backtestLowerLows(slugs, params);
      if (gen !== lowerLowsGen) return;
      const map: Record<string, import("../types").LowerLowAnalysisResult> = {};
      for (const r of res.results) {
        map[r.slug] = r;
      }
      setLowerLowsResults(map);
    } catch (err) {
      if (gen !== lowerLowsGen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === lowerLowsGen) setLowerLowsLoading(false);
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const cfg = await api.config();
        setConfig(cfg.config);
        setPersistence(cfg.config.persistenceEnabled !== false);
        setWalletConfigured(Boolean((cfg.config as { funderAddress?: string }).funderAddress));
        const sid = cfg.config.strategyId ?? "arb";
        setEngine(sid);
        const first = allPresetsForStrategy(sid, userPresets())[0];
        setPresetId(first?.id ?? "");
        if (first) loadPresetIntoForm(first.id, sid);
        else {
          const f = applySettingsToForm(cfg.config, { strategyId: sid });
          setForm(f);
          setPresetFormSnapshot(f);
        }
      } catch {
        /* ignore */
      }
      try {
        const listRes = await api.strategyList();
        setCustomEngines(listRes.engines.filter((e) => !e.native));
      } catch {
        setCustomEngines([]);
      }
      await loadWindows();
      await loadRuns();
    })();

    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (progress()?.status !== "running" && form()) void launch();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        if (form()) openSavePresetDialog();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (!saving() && form()) void savePresetLive();
        return;
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposeRun();
      disposeFilters();
      walletGen += 1;
      window.removeEventListener("keydown", onKey);
    };
  });

  createEffect(() => {
    const on = walletOn();
    const list = filtered();
    if (!on) {
      walletGen += 1;
      setWalletMarks([]);
      setWalletLoading(false);
      return;
    }
    void loadWalletTrades(list);
  });

  return (
    <div class="bt-page">
      <header class="guide-header">
        <div class="guide-header__left">
          <button type="button" class="btn guide-back" onClick={() => navigate("/")}>
            ← Dashboard
          </button>
          <h1>Backtest</h1>
          <a href="/guide" class="btn guide-nav-link">
            Guide
          </a>
          <a href="/strategy-editor" class="btn guide-nav-link">
            Éditeur
          </a>
        </div>
      </header>

      <BacktestFilterBar
        dateKey={dateKey}
        setDateKey={setDateKey}
        dates={dates}
        timeframe={timeframe}
        setTimeframe={setTimeframe}
        timeframes={timeframes}
        prefix={prefix}
        setPrefix={setPrefix}
        prefixesForTimeframe={prefixesForTimeframe}
        completeOnly={completeOnly}
        setCompleteOnly={setCompleteOnly}
        minTicksOn={minTicksOn}
        setMinTicksOn={setMinTicksOn}
        minTicks={minTicks}
        setMinTicks={setMinTicks}
        maxGapOn={maxGapOn}
        setMaxGapOn={setMaxGapOn}
        maxGapSec={maxGapSec}
        setMaxGapSec={setMaxGapSec}
        edgeOn={edgeOn}
        setEdgeOn={setEdgeOn}
        edgeSec={edgeSec}
        setEdgeSec={setEdgeSec}
        cutGaps={cutGaps}
        setCutGaps={setCutGaps}
        walletOn={walletOn}
        setWalletOn={setWalletOn}
        walletConfigured={walletConfigured}
        walletLoading={walletLoading}
        walletMarksCount={() => walletMarks().length}
        lowerLowsLoading={lowerLowsLoading}
        filteredCount={() => filtered().length}
        onAnalyzeLowerLows={() => void loadLowerLows(filtered().map((w) => w.eventSlug))}
        onReloadWindows={() => void loadWindows()}
        onReloadWindowsSoon={() => reloadWindowsSoon()}
        engine={engine}
        customEngines={customEngines}
        presetId={presetId}
        presets={presets}
        onEngineChange={(id) => {
          setEngine(id);
          const first = allPresetsForStrategy(id, userPresets())[0];
          setPresetId(first?.id ?? "");
          loadPresetIntoForm(first?.id ?? "", id);
        }}
        onPresetChange={(id) => {
          setPresetId(id);
          loadPresetIntoForm(id, engine());
        }}
        progress={progress}
        form={form}
        hasInlineErrors={hasInlineErrors}
        onLaunch={() => void launch()}
      />

      <Show when={!persistence()}>
        <p class="bt-empty">Persistence désactivée — aucun snapshot local.</p>
      </Show>
      <Show when={error()}>
        <p class="err">{error()}</p>
      </Show>
      <Show when={progress()?.status === "running"}>
        <div class="bt-progress">
          <div class="bt-progress-bar" style={{ width: `${progress()?.pct ?? 0}%` }} />
          <span>
            {progress()?.current}/{progress()?.total} {progress()?.eventSlug ?? ""}
          </span>
        </div>
      </Show>

      <div class="bt-body">
        <div class="bt-main">
          <StackedMarketChart
            windows={filtered()}
            series={series()}
            cutGaps={cutGaps()}
            positions={chartPositions()}
            walletMarks={walletMarks()}
            walletOn={walletOn()}
            walletLoading={walletLoading()}
            lowerLowsResults={lowerLowsResults()}
            onVisible={(slugs) => void loadSeriesFor(slugs)}
          />
          <BacktestPresetPanel
            form={form()}
            engine={engine()}
            onUpdate={updateForm}
            saving={saving()}
            saveMsg={saveMsg()}
            saveErr={saveErr()}
            onSave={() => void savePresetLive()}
            onLoadLive={() => loadLiveIntoForm()}
            onResetPreset={() => resetPreset()}
            fieldErrors={inlineErrors()}
            isDirty={isDirty()}
            presetDescription={() => currentPreset()?.description ?? null}
            presetName={() => currentPreset()?.name ?? null}
            isUserPreset={currentPreset()?.isUser === true}
            onSavePreset={() => openSavePresetDialog()}
            onDeletePreset={() => deleteCurrentPreset()}
            onOpenEditor={() => {
              const sid = form()?.strategyId;
              if (sid?.startsWith("custom:")) {
                navigateWithQuery("/strategy-editor", { id: sid });
              } else {
                navigate("/strategy-editor");
              }
            }}
            onStrategyActivated={(config: BotConfig) => {
              setConfig(config);
              const f = applySettingsToForm(config, { strategyId: config.strategyId ?? engine() });
              setForm(f);
              setPresetFormSnapshot(f);
              setEngine(config.strategyId ?? "arb");
              setPresetId("");
              setSaveMsg("Stratégie activée sur le live");
              setSaveErr(null);
            }}
          />
        </div>
        <BacktestRunList
          runs={runs()}
          engine={engine()}
          engineOnly={historyEngineOnly()}
          onEngineOnly={setHistoryEngineOnly}
          progress={progress()}
          openingId={openingId()}
          chartRunId={chartRunId()}
          chartLoadingId={chartLoadingId()}
          onOpen={(r) => void openRun(r)}
          onToggleChart={(r) => void toggleChartRun(r)}
        />
      </div>

      <BacktestResultModal
        open={dialogOpen()}
        result={result()}
        positions={positions()}
        run={selectedRun()}
        runChartRules={runChartRules()}
        startedAt={resultStartedAt()}
        canApplyPreset={canApplySelected()}
        applying={applying()}
        applyMsg={applyMsg()}
        applyErr={applyErr()}
        onApplyPreset={() => void applySelectedPreset()}
        onClose={() => setDialogOpen(false)}
      />

      <Show when={showSavePresetDialog()}>
        <div
          class="modal-overlay"
          onClick={() => setShowSavePresetDialog(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowSavePresetDialog(false);
          }}
          tabindex="-1"
          ref={(el) => el.focus()}
        >
          <div class="modal bt-save-preset-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Sauvegarder le preset</h3>
            <label class="bt-pf">
              <span>Nom</span>
              <input
                type="text"
                value={presetNameInput()}
                onInput={(e) => setPresetNameInput(e.currentTarget.value)}
                placeholder="Mon preset"
              />
            </label>
            <label class="bt-pf">
              <span>Description</span>
              <textarea
                value={presetDescInput()}
                onInput={(e) => setPresetDescInput(e.currentTarget.value)}
                placeholder="Description optionnelle"
                rows={3}
              />
            </label>
            <div class="modal-actions">
              <button class="btn" type="button" onClick={() => setShowSavePresetDialog(false)}>
                Annuler
              </button>
              <button
                class="btn btn-primary"
                type="button"
                disabled={!presetNameInput().trim()}
                onClick={() => confirmSavePreset()}
              >
                Sauvegarder
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}