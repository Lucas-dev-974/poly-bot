import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { markets } from "../../stores/marketStore";
import { openPositionList } from "../../stores/positionStore";
import { currentBidForPosition, marketCoverage } from "../../utils/helpers";
import { countdown, fmtPrice, fmtUsd } from "../../utils/format";
import type { SimulatedPosition } from "../../types";

// PNL latent pour une position : (bid courant - fillPrice) × size.
// Doit être un createMemo pour rester réactif aux mises à jour du book.
function usePositionPnl(
  position: SimulatedPosition,
): () => { bid: number | null; pnl: number | null } {
  return createMemo(() => {
    const bid = currentBidForPosition(markets, position);
    if (bid == null) return { bid: null, pnl: null };
    return { bid, pnl: (bid - position.fillPrice) * position.size };
  });
}

export function OpenPositions(props: {
  now: number;
  onClosePosition?: (position: SimulatedPosition) => void;
  closingId?: string | null;
}): JSX.Element {
  const positions = createMemo(() => openPositionList());

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
        const bid = currentBidForPosition(markets, p);
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
        const bid = currentBidForPosition(markets, p);
        if (bid != null) pnl += (bid - p.fillPrice) * p.size;
      }
      map.set(m.slug, pnl);
    }
    return map;
  });

  return (
    <Panel title="Positions ouvertes" full>
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
                    <Badge variant={marketCoverage(m.positions) === "couvert" ? "couvert" : "partiel"}>
                      {marketCoverage(m.positions)}
                    </Badge>
                    <span class="countdown">
                      {m.windowEnd * 1000 <= props.now
                        ? "Résolution…"
                        : countdown(m.windowEnd, props.now)}
                    </span>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Outcome</th>
                        <th>Type</th>
                        <th>Moteur</th>
                        <th>Fill</th>
                        <th>Taille</th>
                        <th>Coût</th>
                        <th>PNL latent</th>
                        <th></th>
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
                                <Badge variant={p.kind}>
                                  {p.orderType ? `${p.orderType} - ${p.kind}` : p.kind}
                                </Badge>
                              </td>
                              <td>{p.strategyId ?? "—"}</td>
                              <td>{fmtPrice(p.fillPrice)}</td>
                              <td>{p.size}</td>
                              <td>{fmtUsd(p.cost)}</td>
                              <td>
                                <Show
                                  when={pnlInfo().pnl != null}
                                  fallback={<span class="muted">—</span>}
                                >
                                  <span class={pnlInfo().pnl! >= 0 ? "ok" : "err"}>
                                    {fmtUsd(pnlInfo().pnl)}
                                  </span>
                                </Show>
                              </td>
                              <td>
                                <Show when={props.onClosePosition}>
                                  <button
                                    class="btn"
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => props.onClosePosition?.(p)}
                                  >
                                    {busy() ? "…" : "Fermer"}
                                  </button>
                                </Show>
                              </td>
                            </tr>
                          );
                        }}
                      </For>
                    </tbody>
                  </table>
                  <div class="mc-total">
                    Coût {fmtUsd(m.positions.reduce((s, p) => s + p.cost, 0))} · PNL latent{" "}
                    <span class={pnlMap() >= 0 ? "ok" : "err"}>
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
          <span class={totalPnl() >= 0 ? "ok" : "err"}>{fmtUsd(totalPnl())}</span>
        </div>
      </Show>
    </Panel>
  );
}
