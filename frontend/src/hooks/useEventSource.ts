import { onCleanup, onMount } from "solid-js";
import type { BotEvent } from "../types";
import { addLog } from "../stores/logStore";

/**
 * SSE connection to /events with native EventSource auto-reconnect.
 * Logs a single "connection lost" message per outage (not per retry).
 */
export function useEventSource(onEvent: (event: BotEvent) => void): void {
  let wasConnected = false;
  let loggedDisconnect = false;

  onMount(() => {
    const es = new EventSource("/events?replay=0");

    es.onopen = () => {
      wasConnected = true;
      loggedDisconnect = false; // reset pour la prochaine déconnexion
    };

    es.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as BotEvent);
      } catch {
        /* ignore malformed */
      }
    };

    es.onerror = () => {
      if (wasConnected && !loggedDisconnect) {
        addLog("Connexion SSE perdue, reconnexion…", undefined, true);
        loggedDisconnect = true;
      }
    };

    onCleanup(() => es.close());
  });
}
