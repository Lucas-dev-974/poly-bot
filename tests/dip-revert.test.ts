import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { DipRevertStrategy } from "../src/strategy/dip-revert-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("dip-revert strategy", () => {
  it("parses and registers dip-revert", () => {
    assert.equal(parseStrategyId("dip-revert"), "dip-revert");
    assert.equal(createStrategy("dip-revert").id, "dip-revert");
  });

  it("emits one FOK buy on favorite after a dip + stabilization", () => {
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      enableExpensiveHedge: false,
      dipRevertBandMin: 0.55,
      dipRevertBandMax: 0.65,
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 60_000,
      dipRevertMinElapsedSec: 180,
      dipRevertMaxElapsedSec: null,
      dipRevertMaxSpread: 0.04,
      dipRevertOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart; // seconds

    // t1 : favori à 0.64 (sample poussé, elapsed < 180 → pas d'entrée)
    let opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.64, 0.35, 100),
      nowMs: (W + 135) * 1000,
    });
    assert.equal(opps.length, 0);

    // t2 : chute à 0.60 (drop 0.04) mais pas encore de rebond
    opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.60, 0.35, 100),
      nowMs: (W + 155) * 1000,
    });
    assert.equal(opps.length, 0);

    // t3 : rebound à 0.605 (span 50s >= 70% lookback, drop >= 0.03, ask > low)
    opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.605, 0.35, 100),
      nowMs: (W + 185) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].token.outcome, "Up");
    assert.equal(opps[0].price, 0.61); // round2(0.605)
  });

  it("does not emit without a real dip (flat favorite)", () => {
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      dipRevertBandMin: 0.55,
      dipRevertBandMax: 0.65,
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 60_000,
      dipRevertMinElapsedSec: 180,
      dipRevertOrderUsdc: 15,
    });
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart;

    for (const [i, ask] of [0.62, 0.62, 0.62].entries()) {
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.35, 100),
        nowMs: (W + 140 + i * 20) * 1000,
      });
      assert.equal(opps.length, 0);
    }
  });

  it("skips when favorite ask is outside the band even after dip", () => {
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      dipRevertBandMin: 0.55,
      dipRevertBandMax: 0.65,
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 60_000,
      dipRevertMinElapsedSec: 180,
      dipRevertOrderUsdc: 15,
    });
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart;

    for (const [i, ask] of [0.92, 0.86, 0.88].entries()) {
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.1, 100),
        nowMs: (W + 140 + i * 20) * 1000,
      });
      assert.equal(opps.length, 0);
    }
  });

  it("does not stack a second entry after a filled leg", () => {
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 60_000,
      dipRevertMinElapsedSec: 0,
    });
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition({
      id: "filled",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      kind: "cheap",
      limitPrice: 0.6,
      fillPrice: 0.6,
      size: 20,
      cost: 12,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId,
    });
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.88, 0.1, 100),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("coerces sticky arbAskLockOnly / hedge off in validateConfigCoherence", () => {
    const config = testConfig({
      strategyId: "dip-revert",
      arbAskLockOnly: true,
      enableExpensiveHedge: true,
      dipRevertBandMin: 0.55,
      dipRevertBandMax: 0.65,
    });
    validateConfigCoherence(config);
    assert.equal(config.arbAskLockOnly, false);
    assert.equal(config.enableExpensiveHedge, false);
  });

  it("measures the dip over a lookback larger than 60s (regression)", () => {
    // Regression: the sliding window used to hard-code a 60s cutoff while
    // dipRevertDropLookbackMs is configurable. With a 120s lookback the span
    // was capped at ~60s < 70% × 120s, so the signal never fired.
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      enableExpensiveHedge: false,
      dipRevertBandMin: 0.55,
      dipRevertBandMax: 0.65,
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 120_000,
      dipRevertMinElapsedSec: 180,
      dipRevertMaxElapsedSec: null,
      dipRevertMaxSpread: 0.04,
      dipRevertOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart;

    // t1 : favori à 0.64 (sample, elapsed < 180)
    let opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.64, 0.35, 100),
      nowMs: (W + 120) * 1000,
    });
    assert.equal(opps.length, 0);

    // t2 : chute à 0.60 (drop 0.04) à t+120s — le dip a 0s de span ici
    opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.60, 0.35, 100),
      nowMs: (W + 150) * 1000,
    });
    assert.equal(opps.length, 0);

    // t3 : rebound à 0.605 à t+210s → span = 210-120 = 90s ≥ 70% × 120s = 84s.
    // drop 0.64→0.605 = 0.035 ≥ 0.03, ask 0.605 > low 0.60 → signal prêt.
    opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.605, 0.35, 100),
      nowMs: (W + 210) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].price, 0.61); // round2(0.605)
  });

  it("never fires with a 120s lookback when samples only span 60s", () => {
    // With the old 60s hard cutoff this test would pass trivially (signal
    // fired on a 60s span); with the fix a 120s lookback requires a 84s span.
    const strategy = new DipRevertStrategy();
    const config = testConfig({
      strategyId: "dip-revert",
      enableExpensiveHedge: false,
      dipRevertMinDrop: 0.03,
      dipRevertDropLookbackMs: 120_000,
      dipRevertMinElapsedSec: 0,
      dipRevertOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart;

    // 3 samples espacés de 20s : span max 40s < 84s requis → jamais prêt.
    for (const [i, ask] of [0.64, 0.60, 0.605].entries()) {
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.35, 100),
        nowMs: (W + 200 + i * 20) * 1000,
      });
      assert.equal(opps.length, 0);
    }
  });
});
