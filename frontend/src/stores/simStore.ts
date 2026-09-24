import { createSignal } from "solid-js";
import type { SimBalance, SimConfigState, SimulatedPosition, SimulatedStats } from "../types";

/** État live du moteur paper trading (simulation). */
export const [simBalance, setSimBalance] = createSignal<SimBalance | null>(null);
export const [simConfigState, setSimConfigState] = createSignal<SimConfigState | null>(null);
export const [simOpenPositions, setSimOpenPositions] = createSignal<SimulatedPosition[]>([]);
export const [simResolvedPositions, setSimResolvedPositions] = createSignal<SimulatedPosition[]>([]);
export const [simStats, setSimEngineStats] = createSignal<SimulatedStats | null>(null);

export function upsertSimOpen(position: SimulatedPosition): void {
  setSimOpenPositions((prev) => {
    const idx = prev.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = position;
      return next;
    }
    return [...prev, position];
  });
}

export function removeSimOpen(position: SimulatedPosition): void {
  // Les variantes vendues (:sold-xxx) partagent le préfixe d'id de l'origine.
  setSimOpenPositions((prev) =>
    prev.filter((p) => p.id !== position.id && !p.id.startsWith(`${position.id}:sold-`)),
  );
}

function upsertSimResolved(position: SimulatedPosition): void {
  setSimResolvedPositions((prev) => {
    const idx = prev.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = position;
      return next;
    }
    return [...prev, position];
  });
}

export function resolveSimPosition(position: SimulatedPosition): void {
  upsertSimResolved(position);
  removeSimOpen(position);
}

/** Remplace les listes (hydratation REST). */
export function replaceSimLists(open: SimulatedPosition[], resolved: SimulatedPosition[]): void {
  setSimOpenPositions(open);
  setSimResolvedPositions(resolved);
}