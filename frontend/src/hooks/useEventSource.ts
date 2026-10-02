import { onMount } from "solid-js";
import { startSse } from "../transport/sse";

/**
 * Ensures the app-wide singleton SSE is running.
 * Prefer calling startSse() once from Root; this hook remains for any
 * legacy mount that still wants a declarative start without a second
 * EventSource (startSse is idempotent).
 */
export function useEventSource(): void {
  onMount(() => {
    startSse();
  });
}
