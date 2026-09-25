import { onCleanup, onMount } from "solid-js";
import { isSseAlive } from "../stores/sseHealthStore";

/**
 * Polling adaptatif à deux vitesses, gate sur la santé du flux SSE :
 * - SSE vivant → fréquence lente (filet de sécurité de réconciliation)
 * - SSE perdu → fréquence rapide (réconciliateur principal, le SSE frontend
 *   utilise replay=0 : les events manqués pendant la coupure ne reviennent pas)
 *
 * L'intervalle n'est re-programmé QUE quand l'état vivant du SSE change :
 * recréer le timer à chaque tick d'un watcher court empêcherait l'échéance
 * du timer principal (anti-pattern clearInterval+setInterval en boucle).
 * À la reconnexion (perdu → vivant), un tick immédiat resynchronise ce que
 * replay=0 a perdu.
 */
export function useAdaptiveSync(
  fn: () => void | Promise<void>,
  opts: { fastMs: number; slowMs: number },
): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let alive: boolean | null = null; // null = jamais évalué

  function applyInterval(): void {
    const nowAlive = isSseAlive();
    if (nowAlive === alive) return; // pas de changement → timer conservé
    const wasAlive = alive;
    alive = nowAlive;
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => void fn(), nowAlive ? opts.slowMs : opts.fastMs);
    // Transition perdu → vivant : resync immédiate de ce que replay=0 a perdu.
    if (!wasAlive && nowAlive) void fn();
  }

  onMount(() => {
    // Premier tick synchronisation immédiat (hydratation au montage).
    void fn();
    applyInterval();
    // Watcher 1 s : détecte les transitions vivant ↔ perdu et re-programme
    // l'intervalle en conséquence (ne touche pas au timer entre deux transitions).
    const watcher = setInterval(() => applyInterval(), 1000);
    onCleanup(() => clearInterval(watcher));
    onCleanup(() => {
      if (timer !== null) clearInterval(timer);
    });
  });
}