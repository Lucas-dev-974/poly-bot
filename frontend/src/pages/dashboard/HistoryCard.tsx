/**
 * Carte « Historique » du dashboard — 3 onglets (Ordres récents | Positions
 * Polymarket | Positions résolues), sur le modèle de la carte Historique de
 * la page Simulation (onglets segmentés + compteurs dans l'en-tête).
 *
 * Les trois panneaux vivent dans `components/panels/` sous forme de CORPS
 * (sans l'enveloppe Sim2Card) : c'est cette carte qui porte le titre, les
 * onglets et le corps. Les panneaux seuls ne sont plus importés par
 * App.tsx.
 */
import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { RecentOrdersBody } from "../../components/panels/RecentOrders";
import { PolymarketPositionsBody } from "../../components/panels/PolymarketPositions";
import { ResolvedPositionsBody } from "../../components/panels/ResolvedPositions";
import { Sim2Card, Sim2Tabs } from "../../components/ui/Sim2Card";
import { orders } from "../../stores/orderStore";
import { polyPositions } from "../../stores/polyStore";
import { resolvedPositions } from "../../stores/positionStore";

type HistTab = "orders" | "poly" | "resolved";

export function HistoryCard(props: {
  now: number;
  onRedeem: (conditionId: string) => void;
}): JSX.Element {
  const [tab, setTab] = createSignal<HistTab>("orders");

  // Les compteurs sont lus AU RENDU (dans le JSX) : les stores sont des
  // proxies réactifs, un tableau figé ici ne se rafraîchirait pas.
  const tabs = (): Array<{ id: HistTab; label: string; count: number }> => [
    { id: "orders", label: "Ordres", count: orders.length },
    { id: "poly", label: "Positions Polymarket", count: polyPositions.length },
    { id: "resolved", label: "Positions résolues", count: resolvedPositions.length },
  ];

  return (
    <Sim2Card
      title="Historique"
      flush
      tabs={
        <Sim2Tabs
          tabs={tabs}
          active={tab()}
          onSelect={setTab}
          ariaLabel="Historique du dashboard"
        />
      }
    >
      <Show when={tab() === "orders"}>
        <RecentOrdersBody now={props.now} />
      </Show>
      <Show when={tab() === "poly"}>
        <PolymarketPositionsBody onRedeem={props.onRedeem} />
      </Show>
      <Show when={tab() === "resolved"}>
        <ResolvedPositionsBody />
      </Show>
    </Sim2Card>
  );
}
