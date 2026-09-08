import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { simStats } from "../../stores/statsStore";
import { fmtUsd, pct } from "../../utils/format";

export function Performance(): JSX.Element {
  return (
    <Panel title="Performance">
      <Show
        when={simStats()}
        fallback={<EmptyState text="En attente de données…" />}
      >
        {(s) => (
          <table>
            <tbody>
              <tr>
                <td>P&L réalisé</td>
                <td class={s().realizedPnl >= 0 ? "ok" : "err"}>
                  {fmtUsd(s().realizedPnl)}
                </td>
              </tr>
              <tr>
                <td>— Arbitrage couvert</td>
                <td class={s().arbRealizedPnl >= 0 ? "ok" : "err"}>
                  {fmtUsd(s().arbRealizedPnl)}
                </td>
              </tr>
              <tr>
                <td>— Directionnel non couvert</td>
                <td class={s().directionalRealizedPnl >= 0 ? "ok" : "err"}>
                  {fmtUsd(s().directionalRealizedPnl)}
                </td>
              </tr>
              <tr>
                <td>Exposition ouverte</td>
                <td>{fmtUsd(s().openExposure)}</td>
              </tr>
              <tr>
                <td>— Couverte</td>
                <td>{fmtUsd(s().coveredExposure)}</td>
              </tr>
              <tr>
                <td>— Non couverte</td>
                <td>{fmtUsd(s().uncoveredExposure)}</td>
              </tr>
              <tr>
                <td>Positions ouvertes</td>
                <td>{s().openPositionsCount}</td>
              </tr>
              <tr>
                <td>Positions résolues</td>
                <td>{s().resolvedPositionsCount}</td>
              </tr>
              <tr>
                <td>Win rate</td>
                <td>
                  {pct(s().winRate)} ({s().wins}/{s().wins + s().losses})
                </td>
              </tr>
              <tr>
                <td>Fill rate</td>
                <td>
                  {pct(s().fillRate)} ({s().totalFilled}/{s().totalAttempted})
                </td>
              </tr>
              <tr>
                <td>Cover rate</td>
                <td>
                  {pct(s().coverRate)} ({s().coveredCount}/
                  {s().coveredCount + s().uncoveredCount})
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Show>
    </Panel>
  );
}
