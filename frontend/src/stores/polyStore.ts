import { createStore, reconcile } from "solid-js/store";
import type { PolymarketPosition } from "../types";
import { marketRecencyMs } from "../utils/market";

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
