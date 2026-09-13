import type { BotConfig } from "./config.js";
import { bus, type PolymarketPosition } from "./dashboard/events.js";
import type { RedeemRepository } from "./db/repositories.js";
import { log } from "./logger.js";
import { getQuotaBlockMsRemaining, getRelayerQuota, isQuotaBlocked } from "./relayer-quota.js";
import type { Trader } from "./trader.js";

/**
 * Auto-redeems resolved positions on Polymarket markets.
 *
 * Subscribes to `polymarketPositions` events emitted by BalanceTracker
 * (every 30s). Filters positions that are:
 *   - redeemable: true  (market resolved, tokens can be burned)
 *   - curPrice at settlement extreme: >= 0.99 (winner) or <= 0.01 (loser)
 *
 * Both winners AND losers must be redeemed. Winners credit pUSD (size × $1);
 * losers credit nothing but burning them clears the position from the
 * wallet so it no longer appears as "active" on Polymarket. Without
 * redeeming losers, resolved losing tokens linger indefinitely and inflate
 * the active position count.
 *
 * For each, calls Trader.redeemPosition() which submits a relayer batch
 * (setApprovalForAll + redeemPositions) to burn the outcome tokens and
 * credit pUSD to the deposit wallet.
 *
 * Dedup: tracks conditionId + outcomeIndex pairs already submitted to
 * avoid re-submitting if the data-api hasn't updated yet (position stays
 * "active" until the relayer tx is mined + indexed).
 */
export class AutoRedeemer {
  /** conditionId + outcomeIndex pairs currently being redeemed or already done. */
  private readonly redeemed = new Set<string>();
  /**
   * conditionId + outcomeIndex pairs that failed recently, with the timestamp
   * at which they become eligible for retry. Prevents retry-storms when the
   * relayer returns 429 (quota exceeded) — without this, a failed redeem is
   * removed from `redeemed` and retried 30s later, looping indefinitely and
   * exhausting the daily quota (1299 attempts observed in 24h for ~14
   * positions).
   */
  private readonly retryAfter = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  /** Base delay before retrying a failed redeem, doubled on consecutive 429s. */
  private static readonly RETRY_BASE_MS = 60_000; // 1 min
  private static readonly RETRY_MAX_MS = 3600_000; // 1 h
  private static readonly QUOTA_RESET_HINT_MS = 65000_000; // ~18h (observed)

  constructor(
    private readonly config: BotConfig,
    private readonly trader: Trader,
    private readonly redeems?: RedeemRepository,
  ) {}

  start(): void {
    if (!this.config.autoRedeemWinners) return;
    if (this.config.readonlyLive) {
      log("AutoRedeemer disabled (readonly-live mode)");
      return;
    }
    if (!this.config.funderAddress) {
      log("AutoRedeemer disabled (no FUNDER_ADDRESS configured)");
      return;
    }

    const since = Date.now() - 24 * 3600_000;
    for (const key of this.redeems?.recentSuccessfulKeys(since) ?? []) {
      this.redeemed.add(key);
    }

    this.unsubscribe = bus.subscribe((event) => {
      if (event.type !== "polymarketPositions") return;
      void this.processPositions(event.positions);
    });

    log("AutoRedeemer started — watching for redeemable positions (winners + losers)");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async processPositions(
    positions: PolymarketPosition[],
  ): Promise<void> {
    // A position is redeemable when the market is resolved (data-api sets
    // redeemable=true). We redeem BOTH winners (curPrice >= 0.99, credits
    // pUSD) AND losers (curPrice <= 0.01, credits 0 but clears the tokens).
    // Without redeeming losers, dead tokens linger in the wallet and
    // Polymarket keeps flagging them as "active" indefinitely.
    const toRedeem = positions.filter(
      (p) => !p.closed && p.redeemable && (p.curPrice >= 0.99 || p.curPrice <= 0.01),
    );

    if (toRedeem.length === 0) return;

    // ── Pre-flight quota check ────────────────────────────────────────
    // The relayer enforces a daily quota on deposit-wallet transactions.
    // When it's exhausted, ANY redeem request returns 429 — so we must NOT
    // loop over every redeemable position firing doomed requests (that's
    // what produced the 1299-attempts/24h spam and the 5× 429 burst in <2s
    // at startup). Skip the whole batch when the quota is blocked.
    if (isQuotaBlocked()) {
      const blockMs = getQuotaBlockMsRemaining();
      const resetIn = Math.max(1, Math.round(blockMs / 1000));
      log("Auto-redeem skipped — relayer quota still blocked", {
        positions: toRedeem.length,
        resetIn: `${resetIn}s`,
      });
      return;
    }

    for (const position of toRedeem) {
      const key = `${position.conditionId}:${position.outcomeIndex}`;
      if (this.redeemed.has(key)) continue;

      // Backoff: skip positions that recently failed and are not yet
      // eligible for retry. This prevents a retry-storm where every 30s
      // poll re-submits the same failing redeem, exhausting the relayer
      // quota (1299 failed attempts in 24h observed before this guard).
      const retryAt = this.retryAfter.get(key);
      if (retryAt !== undefined && Date.now() < retryAt) continue;
      // Eligible for retry — clear the backoff marker.
      this.retryAfter.delete(key);

      // Re-check the quota inside the loop too: a previous iteration in
      // this same batch may have just hit a 429 and armed the block. If so,
      // stop immediately — every subsequent attempt would also 429.
      if (isQuotaBlocked()) {
        const blockMs = getQuotaBlockMsRemaining();
        const resetIn = Math.max(1, Math.round(blockMs / 1000));
        log("Auto-redeem aborted mid-batch — relayer quota exhausted", {
          skippedRemaining: toRedeem.length - toRedeem.indexOf(position),
          resetIn: `${resetIn}s`,
        });
        break;
      }

      this.redeemed.add(key);

      const isWinner = position.curPrice >= 0.99;
      log(isWinner ? "Auto-redeeming winning position" : "Auto-redeeming losing position (cleanup)", {
        title: position.title,
        outcome: position.outcome,
        curPrice: position.curPrice,
        size: position.size,
        conditionId: position.conditionId,
        negRisk: position.negRisk,
      });

      try {
        const result = await this.trader.redeemPosition(
          position.conditionId,
          position.outcomeIndex,
          position.negRisk,
        );
        this.redeems?.insert({
          conditionId: position.conditionId,
          outcomeIndex: position.outcomeIndex,
          negRisk: position.negRisk ? 1 : 0,
          title: position.title,
          outcome: position.outcome,
          size: position.size,
          txHash: result.txHash,
          source: "auto",
          success: 1,
        });
        log("Auto-redeem succeeded", {
          title: position.title,
          outcome: position.outcome,
          txHash: result.txHash,
          transactionId: result.transactionId,
        });
        // Push the updated quota state to the dashboard (SSE).
        bus.emit({ type: "relayerQuota", quota: getRelayerQuota() });
        bus.emit({
          type: "resolution",
          message: `Auto-redeemed ${isWinner ? "winning" : "losing"} position: ${position.title} (${position.outcome})`,
          data: {
            title: position.title,
            outcome: position.outcome,
            txHash: result.txHash,
            conditionId: position.conditionId,
            isWinner,
          },
        });
        // Push the updated quota state to the dashboard (SSE).
        bus.emit({ type: "relayerQuota", quota: getRelayerQuota() });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.redeems?.insert({
          conditionId: position.conditionId,
          outcomeIndex: position.outcomeIndex,
          negRisk: position.negRisk ? 1 : 0,
          title: position.title,
          outcome: position.outcome,
          size: position.size,
          txHash: null,
          source: "auto",
          success: 0,
          errorMessage: msg,
        });

        // Quota exceeded (429): the relayer won't accept ANY transaction
        // until the daily quota resets (~18h). Schedule a long backoff so
        // we don't spam the relayer every 30s with the same doomed request.
        // Parse the "resets in N seconds" hint when available.
        let backoffMs = AutoRedeemer.RETRY_BASE_MS;
        const quotaMatch = /resets in (\d+) seconds/i.exec(msg);
        if (quotaMatch) {
          const resetSeconds = Number(quotaMatch[1]);
          // Reset time + a small margin (60s) so we retry just after reset.
          backoffMs = (resetSeconds + 60) * 1000;
          log("Auto-redeem failed — relayer quota exhausted, backing off until reset", {
            title: position.title,
            outcome: position.outcome,
            conditionId: position.conditionId,
            resetIn: `${resetSeconds}s`,
            retryIn: `${Math.round(backoffMs / 1000)}s`,
          });
        } else if (/429|quota exceeded|too many requests|error code: 1015/i.test(msg)) {
          // 429 without a "resets in N seconds" hint — typically Cloudflare
          // "error code: 1015" rate-limiting. recordQuotaExceeded() will
          // have armed a default ~18h block; back this position off for the
          // same window so it retries in sync with the global block.
          backoffMs = getQuotaBlockMsRemaining() || AutoRedeemer.RETRY_BASE_MS;
          log("Auto-redeem failed — relayer rate-limited (429), backing off", {
            title: position.title,
            outcome: position.outcome,
            conditionId: position.conditionId,
            error: msg,
            retryIn: `${Math.round(backoffMs / 1000)}s`,
          });
        } else {
          // Other errors (network, etc.): exponential-ish backoff with a
          // cap. Double the previous backoff if we already had one.
          const prev = this.retryAfter.get(key);
          if (prev !== undefined) {
            backoffMs = Math.min(
              AutoRedeemer.RETRY_MAX_MS,
              2 * Math.max(AutoRedeemer.RETRY_BASE_MS, prev - Date.now()),
            );
          }
          log("Auto-redeem failed — backing off before retry", {
            title: position.title,
            outcome: position.outcome,
            conditionId: position.conditionId,
            error: msg,
            retryIn: `${Math.round(backoffMs / 1000)}s`,
          });
        }
        this.retryAfter.set(key, Date.now() + backoffMs);
        // Remove from redeemed so the backoff guard above can eventually
        // re-allow the attempt — but only after retryAt has passed.
        this.redeemed.delete(key);

        // Push the updated quota state to the dashboard (SSE).
        bus.emit({ type: "relayerQuota", quota: getRelayerQuota() });

        bus.emit({
          type: "error",
          message: `Auto-redeem failed for ${position.title} (${position.outcome}): ${msg}`,
        });

        // If this was a quota/rate-limit 429, the relayer won't accept ANY
        // further transaction until reset — break out of the loop so we
        // don't fire more doomed requests for the remaining positions in
        // this batch. The pre-flight quota check at the top of the next
        // processPositions() call will keep skipping until the reset.
        if (isQuotaBlocked()) {
          log("Auto-redeem batch aborted — relayer quota exhausted, skipping remaining positions", {
            skippedRemaining: toRedeem.length - toRedeem.indexOf(position) - 1,
            resetIn: `${Math.round(getQuotaBlockMsRemaining() / 1000)}s`,
          });
          break;
        }
      }
    }
  }
}