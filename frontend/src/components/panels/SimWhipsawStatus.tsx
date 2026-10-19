import { Show, createMemo, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { api } from "../../api/client";
import { addLog } from "../../stores/logStore";
import { simWhipsaw, simRemainingMsAt, setSimWhipsaw } from "../../stores/simWhipsawStore";
import { useClock, clockNow } from "../../stores/clockStore";
import { pushError } from "../../stores/toastStore";

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Statut compact « Filtre whipsaw » (page Simulation, paper trading) —
 * ligne compacte intégrée à la section « Filtre whipsaw » du rail
 * Paramètres (redesign sim2). Miroir du WhipsawStatus du dashboard live,
 * branché sur le moteur sim : event SSE `simStrategyStatus` (5 s) + GET
 * /api/sim/strategy-status au montage. La pause est armée par les pertes
 * des positions SIMULÉES (tracker sim), indépendante du bot live.
 * Masqué si le statut est null (moteur sim ≠ fav-band, ou pas encore reçu).
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

  const statusText = createMemo(() => {
    const s = status();
    if (!s || !s.enabled) return null;
    if (s.active) return `Pause active — ${remainingText() ?? "—"} restants`;
    if (s.lossStreak > 0 && s.pauseAfterLosses != null && s.lossStreak >= s.pauseAfterLosses) {
      return `Seuil atteint (${s.lossStreak}/${s.pauseAfterLosses}) — la prochaine perte déclenche la pause`;
    }
    return `Actif — série de pertes : ${s.lossStreak}/${s.pauseAfterLosses ?? "—"}`;
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
        <div class="sim2-whip-row">
          <span class={`sim2-whip-badge ${badgeClass()}`}>
            <span class="sim2-whip-dot" aria-hidden="true" />
            <Show when={s().enabled} fallback={<span>Désactivé</span>}>
              <span>{badgeClass() === "active" ? `Pause ${remainingText() ?? "—"}` : "Whipsaw prêt"}</span>
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