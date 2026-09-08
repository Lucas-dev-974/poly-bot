/**
 * Relayer quota tracker.
 *
 * The Polymarket relayer (relayer-v2.polymarket.com) enforces a daily quota
 * on deposit-wallet transactions. When exhausted it returns HTTP 429 with a
 * body like:
 *
 *   {"error":"quota exceeded: 0 units remaining, resets in 65069 seconds"}
 *
 * This module centralizes that state so the dashboard can display the
 * remaining quota and, when exhausted, a live countdown to the reset.
 *
 * It is a lightweight singleton (no persistence) — the quota is re-learned
 * from the first 429 after each bot restart.
 */

export interface RelayerQuotaState {
  /** True once we've observed a 429 quota-exceeded error. */
  exhausted: boolean;
  /** Unix ms at which the quota resets (0 = unknown). */
  resetAt: number;
  /** Unix ms at which the quota was last observed as exhausted. */
  observedAt: number;
  /** Raw error message from the last 429. */
  lastError: string | null;
}

const state: RelayerQuotaState = {
  exhausted: false,
  resetAt: 0,
  observedAt: 0,
  lastError: null,
};

/**
 * Fallback reset window used when the relayer returns a 429 without a
 * "resets in N seconds" hint (e.g. Cloudflare "error code: 1015").
 * The observed daily quota window is ~18h, so we use a conservative 18h
 * default so callers back off for the right order of magnitude.
 */
const DEFAULT_QUOTA_RESET_MS = 18 * 3600_000; // 18h

/**
 * Record a relayer 429 quota-exceeded error. Parses the "resets in N seconds"
 * hint from the server when present; otherwise falls back to a default
 * ~18h reset window so the bot still backs off instead of spamming.
 */
export function recordQuotaExceeded(errorMessage: string): void {
  const now = Date.now();
  state.exhausted = true;
  state.observedAt = now;
  state.lastError = errorMessage;

  const match = /resets in (\d+) seconds/i.exec(errorMessage);
  if (match) {
    const resetSeconds = Number(match[1]);
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      state.resetAt = now + resetSeconds * 1000;
      return;
    }
  }
  // No "resets in N seconds" hint (e.g. "error code: 1015" from Cloudflare).
  // Fall back to the observed daily window so callers still back off.
  state.resetAt = now + DEFAULT_QUOTA_RESET_MS;
}

/**
 * Record a successful relayer transaction — the quota is clearly not
 * exhausted anymore.
 */
export function recordQuotaOk(): void {
  state.exhausted = false;
  state.resetAt = 0;
  state.lastError = null;
}

/** Current quota state. */
export function getRelayerQuota(): RelayerQuotaState {
  return { ...state };
}

/**
 * Seconds remaining until the quota resets, or 0 if not exhausted / unknown.
 */
export function getQuotaResetSeconds(): number {
  if (!state.exhausted || state.resetAt <= 0) return 0;
  const remaining = Math.max(0, Math.ceil((state.resetAt - Date.now()) / 1000));
  return remaining;
}

/**
 * Whether the relayer quota is currently blocked and should NOT be hit.
 *
 * Returns true when:
 *   - we have observed a 429 (exhausted=true), AND
 *   - the reset time is still in the future.
 *
 * Once the reset time has passed, the caller is expected to attempt a
 * (single) request — on success `recordQuotaOk()` clears the block, on a
 * fresh 429 `recordQuotaExceeded()` re-arms it. This lets the bot auto-
 * resume exactly one attempt after the reset window elapses, without
 * spamming the relayer while blocked.
 */
export function isQuotaBlocked(): boolean {
  if (!state.exhausted) return false;
  if (state.resetAt <= 0) return true; // exhausted with unknown reset → stay blocked
  return Date.now() < state.resetAt;
}

/**
 * Milliseconds until the current block elapses (0 if not blocked).
 */
export function getQuotaBlockMsRemaining(): number {
  if (!isQuotaBlocked()) return 0;
  return Math.max(0, state.resetAt - Date.now());
}
