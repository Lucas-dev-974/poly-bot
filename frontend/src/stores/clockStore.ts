import { createSignal, onCleanup } from "solid-js";

/**
 * Horloge globale partagée (tick 1 s) pour tous les countdowns.
 * Remplace les 3 timers séparés (App, SimulationPage, Header/QuotaBadge).
 *
 * Usage dans un composant (appel synchrone dans le corps) :
 *   useClock();            // démarre le tick global au 1er consommateur
 *   const now = clockNow;  // signal lu réactivement dans le JSX
 */
const [now, setNow] = createSignal(Date.now());

let timer: ReturnType<typeof setInterval> | null = null;
let consumers = 0;

export { now as clockNow };

/** Démarre le tick global 1 s tant qu'au moins un composant est monté. */
export function useClock(): void {
  consumers++;
  if (timer === null) {
    timer = setInterval(() => setNow(Date.now()), 1000);
  }
  onCleanup(() => {
    consumers--;
    if (consumers <= 0) {
      consumers = 0;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  });
}