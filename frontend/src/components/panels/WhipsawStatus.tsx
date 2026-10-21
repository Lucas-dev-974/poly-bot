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
 * La PRÉSENTATION (carte) est partagée avec la page Simulation via
 * `WhipsawCard` ; ce composant ne porte que les données LIVE + le reset.
 */
import { Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
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
import { WhipsawCard } from "./WhipsawCard";

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
      <WhipsawCard
        view={view}
        resetting={resetting()}
        onReset={() => void handleReset()}
      />
    </Show>
  );
}
