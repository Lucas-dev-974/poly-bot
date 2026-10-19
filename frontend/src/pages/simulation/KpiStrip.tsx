/**
 * Rangée KPI de la page Simulation — 5 cartes : Capital total (édition
 * inline + sparkline equity), P&L réalisé (+latent + répartition G/P),
 * Winrate (jauge + EV/trade), Exposition ouverte (vs plafond), Activité
 * moteur (résolues, journal, fill rate).
 *
 * Présentation : toutes les données viennent des stores (lecture directe,
 * inline dans le JSX) + SimControl (édition capital) + SimEquity (sparkline).
 */
import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import type { SimControl } from "./useSimControl";
import type { SimEquity } from "./useSimEquity";
import { MicroSpark, RingGauge, clamp01 } from "./ui";
import { pnlClass } from "../simPageHelpers";
import { simBalance, simEngineStats, simJournal, simResting, simEffectiveConfig } from "../../stores/simStore";
import { fmtUsd } from "../../utils/format";

export function KpiStrip(props: { ctrl: SimControl; equity: SimEquity }): JSX.Element {
  const stats = createMemo(() => simEngineStats());
  const winCount = createMemo(() => stats()?.wins ?? 0);
  const lossCount = createMemo(() => stats()?.losses ?? 0);
  const winPctAll = createMemo(() => {
    const n = winCount() + lossCount();
    return n > 0 ? winCount() / n : 0;
  });
  const evPerTrade = createMemo(() => {
    const n = stats()?.resolvedPositionsCount ?? 0;
    const pnl = stats()?.realizedPnl ?? 0;
    return n > 0 ? pnl / n : null;
  });
  const exposureCap = createMemo(() => {
    const cap = simEffectiveConfig()?.maxExposureUsdc ?? 0;
    return cap > 0 ? cap : null;
  });
  const exposurePct = createMemo(() => {
    const cap = exposureCap();
    if (cap == null) return null;
    return clamp01((stats()?.openExposure ?? 0) / cap);
  });

  return (
    <section class="sim2-kpis">
      <div class="sim2-kpi">
        <span class="sim2-kpi-label">
          Capital total
          <Show when={!props.ctrl.editingCapital()}>
            <button
              type="button"
              class="sim2-pencil"
              title="Modifier le capital total"
              disabled={props.ctrl.sending()}
              onClick={() => props.ctrl.startCapitalEdit()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M17 3l4 4L8 20l-5 1 1-5z" />
              </svg>
            </button>
          </Show>
        </span>
        <Show when={simBalance()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>}>
          {(b) => (
            <Show
              when={props.ctrl.editingCapital()}
              fallback={
                <button
                  type="button"
                  class="sim2-kpi-value sim2-kpi-cap-btn"
                  title="Cliquer pour modifier le capital total"
                  disabled={props.ctrl.sending()}
                  onClick={() => props.ctrl.startCapitalEdit()}
                >
                  {fmtUsd(b().total)}
                </button>
              }
            >
              <input
                class="sim2-kpi-value sim2-kpi-edit"
                type="number"
                min="1"
                step="1"
                value={props.ctrl.capitalEditValue()}
                disabled={props.ctrl.sending()}
                ref={(el) => {
                  queueMicrotask(() => {
                    el.focus();
                    el.select();
                  });
                }}
                onInput={(e) => props.ctrl.setCapitalEditValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void props.ctrl.commitCapitalEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    props.ctrl.cancelCapitalEdit();
                  }
                }}
                onBlur={() => void props.ctrl.commitCapitalEdit()}
              />
            </Show>
          )}
        </Show>
        <Show when={simBalance()} keyed>
          {(b) => (
            <Show when={!props.ctrl.editingCapital()}>
              <span class="sim2-kpi-sub">
                cash <b>{fmtUsd(b.cash)}</b> · positions <b>{fmtUsd(b.positionsValue)}</b>
              </span>
            </Show>
          )}
        </Show>
        <Show when={props.equity.sparkValues().length >= 2}>
          <MicroSpark values={props.equity.sparkValues()} class="sim2-spark" />
        </Show>
      </div>

      <div class="sim2-kpi">
        <span class="sim2-kpi-label">P&amp;L réalisé</span>
        <Show when={stats()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>}>
          {(s) => (
            <>
              <span class="sim2-kpi-value">
                <span class={`num ${pnlClass(s().realizedPnl)}`}>{fmtUsd(s().realizedPnl)}</span>
                <span
                  class={`sim2-tag sim2-tag-latent ${s().unrealizedPnl > 0 ? "pos" : s().unrealizedPnl < 0 ? "neg" : ""}`}
                  title="P&L latent des positions ouvertes (bid live)"
                >
                  {s().unrealizedPnl >= 0 ? "+" : "−"}
                  {fmtUsd(Math.abs(s().unrealizedPnl)).slice(1)} latent
                </span>
              </span>
              <span class="sim2-kpi-sub">
                latent = bid live · <b>{s().openPositionsCount}</b> position(s) ouverte(s)
              </span>
              <div class="sim2-gpbar" title={`${winCount()} gagnantes / ${lossCount()} perdantes`}>
                <i class="sim2-gpbar-w" style={{ width: `${(winPctAll() * 100).toFixed(1)}%` }} />
                <i class="sim2-gpbar-l" />
              </div>
              <span class="sim2-kpi-sub">
                répartition <b>{winCount()} gagnantes</b> / <b>{lossCount()} perdantes</b>
              </span>
            </>
          )}
        </Show>
      </div>

      <div class="sim2-kpi">
        <span class="sim2-kpi-label">Winrate</span>
        <Show when={stats()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>}>
          {(s) => (
            <div class="sim2-wr">
              <RingGauge value={s().winRate} label={`${Math.round(s().winRate * 100)}%`} />
              <span class="sim2-kpi-sub">
                <b>{s().wins} G</b> / <b>{s().losses} P</b>
                <br />
                {s().resolvedPositionsCount} résolues
                <Show when={evPerTrade() != null}>
                  <br />
                  EV / trade <b class={`num ${pnlClass(evPerTrade()!)}`}>{fmtUsd(evPerTrade()!)}</b>
                </Show>
              </span>
            </div>
          )}
        </Show>
      </div>

      <div class="sim2-kpi">
        <span class="sim2-kpi-label">Exposition ouverte</span>
        <Show when={stats()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>}>
          {(s) => (
            <>
              <span class="sim2-kpi-value">
                <span class="num">{fmtUsd(s().openExposure)}</span>
                <Show when={exposurePct() != null}>
                  <span class="sim2-tag sim2-tag-ok">{Math.round((exposurePct() ?? 0) * 100)} % du plafond</span>
                </Show>
              </span>
              <span class="sim2-kpi-sub">
                <b>{s().openPositionsCount}</b> position(s) ouverte(s)
                <Show when={exposureCap() != null}> · plafond <b>{fmtUsd(exposureCap()!)}</b></Show>
              </span>
              <Show when={exposurePct() != null}>
                <div class="sim2-expbar">
                  <i style={{ width: `${((exposurePct() ?? 0) * 100).toFixed(1)}%` }} />
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>

      <div class="sim2-kpi">
        <span class="sim2-kpi-label">Activité moteur</span>
        <Show when={stats()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>}>
          {(s) => (
            <>
              <span class="sim2-kpi-value">
                <span class="num">{s().resolvedPositionsCount}</span>
                <span class="sim2-kpi-unit">résolues</span>
              </span>
              <span class="sim2-kpi-sub">
                journal <b>{simJournal().length}</b> ordres · reposés <b>{simResting().length}</b>
              </span>
              <div class="sim2-expbar" title={`Fill rate : ${Math.round(s().fillRate * 100)}%`}>
                <i style={{ width: `${clamp01(s().fillRate) * 100}%` }} />
              </div>
              <span class="sim2-kpi-sub">
                fill rate <b>{Math.round(s().fillRate * 100)}%</b> · fills <b>{s().totalFilled}</b>/<b>{s().totalAttempted}</b>
              </span>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}