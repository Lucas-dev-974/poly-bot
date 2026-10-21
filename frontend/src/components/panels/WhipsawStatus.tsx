/**
 * Statut du filtre whipsaw (fav-band) — bot LIVE, rail du dashboard.
 *
 * Données : event SSE `strategyStatus` (5 s) + GET /api/strategy/status au
 * montage. La pause est armée par les pertes du bot live.
 *
 * La logique dérivée (classe de badge, countdown, seuil) est dans
 * `useWhipsawView` — partagée avec le panneau SIM.
 */
import { Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Sim2Card } from "../ui/Sim2Card";
import { api } from "../../api/client";
import { config } from "../../stores/botStore";
import { addLog } from "../../stores/logStore";
import {
  strategyStatus,
  remainingMsAt,
  setStrategyStatus,
} from "../../stores/strategyStatusStore";
import { toMessage } from "../../utils/display";
import { useWhipsawView } from "./useWhipsawView";

export function WhipsawStatus(): JSX.Element {
  const [resetting, setResetting] = createSignal(false);

  // Hydratation initiale : un seul GET au montage (le ring buffer SSE peut
  // être vide juste après le boot du bot, le premier event n'arrive qu'au
  // prochain tick de 5 s).
  onMount(() => {
    void (async () => {
      try {
        const res = await api.strategyStatus();
        if (res.status) setStrategyStatus(res.status);
      } catch {
        /* silencieux — l'event SSE prendra le relais */
      }
    })();
  });

  const view = useWhipsawView(strategyStatus, remainingMsAt);

  // Snapshot live du store SSE. Si le moteur n'est plus fav-band (switch à
  // chaud), le backend n'émet plus : on masque l'entry plutôt qu'afficher
  // un statut figé — aligné sur la condition isFavBand ci-dessous.
  const isFavBand = (): boolean => config()?.strategyId === "fav-band";

  const nextWindowText = (): string | null => {
    const s = view.status();
    if (!s || !s.enabled) return null;
    if (s.active) return `Pause active — ${view.remainingText()} restants`;
    if (view.thresholdReached()) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — prochaine fenêtre déclenchera la pause`;
    }
    return `Inactif — série pertes: ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
  };

  const handleReset = async (): Promise<void> => {
    if (resetting()) return;
    setResetting(true);
    try {
      const res = await api.strategyStatusReset();
      if (res.ok) {
        addLog("Filtre whipsaw réinitialisé manuellement");
        // Refresh status immediately
        const fresh = await api.strategyStatus();
        if (fresh.status) setStrategyStatus(fresh.status);
      } else {
        addLog("Échec réinitialisation whipsaw: " + (res.error ?? "inconnu"), undefined, true);
      }
    } catch (e) {
      addLog("Erreur réinitialisation whipsaw: " + toMessage(e), undefined, true);
    } finally {
      setResetting(false);
    }
  };

  return (
    <Show when={isFavBand()}>
      <Sim2Card title="Filtre Whipsaw (fav-band)">
        <div class="whipsaw-status">
          <div class={`whipsaw-badge ${view.badgeClass()}`}>
            <span class="dot" />
            <span class="label">
              {view.badgeClass() === "active" && "⏸️ Pause active"}
              {view.badgeClass() === "ready" && "✅ Prêt"}
              {view.badgeClass() === "disabled" && "⭕ Désactivé"}
              {view.badgeClass() === "unknown" && "❓ Inconnu"}
            </span>
          </div>

          <Show when={view.status()?.enabled}>
            <div class="whipsaw-details">
              <div class="detail-row">
                <span class="detail-label">Fenêtres de pause :</span>
                <span class="detail-value">
                  {view.status()!.pauseWindows} fenêtre(s) (≈{view.status()!.pauseWindows * 15} min)
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Seuil déclenchement :</span>
                <span class="detail-value">
                  {view.status()!.pauseAfterLosses != null
                    ? `${view.status()!.pauseAfterLosses} pertes consécutives`
                    : "Non configuré"}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Série pertes actuelle :</span>
                <span class="detail-value">{view.status()!.lossStreak}</span>
              </div>
              <Show when={view.status()!.active}>
                <div class="detail-row highlight">
                  <span class="detail-label">Temps restant :</span>
                  <span class="detail-value countdown">{view.remainingText()}</span>
                </div>
              </Show>
              <Show when={view.status()!.active}>
                <div class="detail-row reset-row">
                  <button
                    class="btn btn-danger-solid"
                    onClick={() => void handleReset()}
                    disabled={resetting()}
                  >
                    {resetting() ? "⏳ Réinitialisation..." : "🔄 Réinitialiser la pause"}
                  </button>
                </div>
              </Show>
              <div class="detail-row status-text">
                {nextWindowText()}
              </div>
            </div>
          </Show>

          <Show when={view.status() && !view.status()!.enabled}>
            <div class="whipsaw-disabled">
              Le filtre whipsaw est désactivé dans la configuration.
              <br />
              Activez <code>favBandWhipsawEnabled</code> pour voir l'état ici.
            </div>
          </Show>
        </div>
      </Sim2Card>
    </Show>
  );
}
