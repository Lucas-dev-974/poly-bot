import { createStore, reconcile } from "solid-js/store";
import type { SimulatedPosition } from "../types";

const MAX_RESOLVED = 100;

export const [openPositions, setOpenPositions] = createStore<
  Record<string, SimulatedPosition>
>({});

export const [resolvedPositions, setResolvedPositions] = createStore<
  SimulatedPosition[]
>([]);

export function addOrUpdateOpen(position: SimulatedPosition): void {
  if (position.status !== "open") {
    removeOpen(position.id);
    return;
  }
  setOpenPositions(position.id, position);
}

export function removeOpen(id: string): void {
  setOpenPositions(id, undefined as unknown as SimulatedPosition);
}

export function addResolved(position: SimulatedPosition): void {
  setResolvedPositions((prev) => {
    const next = [position, ...prev.filter((p) => p.id !== position.id)];
    return next.slice(0, MAX_RESOLVED);
  });
}

export function clearPositions(): void {
  // Solid setStore({}) merges — it does not delete existing keys.
  setOpenPositions(reconcile({}));
  setResolvedPositions([]);
}

export function replaceOpen(list: SimulatedPosition[]): void {
  const next: Record<string, SimulatedPosition> = {};
  for (const position of list) {
    if (position.status === "open") next[position.id] = position;
  }
  // reconcile replaces the record so vanished ids actually leave the panel.
  setOpenPositions(reconcile(next));
}

export function replaceResolved(list: SimulatedPosition[]): void {
  const newestFirst = [...list].sort(
    (a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0),
  );
  setResolvedPositions(newestFirst.slice(0, MAX_RESOLVED));
}

export function openPositionList(): SimulatedPosition[] {
  return Object.values(openPositions).filter((position) => position.status === "open");
}
