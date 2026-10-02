import { Suspense, Show, lazy } from "solid-js";
import type { JSX } from "solid-js";
import type { ChartTarget } from "../../types";

const MarketHistoryModal = lazy(() =>
  import("./MarketHistoryModal").then((m) => ({ default: m.MarketHistoryModal })),
);

/**
 * Charge le modal + canvas chart en chunk async pour ne pas grossir le
 * dashboard principal. Les adaptateurs ChartTarget restent eager
 * (utils/chart-target-adapters).
 */
export function LazyMarketHistoryModal(props: {
  target: ChartTarget | null | undefined;
  onClose: () => void;
}): JSX.Element {
  return (
    <Show when={props.target}>
      {(t) => (
        <Suspense fallback={null}>
          <MarketHistoryModal target={t()} onClose={props.onClose} />
        </Suspense>
      )}
    </Show>
  );
}
