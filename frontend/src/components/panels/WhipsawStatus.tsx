import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Panel } from "../ui/Panel";
import { api } from "../../api/client";
import { config } from "../../stores/botStore";
import { addLog } from "../../stores/logStore";
import {
  strategyStatus,
  remainingMsAt,
  setStrategyStatus,
} from "../../stores/strategyStatusStore";
import { useClock, clockNow } from "../../stores/clockStore";

export function WhipsawStatus(): JSX.Element {
  const [resetting, setResetting] = createSignal(false);

  // Horloge globale partagée (tick 1 s) pour le countdown client.
  useClock();

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

  const cfg = createMemo(() => config());
  const isFavBand = createMemo(() => cfg()?.strategyId === "fav-band");

  // Snapshot live du store SSE. Si le moteur n'est plus fav-band (switch à
  // chaud), le backend n'émet plus : on masque l'entry plutôt que d'afficher
  // un statut figé — aligné sur la condition isFavBand ci-dessus.
  const snap = createMemo(() => strategyStatus());

  const status = createMemo(() => snap()?.status ?? null);

  // Countdown ancré : remainingMs mesuré à receivedAt, décrémenté par
  // l'horloge locale (remainingMsAt lit aussi le snapshot → réactif).
  const remainingMs = createMemo(() => {
    const s = snap();
    if (!s) return null;
    void clockNow(); // réactivité 1 s
    return remainingMsAt(clockNow());
  });

  const badgeClass = createMemo(() => {
    const s = status();
    if (!s) return "unknown";
    if (!s.enabled) return "disabled";
    if (s.active) return "active";
    return "ready";
  });

  const remainingText = createMemo(() => {
    const ms = remainingMs();
    if (ms == null || !status()?.active) return null;
    const remaining = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(remaining / 60);
    const sec = remaining % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  });

  const nextWindowText = createMemo(() => {
    const s = status();
    if (!s || !s.enabled) return null;
    if (s.active) return `Pause active — ${remainingText()} restants`;
    if (s.lossStreak > 0 && s.pauseAfterLosses != null && s.lossStreak >= s.pauseAfterLosses) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — prochaine fenêtre déclenchera la pause`;
    }
    return `Inactif — série pertes: ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
  });

  const handleReset = async () => {
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
      addLog("Erreur réinitialisation whipsaw: " + (e instanceof Error ? e.message : String(e)), undefined, true);
    } finally {
      setResetting(false);
    }
  };

  return (
    <Show when={isFavBand()}>
      <Panel title="Filtre Whipsaw (fav-band)">
        <div class="whipsaw-status">
          <div class={`whipsaw-badge ${badgeClass()}`}>
            <span class="dot" />
            <span class="label">
              {badgeClass() === "active" && "⏸️ Pause active"}
              {badgeClass() === "ready" && "✅ Prêt"}
              {badgeClass() === "disabled" && "⭕ Désactivé"}
              {badgeClass() === "unknown" && "❓ Inconnu"}
            </span>
          </div>

          <Show when={status()?.enabled}>
            <div class="whipsaw-details">
              <div class="detail-row">
                <span class="detail-label">Fenêtres de pause :</span>
                <span class="detail-value">{status()!.pauseWindows} fenêtre(s) (≈{status()!.pauseWindows * 15} min)</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Seuil déclenchement :</span>
                <span class="detail-value">
                  {status()!.pauseAfterLosses != null
                    ? `${status()!.pauseAfterLosses} pertes consécutives`
                    : "Non configuré"}
                </span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Série pertes actuelle :</span>
                <span class="detail-value">{status()!.lossStreak}</span>
              </div>
              <Show when={status()!.active}>
                <div class="detail-row highlight">
                  <span class="detail-label">Temps restant :</span>
                  <span class="detail-value countdown">{remainingText()}</span>
                </div>
              </Show>
              <Show when={status()!.active}>
                <div class="detail-row reset-row">
                  <button
                    class="btn btn-danger-solid"
                    onClick={handleReset}
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

          <Show when={status() && !status()!.enabled}>
            <div class="whipsaw-disabled">
              Le filtre whipsaw est désactivé dans la configuration.
              <br />
              Activez <code>favBandWhipsawEnabled</code> pour voir l'état ici.
            </div>
          </Show>
        </div>
      </Panel>
    </Show>
  );
}