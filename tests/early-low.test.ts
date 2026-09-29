import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { EarlyLowStrategy } from "../src/strategy/early-low-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("early-low", () => {
  const makeStrategy = () => new EarlyLowStrategy();
  const config = testConfig({
    strategyId: "early-low",
    earlyLowBuyAskMin: 0,
    earlyLowBuyAskMax: 0.15,
    earlyLowMaxElapsedSec: 300,
    earlyLowMaxSpread: 0.08,
    earlyLowOrderUsdc: 1,
    earlyLowExitEnabled: true,
    earlyLowExitAsk: 0.50,
    earlyLowExitMomentumMin: 0.005,
    earlyLow15mOnly: true,
    maxSharesPerOrder: 40,
  });
  const event = testEvent(1_800_000_000); // slug 15m
  const W = event.windowStart;

  it("parses and registers the engine", () => {
    assert.equal(parseStrategyId("early-low"), "early-low");
    assert.equal(createStrategy("early-low").id, "early-low");
  });

  it("emits a $1 FOK buy on the discounted token in the first 5 min", () => {
    const strategy = makeStrategy();
    const tracker = new TradeTracker();
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.85, 0.12),
      nowMs: (W + 30) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].token.outcome, "Down");
    assert.equal(opps[0].price, 0.12);
  });

  it("does not emit after the entry window closes (elapsed > 300s)", () => {
    const strategy = makeStrategy();
    const tracker = new TradeTracker();
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.85, 0.12),
      nowMs: (W + 301) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("does not emit when the lowest ask is above the 15c cap", () =>  {
    const strategy = makeStrategy();
    const tracker = new TradeTracker();
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.85, 0.20),
      nowMs: (W + 30) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("blocks a 5m market when earlyLow15mOnly is on", () => {
    const strategy = makeStrategy();
    const tracker = new TradeTracker();
    const event5m = {
      ...event,
      slug: `btc-updown-5m-${W + 300}`,
      windowStart: W + 600,
      windowEnd: W + 900,
    };
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event: event5m,
      books: books(0.85, 0.12),
      nowMs: (event5m.windowStart + 30) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("rejects a band max >= 0.5 in config validation", () => {
    const cfg = testConfig({
      strategyId: "early-low",
      earlyLowBuyAskMax: 0.55,
    });
    assert.throws(
      () => validateConfigCoherence(cfg),
      /band max below 0.5/,
    );
  });

  it("rejects an exit ask within the buy band in config validation", () => {
    const cfg = testConfig({
      strategyId: "early-low",
      earlyLowBuyAskMax: 0.15,
      earlyLowExitEnabled: true,
      earlyLowExitAsk: 0.10,
    });
    assert.throws(
      () => validateConfigCoherence(cfg),
      /exit above the buy band/,
    );
  });

  it("coerces sticky arb flags via validateConfigCoherence", () => {
    const cfg = testConfig({
      strategyId: "early-low",
      arbAskLockOnly: true,
      enableExpensiveHedge: true,
    });
    validateConfigCoherence(cfg);
    assert.equal(cfg.arbAskLockOnly, false);
    assert.equal(cfg.enableExpensiveHedge, false);
  });

  describe("wait-and-see exit (pipeline defend)", () => {
    it("arms at 50c and does NOT sell on the arming tick", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const cfg = { ...config };
      const first = strategy.shouldDefend({
        config: cfg,
        favoriteAsk: 0.5,
        filledCheap: 8,
        filledExpensive: 0,
        pairId: "p",
        cheapAsk: 0.50,
        cheapBid: 0.49,
        tracker,
        nowMs: (W + 120) * 1000,
      });
      assert.equal(first, false);
    });

    it("holds while the ask keeps rising, sells on stagnation", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const cfg = { ...config };
      const ctx = (ask: number, tick: number) => ({
        config: cfg,
        favoriteAsk: 1 - ask,
        filledCheap: 8,
        filledExpensive: 0,
        pairId: "p",
        cheapAsk: ask,
        cheapBid: Math.max(0, ask - 0.01),
        tracker,
        nowMs: (W + 120 + tick) * 1000,
      });
      // Armement à 0.50 (pas de vente).
      assert.equal(strategy.shouldDefend(ctx(0.5, 0)), false);
      // Montée 0.510 → hold.
      assert.equal(strategy.shouldDefend(ctx(0.51, 1)), false);
      // Montée 0.516 → hold.
      assert.equal(strategy.shouldDefend(ctx(0.516, 2)), false);
      // Stagnation 0.511 → SELL (progression négative).
      assert.equal(strategy.shouldDefend(ctx(0.511, 3)), true);
    });

    it("sells immediately on a drop after arming", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const cfg = { ...config };
      const ctx = (ask: number, tick: number) => ({
        config: cfg,
        favoriteAsk: 1 - ask,
        filledCheap: 8,
        filledExpensive: 0,
        pairId: "p",
        cheapAsk: ask,
        cheapBid: Math.max(0, ask - 0.01),
        tracker,
        nowMs: (W + 120 + tick) * 1000,
      });
      assert.equal(strategy.shouldDefend(ctx(0.5, 0)), false); // arming
      assert.equal(strategy.shouldDefend(ctx(0.52, 1)), false); // rising
      assert.equal(strategy.shouldDefend(ctx(0.50, 2)), true); // drop
    });

    it("sells on flat price (momentum below threshold)", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const cfg = { ...config };
      const ctx = (ask: number, tick: number) => ({
        config: cfg,
        favoriteAsk: 1 - ask,
        filledCheap: 8,
        filledExpensive: 0,
        pairId: "p",
        cheapAsk: ask,
        cheapBid: Math.max(0, ask - 0.01),
        tracker,
        nowMs: (W + 120 + tick) * 1000,
      });
      assert.equal(strategy.shouldDefend(ctx(0.5, 0)), false); // arming
      assert.equal(strategy.shouldDefend(ctx(0.5, 1)), true); // flat → sell
    });

    it("returns false when the exit is disabled", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      assert.equal(
        strategy.shouldDefend({
          config: { ...config, earlyLowExitEnabled: false },
          favoriteAsk: 0.5,
          filledCheap: 8,
          filledExpensive: 0,
          pairId: "p2",
          cheapAsk: 0.6,
          cheapBid: 0.59,
          tracker,
          nowMs: (W + 120) * 1000,
        }),
        false,
      );
    });

    it("defendShares returns the full filled size on a sell trigger", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const cfg = { ...config };
      const ctx = (ask: number, tick: number) => ({
        config: cfg,
        favoriteAsk: 1 - ask,
        filledCheap: 7.5,
        filledExpensive: 0,
        pairId: "p3",
        cheapAsk: ask,
        cheapBid: Math.max(0, ask - 0.01),
        tracker,
        nowMs: (W + 120 + tick) * 1000,
      });
      strategy.shouldDefend(ctx(0.5, 0)); // arming
      assert.equal(strategy.shouldDefend(ctx(0.5, 1)), true); // flat → sell
      assert.equal(strategy.defendShares(ctx(0.5, 1)), 7.5);
    });

    describe("OPT: stop-loss", () => {
      const stopCfg = { ...config, earlyLowStopLossEnabled: true, earlyLowStopLossBidMax: 0.02 };
      const ctxAt = (pairId: string, ask: number, bid: number, tick: number) => ({
        config: stopCfg,
        favoriteAsk: 1 - ask,
        filledCheap: 8,
        filledExpensive: 0,
        pairId,
        cheapAsk: ask,
        cheapBid: bid,
        tracker: new TradeTracker(),
        nowMs: (W + 120 + tick) * 1000,
      });

      it("sells at once when the bid is under the stop, exit disarmed", () => {
        const strategy = makeStrategy();
        assert.equal(
          strategy.shouldDefend(ctxAt("sl1", 0.03, 0.02, 0)),
          true,
        );
      });

      it("does not trigger above the stop", () => {
        const strategy = makeStrategy();
        assert.equal(
          strategy.shouldDefend(ctxAt("sl2", 0.06, 0.06, 0)),
          false,
        );
      });

      it("sells a hard crash even when the exit was armed", () => {
        const strategy = makeStrategy();
        // Armement à 0.50 (pas de vente au tick d'armement).
        assert.equal(strategy.shouldDefend(ctxAt("sl3", 0.5, 0.49, 0)), false, "arming");
        // Chute dure : bid 0.02 ≤ stop → vente immédiate malgré le pipeline TP.
        assert.equal(strategy.shouldDefend(ctxAt("sl3", 0.3, 0.02, 1)), true, "stop");
      });

      it("defendShares returns the full size on a stop trigger", () => {
        const strategy = makeStrategy();
        const ctx = { ...ctxAt("sl4", 0.03, 0.01, 0) };
        assert.equal(strategy.defendShares(ctx), 8);
      });
    });

    describe("OPT: trailing", () => {
      const trailCfg = {
        ...config, earlyLowExitMomentumMin: 0, earlyLowTrailingEnabled: true, earlyLowTrailingOffset: 0.02,
      };
      let t = 0;
      const ctx = (ask: number) => {
        t++;
        return {
          config: trailCfg,
          favoriteAsk: 1 - ask,
          filledCheap: 8,
          filledExpensive: 0,
          pairId: "tr1",
          cheapAsk: ask,
          cheapBid: Math.max(0, ask - 0.01),
          tracker: new TradeTracker(),
          nowMs: (W + 120 + t) * 1000,
        };
      };

      it("tolerates a pullback within the offset, sells beyond it", () => {
        const s = makeStrategy();
        assert.equal(s.shouldDefend(ctx(0.5)), false, "arming tick");
        assert.equal(s.shouldDefend(ctx(0.505)), false, "down 0.5 within 2 offset");
        assert.equal(s.shouldDefend(ctx(0.51)), false, "up");
        assert.equal(s.shouldDefend(ctx(0.492)), false, "pullback within offset");
        assert.equal(s.shouldDefend(ctx(0.47)), true, "beyond offset");
      });

      it("never sells on the arming tick even with momentum 0", () => {
        const s = makeStrategy();
        assert.equal(s.shouldDefend(ctx(0.5)), false, "arming tick");
      });
    });

    describe("OPT: exit deadline", () => {
      const dlCfg = { ...config, earlyLowExitMaxElapsedSec: 600 };
      const windowEnd = W + 900;
      const pairId = `slug:${windowEnd}`; // windowStart déduit = end − 900 = W
      const ctx = (ask: number, tickSec: number) => ({
        config: dlCfg,
        favoriteAsk: 1 - ask,
        filledCheap: 8,
        filledExpensive: 0,
        pairId,
        cheapAsk: ask,
        cheapBid: Math.max(0, ask - 0.01),
        tracker: new TradeTracker(),
        nowMs: (W + tickSec) * 1000,
      });

      it("sells an armed exit past the deadline (windowStart via pairId)", () => {
        const s = makeStrategy();
        assert.equal(s.shouldDefend(ctx(0.5, 60)), false, "arming tick");
        assert.equal(s.shouldDefend(ctx(0.5, 601)), true, "past 600 s → sell");
      });

      it("keeps holding before the deadline with a rising ask", () => {
        const s = makeStrategy();
        assert.equal(s.shouldDefend(ctx(0.5, 60)), false, "arming tick");
        assert.equal(s.shouldDefend(ctx(0.52, 61)), false, "rising → hold");
      });

      it("deadline off (0) never cuts an armed exit", () => {
        const s = makeStrategy();
        const cfg = {
          ...config,
          earlyLowExitMaxElapsedSec: 0,
          earlyLowExitMomentumMin: 0, // delta 0 = hold (sinon flat = sell)
        };
        const c = { ...ctx(0.5, 60), config: cfg };
        assert.equal(s.shouldDefend(c), false, "arming");
        const c2 = { ...c, cheapAsk: 0.5, cheapBid: 0.49, nowMs: (W + 841) * 1000 };
        assert.equal(s.shouldDefend(c2), false, "flat but no deadline");
      });
    });
  });
});