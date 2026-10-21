import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { orders } from "../../stores/orderStore";
import { countdown, fmtPrice, formatReturnPct } from "../../utils/format";
import { reasonLabel } from "../../utils/helpers";
import { Sim2Card } from "../../pages/dashboard/ui";

export function RecentOrders(props: { now: number }): JSX.Element {
  return (
    <Sim2Card title="Ordres récents" count={orders.length} flush>
      <Show
        when={orders.length > 0}
        fallback={<EmptyState text="Aucun ordre pour l'instant." />}
      >
        <div class="orders sim2-table-scroll">
          <table class="sim2-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Marché</th>
                <th>Outcome</th>
                <th class="num">Prix</th>
                <th class="num">Taille</th>
                <th class="num">Rendement</th>
                <th>Statut</th>
                <th>Fin dans</th>
              </tr>
            </thead>
            <tbody>
              <For each={orders}>
                {(o) => (
                  <tr>
                    <td>
                      <span
                        class={`sim2-tag2 ${o.side === "SELL" ? "sim2-side-sell" : ""}`}
                      >
                        {o.side === "SELL"
                          ? `${o.orderType ?? "FOK"} - SELL`
                          : o.orderType
                            ? `${o.orderType} - ${o.kind}`
                            : o.kind}
                      </span>
                      <Show
                        when={
                          o.filled === false &&
                          o.reason !== "resting" &&
                          o.reason !== "cancelled"
                        }
                      >
                        <span
                          class="sim2-tag2"
                          title={reasonLabel(o.reason)}
                        >
                          rejeté
                        </span>
                      </Show>
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
                    <td class="num">{fmtPrice(o.price)}</td>
                    <td class="num">{o.size}</td>
                    <td class="num">{formatReturnPct(o.price)}</td>
                    <td>
                      <span class="sim2-tag2">
                        {o.filled === false &&
                        o.reason !== "resting" &&
                        o.reason !== "cancelled"
                          ? `rejeté · ${reasonLabel(o.reason)}`
                          : o.reason === "cancelled"
                            ? "annulé"
                            : o.reason === "resting" && o.fillPrice == null
                              ? "en attente"
                              : o.fillPrice != null
                                ? `rempli @ ${fmtPrice(o.fillPrice)}`
                                : "rempli"}
                      </span>
                    </td>
                    <td class="num">
                      <span class="sim2-cd">{countdown(o.windowEnd, props.now)}</span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Sim2Card>
  );
}