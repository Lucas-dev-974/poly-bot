import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { resolvedPositions } from "../../stores/positionStore";
import { dateTimeStr, fmtPrice, fmtUsd } from "../../utils/format";

export function ResolvedPositions(): JSX.Element {
  return (
    <Panel title="Positions résolues" full>
      <Show
        when={resolvedPositions.length > 0}
        fallback={<EmptyState text="Aucune position résolue." />}
      >
        <table>
          <thead>
            <tr>
              <th>Résolue</th>
              <th>Marché</th>
              <th>Outcome</th>
              <th>Type</th>
              <th>Fill</th>
              <th>Taille</th>
              <th>Coût</th>
              <th>Crédit</th>
              <th>P&L</th>
              <th>Statut</th>
            </tr>
          </thead>
          <tbody>
            <For each={resolvedPositions}>
              {(p) => {
                const credit = p.status === "won" ? p.size : 0;
                return (
                  <tr>
                    <td>{dateTimeStr(p.resolvedAt)}</td>
                    <td>{p.eventTitle}</td>
                    <td>{p.outcome}</td>
                    <td>
                      <Badge variant={p.kind}>{p.kind}</Badge>
                    </td>
                    <td>{fmtPrice(p.fillPrice)}</td>
                    <td>{p.size}</td>
                    <td>{fmtUsd(p.cost)}</td>
                    <td>{fmtUsd(credit)}</td>
                    <td class={(p.pnl || 0) >= 0 ? "ok" : "err"}>
                      {fmtUsd(p.pnl)}
                    </td>
                    <td>
                      <Badge variant={p.status === "won" ? "live" : "dry"}>
                        {p.status}
                      </Badge>
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </Show>
    </Panel>
  );
}
