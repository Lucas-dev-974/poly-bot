import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { config } from "../../stores/botStore";

export function ConfigBar(props: { onConfigure?: () => void }): JSX.Element {
  return (
    <Show when={config()}>
      {(c) => (
        <div class="config-bar">
          <span>
            Cheap <b>{c().cheapBuyMin}–{c().cheapBuyMax}</b> · {c().cheapOrderUsdc} USDC
          </span>
          <span>
            Hedge <b>{c().expensiveBuyMin}–{c().expensiveBuyMax}</b> · {c().expensiveOrderUsdc} USDC
            · cible {c().pairTargetCost}
          </span>
          <span>
            Marchés <b>{c().marketSlugPrefixes.join(", ")}</b>
          </span>
          <span>
            Poll <b>{c().pollIntervalMs}ms</b>
          </span>
          <button
            class="btn config-btn"
            type="button"
            onClick={() => props.onConfigure?.()}
          >
            Configurer
          </button>
        </div>
      )}
    </Show>
  );
}
