import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import type { BacktestPositionRow, BacktestResult, BacktestRunSummary } from "../../types";
import { groupedSettings, runCompletenessLabel, runPresetLabel, settingsForRun } from "../../utils/backtest-preset";
import { dateTimeStr, fmtUsd, pct } from "../../utils/format";

export function BacktestResultModal(props: {
  open: boolean;
  result: BacktestResult | null;
  positions: BacktestPositionRow[];
  run: BacktestRunSummary | null;
  runChartRules?: Array<{
    action: "buy" | "sell";
    token: "cheap" | "favorite";
    startSec: number;
    endSec: number;
    bandMin: number | null;
    bandMax: number | null;
  }>;
  startedAt?: number | null;
  canApplyPreset: boolean;
  applying: boolean;
  applyMsg: string | null;
  applyErr: string | null;
  onApplyPreset: () => void;
  onClose: () => void;
}): JSX.Element {
  const settings = createMemo(() => settingsForRun(props.run));
  // Fallback vieux runs : derive le WR strict des positions déjà chargées.
  const derivedWinRate = createMemo(() => {
    const rows = props.positions.filter((p) => p.side === "BUY" && p.status !== "open" && p.pnl != null);
    if (rows.length === 0) return null;
    const wins = rows.filter((p) => p.pnl! > 0).length;
    return { wins, losses: rows.length - wins, wr: wins / rows.length };
  });
  const wr = createMemo(() => {
    if (props.result?.winRate != null) {
      return { wins: props.result.wins ?? 0, losses: props.result.losses ?? 0, wr: props.result.winRate };
    }
    return derivedWinRate();
  });
  const groups = createMemo(() => {
    const s = settings();
    if (!s) return [];
    return groupedSettings(s, props.result?.strategyId ?? props.run?.request?.strategyId);
  });
  const presetTitle = createMemo(() => runPresetLabel(props.run, props.result?.strategyId));
  const strategyId = createMemo(
    () => props.result?.strategyId ?? props.run?.request?.strategyId,
  );
  const isCustom = createMemo(() => strategyId()?.startsWith("custom:") === true);

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
              <Show when={wr()}>
                {(w) => (
                  <span title={`Winrate strict des positions résolues (sold incl.) : ${w().wins} gagnées / ${w().losses} perdantes`}>
                    WR {pct(w().wr)} ({w().wins}W/{w().losses}L)
                  </span>
                )}
              </Show>
              <span>Couvert {result().coveredPairs}</span>
              <span>Découvert {result().uncoveredPairs}</span>
            </div>
            <Show when={isCustom()}>
              <section class="bt-modal-chart-rules">
                <h4>Zones de la stratégie (diagnostic)</h4>
                <Show
                  when={props.runChartRules && props.runChartRules.length > 0}
                  fallback={
                    <p class="muted">
                      Aucune zone (chartRules vide) — le squelette graphe est utilisé, pas le
                      moteur chart.
                    </p>
                  }
                >
                  <table class="bt-rule-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Action</th>
                        <th>Token</th>
                        <th>Fenêtre (s)</th>
                        <th>Bande prix</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={props.runChartRules}>
                        {(r, i) => (
                          <tr>
                            <td>{i() + 1}</td>
                            <td class={r.action === "buy" ? "ok" : "err"}>{r.action}</td>
                            <td>{r.token}</td>
                            <td>
                              {r.startSec}–{r.endSec}
                            </td>
                            <td>
                              {r.bandMin != null ? `${r.bandMin}–${r.bandMax}` : "—"}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
                <Show
                  when={
                    props.runChartRules &&
                    props.runChartRules.length > 0 &&
                    result().fillCount === 0 &&
                    result().rejectCount === 0
                  }
                >
                  <p class="err">
                    Aucun ordre tenté (Fills 0 / Rejects 0) : <code>findOpportunities</code> n'a
                    renvoyé aucun signal. Vérifie que tes zones sont des{" "}
                    <code>action: buy</code> (une vente sans position ouverte ne frappe jamais) ,
                    que la bande de prix est atteinte par l'ask, que les confirm ticks sont
                    satisfaits (série croissante) et que le capital / l'exposition le permettent.
                  </p>
                </Show>
              </section>
            </Show>
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
                          <th>Side</th>
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
                              <td class={p.side === "SELL" ? "err" : "ok"}>{p.side}</td>
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
