import { createStore } from "solid-js/store";
import type { LogEntry } from "../types";

const MAX_LOGS = 500;

export const [logs, setLogs] = createStore<LogEntry[]>([]);

export function addLog(
  message: string,
  data?: Record<string, unknown>,
  isError = false,
): void {
  setLogs((prev) =>
    [{ ts: Date.now(), message, data, isError }, ...prev].slice(0, MAX_LOGS),
  );
}
