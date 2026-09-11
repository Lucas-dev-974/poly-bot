import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../api/client";
import { navigate } from "../router";
import { setConfig } from "../stores/botStore";
import { marketList, markets } from "../stores/marketStore";
import {
  ChartEditorSidebar,
  type ChartWindowOption,
} from "../strategy-editor/ChartEditorSidebar";
import { ChartReplayBar } from "../strategy-editor/ChartReplayBar";
import { ChartViewBar } from "../strategy-editor/ChartViewBar";
import { ChartRulePanel, chartDurationSec } from "../strategy-editor/ChartRulePanel";
import {
  ChartRulesCanvas,
  type ChartFillMark,
  type ChartSeriesPoint,
} from "../strategy-editor/ChartRulesCanvas";
import {
  quoteAt,
  replayChartRules,
  type ReplaySignal,
} from "../strategy-editor/chart-rule-replay";
import { GraphToolbar } from "../strategy-editor/GraphToolbar";
import {
  edgeLeadChartRules,
  type ChartRule,
  type StrategyGraph,
} from "../strategy-editor/graph-types";

/** 1× = 15 min de marché en 20 s. */
const MARKET_SEC_PER_WALL_SEC = 45;

/** Graphe nœuds minimal (edge-lead POC) — invisible, requis pour valider / activer côté serveur. */
async function skeletonGraph(chartRules: ChartRule[] = []): Promise<StrategyGraph> {
  const res = await api.strategyTemplate();
  return {
    ...res.graph,
    id: "",
    name: "Nouvelle stratégie",
    chartRules,
  };
}

export function StrategyEditorPage(): JSX.Element {
  const [graph, setGraph] = createSignal<StrategyGraph | null>(null);
  const [selectedRuleId, setSelectedRuleId] = createSignal<string | null>(null);
  const [errors, setErrors] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [windows, setWindows] = createSignal<ChartWindowOption[]>([]);
  const [engines, setEngines] = createSignal<
    Array<{ id: string; name: string; native: boolean }>
  >([]);
  const [selectedSlug, setSelectedSlug] = createSignal<string | null>(null);
  const [windowStart, setWindowStart] = createSignal<number | null>(null);
  const [windowEnd, setWindowEnd] = createSignal<number | null>(null);
  const [seriesUp, setSeriesUp] = createSignal<ChartSeriesPoint[]>([]);
  const [seriesDown, setSeriesDown] = createSignal<ChartSeriesPoint[]>([]);
  const [fills, setFills] = createSignal<ChartFillMark[]>([]);
  const [undoStack, setUndoStack] = createSignal<ChartRule[][]>([]);
  const [playheadSec, setPlayheadSec] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [speed, setSpeed] = createSignal(1);
  const [tooltipEnabled, setTooltipEnabled] = createSignal(true);
  const [showYes, setShowYes] = createSignal(true);
  const [showNo, setShowNo] = createSignal(true);

  const g = () => graph();
  const chartRules = createMemo(() => g()?.chartRules ?? []);
  const durationSec = createMemo(() => chartDurationSec(windowStart(), windowEnd()));
  const windowStartUnix = createMemo(() => windowStart() ?? 0);
  const hasSeries = createMemo(() => seriesUp().length + seriesDown().length > 0);

  const replaySignals = createMemo(() =>
    replayChartRules({
      rules: chartRules(),
      up: seriesUp(),
      down: seriesDown(),
      windowStart: windowStartUnix(),
      durationSec: durationSec(),
    }),
  );

  const replayQuote = createMemo(() => {
    if (!hasSeries()) return null;
    return quoteAt(seriesUp(), seriesDown(), windowStartUnix(), playheadSec());
  });

  const lastSignal = createMemo((): ReplaySignal | null => {
    const head = playheadSec();
    let last: ReplaySignal | null = null;
    for (const sig of replaySignals()) {
      if (sig.elapsedSec <= head + 0.001) last = sig;
      else break;
    }
    return last;
  });

  const mergedWindows = createMemo((): ChartWindowOption[] => {
    const db = windows();
    const live = marketList().map((m) => {
      const row = db.find((w) => w.eventSlug === m.slug);
      return {
        eventSlug: m.slug,
        eventTitle: m.title,
        windowStart: m.windowStart,
        windowEnd: m.windowEnd,
        ticks: row?.ticks ?? 0,
        live: true,
      };
    });
    const liveSlugs = new Set(live.map((w) => w.eventSlug));
    const historical = db
      .filter((w) => !liveSlugs.has(w.eventSlug))
      .map((w) => ({ ...w, live: false }));
    return [...live, ...historical];
  });

  const setChartRules = (rules: ChartRule[]) => {
    const current = g();
    if (!current) return;
    setUndoStack((stack) => [...stack, current.chartRules ?? []]);
    setGraph(syncLeadsWithEdge({ ...current, chartRules: rules }, rules));
  };

  const undoZones = () => {
    const stack = undoStack();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    const current = g();
    if (!current) return;
    setGraph(syncLeadsWithEdge({ ...current, chartRules: prev }, prev));
    setSelectedRuleId(null);
    setStatus("Zone annulée");
  };

  const applyEdgeLeadPreset = () => {
    const current = g();
    if (!current) return;
    setUndoStack((stack) => [...stack, current.chartRules ?? []]);
    const rules = edgeLeadChartRules(durationSec());
    setGraph({ ...current, chartRules: rules, leadsWithEdge: true });
    setSelectedRuleId(rules[0]?.id ?? null);
    setStatus("Preset Edge-lead chargé (bande + confirm + cheap après fill)");
  };

  function seek(sec: number) {
    setPlaying(false);
    setPlayheadSec(Math.min(Math.max(sec, 0), durationSec()));
  }

  function restart() {
    setPlaying(false);
    setPlayheadSec(0);
  }

  function playPause() {
    if (!hasSeries()) return;
    if (playing()) {
      setPlaying(false);
      return;
    }
    if (playheadSec() >= durationSec() - 0.4) setPlayheadSec(0);
    setPlaying(true);
  }

  function toggleYes() {
    if (showYes() && !showNo()) return;
    setShowYes(!showYes());
  }

  function toggleNo() {
    if (showNo() && !showYes()) return;
    setShowNo(!showNo());
  }

  createEffect(() => {
    if (!playing()) return;
    const rate = speed() * MARKET_SEC_PER_WALL_SEC;
    const cap = durationSec();
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let stop = false;
      setPlayheadSec((p) => {
        const next = p + dt * rate;
        if (next >= cap) {
          stop = true;
          return cap;
        }
        return next;
      });
      if (stop) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (inField) return;
        e.preventDefault();
        undoZones();
        return;
      }
      if (!inField && e.code === "Space") {
        e.preventDefault();
        playPause();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
    void (async () => {
      setBusy(true);
      try {
        setGraph(await skeletonGraph());
        await refreshMeta();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    })();
  });

  async function refreshMeta() {
    const [winRes, listRes] = await Promise.all([
      api.strategyChartWindows(),
      api.strategyList(),
    ]);
    setWindows(winRes.windows);
    setEngines(listRes.engines);
  }

  async function loadStrategy(id: string) {
    setBusy(true);
    try {
      const res = await api.strategyGet(id);
      setGraph(res.graph);
      setSelectedRuleId(null);
      setUndoStack([]);
      setStatus(`Stratégie chargée : ${id}`);
      setErrors([]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function newStrategy() {
    setBusy(true);
    try {
      setGraph(await skeletonGraph());
      setSelectedRuleId(null);
      setSelectedSlug(null);
      setWindowStart(null);
      setWindowEnd(null);
      setSeriesUp([]);
      setSeriesDown([]);
      setFills([]);
      setUndoStack([]);
      setPlaying(false);
      setPlayheadSec(0);
      setStatus("Nouvelle stratégie");
      setErrors([]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function clearWindow() {
    setSelectedSlug(null);
    setWindowStart(null);
    setWindowEnd(null);
    setSeriesUp([]);
    setSeriesDown([]);
    setFills([]);
    setPlaying(false);
    setPlayheadSec(0);
    setStatus("Axe 0–15 min (sans courbes)");
  }

  async function loadFills(upTokenId?: string | null, downTokenId?: string | null) {
    const fromWatch = tokenIdsFromWatching(selectedSlug());
    const ids = [upTokenId, downTokenId, fromWatch.up, fromWatch.down].filter(
      (id): id is string => Boolean(id),
    );
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      setFills([]);
      return;
    }
    try {
      const res = await api.botFills(unique);
      setFills(
        res.fills.map((f) => ({
          t: f.timestamp,
          price: f.price,
          outcomeIndex: f.outcomeIndex,
          side: f.side,
        })),
      );
    } catch {
      setFills([]);
    }
  }

  async function loadWindow(w: ChartWindowOption) {
    setSelectedSlug(w.eventSlug);
    setWindowStart(w.windowStart);
    setWindowEnd(w.windowEnd);
    setBusy(true);
    try {
      if (w.ticks <= 0 && !w.live) {
        setSeriesUp([]);
        setSeriesDown([]);
        setFills([]);
        setPlaying(false);
        setPlayheadSec(0);
        setStatus("Marché sans ticks — axe seulement");
        return;
      }
      const s = await api.strategyChartSeries({
        eventSlug: w.eventSlug,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      });
      setSeriesUp(s.up);
      setSeriesDown(s.down);
      setPlaying(false);
      setPlayheadSec(0);
      await loadFills(s.upTokenId, s.downTokenId);
      setStatus(
        w.live
          ? `Marché live : ${w.eventTitle || w.eventSlug}`
          : `Courbes chargées : ${w.eventTitle || w.eventSlug}`,
      );
    } catch (error) {
      setSeriesUp([]);
      setSeriesDown([]);
      await loadFills(null, null);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    const current = g();
    if (!current) return;
    setBusy(true);
    try {
      const res = await api.strategyValidate(current);
      setErrors(res.errors);
      setStatus(res.ok ? "Stratégie valide" : "Stratégie invalide");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const current = g();
    if (!current) return;
    setBusy(true);
    try {
      const listed = await api.strategyList();
      const exists =
        Boolean(current.id) && listed.engines.some((engine) => engine.id === current.id);
      const stored = exists
        ? await api.strategyUpdate(current.id, current)
        : await api.strategyCreate(current);
      setGraph(stored.graph);
      setStatus("Sauvegardé");
      const res = await api.strategyValidate(stored.graph);
      setErrors(res.errors);
      await refreshMeta();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    const current = g();
    if (!current) return;
    if ((current.chartRules?.length ?? 0) === 0) {
      setStatus("Active impossible : ajoute au moins une zone chart (sinon squelette graph edge-lead).");
      setErrors(["chartRules: at least one zone required to activate from the editor"]);
      return;
    }
    setBusy(true);
    try {
      const listed = await api.strategyList();
      const exists =
        Boolean(current.id) && listed.engines.some((engine) => engine.id === current.id);
      const stored = exists
        ? await api.strategyUpdate(current.id, current)
        : await api.strategyCreate(current);
      setGraph(stored.graph);
      const res = await api.strategyActivate(stored.graph.id);
      if (res.config) setConfig(res.config);
      const n = stored.graph.chartRules?.length ?? 0;
      setStatus(`Activé : ${stored.graph.id} — ${n} zone(s) exécutées live et en backtest`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    const current = g();
    if (!current) return;
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${current.id || "strategy"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as StrategyGraph;
      setGraph(parsed);
      setSelectedRuleId(null);
      setUndoStack([]);
      setStatus("JSON importé");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  const okStatus = () =>
    errors().length === 0 &&
    (status().includes("valide") || status().startsWith("Activé") || status() === "Sauvegardé");

  return (
    <div class="se-page">
      <header class="se-header">
        <button type="button" class="btn guide-back" onClick={() => navigate("/")}>
          ← Dashboard
        </button>
        <h1>Éditeur</h1>
        <div class="se-header-spacer" />
        <GraphToolbar
          busy={busy()}
          canUndo={undoStack().length > 0}
          onValidate={() => void validate()}
          onSave={() => void save()}
          onActivate={() => void activate()}
          onUndo={undoZones}
          onExport={exportJson}
          onImport={(file) => void importJson(file)}
        />
        <span class={`se-status${errors().length ? " is-err" : okStatus() ? " is-ok" : ""}`}>
          {status()}
        </span>
      </header>
      <Show when={g()}>
        {(current) => (
          <div class="se-body">
            <ChartEditorSidebar
              name={current().name}
              leadsWithEdge={current().leadsWithEdge}
              windows={mergedWindows()}
              engines={engines()}
              selectedSlug={selectedSlug()}
              selectedStrategyId={current().id || null}
              onName={(name) => setGraph({ ...current(), name })}
              onLeadsWithEdge={(leadsWithEdge) => setGraph({ ...current(), leadsWithEdge })}
              onLoadWindow={(w) => void loadWindow(w)}
              onClearWindow={clearWindow}
              onLoadStrategy={(id) => void loadStrategy(id)}
              onNewStrategy={() => void newStrategy()}
            />
            <div class="se-main">
              <ChartViewBar
                tooltipEnabled={tooltipEnabled()}
                showYes={showYes()}
                showNo={showNo()}
                onToggleTooltip={() => setTooltipEnabled(!tooltipEnabled())}
                onToggleYes={toggleYes}
                onToggleNo={toggleNo}
              />
              <ChartRulesCanvas
                durationSec={durationSec()}
                windowStartUnix={windowStartUnix()}
                up={seriesUp()}
                down={seriesDown()}
                fills={fills()}
                signals={replaySignals()}
                playheadSec={playheadSec()}
                showYes={showYes()}
                showNo={showNo()}
                tooltipEnabled={tooltipEnabled()}
                rules={chartRules()}
                selectedRuleId={selectedRuleId()}
                onSelectRule={setSelectedRuleId}
                onRulesChange={setChartRules}
                onLinkRejected={setStatus}
                onSeek={seek}
              />
              <ChartReplayBar
                durationSec={durationSec()}
                playheadSec={playheadSec()}
                playing={playing()}
                speed={speed()}
                hasSeries={hasSeries()}
                quote={replayQuote()}
                lastSignal={lastSignal()}
                onPlayPause={playPause}
                onSeek={seek}
                onSpeed={setSpeed}
                onRestart={restart}
              />
              <Show when={errors().length > 0}>
                <div class="se-errors">
                  <For each={errors()}>{(err) => <div>{err}</div>}</For>
                </div>
              </Show>
            </div>
            <ChartRulePanel
              rules={chartRules()}
              selectedId={selectedRuleId()}
              durationSec={durationSec()}
              onChange={setChartRules}
              onSelect={setSelectedRuleId}
              onApplyEdgeLead={applyEdgeLeadPreset}
              onLinkRejected={setStatus}
            />
          </div>
        )}
      </Show>
    </div>
  );
}

/** B1: auto-enable when a favorite-buy zone exists; never force-disable (sidebar can). */
function syncLeadsWithEdge(graph: StrategyGraph, rules: ChartRule[]): StrategyGraph {
  const wantsEdge = rules.some((r) => r.action === "buy" && r.token === "favorite");
  if (!wantsEdge || graph.leadsWithEdge) return graph;
  return { ...graph, leadsWithEdge: true };
}

function tokenIdsFromWatching(slug: string | null): { up: string | null; down: string | null } {
  if (!slug) return { up: null, down: null };
  const market = markets[slug];
  if (!market) return { up: null, down: null };
  return {
    up: market.books.find((b) => b.outcomeIndex === 0)?.tokenId ?? null,
    down: market.books.find((b) => b.outcomeIndex === 1)?.tokenId ?? null,
  };
}
