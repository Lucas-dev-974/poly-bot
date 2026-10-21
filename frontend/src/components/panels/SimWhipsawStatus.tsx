/**
 * Statut compact « Filtre whipsaw » (page Simulation, paper trading) —
 * ligne compacte intégrée à la section « Filtre whipsaw » du rail
 * Paramètres (redesign sim2). Miroir du WhipsawStatus du dashboard live,
 * branché sur le moteur sim : event SSE `simStrategyStatus` (5 s) + GET
 * /api/sim/strategy-status au montage. La pause est armée par les pertes
 * des positions SIMULÉES (tracker sim), indépendante du bot live.
 *
 * La ligne n'est affichée QUE si le filtre whipsaw est ACTIVÉ dans la
 * config EFFECTIVE du moteur sim (`favBandWhipsawEnabled`) — même règle que
 * la carte du dashboard live : la source de vérité est la CONFIG (ce que le
 * moteur applique), pas le snapshot runtime (daté de ≤ 5 s). Masquée aussi
 * si le statut est null (moteur sim ≠ fav-band, ou pas encore reçu).
 *
 * La logique dérivée (classe de badge, countdown, seuil) est dans
 * `useWhipsawView` — partagée avec le panneau LIVE.
 */
import { Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { simWhipsaw, simRemainingMsAt, setSimWhipsaw } from "../../stores/simWhipsawStore";
import { simEffectiveConfig } from "../../stores/simStore";
import { pushError } from "../../stores/toastStore";
import { toMessage } from "../../utils/display";
import { useWhipsawView } from "./useWhipsawView";

export function SimWhipsawStatus(): JSX.Element {
  const [resetting, setResetting] = createSignal(false);

  // Hydratation initiale : un seul GET au montage (le ring buffer SSE peut
  // être vide juste après le boot, le premier event n'arrive qu'au prochain
  // tick de 5 s du moteur sim).
  onMount(() => {
    void (async () => {
      try {
        const res = await api.simStrategyStatus();
        setSimWhipsaw(res.status);
      } catch {
        /* silencieux — l'event SSE prendra le relais */
      }
    })();
  });

  // Source de vérité « filtre whipsaw ACTIVÉ » : la config EFFECTIVE du
  // moteur sim (preset + settings appliqués). Le snapshot runtime ne porte
  // que l'état de la pause — il ne peut pas piloter l'affichage.
  const view = useWhipsawView(simWhipsaw, simRemainingMsAt, () =>
    simEffectiveConfig()?.favBandWhipsawEnabled === true,
  );

  const statusText = (): string | null => {
    const s = view.status();
    if (!s) return null;
    if (s.active) return `Pause active — ${view.remainingText() ?? "—"} restants`;
    if (view.thresholdReached()) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — la prochaine perte déclenche la pause`;
    }
    return `Actif — série de pertes : ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
  };

  async function handleReset(): Promise<void> {
    if (resetting()) return;
    setResetting(true);
    try {
      const res = await api.simStrategyStatusReset();
      if (res.ok) {
        addLog("Filtre whipsaw sim réinitialisé manuellement");
        const fresh = await api.simStrategyStatus();
        setSimWhipsaw(fresh.status);
      } else {
        addLog("Échec réinitialisation whipsaw sim : " + (res.error ?? "inconnu"), undefined, true);
      }
    } catch (e) {
      pushError("Whipsaw sim : " + toMessage(e), { group: "sim-error", replaceGroup: true });
    } finally {
      setResetting(false);
    }
  }

  return (
    <Show when={view.enabled()}>
      <Show when={view.status()}>
        {(s) => (
          <div class="sim2-whip-row">
            <span class={`sim2-whip-badge ${view.badgeClass()}`}>
              <span class="sim2-whip-dot" aria-hidden="true" />
              <span>{view.badgeClass() === "active" ? `Pause ${view.remainingText() ?? "—"}` : "Whipsaw prêt"}</span>
            </span>
            <span
              class="sim2-whip-note"
              title={`Fenêtres de pause : ${s().pauseWindows} · seuil ${s().pauseAfterLosses ?? "—"} pertes · série ${s().lossStreak}`}
            >
              {statusText()}
            </span>
            <Show when={s().active}>
              <button
                class="btn btn-ghost sim2-whip-reset"
                onClick={() => void handleReset()}
                disabled={resetting()}
              >
                {resetting() ? "Réinitialisation…" : "Réinitialiser la pause"}
              </button>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  );
}
