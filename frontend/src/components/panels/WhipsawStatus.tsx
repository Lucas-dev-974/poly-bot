/**
 * Statut du filtre whipsaw (fav-band) — bot LIVE, rail du dashboard.
 *
 * Données : event SSE `strategyStatus` (5 s) + GET /api/strategy/status au
 * montage. La pause est armée par les pertes du bot live.
 *
 * La carte n'est affichée QUE si le filtre whipsaw est ACTIVÉ dans la config
 * live (`favBandWhipsawEnabled`) — la source de vérité est la CONFIG, pas le
 * snapshot runtime (daté de ≤ 5 s) : un filtre désactivé ne doit pas
 * afficher de carte du tout.
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

  // Source de vérité « filtre whipsaw ACTIVÉ » : la config LIVE (event SSE
  // `config` + /api/state). Le snapshot runtime ne porte que l'état de la
  // pause (daté de ≤ 5 s) — il ne peut pas piloter l'affichage de la carte.
  const view = useWhipsawView(strategyStatus, remainingMsAt, () =>
    config()?.favBandWhipsawEnabled === true,
  );

  // Snapshot live du store SSE. Si le moteur n'est plus fav-band (switch à
  // chaud), le backend n'émet plus : on masque l'entry plutôt qu'afficher
  // un statut figé — aligné sur la condition isFavBand ci-dessous.
  const isFavBand = (): boolean => config()?.strategyId === "fav-band";

  const nextWindowText = (): string | null => {
    const s = view.status();
    if (!s) return null;
    if (s.active) return `Pause active — ${view.remainingText()} restants`;
    if (view.thresholdReached()) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — prochaine fenêtre déclenchera la pause`;
    }
    return `Actif — série pertes: ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
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
    <Show when={isFavBand() && view.enabled()}>
      <Sim2Card title="Filtre Whipsaw (fav-band)">
        <div class="whipsaw-status">
          <div class={`whipsaw-badge ${view.badgeClass()}`}>
            <span class="dot" />
            <span class="label">
              {view.badgeClass() === "active" && "⏸️ Pause active"}
              {view.badgeClass() === "ready" && "✅ Prêt"}
              {view.badgeClass() === "unknown" && "❓ Inconnu"}
            </span>
          </div>

          <Show when={view.status()}>
            {(s) => (
              <div class="whipsaw-details">
                <div class="detail-row">
                  <span class="detail-label">Fenêtres de pause :</span>
                  <span class="detail-value">
                    {s().pauseWindows} fenêtre(s) (≈{s().pauseWindows * 15} min)
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Seuil déclenchement :</span>
                  <span class="detail-value">
                    {s().pauseAfterLosses != null
                      ? `${s().pauseAfterLosses} pertes consécutives`
                      : "Non configuré"}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Série pertes actuelle :</span>
                  <span class="detail-value">{s().lossStreak}</span>
                </div>
                <Show when={s().active}>
                  <div class="detail-row highlight">
                    <span class="detail-label">Temps restant :</span>
                    <span class="detail-value countdown">{view.remainingText()}</span>
                  </div>
                </Show>
                <Show when={s().active}>
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
            )}
          </Show>
        </div>
      </Sim2Card>
    </Show>
  );
}
