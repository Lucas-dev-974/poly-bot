import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import type { BacktestPositionRow, BacktestResult, BacktestRunSummary } from "../../types";
import { groupedSettings, runCompletenessLabel, runPresetLabel, settingsForRun } from "../../utils/backtest-preset";
import { dateTimeStr, fmtUsd } from "../../utils/format";

export function BacktestResultModal(props: {
  open: boolean;
  result: BacktestResult | null;
  positions: BacktestPositionRow[];
  run: BacktestRunSummary | null;
  startedAt?: number | null;
  canApplyPreset: boolean;
  applying: boolean;
  applyMsg: string | null;
  applyErr: string | null;
  onApplyPreset: () => void;
  onClose: () => void;
}): JSX.Element {
  const settings = createMemo(() => settingsForRun(props.run));
  const groups = createMemo(() => {
    const s = settings();
    if (!s) return [];
    return groupedSettings(s, props.result?.strategyId ?? props.run?.request?.strategyId);
  });
  const presetTitle = createMemo(() => runPresetLabel(props.run, props.result?.strategyId));

  return (
    <Show when={props.open && props.result}>
      {(result) => (
        <div
          class="modal-overlay"
          tabindex="-1"
          ref={(el) => el.focus()}
          onClick={props.onClose}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <div class="modal bt-modal" onClick={(e) => e.stopPropagation()}>
            <div class="bt-modal-head">
              <div>
                <h3>Résultat du backtest</h3>
                <p class="bt-modal-meta">
                  {presetTitle()}
                  {props.startedAt ? ` · ${dateTimeStr(props.startedAt)}` : ""}
                  <Show when={props.run?.request}>
                    {" · "}
                    {runCompletenessLabel(props.run) ?? (props.run?.request?.completeOnly ? "complets" : "tous")}
                  </Show>
                </p>
              </div>
              <div class={`bt-modal-pnl ${result().pnl >= 0 ? "ok" : "err"}`}>
                {fmtUsd(result().pnl)}
                <span>
                  {fmtUsd(result().capitalStart)} → {fmtUsd(result().capitalEnd)}
                </span>
              </div>
            </div>
            <div class="bt-stats">
              <span>Fenêtres {result().windowsTested}</span>
              <span>Skip {result().windowsSkippedIncomplete}</span>
              <span>Unresolved {result().unresolvedWindows}</span>
              <span>Fills {result().fillCount}</span>
              <span>Rejects {result().rejectCount}</span>
              <span>Couvert {result().coveredPairs}</span>
              <span>Découvert {result().uncoveredPairs}</span>
            </div>
            <div class="bt-modal-split">
              <section class="bt-modal-cfg">
                <h4>Config du run</h4>
                <Show
                  when={groups().length > 0}
                  fallback={<p class="muted">Aucune config persistée pour ce run.</p>}
                >
                  <For each={groups()}>
                    {(group) => (
                      <div class="bt-cfg-group">
                        <div class="bt-cfg-group-title">{group.label}</div>
                        <div class="bt-cfg-dl">
                          <For each={group.rows}>
                            {(row) => (
                              <div class="bt-cfg-row">
                                <span>{row.label}</span>
                                <b>{row.value}</b>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </section>
              <section class="bt-modal-pos">
                <h4>Positions</h4>
                <div class="bt-pos-table">
                  <Show
                    when={props.positions.length > 0}
                    fallback={<p class="muted">Aucune position persistée.</p>}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Marché</th>
                          <th>Kind</th>
                          <th>Outcome</th>
                          <th>Fill</th>
                          <th>Size</th>
                          <th>Status</th>
                          <th>PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={props.positions}>
                          {(p) => (
                            <tr>
                              <td>{p.eventSlug}</td>
                              <td>{p.kind}</td>
                              <td>{p.outcome}</td>
                              <td>{p.fillPrice.toFixed(3)}</td>
                              <td>{p.size.toFixed(2)}</td>
                              <td>{p.status}</td>
                              <td>{p.pnl == null ? "—" : fmtUsd(p.pnl)}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
              </section>
            </div>
            <div class="modal-actions">
              <Show when={props.applyErr}>
                <span class="err">{props.applyErr}</span>
              </Show>
              <Show when={props.applyMsg}>
                <span class="ok">{props.applyMsg}</span>
              </Show>
              <button
                class="btn btn-primary"
                type="button"
                disabled={!props.canApplyPreset || props.applying}
                onClick={props.onApplyPreset}
              >
                {props.applying ? "…" : "Appliquer preset"}
              </button>
              <button class="btn" type="button" onClick={props.onClose}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
