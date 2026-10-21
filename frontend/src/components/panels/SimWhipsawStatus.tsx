/**
 * Statut compact « Filtre whipsaw » (page Simulation, paper trading) —
 * ligne compacte intégrée à la section « Filtre whipsaw » du rail
 * Paramètres (redesign sim2). Miroir du WhipsawStatus du dashboard live,
 * branché sur le moteur sim : event SSE `simStrategyStatus` (5 s) + GET
 * /api/sim/strategy-status au montage. La pause est armée par les pertes
 * des positions SIMULÉES (tracker sim), indépendante du bot live.
 * Masqué si le statut est null (moteur sim ≠ fav-band, ou pas encore reçu).
 *
 * La logique dérivée (classe de badge, countdown, seuil) est dans
 * `useWhipsawView` — partagée avec le panneau LIVE.
 */
import { Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { simWhipsaw, simRemainingMsAt, setSimWhipsaw } from "../../stores/simWhipsawStore";
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

  const view = useWhipsawView(simWhipsaw, simRemainingMsAt);

  const statusText = (): string | null => {
    const s = view.status();
    if (!s || !s.enabled) return null;
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
    <Show when={view.status()}>
      {(s) => (
        <div class="sim2-whip-row">
          <span class={`sim2-whip-badge ${view.badgeClass()}`}>
            <span class="sim2-whip-dot" aria-hidden="true" />
            <Show when={s().enabled} fallback={<span>Désactivé</span>}>
              <span>{view.badgeClass() === "active" ? `Pause ${view.remainingText() ?? "—"}` : "Whipsaw prêt"}</span>
            </Show>
          </span>
          <span
            class="sim2-whip-note"
            title={
              s().enabled
                ? `Fenêtres de pause : ${s().pauseWindows} · seuil ${s().pauseAfterLosses ?? "—"} pertes · série ${s().lossStreak}`
                : undefined
            }
          >
            {s().enabled ? statusText() : "Activez favBandWhipsawEnabled pour armer le filtre."}
          </span>
          <Show when={s().enabled && s().active}>
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
  );
}
