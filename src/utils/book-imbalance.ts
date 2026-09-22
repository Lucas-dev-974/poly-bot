import type { TokenBook } from "../types.js";

/**
 * Cross-book imbalance over 3 levels, Up-perspective.
 *
 * A binary market's two token books are mirror views of the same liquidity:
 * a bid on Up at p ≡ an ask on Down at 1−p. Summing bidsUp + asksDown gives
 * the pressure toward Up; asksUp + bidsDown the pressure toward Down.
 *
 *   crossImbalance = (bidsUp + asksDown − asksUp − bidsDown) / total
 *
 * > 0 = book pressure toward Up, < 0 = toward Down. Range [−1, +1].
 * Null when both books are missing or carry no size data.
 */
export function crossImbalance(
  up: TokenBook | undefined,
  down: TokenBook | undefined,
): number | null {
  const bull =
    (up?.bestBidSize ?? 0) +
    (up?.bid2Size ?? 0) +
    (up?.bid3Size ?? 0) +
    (down?.bestAskSize ?? 0) +
    (down?.ask2Size ?? 0) +
    (down?.ask3Size ?? 0);
  const bear =
    (up?.bestAskSize ?? 0) +
    (up?.ask2Size ?? 0) +
    (up?.ask3Size ?? 0) +
    (down?.bestBidSize ?? 0) +
    (down?.bid2Size ?? 0) +
    (down?.bid3Size ?? 0);
  if (bull + bear <= 0) return null;
  return (bull - bear) / (bull + bear);
}

/**
 * Cross-book imbalance signed toward the given outcome index:
 * + = pressure agrees with that token's side, − = pressure against it.
 * Pass the favorite's outcomeIndex at entry time.
 */
export function crossImbalanceSigned(
  up: TokenBook | undefined,
  down: TokenBook | undefined,
  favIdx: number,
): number | null {
  const cross = crossImbalance(up, down);
  if (cross === null) return null;
  return favIdx === 0 ? cross : -cross;
}

/**
 * Per-pair rolling history of the signed cross imbalance, for persistence
 * gates ("condition held for N consecutive ticks"). Bounded: push() keeps
 * at most `keep` samples per pair; forget() drops stale windows.
 */
export class CrossImbalanceHistory {
  private readonly byPair = new Map<string, Array<{ ts: number; v: number | null }>>();

  /** Record one sample. Keeps the last `keep` samples per pair. */
  push(pairId: string, ts: number, value: number | null, keep: number): void {
    const list = this.byPair.get(pairId) ?? [];
    list.push({ ts, v: value });
    if (list.length > keep) list.splice(0, list.length - keep);
    this.byPair.set(pairId, list);
  }

  /**
   * True when the last `ticks` non-null samples are all strictly below
   * `threshold`. Fewer than `ticks` samples → false (gate not armed yet).
   */
  consecutiveBelow(pairId: string, threshold: number, ticks: number): boolean {
    const list = this.byPair.get(pairId);
    if (!list || list.length < ticks) return false;
    const tail = list.slice(-ticks);
    return tail.every((s) => s.v !== null && s.v < threshold);
  }

  /**
   * True when the last `ticks` non-null samples are all >= `threshold`.
   * Fewer than `ticks` samples → false (gate not armed yet).
   */
  consecutiveAtOrAbove(pairId: string, threshold: number, ticks: number): boolean {
    const list = this.byPair.get(pairId);
    if (!list || list.length < ticks) return false;
    const tail = list.slice(-ticks);
    return tail.every((s) => s.v !== null && s.v >= threshold);
  }

  /** Drop pairs not seen since `staleMs` (closed windows never return). */
  forgetStale(nowMs: number, staleMs: number): void {
    for (const [key, list] of this.byPair) {
      const last = list[list.length - 1];
      if (!last || nowMs - last.ts > staleMs) this.byPair.delete(key);
    }
  }
}