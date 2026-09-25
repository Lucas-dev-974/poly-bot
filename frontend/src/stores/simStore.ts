import { createSignal } from "solid-js";
import type { BotConfig, SimBalance, SimConfigState, SimulatedPosition, SimulatedStats } from "../types";
import type { SimRestingOrder, SimTrade } from "../api/client";

/** État live du moteur paper trading (simulation). */
export const [simBalance, setSimBalance] = createSignal<SimBalance | null>(null);
export const [simConfigState, setSimConfigState] = createSignal<SimConfigState | null>(null);
/** Config effective du moteur (preset + settings appliqués) — panneau config 5m. */
export const [simEffectiveConfig, setSimEffectiveConfig] = createSignal<BotConfig | null>(null);
export const [simOpenPositions, setSimOpenPositions] = createSignal<SimulatedPosition[]>([]);
export const [simResolvedPositions, setSimResolvedPositions] = createSignal<SimulatedPosition[]>([]);
/**
 * Stats du moteur paper (event SSE `simStats`). Nommage explicite : l'homonymie
 * historique avec statsStore.simStats (global) était une source de confusion.
 */
export const [simEngineStats, setSimEngineStats] = createSignal<SimulatedStats | null>(null);
/**
 * Ordres en attente (GTC papier) + journal des ordres — sortaient de signaux
 * locaux de SimulationPage (perdus à la navigation). Hydratés par /api/sim/state
 * + le poll adaptatif, mis à jour par le dispatcher pour la partie SSE.
 */
export const [simResting, setSimResting] = createSignal<SimRestingOrder[]>([]);
export const [simJournal, setSimJournal] = createSignal<SimTrade[]>([]);

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

/** Remplace les listes de positions (hydratation REST). */
export function replaceSimLists(open: SimulatedPosition[], resolved: SimulatedPosition[]): void {
  setSimOpenPositions(open);
  setSimResolvedPositions(resolved);
}

/** Remplace resting + journal (hydratation REST /api/sim/state, poll adaptatif). */
export function replaceSimRestingAndJournal(
  resting: SimRestingOrder[],
  journal: SimTrade[],
): void {
  setSimResting(resting);
  setSimJournal(journal);
}