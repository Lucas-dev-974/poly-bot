import type { BotEvent } from "../types";
import { addLog } from "../stores/logStore";
import { dispatchEvent } from "../stores/dispatcher";
import {
  markSseEvent,
  markSseError,
  markSseOpen,
} from "../stores/sseHealthStore";

/**
 * Singleton SSE (/events?replay=0) for the whole app.
 * One EventSource shared by dashboard + simulation (and any future page).
 * All events — including `balance` — go through dispatchEvent.
 */
let es: EventSource | null = null;
let wasConnected = false;
let loggedDisconnect = false;

function onMessage(msg: MessageEvent<string>): void {
  markSseEvent();
  try {
    dispatchEvent(JSON.parse(msg.data) as BotEvent);
  } catch {
    /* ignore malformed */
  }
}

function onOpen(): void {
  wasConnected = true;
  loggedDisconnect = false;
  markSseOpen();
}

function onError(): void {
  markSseError();
  if (wasConnected && !loggedDisconnect) {
    addLog("Connexion SSE perdue, reconnexion…", undefined, true);
    loggedDisconnect = true;
  }
}

/** Start the shared SSE connection once. Safe to call from multiple mounts. */
export function startSse(): void {
  if (es) return;
  es = new EventSource("/events?replay=0");
  es.onopen = onOpen;
  es.onmessage = onMessage;
  es.onerror = onError;
}
