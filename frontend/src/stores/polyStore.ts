import { createStore, reconcile } from "solid-js/store";
import type { PolymarketPosition } from "../types";
import { marketRecencyMs } from "../utils/market";
import { api } from "../api/client";

export const [polyPositions, setPolyPositions] = createStore<
  PolymarketPosition[]
>([]);

// État du redeem par conditionId — survit aux re-renders SSE.
export const [redeemingConditions, setRedeemingConditions] = createStore<
  Record<string, boolean>
>({});

export const [redeemedConditions, setRedeemedConditions] = createStore<
  Record<string, boolean>
>({});

export function replacePolyPositions(positions: PolymarketPosition[]): void {
  const incomingKeys = new Set(
    positions.map((p) => `${p.conditionId}:${p.outcomeIndex}`),
  );
  const retained = polyPositions.filter((p) => {
    const key = `${p.conditionId}:${p.outcomeIndex}`;
    if (incomingKeys.has(key)) return false;
    return Boolean(p.closed || redeemedConditions[p.conditionId]);
  });

  const sorted = [...positions, ...retained].sort(
    (a, b) => marketRecencyMs(b) - marketRecencyMs(a),
  );
  setPolyPositions(reconcile(sorted));
}

export function startRedeem(conditionId: string): void {
  setRedeemingConditions(conditionId, true);
}

export function finishRedeem(conditionId: string): void {
  setRedeemingConditions(conditionId, false);
  setRedeemedConditions(conditionId, true);
}

export function failRedeem(conditionId: string): void {
  setRedeemingConditions(conditionId, false);
}

export function clearPoly(): void {
  setPolyPositions([]);
  setRedeemingConditions(reconcile({}));
  setRedeemedConditions(reconcile({}));
}

/**
 * Fallback REST : les positions Polymarket n'ont QUE le SSE (aucun autre
 * réconciliateur — l'event polymarketPositions est un replace complet, donc
 * idempotent). À appeler au montage et pendant les coupures SSE ; le backend
 * sert le cache du dernier poll BalanceTracker (30 s), sans refetch réseau.
 * Throttle 30 s pour ne pas marteler l'endpoint pendant une panne longue.
 */
const FALLBACK_THROTTLE_MS = 30_000;
let lastFallbackAt = 0;

export async function fetchPolyPositionsFallback(): Promise<void> {
  const now = Date.now();
  if (now - lastFallbackAt < FALLBACK_THROTTLE_MS) return;
  lastFallbackAt = now;
  try {
    const res = await api.polyPositions();
    replacePolyPositions(res.positions);
  } catch {
    /* silencieux — le SSE reprendra le relais */
  }
}
