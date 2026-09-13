import type { BotConfig } from "../config.js";
import { bus } from "../dashboard/events.js";
import type { Repositories } from "../db/index.js";
import { log } from "../logger.js";
import type { MarketScanner } from "../market-scanner.js";
import type { SimulatedBroker } from "../simulated-broker.js";
import type { SimulatedLedger } from "../simulated-ledger.js";
import type { TradingStrategy } from "../strategy/trading-strategy.js";
import type { TradeTracker } from "../trade-tracker.js";
import type { Trader } from "../trader.js";
import type { OrderResult, TradeOpportunity, SimulatedPosition } from "../types.js";
import { shouldPostIndependentHedge } from "../strategy/hedge-post.js";
import { formatReturnPct, MIN_CLOB_SHARES } from "../utils/prices.js";
import type { BalanceGuard } from "./balance-guard.js";
import type { LiveOrderLifecycle } from "./live-order-lifecycle.js";
import { orderTypeFor } from "./order-type.js";

export type OpportunityExecutorDeps = {
  config: BotConfig; // shared mutable reference - do not copy
  trader: Trader;
  tracker: TradeTracker;
  scanner: MarketScanner;
  repos?: Repositories;
  broker: SimulatedBroker | null;
  ledger: SimulatedLedger | null;
  lifecycle: LiveOrderLifecycle;
  balance: BalanceGuard;
  defendPair: (pairId: string) => Promise<void>;
  onAttempt: () => void;
};

export class OpportunityExecutor {
  private strategy: TradingStrategy;

  constructor(
    private readonly deps: OpportunityExecutorDeps,
    strategy: TradingStrategy,
  ) {
    this.strategy = strategy;
  }

  setStrategy(strategy: TradingStrategy): void {
    this.strategy = strategy;
  }

  async executeOpportunity(opportunity: TradeOpportunity): Promise<void> {
    log("Placing limit order", {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      limitPrice: opportunity.price,
      size: opportunity.size,
      potentialReturn: formatReturnPct(opportunity.price),
    });

    // Garde-fou : ne pas acheter si la clôture du marché est dans moins de
    // X minutes (si minMinutesBeforeCloseToBuy est défini et non null).
    if (this.deps.config.minMinutesBeforeCloseToBuy !== null) {
      const nowSec = Date.now() / 1000;
      const minutesLeft = (opportunity.event.windowEnd - nowSec) / 60;
      if (minutesLeft < this.deps.config.minMinutesBeforeCloseToBuy) {
        bus.emit({ type: "order", result: {
          dryRun: this.deps.config.dryRun, tokenId: opportunity.token.tokenId, side: "BUY",
          price: opportunity.price, size: opportunity.size, filled: false,
          reason: "too-close-to-close",
          orderType: orderTypeFor(opportunity, this.deps.config, this.strategy),
        }, opportunity });
        log("Order skipped - too close to market close", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          minutesLeft: minutesLeft.toFixed(1),
          minRequired: this.deps.config.minMinutesBeforeCloseToBuy,
        });
        return;
      }
    }

    if (this.deps.balance.isInBackoff()) {
      log("Live order skipped - balance backoff active");
      return;
    }

    if (this.deps.config.readonlyLive) {
      if (!this.deps.tracker.has(opportunity.tradeKey)) {
        bus.emit({ type: "order", result: {
          dryRun: false, tokenId: opportunity.token.tokenId, side: "BUY",
          price: opportunity.price, size: opportunity.size, filled: false,
          reason: "readonly-live",
          orderType: orderTypeFor(opportunity, this.deps.config, this.strategy),
        }, opportunity });
        this.deps.tracker.mark(opportunity.tradeKey);
      }
      log("Order skipped - READONLY_LIVE mode (no trading)", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
      });
      return;
    }

    // Hedge must match a committed cheap leg. A hedge (GTC or FOK) must
    // never be posted without a filled cheap — a hedge on a resting cheap
    // is a naked favorite (C2). The hedge is posted only after the cheap
    // fill is detected by pollOrderFills, at the next tick.
    // Edge-lead inverts this. Reverse can bypass via requireCheapFillBeforeExpensive=false.
    // Independent grids still get a live band check (shouldPostIndependentHedge).
    const cheapCommitted =
      opportunity.kind === "expensive"
        ? this.deps.tracker.getFilledCheapSizeForPair(opportunity.pairId)
        : this.deps.tracker.getCheapSizeForPair(opportunity.pairId);
    const bypassCheapFillGate =
      this.strategy.leadsWithEdge ||
      (this.strategy.independentHedgeGrid === true &&
        this.deps.config.requireCheapFillBeforeExpensive === false);
    if (
      opportunity.kind === "expensive" &&
      cheapCommitted === 0 &&
      !bypassCheapFillGate
    ) {
      // No filled cheap leg: do not post a naked hedge.
      log("Hedge skipped - no committed cheap leg", {
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        pairId: opportunity.pairId,
      });
      return;
    }

    // Live wallet gate: arb/barbell always; independentHedgeGrid when cheap-fill
    // is required (default reverse). Skip only when requireCheapFillBeforeExpensive
    // is false (intentional naked-hedge bypass). Never downsize reverse grid levels
    // to cheapHeld — only fail-closed on missing/zero balance.
    if (
      opportunity.kind === "expensive" &&
      !this.deps.config.dryRun &&
      !this.strategy.leadsWithEdge &&
      (this.strategy.independentHedgeGrid !== true ||
        this.deps.config.requireCheapFillBeforeExpensive)
    ) {
      const cheapHeld = await this.deps.lifecycle.confirmCheapTokensForHedge(opportunity.pairId);
      if (cheapHeld === null) {
        log("Hedge skipped - cheap token balance unknown (fail-closed)", {
          market: opportunity.event.title,
          pairId: opportunity.pairId,
        });
        return;
      }
      if (cheapHeld <= 0) {
        log("Hedge skipped - no cheap tokens held", {
          market: opportunity.event.title,
          pairId: opportunity.pairId,
        });
        return;
      }
      if (
        this.strategy.independentHedgeGrid !== true &&
        cheapHeld < opportunity.size
      ) {
        if (cheapHeld < MIN_CLOB_SHARES) {
          log("Hedge skipped - remaining cheap shares below CLOB minimum", {
            market: opportunity.event.title,
            pairId: opportunity.pairId,
            cheapHeld,
          });
          return;
        }
        opportunity = { ...opportunity, size: cheapHeld };
      }
    }

    if (this.deps.broker && this.deps.ledger) {
      this.executeSimulated(opportunity);
      return;
    }

    const useFOK = orderTypeFor(opportunity, this.deps.config, this.strategy) === "FOK";
    let estimatedCost = Math.round(
      (useFOK
        ? Math.min(
            opportunity.token.bestAsk ?? opportunity.price,
            this.deps.config.expensiveBuyMax,
          )
        : opportunity.price) *
        opportunity.size *
        100,
    ) / 100;

    // Garde-fou balance : ne pas poster si le solde CLOB disponible est
    // insuffisant pour couvrir le coût estimé. Le solde est caché 30s pour
    // éviter un appel réseau par opportunity (getAvailableCollateral est async).
    // Fail-closed : en mode live, si le solde est inconnu (null = fetch échoué
    // ou jamais réussi), on rejette l'ordre au lieu de poster à l'aveugle.
    // En dry-run, available est toujours null (pas de client CLOB) → on passe.
    const available = await this.deps.balance.getCachedAvailableCollateral();
    if (available === null) {
      if (!this.deps.config.dryRun) {
        log("Live order skipped - balance unknown (fail-closed)", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
        });
        this.rejectLiveWithRetry(opportunity, "balance-unknown", {});
        return;
      }
      // Dry-run: pas de client CLOB, available est toujours null — autoriser.
    } else if (estimatedCost > available) {
      this.rejectLiveWithRetry(opportunity, "insufficient-balance", {
        estimatedCost,
        available,
      });
      return;
    }

    if (
      this.deps.tracker.getOpenExposure() +
        this.deps.tracker.getRestingExposure() +
        estimatedCost >
      this.deps.config.maxExposureUsdc
    ) {
      log("Live order skipped - exposure cap", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        size: opportunity.size,
        estimatedCost,
        openExposure: this.deps.tracker.getOpenExposure(),
        restingExposure: this.deps.tracker.getRestingExposure(),
        cap: this.deps.config.maxExposureUsdc,
      });
      return;
    }

    if (
      opportunity.kind === "expensive" &&
      !this.deps.config.dryRun &&
      !this.strategy.leadsWithEdge &&
      this.strategy.independentHedgeGrid === true
    ) {
      const freshBook = await this.deps.scanner.getTokenBook(opportunity.token.tokenId);
      const freshAsk = freshBook?.bestAsk ?? null;
      const band = shouldPostIndependentHedge(
        freshAsk,
        opportunity.price,
        this.deps.config.expensiveBuyMin,
        this.deps.config.expensiveBuyMax,
      );
      if (!band.ok) {
        log("Hedge skipped at post time (independent grid band)", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          reason: band.reason,
          freshAsk,
          limitPrice: opportunity.price,
        });
        return;
      }
      opportunity = {
        ...opportunity,
        token: { ...opportunity.token, bestAsk: freshAsk },
      };
    } else if (
      opportunity.kind === "expensive" &&
      !this.deps.config.dryRun &&
      !this.strategy.leadsWithEdge &&
      !this.strategy.independentHedgeGrid
    ) {
      const freshBook = await this.deps.scanner.getTokenBook(opportunity.token.tokenId);
      const freshAsk = freshBook?.bestAsk ?? null;
      const decision = this.strategy.hedgeAtPostTime({
        config: this.deps.config,
        tracker: this.deps.tracker,
        pairId: opportunity.pairId,
        freshAsk,
        nowMs: Date.now(),
      });
      if (decision.action === "defend") {
        log("Hedge skipped - defending uncovered pair at post time", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          reason: decision.reason,
          freshAsk,
        });
        await this.deps.defendPair(opportunity.pairId);
        return;
      }
      if (decision.action === "skip") {
        log("Hedge skipped at post time", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          reason: decision.reason,
          freshAsk,
          originalAsk: opportunity.token.bestAsk,
        });
        return;
      }
      opportunity = {
        ...opportunity,
        price: decision.price,
        token: { ...opportunity.token, bestAsk: freshAsk },
      };
      estimatedCost = Math.round(decision.price * opportunity.size * 100) / 100;
      // Fresh ask can be higher than the snapshot used for the first
      // collateral / exposure checks. Re-evaluate with the POST price.
      if (available !== null && estimatedCost > available) {
        this.rejectLiveWithRetry(opportunity, "insufficient-balance", {
          estimatedCost,
          available,
        });
        return;
      }
      if (
        this.deps.tracker.getOpenExposure() +
          this.deps.tracker.getRestingExposure() +
          estimatedCost >
        this.deps.config.maxExposureUsdc
      ) {
        log("Live order skipped - exposure cap", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          limitPrice: opportunity.price,
          size: opportunity.size,
          estimatedCost,
          openExposure: this.deps.tracker.getOpenExposure(),
          restingExposure: this.deps.tracker.getRestingExposure(),
          cap: this.deps.config.maxExposureUsdc,
        });
        return;
      }
    }

    // --- Dispatch: FOK or GTC for expensive hedge, GTC for cheap legs ---
    //
    // Expensive hedge order type is configurable via EXPENSIVE_ORDER_TYPE:
    //  - FOK (default): Fill-or-Kill. Entire size at min(ask, expensiveBuyMax)
    //    or killed. No resting order. Only after a cheap fill, and only if
    //    fill+hedge ≤ pairLockMax (checked above).
    //  - GTC: same price clamp, also only after a cheap fill. Rests if not
    //    fully filled; cancelled if the cheap vanishes without a fill.
    //
    // Cheap leg: always GTC limit order (unchanged).
    // useFOK / estimatedCost computed above (FOK-aware notionnel).

    let result: OrderResult;
    try {
      result = useFOK
        ? await this.deps.trader.placeBuyFOK(opportunity)
        : await this.deps.trader.placeBuy(opportunity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not enough balance|insufficient balance/i.test(message)) {
        this.deps.balance.noteBalanceRejection();
      }
      this.deps.tracker.incrementRetry(opportunity.tradeKey);
      if (this.deps.tracker.getRetryCount(opportunity.tradeKey) >= this.deps.config.simMaxRetryAttempts) {
        this.deps.tracker.mark(opportunity.tradeKey);
        log("Live order abandoned after max retries", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          price: opportunity.price,
        });
      } else {
        log("Live order failed, will retry", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          price: opportunity.price,
          error: message,
          retry: this.deps.tracker.getRetryCount(opportunity.tradeKey),
        });
      }
      bus.emit({ type: "error", message: `Order failed: ${message}` });
      bus.emit({
        type: "order",
        result: {
          dryRun: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          filled: false,
          reason: "order-failed",
          orderType: useFOK ? "FOK" : "GTC",
        },
        opportunity,
      });
      return;
    }

    this.deps.balance.noteBalanceOk();

    // For FOK: don't mark the trade key if killed — the favorite may rise
    // later in the window and become marketable. Instead, increment the retry
    // count; after simMaxRetryAttempts the key is marked (permanently skipped)
    // to stop spamming a favorite that never reaches our price.
    if (useFOK) {
      // FOK is synchronous: either filled or killed. No resting order.
      const filledSize = result.filledSize ?? 0;
      if (result.filled && filledSize > 0) {
        this.deps.tracker.mark(opportunity.tradeKey);
        this.deps.onAttempt();

        const orderId = (result.response as { orderID?: string } | undefined)
          ?.orderID;
        const fillPrice = result.fillPrice ?? opportunity.price;
        const position: SimulatedPosition = {
          id: `live:${orderId ?? Date.now()}`,
          eventSlug: opportunity.event.slug,
          eventTitle: opportunity.event.title,
          tokenId: opportunity.token.tokenId,
          outcome: opportunity.token.outcome,
          outcomeIndex: opportunity.token.outcomeIndex,
          kind: opportunity.kind,
          limitPrice: opportunity.price,
          fillPrice,
          size: filledSize,
          cost: Math.round(fillPrice * filledSize * 100) / 100,
          windowEnd: opportunity.event.windowEnd,
          status: "open",
          fillReason: "marketable",
          pairId: opportunity.pairId,
          bestAskAtFill: opportunity.token.bestAsk,
          orderType: "FOK",
          strategyId: this.strategy.id,
        };
        this.deps.tracker.addOpenPosition(position);
        this.deps.tracker.attachLeg(position);
        this.strategy.onBuyCommitted?.(opportunity);
        bus.emit({ type: "openedPosition", position });
        log("FOK hedge filled — position created", {
          orderId,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          fillPrice,
          filledSize,
          cost: position.cost,
        });
      } else if (result.filled && filledSize <= 0) {
        log("FOK reported success with zero size — no position created", {
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
        });
      } else {
        // FOK killed — no fill. Retry silently; emit at most once so the
        // dashboard is not flooded (was 1 killed-fok row per tick).
        this.deps.tracker.incrementRetry(opportunity.tradeKey);
        const retries = this.deps.tracker.getRetryCount(opportunity.tradeKey);
        if (retries >= this.deps.config.simMaxRetryAttempts) {
          this.deps.tracker.mark(opportunity.tradeKey);
          log("FOK hedge abandoned after max retries (favorite never reached ask)", {
            market: opportunity.event.title,
            outcome: opportunity.token.outcome,
            limitPrice: opportunity.price,
            bestAsk: opportunity.token.bestAsk,
            retries,
          });
        } else {
          log("FOK hedge killed (no fill at current ask)", {
            market: opportunity.event.title,
            outcome: opportunity.token.outcome,
            limitPrice: opportunity.price,
            bestAsk: opportunity.token.bestAsk,
            retry: retries,
          });
        }
        if (retries === 1) {
          bus.emit({ type: "opportunity", opportunity });
          bus.emit({ type: "order", result, opportunity });
        }
      }
      if (result.filled) {
        bus.emit({ type: "opportunity", opportunity });
        bus.emit({ type: "order", result, opportunity });
      }
      return;
    }

    // GTC path (cheap leg): record as resting posted order for later fill polling.
    const orderId = (result.response as { orderID?: string } | undefined)
      ?.orderID;
    this.deps.tracker.recordPostedOrder(
      opportunity.tradeKey,
      opportunity.event.slug,
      opportunity.event.windowEnd,
      estimatedCost,
      orderId,
      {
        eventSlug: opportunity.event.slug,
        windowEnd: opportunity.event.windowEnd,
        tokenId: opportunity.token.tokenId,
        outcome: opportunity.token.outcome,
        outcomeIndex: opportunity.token.outcomeIndex,
        kind: opportunity.kind,
        limitPrice: opportunity.price,
        size: opportunity.size,
        pairId: opportunity.pairId,
        eventTitle: opportunity.event.title,
        bestAskAtFill: opportunity.token.bestAsk,
        strategyId: this.strategy.id,
      },
    );

    this.deps.tracker.mark(opportunity.tradeKey);
    this.deps.onAttempt();
    this.strategy.onBuyCommitted?.(opportunity);

    bus.emit({ type: "opportunity", opportunity });
    bus.emit({ type: "order", result, opportunity });

    log("Live order placed", {
      tokenId: result.tokenId,
      price: result.price,
      size: result.size,
      response: result.response,
    });
  }

  private rejectLiveWithRetry(
    opportunity: TradeOpportunity,
    reason: string,
    extra: Record<string, unknown>,
  ): void {
    this.deps.tracker.incrementRetry(opportunity.tradeKey);
    const retries = this.deps.tracker.getRetryCount(opportunity.tradeKey);
    if (retries === 1) {
      bus.emit({
        type: "order",
        result: {
          dryRun: false,
          tokenId: opportunity.token.tokenId,
          side: "BUY",
          price: opportunity.price,
          size: opportunity.size,
          filled: false,
          reason,
          orderType: orderTypeFor(opportunity, this.deps.config, this.strategy),
        },
        opportunity,
      });
    }
    if (retries >= this.deps.config.simMaxRetryAttempts) {
      this.deps.tracker.mark(opportunity.tradeKey);
      log(`Live order abandoned after max retries (${reason})`, {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        retries,
        ...extra,
      });
      return;
    }
    log(`Live order skipped - ${reason}`, {
      kind: opportunity.kind,
      market: opportunity.event.title,
      outcome: opportunity.token.outcome,
      retry: retries,
      ...extra,
    });
  }

  executeSimulated(opportunity: TradeOpportunity): void {
    if (!this.deps.broker || !this.deps.ledger) return;

    this.deps.onAttempt();
    const openExposure = this.deps.tracker.getOpenExposure();
    const result = this.deps.broker.attemptFill(opportunity, openExposure);

    if (result.filled && result.position) {
      this.deps.tracker.mark(opportunity.tradeKey);
      this.deps.tracker.addOpenPosition(result.position);
      this.deps.tracker.attachLeg(result.position);
      this.strategy.onBuyCommitted?.(opportunity);
      bus.emit({ type: "openedPosition", position: result.position });

      const orderResult = {
        dryRun: true,
        tokenId: opportunity.token.tokenId,
        side: "BUY" as const,
        price: opportunity.price,
        fillPrice: result.position.fillPrice,
        size: opportunity.size,
        filled: true,
        orderType: "SIM" as const,
      };

      bus.emit({ type: "opportunity", opportunity });
      bus.emit({ type: "order", result: orderResult, opportunity });

      log("Dry-run order filled", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        limitPrice: opportunity.price,
        fillPrice: result.position.fillPrice,
        bestAskAtFill: result.position.bestAskAtFill,
        size: opportunity.size,
        reason: result.reason,
      });
      return;
    }

    const rejectedResult: OrderResult = {
      dryRun: true,
      tokenId: opportunity.token.tokenId,
      side: "BUY",
      price: opportunity.price,
      size: opportunity.size,
      filled: false,
      reason: result.reason,
      orderType: "SIM",
    };
    bus.emit({ type: "opportunity", opportunity });
    bus.emit({ type: "order", result: rejectedResult, opportunity });

    if (result.reason === "insufficient-capital") {
      log("Simulated order rejected - insufficient capital", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        balance: this.deps.ledger.getBalance(),
      });
      return;
    }

    if (result.reason === "exposure-cap") {
      log("Simulated order rejected - exposure cap reached", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
        size: opportunity.size,
        openExposure: this.deps.tracker.getOpenExposure(),
        cap: this.deps.config.maxExposureUsdc,
      });
      return;
    }

    if (result.reason === "not-a-favorite") {
      // Structural rejection: the "expensive" token is not a real favorite.
      // The favorite may come back above expensiveBuyMin, so count a retry
      // instead of permanently skipping this level every tick.
      this.deps.tracker.incrementRetry(opportunity.tradeKey);
      if (this.deps.tracker.getRetryCount(opportunity.tradeKey) >= this.deps.config.simMaxRetryAttempts) {
        this.deps.tracker.mark(opportunity.tradeKey);
        log("Simulated hedge abandoned after max retries (not a favorite)", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          bestAsk: opportunity.token.bestAsk,
          expensiveBuyMin: this.deps.config.expensiveBuyMin,
        });
      } else {
        log("Simulated hedge rejected - not a favorite", {
          kind: opportunity.kind,
          market: opportunity.event.title,
          outcome: opportunity.token.outcome,
          limitPrice: opportunity.price,
          bestAsk: opportunity.token.bestAsk,
          expensiveBuyMin: this.deps.config.expensiveBuyMin,
          retry: this.deps.tracker.getRetryCount(opportunity.tradeKey),
        });
      }
      return;
    }

    this.deps.tracker.incrementRetry(opportunity.tradeKey);
    if (this.deps.tracker.getRetryCount(opportunity.tradeKey) >= this.deps.config.simMaxRetryAttempts) {
      this.deps.tracker.mark(opportunity.tradeKey);
      log("Simulated order abandoned after max retries", {
        kind: opportunity.kind,
        market: opportunity.event.title,
        outcome: opportunity.token.outcome,
        price: opportunity.price,
      });
    }
  }
}
