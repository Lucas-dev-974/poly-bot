/**
 * Rangée KPI du Dashboard — 5 cartes sim2, miroir de la page Simulation :
 * Capital live (cash + positions), P&L réalisé (+latent + répartition G/P),
 * Winrate (jauge + EV/trade), Exposition ouverte (vs plafond Config),
 * Positions Polymarket (redeemables à clôturer).
 *
 * Présentation pure : toutes les données viennent des stores (lecture
 * directe INLINE dans le JSX — piège Solid : jamais de capture figée), le
 * flux d'agrégats = `statsStore.globalStats` (SSE `stats`, tous moteurs).
 */
import type { JSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import { RingGauge, clamp01 } from "../../components/ui/sim2Widgets";
import { pnlClass } from "../../utils/display";
import { globalStats } from "../../stores/statsStore";
import { liveBalance } from "../../stores/balanceStore";
import { config } from "../../stores/botStore";
import { polyPositions } from "../../stores/polyStore";
import { fmtUsd } from "../../utils/format";

export function KpiStrip(): JSX.Element {
  const stats = createMemo(() => globalStats());
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
    const cap = config()?.maxExposureUsdc ?? 0;
    return cap > 0 ? cap : null;
  });
  const exposurePct = createMemo(() => {
    const cap = exposureCap();
    if (cap == null) return null;
    return clamp01((stats()?.openExposure ?? 0) / cap);
  });
  // polyPositions est un createStore (proxy réactif) : lecture directe,
  // pas d'appel en fonction.
  const redeemable = createMemo(() => polyPositions.filter((p) => p.redeemable));

  return (
    <section class="sim2-kpis">
      <div class="sim2-kpi">
        <span class="sim2-kpi-label">Capital live</span>
        <Show when={liveBalance()} fallback={<span class="sim2-kpi-value sim2-muted">—</span>} keyed>
          {(b) => (
            <>
              <span class="sim2-kpi-value">{fmtUsd(b.availableCollateral + b.positionsValue)}</span>
              <span class="sim2-kpi-sub">
                cash <b>{fmtUsd(b.availableCollateral)}</b> · positions{" "}
                <b>{fmtUsd(b.positionsValue)}</b>
              </span>
            </>
          )}
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
        <span class="sim2-kpi-label">Polymarket</span>
        <Show
          when={redeemable().length > 0}
          fallback={
            <>
              <span class="sim2-kpi-value">
                <span class="num">{polyPositions.length}</span>
                <span class="sim2-kpi-unit">suivies</span>
              </span>
              <span class="sim2-kpi-sub">aucune à clôturer</span>
            </>
          }
        >
          <span class="sim2-kpi-value">
            <span class="num">{redeemable().length}</span>
            <span class="sim2-kpi-unit">à clôturer</span>
          </span>
          <span class="sim2-kpi-sub" title="Positions gagnantes résolues, redeem disponibles">
            clôture{" "}
            <b>{fmtUsd(redeemable().reduce((acc: number, p) => acc + (p.currentValue ?? 0), 0))}</b> pUSD
          </span>
          <span class="sim2-kpi-sub">
            <b>{redeemable().length}</b> redeem en attente · clic sur une carte Position Polymarket
          </span>
        </Show>
      </div>
    </section>
  );
}