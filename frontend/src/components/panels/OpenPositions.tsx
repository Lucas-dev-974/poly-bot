import { For, Show, createMemo, createSignal } from "solid-js";
import { LazyMarketHistoryModal } from "../modals/LazyMarketHistoryModal";
import { simulatedPositionToChartTarget } from "../../utils/chart-target-adapters";
import type { JSX } from "solid-js";
import { EmptyState } from "../ui/EmptyState";
import { markets } from "../../stores/marketStore";
import { openPositionList } from "../../stores/positionStore";
import { currentQuotesForPosition, marketCoverage } from "../../utils/helpers";
import { countdown, fmtPrice, fmtUsd } from "../../utils/format";
import type { SimulatedPosition } from "../../types";
import { Sim2Card } from "../../pages/dashboard/ui";

// PNL latent + quotes du token d'une position : (bid courant - fillPrice) × size.
// Doit être un createMemo pour rester réactif aux mises à jour du book.
function usePositionPnl(
  position: SimulatedPosition,
): () => {
  bid: number | null;
  ask: number | null;
  pnl: number | null;
} {
  return createMemo(() => {
    const { bid, ask } = currentQuotesForPosition(markets, position);
    if (bid == null) return { bid, ask, pnl: null };
    return { bid, ask, pnl: (bid - position.fillPrice) * position.size };
  });
}

export function OpenPositions(props: {
  now: number;
  onClosePosition?: (position: SimulatedPosition) => void;
  closingId?: string | null;
}): JSX.Element {
  const positions = createMemo(() => openPositionList());

  const [chartPosition, setChartPosition] = createSignal<SimulatedPosition | null>(null);

  const byMarket = createMemo(() => {
    const map = new Map<string, {
      slug: string;
      title: string;
      windowEnd: number;
      positions: SimulatedPosition[];
    }>();
    for (const p of positions()) {
      if (!map.has(p.eventSlug)) {
        map.set(p.eventSlug, {
          slug: p.eventSlug,
          title: p.eventTitle,
          windowEnd: p.windowEnd,
          positions: [],
        });
      }
      map.get(p.eventSlug)!.positions.push(p);
    }
    return [...map.values()].sort((a, b) => a.windowEnd - b.windowEnd);
  });

  const totalPnl = createMemo(() => {
    let total = 0;
    for (const m of byMarket()) {
      for (const p of m.positions) {
        const bid = currentQuotesForPosition(markets, p).bid;
        if (bid != null) total += (bid - p.fillPrice) * p.size;
      }
    }
    return total;
  });

  const marketPnls = createMemo(() => {
    const map = new Map<string, number>();
    for (const m of byMarket()) {
      let pnl = 0;
      for (const p of m.positions) {
        const bid = currentQuotesForPosition(markets, p).bid;
        if (bid != null) pnl += (bid - p.fillPrice) * p.size;
      }
      map.set(m.slug, pnl);
    }
    return map;
  });

  return (
    <>
      <Sim2Card
        title="Positions ouvertes"
        count={positions().length}
        flush
      >
        <Show
          when={positions().length > 0}
          fallback={<EmptyState text="Aucune position ouverte." />}
        >
          <div class="market-cards">
            <For each={byMarket()}>
              {(m) => {
                const pnlMap = createMemo(() => marketPnls().get(m.slug) ?? 0);
                return (
                  <div class="market-card">
                    <div class="mc-head">
                      <span class="mc-title">
                        <a
                          class="market-link"
                          href={`https://polymarket.com/event/${encodeURIComponent(m.slug)}`}
                          target="_blank"
                          rel="noopener"
                        >
                          {m.title}
                        </a>
                      </span>
                      <span
                        class={`sim2-tag2 ${marketCoverage(m.positions) === "couvert" ? "pnl-pos" : ""}`}
                      >
                        {marketCoverage(m.positions)}
                      </span>
                      <span class="countdown">
                        {m.windowEnd * 1000 <= props.now
                          ? "Résolution…"
                          : countdown(m.windowEnd, props.now)}
                      </span>
                    </div>
                    <table class="sim2-table">
                      <thead>
                        <tr>
                          <th>Outcome</th>
                          <th>Type</th>
                          <th>Moteur</th>
                          <th class="num">Fill</th>
                          <th class="num">Taille</th>
                          <th class="num">Bid</th>
                          <th class="num">Ask</th>
                          <th class="num">Coût</th>
                          <th class="num">PNL latent</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={m.positions}>
                          {(p) => {
                            const pnlInfo = usePositionPnl(p);
                            const busy = () => props.closingId === p.id;
                            return (
                              <tr>
                                <td>{p.outcome}</td>
                                <td>
                                  <span class="sim2-tag2">
                                    {p.orderType ? `${p.orderType} - ${p.kind}` : p.kind}
                                  </span>
                                </td>
                                <td>{p.strategyId ?? "—"}</td>
                                <td class="num">{fmtPrice(p.fillPrice)}</td>
                                <td class="num">{p.size}</td>
                                <td class="num">{fmtPrice(pnlInfo().bid)}</td>
                                <td class="num">{fmtPrice(pnlInfo().ask)}</td>
                                <td class="num">{fmtUsd(p.cost)}</td>
                                <td
                                  class={`num ${pnlInfo().pnl == null ? "" : pnlInfo().pnl! >= 0 ? "pnl-pos" : "pnl-neg"}`}
                                >
                                  <Show
                                    when={pnlInfo().pnl != null}
                                    fallback={<span class="sim2-muted">—</span>}
                                  >
                                    {fmtUsd(pnlInfo().pnl)}
                                  </Show>
                                </td>
                                <td>
                                  <span class="poly-action-cell">
                                    <button
                                      class="chart-btn"
                                      type="button"
                                      title="Voir le graphique du marché"
                                      onClick={() => setChartPosition(p)}
                                    >
                                      📊
                                    </button>
                                    <Show when={props.onClosePosition}>
                                      <button
                                        class="btn btn-ghost"
                                        type="button"
                                        disabled={busy()}
                                        onClick={() => props.onClosePosition?.(p)}
                                      >
                                        {busy() ? "…" : "Fermer"}
                                      </button>
                                    </Show>
                                  </span>
                                </td>
                              </tr>
                            );
                          }}
                        </For>
                      </tbody>
                    </table>
                    <div class="mc-total">
                      Coût {fmtUsd(m.positions.reduce((s, p) => s + p.cost, 0))} · PNL latent{" "}
                      <span class={`num ${pnlMap() >= 0 ? "pnl-pos" : "pnl-neg"}`}>
                        {fmtUsd(pnlMap())}
                      </span>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="orders-total">
            PNL latent total :{" "}
            <span class={`num ${totalPnl() >= 0 ? "pnl-pos" : "pnl-neg"}`}>{fmtUsd(totalPnl())}</span>
          </div>
        </Show>
      </Sim2Card>
      <Show when={chartPosition()}>
        {(p) => (
          <LazyMarketHistoryModal
            target={simulatedPositionToChartTarget(p())}
            onClose={() => setChartPosition(null)}
          />
        )}
      </Show>
    </>
  );
}