import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { orders } from "../../stores/orderStore";
import { countdown, fmtPrice, formatReturnPct } from "../../utils/format";
import { reasonLabel } from "../../utils/helpers";

export function RecentOrders(props: { now: number }): JSX.Element {
  return (
    <Panel title="Ordres récents">
      <div id="orders">
        <Show
          when={orders.length > 0}
          fallback={<EmptyState text="Aucun ordre pour l'instant." />}
        >
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Marché</th>
                <th>Outcome</th>
                <th>Prix</th>
                <th>Taille</th>
                <th>Rendement</th>
                <th>Statut</th>
                <th>Fin dans</th>
              </tr>
            </thead>
            <tbody>
              <For each={orders}>
                {(o) => {
                  const ret = formatReturnPct(o.price);
                  let status: JSX.Element;
                  if (o.filled === false && o.reason !== "resting" && o.reason !== "cancelled") {
                    status = (
                      <Badge variant="cheap">
                        rejeté · {reasonLabel(o.reason)}
                      </Badge>
                    );
                  } else if (o.reason === "cancelled") {
                    status = <Badge variant="cheap">annulé</Badge>;
                  } else if (o.reason === "resting" && o.fillPrice == null) {
                    status = <Badge variant="dry">en attente</Badge>;
                  } else {
                    const fillLabel =
                      o.fillPrice != null
                        ? `rempli @ ${fmtPrice(o.fillPrice)}`
                        : "rempli";
                    status = <Badge variant="live">{fillLabel}</Badge>;
                  }
                  return (
                    <tr>
                      <td>
                        <Badge variant={o.side === "SELL" ? "partiel" : o.kind}>
                          {o.side === "SELL"
                            ? `${o.orderType ?? "FOK"} - SELL`
                            : o.orderType
                              ? `${o.orderType} - ${o.kind}`
                              : o.kind}
                        </Badge>
                      </td>
                      <td>
                        <a
                          class="market-link"
                          href={`https://polymarket.com/event/${encodeURIComponent(o.slug)}`}
                          target="_blank"
                          rel="noopener"
                        >
                          {o.market}
                        </a>
                      </td>
                      <td>{o.outcome}</td>
                      <td>{fmtPrice(o.price)}</td>
                      <td>{o.size}</td>
                      <td>{ret}</td>
                      <td>{status}</td>
                      <td class="countdown">{countdown(o.windowEnd, props.now)}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </Panel>
  );
}
