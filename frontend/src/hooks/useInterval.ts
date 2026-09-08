import { onCleanup, onMount } from "solid-js";

/**
 * Runs a callback every `ms` milliseconds while mounted.
 * Used for countdowns and periodic REST sync.
 */
export function useInterval(fn: () => void, ms: number): void {
  onMount(() => {
    const id = setInterval(fn, ms);
    onCleanup(() => clearInterval(id));
  });
}
