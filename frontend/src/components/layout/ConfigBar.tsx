import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { config } from "../../stores/botStore";

export function ConfigBar(props: { onConfigure?: () => void }): JSX.Element {
  return (
    <Show when={config()}>
      {(c) => (
        <div class="config-bar">
          <span>
            {c().strategyId === "edge-lead" ? (
              <>
                Cheap <b>{c().edgeCheapBandMin}–{c().edgeCheapBandMax}</b>
                {" · edge "}
                <b>{c().edgeOrderUsdc}</b> USDC · cheap <b>{c().edgeCheapOrderUsdc}</b> USDC
              </>
            ) : c().strategyId === "fav-band" ? (
              <>
                Fav <b>{c().favBandAskMin}–{c().favBandAskMax}</b> · {c().favBandOrderUsdc} USDC
              </>
            ) : c().strategyId === "dip-revert" ? (
              <>
                Dip <b>{c().dipRevertBandMin}–{c().dipRevertBandMax}</b> · {c().dipRevertOrderUsdc} USDC
              </>
            ) : c().strategyId === "barbell" ? (
              <>
                Cheap <b>{c().cheapBuyMin}–{c().cheapBuyMax}</b> · {c().barbellCheapOrderUsdc} USDC
              </>
            ) : c().strategyId === "reverse" ? (
              <>
                Cheap <b>{c().cheapBuyMin}–{c().cheapBuyMax}</b> · {c().reverseCheapOrderUsdc} USDC
              </>
            ) : String(c().strategyId).startsWith("custom:") ? (
              <>
                Custom · {c().customOrderUsdc} USDC
              </>
            ) : (
              <>
                Cheap <b>{c().cheapBuyMin}–{c().cheapBuyMax}</b> · {c().cheapOrderUsdc} USDC
              </>
            )}
          </span>
          <span>
            Moteur <b>{c().strategyId}</b>
            {c().strategyId === "edge-lead"
              ? ` · edge ${c().edgeBandMin}–${c().edgeBandMax}`
              : c().strategyId === "barbell"
                ? ` · ratio ${c().barbellHedgeRatio ?? 0.5}`
                : c().strategyId === "reverse"
                  ? " · grilles maker"
                  : c().strategyId.startsWith("custom:")
                    ? ""
                    : ` · lock ${c().pairLockMax}`}
          </span>
          <Show when={c().strategyId !== "edge-lead"}>
            <span>
              Hedge <b>{c().expensiveBuyMin}–{c().expensiveBuyMax}</b>
              · plafond {c().expensiveOrderUsdc} USDC
            </span>
          </Show>
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
