/**
 * Statut du filtre whipsaw (fav-band) — page Simulation (paper trading).
 *
 * Données : event SSE `simStrategyStatus` (5 s) + GET
 * /api/sim/strategy-status au montage. La pause est armée par les pertes
 * des positions SIMULÉES (tracker sim), indépendante du bot live.
 *
 * La carte n'est affichée QUE si le filtre whipsaw est ACTIVÉ dans la
 * config EFFECTIVE du moteur sim (`favBandWhipsawEnabled`) — même règle que
 * la carte du dashboard live : la source de vérité est la CONFIG (ce que le
 * moteur applique), pas le snapshot runtime (daté de ≤ 5 s).
 *
 * La PRÉSENTATION (carte) est partagée avec le dashboard live via
 * `WhipsawCard` ; ce composant ne porte que les données SIM + le reset.
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
import { WhipsawCard } from "./WhipsawCard";

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
      <WhipsawCard
        view={view}
        resetting={resetting()}
        onReset={() => void handleReset()}
      />
    </Show>
  );
}
