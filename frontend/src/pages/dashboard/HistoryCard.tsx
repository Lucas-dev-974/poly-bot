/**
 * Carte « Historique » du dashboard — 3 onglets (Ordres récents | Positions
 * Polymarket | Positions résolues), sur le modèle de la carte Historique de
 * la page Simulation (onglets segmentés + compteurs dans l'en-tête).
 *
 * Les trois panneaux vivent désormais dans `components/panels/` sous forme de
 * CORPS (sans l'enveloppe Sim2Card) : c'est cette carte qui porte le titre,
 * les onglets et le corps. Les panneaux seuls ne sont plus importés par
 * App.tsx.
 */
import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { RecentOrdersBody } from "../../components/panels/RecentOrders";
import { PolymarketPositionsBody } from "../../components/panels/PolymarketPositions";
import { ResolvedPositionsBody } from "../../components/panels/ResolvedPositions";
import { orders } from "../../stores/orderStore";
import { polyPositions } from "../../stores/polyStore";
import { resolvedPositions } from "../../stores/positionStore";

type HistTab = "orders" | "poly" | "resolved";

export function HistoryCard(props: {
  now: number;
  onRedeem: (conditionId: string) => void;
}): JSX.Element {
  const [tab, setTab] = createSignal<HistTab>("orders");

  return (
    <section class="sim2-card">
      <div class="sim2-card-h">
        <h2>Historique</h2>
        <div class="sim2-seg" role="tablist">
          <button
            role="tab"
            classList={{ on: tab() === "orders" }}
            onClick={() => setTab("orders")}
          >
            Ordres <span class="n">{orders.length}</span>
          </button>
          <button
            role="tab"
            classList={{ on: tab() === "poly" }}
            onClick={() => setTab("poly")}
          >
            Positions Polymarket <span class="n">{polyPositions.length}</span>
          </button>
          <button
            role="tab"
            classList={{ on: tab() === "resolved" }}
            onClick={() => setTab("resolved")}
          >
            Positions résolues <span class="n">{resolvedPositions.length}</span>
          </button>
        </div>
      </div>
      <div class="sim2-card-b sim2-card-b-flush">
        <Show when={tab() === "orders"}>
          <RecentOrdersBody now={props.now} />
        </Show>
        <Show when={tab() === "poly"}>
          <PolymarketPositionsBody onRedeem={props.onRedeem} />
        </Show>
        <Show when={tab() === "resolved"}>
          <ResolvedPositionsBody />
        </Show>
      </div>
    </section>
  );
}
