import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Panel } from "../ui/Panel";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { simWhipsaw, simRemainingMsAt, setSimWhipsaw } from "../../stores/simWhipsawStore";
import { useClock, clockNow } from "../../stores/clockStore";
import { pushError } from "../../stores/toastStore";

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Panneau « Filtre whipsaw » de la page Simulation (paper trading) — miroir
 * de WhipsawStatus (dashboard live), branché sur le moteur sim :
 * event SSE `simStrategyStatus` (5 s) + GET /api/sim/strategy-status au
 * montage. La pause est armée par les pertes des positions SIMULÉES
 * (tracker sim), indépendante du bot live. Entry masquée si le statut est
 * null (moteur sim ≠ fav-band, ou pas encore reçu).
 */
export function SimWhipsawStatus(): JSX.Element {
  const [resetting, setResetting] = createSignal(false);

  // Horloge globale partagée (tick 1 s) pour le countdown client.
  useClock();

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

  // Snapshot live du store SSE. `null` = moteur sim ≠ fav-band → masqué.
  const snap = createMemo(() => simWhipsaw());
  const status = createMemo(() => snap()?.status ?? null);

  // Countdown ancré : remainingMs mesuré à receivedAt, décrémenté par
  // l'horloge locale (simRemainingMsAt lit aussi le snapshot → réactif).
  const remainingMs = createMemo(() => {
    const s = status();
    if (!s) return null;
    void clockNow(); // réactivité 1 s
    return simRemainingMsAt(clockNow());
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
    <Show when={status()}>
      {(s) => (
        <Panel title="Filtre whipsaw (paper)">
          <div class="whipsaw-status">
            <div class={`whipsaw-badge ${badgeClass()}`}>
              <span class="dot" />
              <span class="label">
                {badgeClass() === "active" && "⏸️ Pause active"}
                {badgeClass() === "ready" && "✅ Prêt"}
                {badgeClass() === "disabled" && "⭕ Désactivé"}
              </span>
            </div>

            <Show when={s().enabled}>
              <div class="whipsaw-details">
                <div class="detail-row">
                  <span class="detail-label">Fenêtres de pause :</span>
                  <span class="detail-value">{s().pauseWindows} fenêtre(s) (≈{s().pauseWindows * 15} min)</span>
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
                    <span class="detail-value countdown">{remainingText()}</span>
                  </div>
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

            <Show when={!s().enabled}>
              <div class="whipsaw-disabled">
                Le filtre whipsaw est désactivé dans la configuration du moteur sim.
                <br />
                Activez <code>favBandWhipsawEnabled</code> dans le panneau Paramètres (section « Filtre whipsaw ») pour voir l'état ici.
              </div>
            </Show>
          </div>
        </Panel>
      )}
    </Show>
  );
}