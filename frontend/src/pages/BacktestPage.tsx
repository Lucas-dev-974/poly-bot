import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../api/client";
import type { StrategyEngineSummary } from "../api/client";
import { BacktestPresetPanel } from "../components/backtest/BacktestPresetPanel";
import { BacktestResultModal } from "../components/backtest/BacktestResultModal";
import { BacktestRunList } from "../components/backtest/BacktestRunList";
import { StackedMarketChart } from "../components/backtest/StackedMarketChart";
import {
  allPresetsForStrategy,
  STRATEGY_ENGINE_OPTIONS,
  findPresetById,
  type AnyPreset,
  type StrategyId,
} from "../config/strategyPresets";
import { navigate, navigateWithQuery } from "../router";
import { setConfig } from "../stores/botStore";
import type {
  BacktestPositionRow,
  BacktestProgress,
  BacktestResult,
  BacktestRunRequestSummary,
  BacktestRunSummary,
  BacktestSeriesPoint,
  BacktestWindowMeta,
  BotConfig,
  CompletenessRequest,
} from "../types";
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
import {
  deleteUserPreset,
  loadUserPresets,
  saveUserPreset,
  type UserPreset,
} from "../utils/user-presets";

export function BacktestPage(): JSX.Element {
  const [windows, setWindows] = createSignal<BacktestWindowMeta[]>([]);
  const [series, setSeries] = createSignal<Record<string, BacktestSeriesPoint[]>>({});
  const [completeOnly, setCompleteOnly] = createSignal(true);
  const [minTicksOn, setMinTicksOn] = createSignal(true);
  const [minTicks, setMinTicks] = createSignal("855");
  const [maxGapOn, setMaxGapOn] = createSignal(true);
  const [maxGapSec, setMaxGapSec] = createSignal("2");
  const [edgeOn, setEdgeOn] = createSignal(true);
  const [edgeSec, setEdgeSec] = createSignal("2");
  const [cutGaps, setCutGaps] = createSignal(true);
  const [dateKey, setDateKey] = createSignal("all");
  const [prefix, setPrefix] = createSignal("");
  const [timeframe, setTimeframe] = createSignal("");
  const [engine, setEngine] = createSignal<StrategyId>("arb");
  const [customEngines, setCustomEngines] = createSignal<StrategyEngineSummary[]>([]);
  const [historyEngineOnly, setHistoryEngineOnly] = createSignal(true);
  const [presetId, setPresetId] = createSignal<string>("conservative");
  const [liveConfig, setLiveConfig] = createSignal<BotConfig | null>(null);
  const [form, setForm] = createSignal<ConfigFormState | null>(null);
  const [persistence, setPersistence] = createSignal(true);
  const [progress, setProgress] = createSignal<BacktestProgress | null>(null);
  const [result, setResult] = createSignal<BacktestResult | null>(null);
  const [positions, setPositions] = createSignal<BacktestPositionRow[]>([]);
  const [runs, setRuns] = createSignal<BacktestRunSummary[]>([]);
  const [resultStartedAt, setResultStartedAt] = createSignal<number | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [openingId, setOpeningId] = createSignal<string | null>(null);
  const [selectedRun, setSelectedRun] = createSignal<BacktestRunSummary | null>(null);
  const [runChartRules, setRunChartRules] = createSignal<
    Array<{
      action: "buy" | "sell";
      token: "cheap" | "favorite";
      startSec: number;
      endSec: number;
      bandMin: number | null;
      bandMax: number | null;
    }>
  >([]);
  const [chartRunId, setChartRunId] = createSignal<string | null>(null);
  const [chartPositions, setChartPositions] = createSignal<BacktestPositionRow[]>([]);
  const [chartLoadingId, setChartLoadingId] = createSignal<string | null>(null);
  const [walletOn, setWalletOn] = createSignal(false);
  const [walletMarks, setWalletMarks] = createSignal<WalletOverlayMark[]>([]);
  const [walletLoading, setWalletLoading] = createSignal(false);
  const [walletConfigured, setWalletConfigured] = createSignal<boolean | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saveMsg, setSaveMsg] = createSignal<string | null>(null);
  const [saveErr, setSaveErr] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [applyMsg, setApplyMsg] = createSignal<string | null>(null);
  const [applyErr, setApplyErr] = createSignal<string | null>(null);
  const [userPresets, setUserPresets] = createSignal<UserPreset[]>([]);
  const [presetFormSnapshot, setPresetFormSnapshot] = createSignal<ConfigFormState | null>(null);
  const [showSavePresetDialog, setShowSavePresetDialog] = createSignal(false);
  const [presetNameInput, setPresetNameInput] = createSignal("");
  const [presetDescInput, setPresetDescInput] = createSignal("");
  let pollTimer: number | undefined;
  let windowsTimer: number | undefined;
  let pollGen = 0;
  let chartGen = 0;
  let walletGen = 0;
  const loadedSlugs = new Set<string>();

  const dates = createMemo(() => {
    const keys = new Set<string>();
    for (const w of windows()) {
      keys.add(dayKey(w.windowStart));
    }
    return [...keys].sort().reverse();
  });

  /**
   * Familles réellement présentes dans les fenêtres listées (multi-timeframe) :
   * dérivée des données au lieu d'options btc/eth-15m hardcodées.
   */
  const prefixes = createMemo(() => {
    const seen = new Set<string>();
    for (const w of windows()) {
      seen.add(w.eventSlug.replace(/-\d{10}$/, ""));
    }
    return [...seen].sort();
  });

  /**
   * Timeframes (durées) réellement présents, ex. ["15m","5m"]. Dériver du
   * préfixe de famille = un seul endroit de vérité (le slug).
   */
  const timeframes = createMemo(() => {
    const seen = new Set<string>();
    for (const p of prefixes()) {
      const m = p.match(/-updown-(\d+)([mh])$/);
      if (m) seen.add(`${m[1]}${m[2]}`);
    }
    return [...seen].sort(byDurationAsc);
  });

  /** Familles du timeframe sélectionné ("" = tous). */
  const prefixesForTimeframe = createMemo(() => {
    const tf = timeframe();
    if (!tf) return prefixes();
    return prefixes().filter((p) => p.endsWith(`-updown-${tf}`));
  });

  const filtered = createMemo(() => {
    const key = dateKey();
    const p = prefix();
    const tf = timeframe();
    return windows().filter((w) => {
      if (key !== "all" && dayKey(w.windowStart) !== key) return false;
      if (tf && !w.eventSlug.includes(`-updown-${tf}-`)) return false;
      if (p && !w.eventSlug.startsWith(p)) return false;
      return true;
    });
  });

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
    if (!base) return;
    const preset = findPresetById(id, userPresets());
    if (!preset) {
      const f = applySettingsToForm(base, { strategyId });
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
      strategyId: preset.strategyId,
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
      const saved = saveUserPreset({
        id,
        name,
        description: presetDescInput().trim(),
        strategyId: f.strategyId,
        settings,
      });
      setUserPresets(loadUserPresets());
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
    deleteUserPreset(preset.id);
    setUserPresets(loadUserPresets());
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
        setLiveConfig(res.config);
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
        setLiveConfig(res.config);
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

  function completenessPayload(): CompletenessRequest {
    const ticks = Number(minTicks());
    const gapSec = Number(maxGapSec());
    const edge = Number(edgeSec());
    return {
      requireMinTicks: minTicksOn(),
      minTicks: Number.isFinite(ticks) && ticks >= 1 ? Math.round(ticks) : 855,
      requireMaxGap: maxGapOn(),
      maxGapMs: Number.isFinite(gapSec) && gapSec > 0 ? Math.round(gapSec * 1000) : 2000,
      requireEdge: edgeOn(),
      maxEdgeGapMs: Number.isFinite(edge) && edge > 0 ? Math.round(edge * 1000) : 2000,
    };
  }

  function reloadWindowsSoon(): void {
    window.clearTimeout(windowsTimer);
    windowsTimer = window.setTimeout(() => {
      void loadWindows();
    }, 400);
  }

  async function loadWindows(): Promise<void> {
    window.clearTimeout(windowsTimer);
    const res = await api.backtestWindows({
      completeOnly: completeOnly(),
      completeness: completenessPayload(),
    });
    setWindows(res.windows);
    loadedSlugs.clear();
    setSeries({});
    void loadVisible(res.windows.slice(0, 20).map((w) => w.eventSlug));
  }

  async function loadVisible(slugs: string[]): Promise<void> {
    const missing = slugs.filter((s) => !loadedSlugs.has(s));
    if (missing.length === 0) return;
    const res = await api.backtestSeries(missing);
    for (const slug of missing) loadedSlugs.add(slug);
    setSeries((prev) => ({ ...prev, ...res.series }));
  }

  async function loadWalletTrades(list: BacktestWindowMeta[]): Promise<void> {
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

  async function loadRuns(): Promise<BacktestRunSummary[]> {
    try {
      const res = await api.backtestRuns(20);
      setRuns(res.runs);
      return res.runs;
    } catch {
      return runs();
    }
  }

  async function loadRunChartRules(
    run: BacktestRunSummary,
    request: BacktestRunRequestSummary | null,
  ): Promise<void> {
    setRunChartRules([]);
    const sid =
      request?.settings?.strategyId ??
      request?.strategyId ??
      run.result?.strategyId ??
      run.request?.strategyId;
    if (typeof sid !== "string" || !sid.startsWith("custom:")) {
      return;
    }
    try {
      const res = await api.strategyGet(sid);
      const rules = (res.graph.chartRules ?? []).map((r) => ({
        action: r.action as "buy" | "sell",
        token: r.token as "cheap" | "favorite",
        startSec: r.startSec,
        endSec: r.endSec,
        bandMin: r.bandMin ?? null,
        bandMax: r.bandMax ?? null,
      }));
      setRunChartRules(rules);
    } catch {
      setRunChartRules([]);
    }
  }

  async function openRun(run: BacktestRunSummary): Promise<void> {
    setError(null);
    setOpeningId(run.id);
    try {
      const st = await api.backtestStatus(run.id);
      if (!st.result) {
        setError(st.progress.error ?? "Résultat indisponible");
        return;
      }
      setResult(st.result);
      setPositions(st.positions);
      if (chartRunId() === run.id) setChartPositions(st.positions);
      setResultStartedAt(run.startedAt);
      setSelectedRun({
        ...run,
        request: st.request ?? run.request,
      });
      await loadRunChartRules(run, st.request);
      setApplyMsg(null);
      setApplyErr(null);
      setDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningId(null);
    }
  }

  async function launch(): Promise<void> {
    setError(null);
    const current = form();
    if (!current) {
      setError("Preset non chargé");
      return;
    }
    const errors = validateConfigForm(current, true, {
      leadsWithEdge: current.strategyId === "edge-lead" || current.strategyId.startsWith("custom:"),
    });
    if (errors.length > 0) {
      setError(errors[0] ?? "Preset invalide");
      return;
    }
    const range = dateRange(dateKey(), filtered());
    try {
      const settings = formToSettings(current);
      // Timeframe seul → toutes les familles de cette durée ; préfixe précis
      // → une famille unique. Le run côté job filtre déjà sur ces listes.
      const tf = timeframe();
      const prefixes = prefix()
        ? [prefix()]
        : tf
          ? prefixesForTimeframe()
          : undefined;
      const body = {
        strategyId: current.strategyId,
        completeOnly: completeOnly(),
        completeness: completenessPayload(),
        from: range?.from,
        to: range?.to,
        prefixes,
        presetId: presetId() || undefined,
        settings,
      };
      const started = await api.backtestStart(body);
      setProgress({
        runId: started.runId,
        status: "running",
        current: 0,
        total: 0,
        eventSlug: null,
        pct: 0,
      });
      await loadRuns();
      poll(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function poll(id: string): void {
    window.clearInterval(pollTimer);
    const gen = ++pollGen;
    const tick = async (): Promise<void> => {
      if (gen !== pollGen) return;
      try {
        const st = await api.backtestStatus(id);
        if (gen !== pollGen) return;
        setProgress(st.progress);
        if (st.progress.status === "running") return;
        window.clearInterval(pollTimer);
        const list = await loadRuns();
        if (gen !== pollGen) return;
        if (chartRunId() === id) setChartPositions(st.positions);
        const viewingOther = dialogOpen() && selectedRun()?.id !== id;
        if (viewingOther) return;
        setResult(st.result);
        setPositions(st.positions);
        if (st.progress.status === "done") {
          const row = list.find((r) => r.id === id) ?? null;
          setSelectedRun(
            row ? { ...row, request: st.request ?? row.request } : row,
          );
          setResultStartedAt(row?.startedAt ?? Date.now());
          setApplyMsg(null);
          setApplyErr(null);
          setDialogOpen(true);
        }
        if (st.progress.status === "error") setError(st.progress.error ?? "Erreur backtest");
      } catch (err) {
        if (gen !== pollGen) return;
        window.clearInterval(pollTimer);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    pollTimer = window.setInterval(() => {
      void tick();
    }, 250);
  }

  async function toggleChartRun(run: BacktestRunSummary): Promise<void> {
    if (chartRunId() === run.id) {
      chartGen += 1;
      setChartRunId(null);
      setChartPositions([]);
      setChartLoadingId(null);
      return;
    }
    const gen = ++chartGen;
    setChartRunId(run.id);
    if (selectedRun()?.id === run.id) {
      setChartPositions(positions());
    } else {
      setChartPositions([]);
    }
    setChartLoadingId(run.id);
    setError(null);
    try {
      const st = await api.backtestStatus(run.id);
      if (gen !== chartGen) return;
      setChartPositions(st.positions);
    } catch (err) {
      if (gen !== chartGen) return;
      setChartRunId(null);
      setChartPositions([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === chartGen) setChartLoadingId(null);
    }
  }

  onMount(() => {
    setUserPresets(loadUserPresets());
    void (async () => {
      try {
        const cfg = await api.config();
        setLiveConfig(cfg.config);
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
        setCustomEngines(listRes.engines.filter((engine) => !engine.native));
      } catch {
        setCustomEngines([]);
      }
      await loadWindows();
      await loadRuns();
    })();

    // Raccourcis clavier
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Enter = lancer le backtest
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (progress()?.status !== "running" && form()) void launch();
        return;
      }
      // Ctrl+Shift+S = sauvegarder comme preset utilisateur (avant Ctrl+S)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        if (form()) openSavePresetDialog();
        return;
      }
      // Ctrl+S = enregistrer vers live
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        if (!saving() && form()) void savePresetLive();
        return;
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      pollGen += 1;
      chartGen += 1;
      walletGen += 1;
      window.clearInterval(pollTimer);
      window.clearTimeout(windowsTimer);
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

      <div class="bt-toolbar">
        <label>
          Date
          <select value={dateKey()} onChange={(e) => setDateKey(e.currentTarget.value)}>
            <option value="all">Toutes</option>
            <For each={dates()}>{(d) => <option value={d}>{d}</option>}</For>
          </select>
        </label>
        <label title="Durée de fenêtre (dérivée des données enregistrées)">
          Timeframe
          <select
            value={timeframe()}
            onChange={(e) => {
              setTimeframe(e.currentTarget.value);
              // Un préfixe d'un autre timeframe ne matcherait rien : reset.
              setPrefix("");
            }}
          >
            <option value="">Tous</option>
            <For each={timeframes()}>
              {(tf) => <option value={tf}>{tf}</option>}
            </For>
          </select>
        </label>
        <label>
          Marché
          <select value={prefix()} onChange={(e) => setPrefix(e.currentTarget.value)}>
            <option value="">Tous</option>
            <For each={prefixesForTimeframe()}>
              {(p) => <option value={p}>{p}</option>}
            </For>
          </select>
        </label>
        <label class="bt-check" title="Ne garder que les fenêtres qui passent les règles ci-contre">
          <input
            type="checkbox"
            checked={completeOnly()}
            onChange={(e) => {
              setCompleteOnly(e.currentTarget.checked);
              void loadWindows();
            }}
          />
          Complets
        </label>
        <div class="bt-rules">
          <label
            class={`bt-rule${minTicksOn() ? "" : " is-off"}`}
            title="Minimum de ticks (les deux outcomes) dans la fenêtre"
          >
            <input
              type="checkbox"
              checked={minTicksOn()}
              onChange={(e) => {
                setMinTicksOn(e.currentTarget.checked);
                void loadWindows();
              }}
            />
            Ticks
            <input
              type="number"
              min="1"
              max="900"
              step="1"
              value={minTicks()}
              disabled={!minTicksOn()}
              onInput={(e) => {
                setMinTicks(e.currentTarget.value);
                reloadWindowsSoon();
              }}
            />
          </label>
          <label
            class={`bt-rule${maxGapOn() ? "" : " is-off"}`}
            title="Écart max entre deux ticks successifs"
          >
            <input
              type="checkbox"
              checked={maxGapOn()}
              onChange={(e) => {
                setMaxGapOn(e.currentTarget.checked);
                void loadWindows();
              }}
            />
            Trou
            <input
              type="number"
              min="0.5"
              max="900"
              step="0.5"
              value={maxGapSec()}
              disabled={!maxGapOn()}
              onInput={(e) => {
                setMaxGapSec(e.currentTarget.value);
                reloadWindowsSoon();
              }}
            />
            s
          </label>
          <label
            class={`bt-rule${edgeOn() ? "" : " is-off"}`}
            title="Premier / dernier tick à moins de N secondes des bords de fenêtre"
          >
            <input
              type="checkbox"
              checked={edgeOn()}
              onChange={(e) => {
                setEdgeOn(e.currentTarget.checked);
                void loadWindows();
              }}
            />
            Bords
            <input
              type="number"
              min="0.5"
              max="900"
              step="0.5"
              value={edgeSec()}
              disabled={!edgeOn()}
              onInput={(e) => {
                setEdgeSec(e.currentTarget.value);
                reloadWindowsSoon();
              }}
            />
            s
          </label>
        </div>
        <label class="bt-check" title="Couper les courbes sur les trous">
          <input
            type="checkbox"
            checked={cutGaps()}
            onChange={(e) => setCutGaps(e.currentTarget.checked)}
          />
          Trous
        </label>
        <label
          class="bt-check"
          title={
            walletConfigured() === false
              ? "FUNDER_ADDRESS manquant — pas de wallet à interroger"
              : "Afficher les fills Data API du wallet sur le graphique"
          }
        >
          <input
            type="checkbox"
            checked={walletOn()}
            disabled={walletConfigured() === false}
            onChange={(e) => setWalletOn(e.currentTarget.checked)}
          />
          Wallet
          <Show when={walletOn()}>
            <span class="bt-wallet-count">{walletLoading() ? "…" : walletMarks().length}</span>
          </Show>
        </label>
        <label>
          Moteur
          <select
            value={engine()}
            onChange={(e) => {
              const id = e.currentTarget.value as StrategyId;
              setEngine(id);
              const first = allPresetsForStrategy(id, userPresets())[0];
              setPresetId(first?.id ?? "");
              loadPresetIntoForm(first?.id ?? "", id);
            }}
          >
            <For each={STRATEGY_ENGINE_OPTIONS}>
              {(option) => <option value={option.id}>{option.label}</option>}
            </For>
            <For each={customEngines()}>
              {(engine) => (
                <option value={engine.id}>
                  {engine.name} ({engine.id})
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          Preset
          <select
            value={presetId()}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setPresetId(id);
              loadPresetIntoForm(id, engine());
            }}
          >
            <option value="">Personnalisé</option>
            <For each={presets()}>
              {(p) => (
                <option value={p.id}>
                  {p.isUser ? "★ " : ""}{p.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <button
          class="btn"
          type="button"
          disabled={progress()?.status === "running" || (completeOnly() && filtered().length === 0) || !form() || hasInlineErrors()}
          onClick={() => void launch()}
          title={hasInlineErrors() ? "Corrigez les erreurs de validation avant de lancer" : "Ctrl+Enter"}
        >
          Lancer
        </button>
      </div>

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
            onVisible={(slugs) => void loadVisible(slugs)}
          />
          <BacktestPresetPanel
            form={form()}
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
            onStrategyActivated={(config) => {
              setLiveConfig(config);
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
          onOpen={(run) => void openRun(run)}
          onToggleChart={(run) => void toggleChartRun(run)}
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

function dayKey(windowStart: number): string {
  const d = new Date(windowStart * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Tri des timeframes par durée croissante ("5m" avant "15m" avant "1h"). */
function byDurationAsc(a: string, b: string): number {
  const toSec = (tf: string): number => {
    const m = tf.match(/^(\d+)([mh])$/);
    if (!m) return Number.MAX_SAFE_INTEGER;
    return Number(m[1]) * (m[2] === "h" ? 3600 : 60);
  };
  return toSec(a) - toSec(b);
}

function dateRange(
  key: string,
  list: BacktestWindowMeta[],
): { from: number; to: number } | undefined {
  if (key === "all" || list.length === 0) return undefined;
  const day = list.filter((w) => dayKey(w.windowStart) === key);
  if (day.length === 0) return undefined;
  return {
    from: Math.min(...day.map((w) => w.windowStart)),
    to: Math.max(...day.map((w) => w.windowStart)),
  };
}
