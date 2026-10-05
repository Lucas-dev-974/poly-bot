import { createStore } from "solid-js/store";
import type { OrderView } from "../types";

const MAX_ORDERS = 100;

export const [orders, setOrders] = createStore<OrderView[]>([]);

export function addOrder(order: OrderView): void {
  setOrders((prev) => [order, ...prev].slice(0, MAX_ORDERS));
}

function matchesResting(order: OrderView, orderId?: string, tokenId?: string): boolean {
  if (order.reason !== "resting" || order.fillPrice != null) return false;
  if (orderId) return order.orderId === orderId;
  return order.tokenId === tokenId;
}

export function markOrderFilled(
  tokenId: string,
  fillPrice: number,
  orderId?: string,
): void {
  setOrders((prev) =>
    prev.map((o) =>
      matchesResting(o, orderId, tokenId)
        ? { ...o, filled: true, reason: undefined, fillPrice, orderId: orderId ?? o.orderId }
        : o,
    ),
  );
}

export function replaceOrders(next: OrderView[]): void {
  setOrders(next.slice(0, MAX_ORDERS));
}

export function markOrderCancelled(tokenId: string, orderId?: string): void {
  setOrders((prev) =>
    prev.map((o) =>
      matchesResting(o, orderId, tokenId)
        ? { ...o, filled: false, reason: "cancelled" }
        : o,
    ),
  );
}
