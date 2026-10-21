/**
 * Onglet « Positions résolues » de la carte Historique du dashboard.
 * CORPS seul (la carte + les onglets sont portés par
 * pages/dashboard/HistoryCard).
 */
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { resolvedPositions } from "../../stores/positionStore";
import { dateTimeStr, fmtPrice, fmtUsd } from "../../utils/format";
import { pnlClass } from "../../utils/display";

export function ResolvedPositionsBody(): JSX.Element {
  return (
    <Show
      when={resolvedPositions.length > 0}
      fallback={<EmptyState text="Aucune position résolue." />}
    >
      <div class="resolved sim2-table-scroll">
        <table class="sim2-table">
          <thead>
            <tr>
              <th>Résolue</th>
              <th>Marché</th>
              <th>Outcome</th>
              <th>Type</th>
              <th>Moteur</th>
              <th class="num">Fill</th>
              <th class="num">Taille</th>
              <th class="num">Coût</th>
              <th class="num">Crédit</th>
              <th class="num">P&amp;L</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            <For each={resolvedPositions}>
              {(p) => {
                const credit =
                  p.status === "won"
                    ? p.size
                    : p.status === "void"
                      ? (p.pnl ?? 0) + p.cost
                      : p.status === "sold"
                        ? (p.pnl ?? 0) + p.cost
                        : 0;
                return (
                  <tr>
                    <td class="num">{dateTimeStr(p.resolvedAt)}</td>
                    <td>{p.eventTitle}</td>
                    <td>{p.outcome}</td>
                    <td>
                      <span class="sim2-tag2">{p.kind}</span>
                    </td>
                    <td>{p.strategyId ?? "—"}</td>
                    <td class="num">{fmtPrice(p.fillPrice)}</td>
                    <td class="num">{p.size}</td>
                    <td class="num">{fmtUsd(p.cost)}</td>
                    <td class="num">{fmtUsd(credit)}</td>
                    <td class={`num ${pnlClass(p.pnl ?? 0)}`}>
                      {fmtUsd(p.pnl)}
                    </td>
                    <td>
                      <span class="sim2-tag2">{p.status}</span>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
