import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { marketList } from "../../stores/marketStore";
import { countdown, fmtPrice } from "../../utils/format";
import { MarketHistoryModal, marketToChartTarget } from "../modals/MarketHistoryModal";
import type { MarketView } from "../../types";

export function ActiveMarkets(props: { now: number }): JSX.Element {
  const list = createMemo(() => marketList(props.now));
  const [chartMarket, setChartMarket] = createSignal<MarketView | null>(null);

  return (
    <>
      <Panel title="Marchés actifs">
        <Show
          when={list().length > 0}
          fallback={<EmptyState text="En attente de données…" />}
        >
        <table>
          <thead>
            <tr>
              <th>Marché</th>
              <th>Fenêtre</th>
              <th>Token</th>
              <th>Bid</th>
              <th>Ask</th>
              <th>Rôle</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            <For each={list()}>
              {(m) => (
                <For each={m.books}>
                  {(book) => {
                    const cheapestAsk = Math.min(
                      ...m.books.map((b) => b.bestAsk ?? Number.POSITIVE_INFINITY),
                    );
                    const role =
                      book.bestAsk !== null && book.bestAsk === cheapestAsk
                        ? "underdog"
                        : "favorite";
                    return (
                      <tr>
                        <td>
                          <a
                            class="market-link"
                            href={`https://polymarket.com/event/${encodeURIComponent(m.slug)}`}
                            target="_blank"
                            rel="noopener"
                          >
                            {m.title}
                          </a>
                        </td>
                        <td class="countdown">{countdown(m.windowEnd, props.now)}</td>
                        <td>{book.outcome}</td>
                        <td>{fmtPrice(book.bestBid)}</td>
                        <td>{fmtPrice(book.bestAsk)}</td>
                        <td>
                          <Badge variant={role}>{role}</Badge>
                        </td>
                        <td>
                          {m.books.indexOf(book) === 0 && (
                            <button
                              class="chart-btn"
                              type="button"
                              title={m.books.length > 0 ? "Voir le graphique" : "Données indisponibles"}
                              disabled={m.books.length === 0}
                              onClick={() => setChartMarket(m)}
                            >
                              📊
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              )}
            </For>
          </tbody>
        </table>
        </Show>
      </Panel>
      <Show when={chartMarket()}>
        {(m) => (
          <MarketHistoryModal
            target={marketToChartTarget(m())}
            onClose={() => setChartMarket(null)}
          />
        )}
      </Show>
    </>
  );
}
