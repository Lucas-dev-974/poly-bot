/**
 * Barre de contexte sim2 du Dashboard — même design que /simulation.
 * Chips : mode LIVE/READONLY, stratégie (résumé ex-ConfigBar, textes
 * conservés à l'identique) + bouton Paramètres, marchés + poll, hedge,
 * capital live, état WS, quota relayer.
 */
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { config, mode } from "../../stores/botStore";
import { liveBalance } from "../../stores/balanceStore";
import { WsBadge, QuotaBadge } from "../../components/layout/Badges";
import { fmtUsd } from "../../utils/format";

export function ContextBar(props: { onConfigure?: () => void }): JSX.Element {
  return (
    <div class="sim2-context">
      {/* Mode exécution (ex-badge du Header). */}
      <span class="sim2-chip" title="Mode d'exécution du bot">
        <b>Mode</b>
        <Show when={mode() === "readonly"} fallback={<span>{`LIVE`}</span>}>
          <span>LIVE (READONLY)</span>
        </Show>
      </span>

      {/* Résumé stratégie + ouverture des Paramètres (ex-ConfigBar). */}
      <Show when={config()}>
        {(c) => (
          <>
            <span
              class="sim2-chip"
              title="Paramètres du moteur (ouvrir les Paramètres pour éditer)"
            >
              <b>Moteur</b>
              <span>{c().strategyId}</span>
              <span class="sim2-chip-sep" />
              {/* Textes de synthèse hérités du ConfigBar, branche par branche. */}
              <span>
                {c().strategyId === "edge-lead"
                  ? `Cheap ${c().edgeCheapBandMin}–${c().edgeCheapBandMax} · edge ${c().edgeOrderUsdc} · cheap ${c().edgeCheapOrderUsdc} USDC`
                  : c().strategyId === "fav-band"
                    ? `Fav ${c().favBandAskMin}–${c().favBandAskMax} · ${c().favBandOrderUsdc} USDC${c().favBandExitEnabled ? " · exit" : ""}`
                    : c().strategyId === "dip-revert"
                      ? `Dip ${c().dipRevertBandMin}–${c().dipRevertBandMax} · ${c().dipRevertOrderUsdc} USDC`
                      : c().strategyId === "open-entry"
                        ? `Lean ${c().openEntryLeanTrigger} ≤ ${c().openEntryMaxElapsedSec}s · fair ≤ ${c().openEntryFairAskSumMax} · ${c().openEntryOrderUsdc} USDC${c().openEntrySlEnabled === false ? " · SL off" : " · SL on"}`
                        : c().strategyId === "probability-repricing"
                          ? `Reprice ${c().repricingOrderUsdc} USDC · TP ${c().repricingTargetAbs} / SL ${c().repricingStopAbs}`
                          : c().strategyId === "barbell"
                            ? `Cheap ${c().cheapBuyMin}–${c().cheapBuyMax} · ${c().barbellCheapOrderUsdc} USDC`
                            : c().strategyId === "reverse"
                              ? `Cheap ${c().cheapBuyMin}–${c().cheapBuyMax} · ${c().reverseCheapOrderUsdc} USDC`
                              : String(c().strategyId).startsWith("custom:")
                                ? `Custom · ${c().customOrderUsdc} USDC`
                                : `Cheap ${c().cheapBuyMin}–${c().cheapBuyMax} · ${c().cheapOrderUsdc} USDC`}
              </span>
              <button
                type="button"
                class="btn btn-ghost"
                title="Ouvrir les paramètres du bot"
                onClick={() => props.onConfigure?.()}
              >
                ⚙ Paramètres
              </button>
            </span>

            {/* Infos moteur complémentaires (ex-ConfigBar, 2e span). */}
            <span class="sim2-chip sim2-ellip" title={`Moteur ${c().strategyId} — rappels`}>
              <span class="sim2-ellip num">
                {c().strategyId === "edge-lead"
                  ? `edge ${c().edgeBandMin}–${c().edgeBandMax}`
                  : c().strategyId === "open-entry"
                    ? "SL dual-scale ou hold"
                    : c().strategyId === "probability-repricing"
                      ? "exits bid (TP/stop/time)"
                      : c().strategyId === "barbell"
                        ? `ratio ${c().barbellHedgeRatio ?? 0.5}`
                        : c().strategyId === "reverse"
                          ? "grilles maker"
                          : c().strategyId.startsWith("custom:")
                            ? "—"
                            : `lock ${c().pairLockMax}`}
              </span>
            </span>

            <Show when={c().strategyId !== "edge-lead"}>
              <span class="sim2-chip" title="Hedge (côté cher)">
                <b>Hedge</b>
                <span class="num">
                  {c().expensiveBuyMin}–{c().expensiveBuyMax}
                </span>
                <span class="sim2-chip-sep" />
                <span>
                  plafond <b>{c().expensiveOrderUsdc} USDC</b>
                </span>
              </span>
            </Show>
          </>
        )}
      </Show>

      {/* Marchés surveillés + cadence (miroir de la chip Marchés/Scan sim). */}
      <Show when={config()}>
        {(c) => (
          <span class="sim2-chip" title="Marchés surveillés et cadence de scan">
            <b>Marchés</b>
            <span class="sim2-ellip num">{c().marketSlugPrefixes.join(", ")}</span>
            <span class="sim2-chip-sep" />
            <b>Poll</b>
            <span class="num">
              {c().pollIntervalMs}
              <small> ms</small>
            </span>
          </span>
        )}
      </Show>

      {/* Capital live (ex-capital-badge du Header). */}
      <Show when={liveBalance()} keyed>
        {(b) => (
          <span class="sim2-chip" title="Compte live : cash + valorisation positions">
            <b>Capital</b>
            <span class="num">{fmtUsd(b.availableCollateral + b.positionsValue)}</span>
            <span class="sim2-chip-sep" />
            <span>
              cash <b>{fmtUsd(b.availableCollateral)}</b> · positions{" "}
              <b>{fmtUsd(b.positionsValue)}</b>
            </span>
          </span>
        )}
      </Show>

      <WsBadge />
      <QuotaBadge />
    </div>
  );
}