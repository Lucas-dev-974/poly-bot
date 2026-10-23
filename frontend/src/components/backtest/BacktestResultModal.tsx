import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import type { BacktestPositionRow, BacktestResult, BacktestRunSummary } from "../../types";
import { groupedSettings, runCompletenessLabel, runPresetLabel, settingsForRun } from "../../utils/backtest-preset";
import { dateTimeStr, fmtUsd, pct } from "../../utils/format";
import { EquityMini } from "../ui/EquityMini";

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

  // Courbe d'équité du run : cumul du P&L fenêtre par fenêtre (résolues),
  // ancré sur capitalStart → capitalEnd. Absente sur les vieux runs
  // (result.windows vide) et sur les fenêtres non résolues (pnl null).
  const equityValues = createMemo((): number[] => {
    const r = props.result;
    if (!r || !r.windows || r.windows.length < 2) return [];
    let c = r.capitalStart;
    const v: number[] = [r.capitalStart];
    for (const w of r.windows) {
      if (w.pnl != null) {
        c += w.pnl;
        v.push(Math.round(c * 100) / 100);
      }
    }
    return v;
  });

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
            <div class="bt-stats bt-chips">
              <span class="bt-chip">Fenêtres <b>{result().windowsTested}</b></span>
              <span class="bt-chip">Skip <b>{result().windowsSkippedIncomplete}</b></span>
              <span class="bt-chip">Unresolved <b>{result().unresolvedWindows}</b></span>
              <span class="bt-chip">Fills <b>{result().fillCount}</b></span>
              <span class="bt-chip">Rejects <b class={result().rejectCount > 0 ? "neg" : ""}>{result().rejectCount}</b></span>
              <Show when={wr()}>
                {(w) => (
                  <span
                    class="bt-chip"
                    title={`Winrate strict des positions résolues (sold incl.) : ${w().wins} gagnées / ${w().losses} perdantes`}
                  >
                    WR <b>{pct(w().wr)}</b>
                    <span>
                      ({w().wins}W/{w().losses}L)
                    </span>
                  </span>
                )}
              </Show>
              <span class="bt-chip">Couvert <b>{result().coveredPairs}</b></span>
              <span class="bt-chip">Découvert <b>{result().uncoveredPairs}</b></span>
            </div>
            <Show when={equityValues().length > 1}>
              <div class="bt-equity">
                <div class="lbl-equity">P&L cumulé par fenêtre résolue</div>
                <EquityMini values={equityValues()} />
              </div>
            </Show>
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
                <div class="bt-pos-table sim2-table-scroll">
                  <Show
                    when={props.positions.length > 0}
                    fallback={<p class="muted">Aucune position persistée.</p>}
                  >
                    <table class="sim2-table">
                      <thead>
                        <tr>
                          <th>Fenêtre</th>
                          <th>Side</th>
                          <th>Kind</th>
                          <th>Outcome</th>
                          <th class="num">Fill</th>
                          <th class="num">Size</th>
                          <th>Status</th>
                          <th class="num">PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={props.positions}>
                          {(p) => (
                            <tr>
                              <td class="bt-cell-evt" title={`${p.eventSlug} — ${p.eventTitle}`}>
                                <span class="ellip">{p.eventSlug}</span>
                              </td>
                              <td class={p.side === "SELL" ? "sim2-side-sell" : "sim2-side-buy"}>{p.side}</td>
                              <td>{p.kind}</td>
                              <td>{p.outcome}</td>
                              <td class="num">{p.fillPrice.toFixed(3)}</td>
                              <td class="num">{p.size.toFixed(2)}</td>
                              <td>{p.status}</td>
                              <td class={`num ${p.pnl == null ? "" : p.pnl >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                                {p.pnl == null ? "—" : fmtUsd(p.pnl)}
                              </td>
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
                class="btn sim2-danger-ghost"
                type="button"
                disabled={!props.canApplyPreset || props.applying}
                onClick={props.onApplyPreset}
                title="Écrit le preset de ce run dans la config du bot LIVE — confirmation demandée"
              >
                {props.applying ? "…" : "Appliquer preset au live"}
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
