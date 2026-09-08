import { bus } from "./dashboard/events.js";

export function log(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] ${message}`);
  }
  bus.emit({ type: "log", message, data });
}

export function logError(error: unknown): void {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  bus.emit({ type: "error", message });
}
