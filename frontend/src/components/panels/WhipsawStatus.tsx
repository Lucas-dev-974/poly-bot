import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Panel } from "../ui/Panel";
import { api } from "../../api/client";
import { config } from "../../stores/botStore";
import { addLog } from "../../stores/logStore";

export function WhipsawStatus(): JSX.Element {
  const [status, setStatus] = createSignal<{
    enabled: boolean;
    active: boolean;
    remainingMs: number;
    lossStreak: number;
    pauseAfterLosses: number | null;
    pauseWindows: number;
  } | null>(null);

  const [resetting, setResetting] = createSignal(false);

  // Poll every second for live countdown
  onMount(() => {
    const fetchStatus = async () => {
      try {
        const res = await api.strategyStatus();
        setStatus(res.status);
      } catch {
        setStatus(null);
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 1000);
    return () => clearInterval(id);
  });

  const cfg = createMemo(() => config());
  const isFavBand = createMemo(() => cfg()?.strategyId === "fav-band");

  const badgeClass = createMemo(() => {
    const s = status();
    if (!s) return "unknown";
    if (!s.enabled) return "disabled";
    if (s.active) return "active";
    return "ready";
  });

  const remainingText = createMemo(() => {
    const s = status();
    if (!s || !s.active) return null;
    const remaining = Math.max(0, Math.ceil(s.remainingMs / 1000));
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
        setStatus(fresh.status);
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