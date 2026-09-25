import { createSignal } from "solid-js";
import type { EngineStatsRow, SimulatedStats } from "../types";
import { api } from "../api/client";

/**
 * Stats GLOBALES du bot (events SSE `stats`, tous moteurs confondus).
 * Anciennement exporté sous le nom ambigu `simStats` — renommé pour lever
 * l'homonymie avec le moteur paper (simStore.simEngineStats).
 */
const [globalStats, setGlobalStats] = createSignal<SimulatedStats | null>(null);

/**
 * Stats agrégées PAR moteur (REST /api/stats/by-engine) — sortaient d'un
 * signal local de Performance.tsx. Refresh au montage + à la sélection.
 */
const [engineRows, setEngineRows] = createSignal<EngineStatsRow[]>([]);

export { globalStats, engineRows };

/** Appelé par le dispatcher (event `stats`). */
export function setSimStats(stats: SimulatedStats): void {
  setGlobalStats(stats);
}

/** Fetch REST des stats par moteur. Échec silencieux (endpoint ancien backend). */
export async function refreshEngineStats(): Promise<void> {
  try {
    const { engines: rows } = await api.statsByEngine();
    setEngineRows(rows);
  } catch {
    // Endpoint indisponible (backend ancien) : on garde l'état précédent.
    setEngineRows([]);
  }
}