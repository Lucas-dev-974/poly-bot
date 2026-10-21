/**
 * Carte « Flux en direct » de la page Simulation — 3 onglets : positions
 * ouvertes (P&L latent au bid live), ordres GTC reposés, marché actif
 * (ActiveMarkets temps réel, embarque son propre Panel).
 *
 * Données : stores sim (SSE) + marketStore. useClock() : horloge partagée
 * (tick 1 s) pour les countdowns.
 */
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { ActiveMarkets } from "../../components/panels/ActiveMarkets";
import { EmptyState } from "../../components/ui/EmptyState";
import { Sim2Card, Sim2Tabs } from "../../components/ui/Sim2Card";
import type { ChartTarget, SimulatedPosition } from "../../types";
import { simulatedPositionToChartTarget } from "../../utils/chart-target-adapters";
import { useClock, clockNow } from "../../stores/clockStore";
import { liveBidForToken, marketTitleForToken } from "../../stores/marketStore";
import { simOpenPositions, simResting } from "../../stores/simStore";
import { countdown, fmtPrice, fmtShares, fmtUsd, pct } from "../../utils/format";
import { countdownClass, pnlClass } from "../../utils/display";
import { GraphButton, OutcomeChip } from "../../components/ui/sim2Widgets";

/** P&L non réalisé d'une position ouverte, au prix de sortie (bid live). */
function unrealizedPnl(p: SimulatedPosition): number | null {
  const bid = liveBidForToken(p.tokenId);
  if (bid == null) return null;
  return (bid - p.fillPrice) * p.size;
}

type FeedTab = "positions" | "resting" | "market";

export function LiveFeedCard(props: { onChart: (t: ChartTarget) => void }): JSX.Element {
  // Horloge globale partagée (tick 1 s) — countdowns.
  useClock();
  const now = clockNow;
  const [feedTab, setFeedTab] = createSignal<FeedTab>("positions");

  // Onglets : compteurs lus au rendu (jamais capturés).
  const tabs = (): Array<{ id: FeedTab; label: string; count?: number }> => [
    { id: "positions", label: "Positions ouvertes", count: simOpenPositions().length },
    { id: "resting", label: "Ordres reposés", count: simResting().length },
    { id: "market", label: "Marché actif" },
  ];

  return (
    <Sim2Card
      title="Flux en direct"
      raw
      tabs={
        <Sim2Tabs
          tabs={tabs}
          active={feedTab()}
          onSelect={setFeedTab}
          ariaLabel="Flux en direct de la simulation"
        />
      }
    >
      <Show when={feedTab() === "positions"}>
        <div class="sim2-card-b">
          <Show
            when={simOpenPositions().length > 0}
            fallback={<EmptyState text="Aucune position papier ouverte." />}
          >
            <table class="sim2-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th class="num">Fill</th>
                  <th class="num">Bid live</th>
                  <th class="num">Taille</th>
                  <th class="num">Coût</th>
                  <th class="num">P&amp;L latent</th>
                  <th>Clôture</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <For each={simOpenPositions()}>
                  {(p) => (
                    <tr title={p.eventSlug}>
                      <td>
                        <div class="sim2-mkt">
                          <b>{p.eventTitle}</b>
                          <small class="num">{p.eventSlug}</small>
                        </div>
                      </td>
                      <td>
                        <OutcomeChip label={p.outcome} />
                      </td>
                      <td class="num">{fmtPrice(p.fillPrice)}</td>
                      <td class="num">{fmtPrice(liveBidForToken(p.tokenId))}</td>
                      <td class="num">{fmtShares(p.size)}</td>
                      <td class="num">{fmtUsd(p.cost)}</td>
                      <td class={`num ${pnlClass(unrealizedPnl(p) ?? 0)}`}>
                        <Show when={unrealizedPnl(p) != null} fallback="—">
                          {fmtUsd(unrealizedPnl(p)!)}
                          <Show when={p.cost > 0}>
                            <span class="sim2-pnl-pct">
                              {" "}({pct((unrealizedPnl(p)! / p.cost) * 100)})
                            </span>
                          </Show>
                        </Show>
                      </td>
                      <td>
                        <span class={`sim2-cd num ${countdownClass(p.windowEnd, now())}`}>
                          {countdown(p.windowEnd, now())}
                        </span>
                      </td>
                      <td>
                        <span class="sim2-tag2">{p.orderType ?? "GTC"}</span>
                      </td>
                      <td>
                        <GraphButton
                          title="Voir le graphique du marché avec les points d'entrée/sortie"
                          onClick={() => props.onChart(simulatedPositionToChartTarget(p))}
                        />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>

      <Show when={feedTab() === "resting"}>
        <div class="sim2-card-b">
          <Show when={simResting().length > 0} fallback={<EmptyState text="Aucun ordre GTC en attente." />}>
            <table class="sim2-table">
              <thead>
                <tr>
                  <th>Marché</th>
                  <th>Outcome</th>
                  <th>Kind</th>
                  <th class="num">Limite</th>
                  <th class="num">Taille</th>
                  <th class="num">Coût</th>
                  <th>Fin de fenêtre</th>
                </tr>
              </thead>
              <tbody>
                <For each={simResting()}>
                  {(o) => (
                    <tr title={o.key}>
                      <td>
                        <div class="sim2-mkt">
                          <b>{marketTitleForToken(o.tokenId)}</b>
                        </div>
                      </td>
                      <td>
                        <OutcomeChip label={o.outcome} />
                      </td>
                      <td>{o.kind}</td>
                      <td class="num">{fmtPrice(o.limitPrice)}</td>
                      <td class="num">{fmtShares(o.size)}</td>
                      <td class="num">{fmtUsd(o.cost)}</td>
                      <td>
                        <span class={`sim2-cd num ${countdownClass(o.windowEnd, now())}`}>
                          {countdown(o.windowEnd, now())}
                        </span>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>

      <Show when={feedTab() === "market"}>
        {/* ActiveMarkets embarque son propre Panel : rendu brut dans l'onglet. */}
        <div class="sim2-card-b sim2-card-b-flush">
          <ActiveMarkets now={now()} />
        </div>
      </Show>
    </Sim2Card>
  );
}