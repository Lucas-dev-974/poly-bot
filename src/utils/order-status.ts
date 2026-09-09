export type NormalizedOrderStatus =
  | "live"
  | "matched"
  | "cancelled"
  | "invalid"
  | "unknown";

export interface ParsedOrderStatus {
  filled: boolean;
  cancelled: boolean;
  sizeMatched: number;
  status: NormalizedOrderStatus;
}

/**
 * Map CLOB status strings (ORDER_STATUS_MATCHED, matched, canceled, …)
 * onto a small enum. The official API uses ORDER_STATUS_* ; the JS client
 * often returns the short form.
 */
export function normalizeOrderStatus(raw: unknown): NormalizedOrderStatus {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^order_status_/, "")
    .replace(/-/g, "_");
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("match")) return "matched";
  if (s === "live" || s === "open") return "live";
  if (s.includes("invalid")) return "invalid";
  return "unknown";
}

/**
 * Interpret a CLOB getOrder payload.
 *
 * A LIVE order with size_matched === original_size is NOT a fill — that
 * pattern is how ghost maker matches show up before (or instead of) a
 * real MATCHED status. Only an explicit matched status plus size_matched > 0
 * counts as filled. Token delivery is confirmed separately via balance.
 */
export function parseOrderStatus(order: {
  size_matched?: unknown;
  original_size?: unknown;
  status?: unknown;
}): ParsedOrderStatus {
  const sizeMatchedRaw = Number(order.size_matched);
  const sizeMatched = Number.isFinite(sizeMatchedRaw) && sizeMatchedRaw > 0
    ? sizeMatchedRaw
    : 0;
  const status = normalizeOrderStatus(order.status);
  const cancelled = status === "cancelled" || status === "invalid";
  const filled = status === "matched" && sizeMatched > 0;
  return { filled, cancelled, sizeMatched, status };
}

/**
 * Size we are willing to book locally given the CLOB-claimed match and the
 * conditional-token balance we actually hold.
 *
 * `held === null` means the balance check failed → fail-closed (0).
 * Taker fees can leave held slightly under claimed; we book what we hold.
 */
export function confirmedFillSize(
  claimed: number,
  held: number | null,
): number {
  if (held === null || !Number.isFinite(held) || held <= 0) return 0;
  if (!Number.isFinite(claimed) || claimed <= 0) return 0;
  return Math.round(Math.min(claimed, held) * 100) / 100;
}

/**
 * CLOB conditional balances are either raw 6-decimal units or already in
 * shares. Our working sizes are tens of shares, never thousands.
 */
export function sharesFromConditionalBalance(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw >= 1000 ? raw / 1_000_000 : raw;
}

/**
 * Size actually sold after a FOK SELL. The CLOB often returns success=false
 * / empty makingAmount on a real match (same class of bug as ghost BUY
 * fills). Token-balance drop is the source of truth when we have it.
 *
 * `heldAfter === null` and no CLOB fill → `balanceUnknown` (caller must
 * not treat the cheap as still held for hedging).
 */
export function confirmedSoldSize(
  intended: number,
  clobFilledSize: number,
  heldBefore: number | null,
  heldAfter: number | null,
): { soldSize: number; balanceUnknown: boolean } {
  const want = Number.isFinite(intended) && intended > 0 ? intended : 0;
  const clob =
    Number.isFinite(clobFilledSize) && clobFilledSize > 0 ? clobFilledSize : 0;

  if (heldBefore !== null && heldAfter !== null) {
    const dropped = Math.round(Math.max(0, heldBefore - heldAfter) * 100) / 100;
    return {
      soldSize: Math.min(want || dropped, dropped),
      balanceUnknown: false,
    };
  }

  if (heldAfter !== null) {
    if (heldAfter <= 0) {
      return { soldSize: want || clob, balanceUnknown: false };
    }
    if (want > 0 && heldAfter < want) {
      return {
        soldSize: Math.round((want - heldAfter) * 100) / 100,
        balanceUnknown: false,
      };
    }
    return { soldSize: 0, balanceUnknown: false };
  }

  if (clob > 0) {
    return { soldSize: Math.min(want || clob, clob), balanceUnknown: false };
  }
  return { soldSize: 0, balanceUnknown: true };
}
