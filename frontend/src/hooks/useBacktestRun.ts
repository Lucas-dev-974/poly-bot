import { createSignal, type Accessor } from "solid-js";
import { api } from "../api/client";
import { loadRuns as loadRunsFromStore } from "../stores/backtestStore";
import type {
  BacktestPositionRow,
  BacktestProgress,
  BacktestResult,
  BacktestRunRequestSummary,
  BacktestRunSummary,
  BacktestWindowMeta,
  CompletenessRequest,
} from "../types";
import { formToSettings, validateConfigForm, type ConfigFormState } from "../utils/configForm";
import { dateRange } from "./useBacktestFilters";

export type UseBacktestRunDeps = {
  form: Accessor<ConfigFormState | null>;
  dateKey: Accessor<string>;
  filtered: Accessor<BacktestWindowMeta[]>;
  timeframe: Accessor<string>;
  prefix: Accessor<string>;
  prefixesForTimeframe: Accessor<string[]>;
  completeOnly: Accessor<boolean>;
  completenessPayload: () => CompletenessRequest;
  presetId: Accessor<string>;
};

/**
 * Cycle de vie d'un run backtest : launch / poll / open / chart overlay.
 * Seam clair extrait de BacktestPage.
 */
export function useBacktestRun(deps: UseBacktestRunDeps) {
  const [progress, setProgress] = createSignal<BacktestProgress | null>(null);
  const [result, setResult] = createSignal<BacktestResult | null>(null);
  const [positions, setPositions] = createSignal<BacktestPositionRow[]>([]);
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
  const [error, setError] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [applyMsg, setApplyMsg] = createSignal<string | null>(null);
  const [applyErr, setApplyErr] = createSignal<string | null>(null);

  let pollTimer: number | undefined;
  let pollGen = 0;
  let chartGen = 0;

  async function loadRuns(): Promise<BacktestRunSummary[]> {
    return loadRunsFromStore();
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
    const current = deps.form();
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
    const range = dateRange(deps.dateKey(), deps.filtered());
    try {
      const settings = formToSettings(current);
      const tf = deps.timeframe();
      const prefixes = deps.prefix()
        ? [deps.prefix()]
        : tf
          ? deps.prefixesForTimeframe()
          : undefined;
      const body = {
        strategyId: current.strategyId,
        completeOnly: deps.completeOnly(),
        completeness: deps.completenessPayload(),
        from: range?.from,
        to: range?.to,
        prefixes,
        presetId: deps.presetId() || undefined,
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

  function disposeRun(): void {
    pollGen += 1;
    chartGen += 1;
    window.clearInterval(pollTimer);
  }

  return {
    progress,
    setProgress,
    result,
    setResult,
    positions,
    setPositions,
    resultStartedAt,
    setResultStartedAt,
    dialogOpen,
    setDialogOpen,
    openingId,
    selectedRun,
    setSelectedRun,
    runChartRules,
    setRunChartRules,
    chartRunId,
    chartPositions,
    setChartPositions,
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
    poll,
    toggleChartRun,
    disposeRun,
  };
}

export type BacktestRunApi = ReturnType<typeof useBacktestRun>;
