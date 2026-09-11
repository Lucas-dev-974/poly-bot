import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { STRATEGY_PRESETS } from "../../config/strategyPresets";
import type { BacktestProgress, BacktestRunSummary, StrategyId } from "../../types";
import { dateTimeStr, fmtUsd } from "../../utils/format";
import { runEngineId } from "../../utils/backtest-preset";

const ENGINE_SHORT: Partial<Record<string, string>> = {
  arb: "Arb",
  barbell: "Barbell",
  "edge-lead": "Edge",
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

  return (
    <aside class="bt-runs">
      <div class="bt-runs-head">
        <span>Historique</span>
        <div class="bt-runs-seg" role="group" aria-label="Filtre historique">
          <button
            type="button"
            class={`bt-runs-seg-btn${props.engineOnly ? "" : " is-on"}`}
            onClick={() => props.onEngineOnly(false)}
          >
            Tous
          </button>
          <button
            type="button"
            class={`bt-runs-seg-btn${props.engineOnly ? " is-on" : ""}`}
            onClick={() => props.onEngineOnly(true)}
          >
            {engineLabel(props.engine)}
          </button>
        </div>
      </div>
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
            return (
              <div
                class={`bt-run${status() === "running" ? " is-live" : ""}${onChart() ? " is-chart" : ""}`}
              >
                <label
                  class={`bt-run-check${props.chartLoadingId === run.id ? " is-loading" : ""}`}
                  title="Afficher les positions sur le graphique"
                >
                  <input
                    type="checkbox"
                    checked={onChart()}
                    disabled={!canOpen()}
                    aria-label="Afficher les positions sur le graphique"
                    onChange={() => props.onToggleChart(run)}
                  />
                  <span class="bt-run-check-box" aria-hidden="true" />
                </label>
                <div class="bt-run-main">
                  <div class="bt-run-top">
                    <span class="bt-run-when">{dateTimeStr(run.startedAt)}</span>
                    <span class={`bt-run-status is-${status()}`}>
                      {statusLabel(status(), live()?.pct)}
                    </span>
                  </div>
                  <div class="bt-run-label">{runTitle(run)}</div>
                  <Show when={status() === "error" && (live()?.error ?? run.error)}>
                    <div class="bt-run-err">{live()?.error ?? run.error}</div>
                  </Show>
                  <Show when={pnl() != null}>
                    <div class={`bt-run-pnl ${(pnl() ?? 0) >= 0 ? "ok" : "err"}`}>{fmtUsd(pnl())}</div>
                  </Show>
                </div>
                <button
                  class="btn"
                  type="button"
                  disabled={!canOpen() || props.openingId === run.id}
                  onClick={() => props.onOpen(run)}
                >
                  {props.openingId === run.id ? "…" : "Détail"}
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </aside>
  );
}

function runTitle(run: BacktestRunSummary): string {
  const sid = engineLabel(runEngineId(run));
  if (run.request?.useCurrentConfig) return `${sid} · config live`;
  const preset = STRATEGY_PRESETS.find((p) => p.id === run.request?.presetId);
  return preset ? `${sid} · ${preset.name}` : sid;
}

function statusLabel(status: string, pct?: number): string {
  if (status === "running") return pct != null ? `${pct}%` : "en cours";
  if (status === "done") return "terminé";
  if (status === "error") return "erreur";
  if (status === "cancelled") return "annulé";
  return status;
}
