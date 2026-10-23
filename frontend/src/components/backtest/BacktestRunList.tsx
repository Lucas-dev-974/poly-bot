import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { STRATEGY_PRESETS } from "../../config/strategyPresets";
import type { BacktestProgress, BacktestRunSummary, StrategyId } from "../../types";
import { dateTimeStr, fmtUsd, pct } from "../../utils/format";
import { runEngineId } from "../../utils/backtest-preset";
import { Sim2Card, Sim2Tabs } from "../ui/Sim2Card";

const ENGINE_SHORT: Partial<Record<string, string>> = {
  arb: "Arb",
  barbell: "Barbell",
  "edge-lead": "Edge",
  reverse: "Rev",
};

function engineLabel(id: string | undefined): string {
  if (!id) return "?";
  return ENGINE_SHORT[id] ?? (id.startsWith("custom:") ? id.slice("custom:".length) : id);
}

export function BacktestRunList(props: {
  runs: BacktestRunSummary[];
  engine: StrategyId;
  engineOnly: boolean;
  onEngineOnly: (value: boolean) => void;
  progress: BacktestProgress | null;
  openingId: string | null;
  chartRunId: string | null;
  chartLoadingId: string | null;
  onOpen: (run: BacktestRunSummary) => void;
  onToggleChart: (run: BacktestRunSummary) => void;
}): JSX.Element {
  const visible = () =>
    props.engineOnly ? props.runs.filter((run) => runEngineId(run) === props.engine) : props.runs;

  const engineCount = createMemo(
    () => props.runs.filter((run) => runEngineId(run) === props.engine).length,
  );
  const segTabs = createMemo(() => [
    { id: "all" as const, label: "Tous", count: props.runs.length },
    { id: "engine" as const, label: engineLabel(props.engine), count: engineCount() },
  ]);

  return (
    <aside class="bt-runs">
      <Sim2Card
        title="Historique"
        count={`${visible().length}/${props.runs.length}`}
        tabs={
          <Sim2Tabs
            tabs={segTabs}
            active={props.engineOnly ? "engine" : "all"}
            onSelect={(id) => props.onEngineOnly(id === "engine")}
            ariaLabel="Filtre historique"
          />
        }
        raw
      >
        <div class="bt-runs-list">
          <Show when={visible().length === 0}>
            <p class="bt-runs-empty">
              {props.engineOnly
                ? `Aucun backtest ${engineLabel(props.engine)}.`
                : "Aucun backtest enregistré."}
            </p>
          </Show>
          <For each={visible()}>
            {(run) => {
              const live = () => props.progress?.runId === run.id ? props.progress : null;
              const status = () => live()?.status ?? run.status;
              const canOpen = () => status() === "done" || run.result != null;
              const onChart = () => props.chartRunId === run.id;
              const pnl = () => run.result?.pnl;
              const wr = () => run.result?.winRate;
              const dur = () =>
                run.finishedAt && run.finishedAt > run.startedAt
                  ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))
                  : null;
              return (
                <div
                  class={`bt-run${status() === "running" ? " is-live" : ""}${onChart() ? " is-chart" : ""}`}
                >
                  <label
                    class={`bt-run-check${props.chartLoadingId === run.id ? " is-loading" : ""}`}
                    title="Afficher entrées (cercles) et sorties (croix : vente mid-marché ou résolution)"
                  >
                    <input
                      type="checkbox"
                      checked={onChart()}
                      disabled={!canOpen()}
                      aria-label="Afficher entrées et sorties sur le graphique"
                      onChange={() => props.onToggleChart(run)}
                    />
                    <span class="bt-run-check-box" aria-hidden="true" />
                  </label>
                  <div class="bt-run-main">
                    <div class="bt-run-top">
                      <span class="bt-run-tag">{runTitle(run)}</span>
                      <span class={`bt-run-status is-${status()}`}>
                        {statusLabel(status(), live()?.pct)}
                      </span>
                    </div>
                    <div class="bt-run-metrics">
                      <Show when={pnl() != null}>
                        <span class={`bt-run-pnl ${(pnl() ?? 0) >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                          {fmtUsd(pnl())}
                        </span>
                      </Show>
                      <Show when={wr() != null}>
                        <span
                          class="bt-run-wr"
                          title={`Winrate strict : ${run.result?.wins ?? 0} gagnées / ${(run.result?.wins ?? 0) + (run.result?.losses ?? 0)} résolues`}
                        >
                          WR {pct(wr() ?? 0)}
                        </span>
                      </Show>
                      <Show when={pnl() == null && wr() == null}>
                        <span class="bt-run-wr">—</span>
                      </Show>
                      <span class="bt-run-open">
                        <button
                          class="btn btn-ghost"
                          type="button"
                          disabled={!canOpen() || props.openingId === run.id}
                          onClick={() => props.onOpen(run)}
                        >
                          {props.openingId === run.id ? "…" : "Détail"}
                        </button>
                      </span>
                    </div>
                    <div class="bt-run-sub" title={run.error ?? undefined}>
                      <span>{dateTimeStr(run.startedAt)}</span>
                      <Show when={run.result?.windowsTested != null}>
                        <span>{run.result?.windowsTested} fen.</span>
                      </Show>
                      <Show when={run.result?.fillCount != null}>
                        <span>{run.result?.fillCount} fills</span>
                      </Show>
                      <Show when={dur() != null}>
                        <span>{dur()}s</span>
                      </Show>
                    </div>
                    <Show when={status() === "error" && (live()?.error ?? run.error)}>
                      <div class="bt-run-err">{live()?.error ?? run.error}</div>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Sim2Card>
    </aside>
  );
}

function runTitle(run: BacktestRunSummary): string {
  const sid = engineLabel(runEngineId(run));
  if (run.request?.useCurrentConfig) return `${sid} · config live`;
  const preset = STRATEGY_PRESETS.find((p) => p.id === run.request?.presetId);
  return preset ? `${sid} · ${preset.name}` : sid;
}

function statusLabel(status: string, pctVal?: number): string {
  if (status === "running") return pctVal != null ? `${pctVal}%` : "en cours";
  if (status === "done") return "terminé";
  if (status === "error") return "erreur";
  if (status === "cancelled") return "annulé";
  return status;
}