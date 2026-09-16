import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { AntiflipRevertStrategy } from "../src/strategy/antiflip-revert-strategy.js";
import { FlipConfirmStrategy } from "../src/strategy/flip-confirm-strategy.js";
import { EarlyConvictionStrategy } from "../src/strategy/early-conviction-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

describe("new directional strategies (antiflip-revert / flip-confirm / early-conviction)", () => {
  it("parses and registers all three engines", () => {
    assert.equal(parseStrategyId("antiflip-revert"), "antiflip-revert");
    assert.equal(parseStrategyId("flip-confirm"), "flip-confirm");
    assert.equal(parseStrategyId("early-conviction"), "early-conviction");
    assert.equal(createStrategy("antiflip-revert").id, "antiflip-revert");
    assert.equal(createStrategy("flip-confirm").id, "flip-confirm");
    assert.equal(createStrategy("early-conviction").id, "early-conviction");
  });

  describe("antiflip-revert", () => {
    const makeStrategy = () => new AntiflipRevertStrategy();
    const config = testConfig({ strategyId: "antiflip-revert", maxSharesPerOrder: 40 });
    const event = testEvent(1_800_000_000);
    const W = event.windowStart;

    it("coerces sticky arb flags via validateConfigCoherence", () => {
      const cfg = testConfig({ strategyId: "antiflip-revert", arbAskLockOnly: true, enableExpensiveHedge: true });
      validateConfigCoherence(cfg);
      assert.equal(cfg.arbAskLockOnly, false);
      assert.equal(cfg.enableExpensiveHedge, false);
    });

    it("rejects deposedAskMin outside the band", () => {
      const cfg = testConfig({
        strategyId: "antiflip-revert",
        antiflipBandMin: 0.35,
        antiflipBandMax: 0.45,
        antiflipDeposedAskMin: 0.30,
      });
      assert.throws(() => validateConfigCoherence(cfg), /within \[antiflipBandMin, antiflipBandMax\]/);
    });

    it("does not emit before a flip is observed", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100), // stable favorite, never flipped
        nowMs: (W + 300) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("emits on the deposed favorite right after a fresh flip", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      // tick 1 : Up mène 0.62/0.37 (favori observé = Up)
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 250) * 1000,
      });
      // tick 2 : flip vers Down (0.42/0.55) ; le déchu (Up) cote 0.42 ∈ bande
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.55, 100),
        nowMs: (W + 251) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].token.outcome, "Up"); // le DÉCHU
      assert.equal(opps[0].orderType, "FOK");
      assert.equal(opps[0].price, 0.42);
    });

    it("does not emit when the flip is stale (> lookbackMs)", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 250) * 1000,
      });
      // tick 2 : flip vers Down à 251s (le déchu est hors de la bande à ce
      // tick : 0.33 < 0.35, pas d'entrée, mais le flip est horodaté)
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.33, 0.62, 100),
        nowMs: (W + 251) * 1000,
      });
      // tick 3 : 91s après le flip (> lookback 90s) : le déchu est revenu
      // dans la bande mais le flip est stale → pas d'entrée
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.55, 100),
        nowMs: (W + 251 + 91) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("does not emit when the deposed ask is below the floor", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 250) * 1000,
      });
      // déchu à 0.38 < floor 0.40
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.38, 0.55, 100),
        nowMs: (W + 251) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("blocks stacking after a filled leg", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 250) * 1000,
      });
      tracker.addOpenPosition({
        tradeKey: "seed",
        pairId: `${event.slug}:${event.windowEnd}`,
        kind: "cheap",
        event,
        token: books(0.42, 0.55)[0],
        price: 0.42,
        size: 10,
        tickSize: 0.01,
        negRisk: false,
        orderType: "FOK",
      });
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.55, 100),
        nowMs: (W + 251) * 1000,
      });
      assert.equal(opps.length, 0);
    });
  });

  describe("flip-confirm", () => {
    const makeStrategy = () => new FlipConfirmStrategy();
    const config = testConfig({ strategyId: "flip-confirm", maxSharesPerOrder: 40 });
    const event = testEvent(1_800_000_000);
    const W = event.windowStart;

    it("buys the NEW favorite after a fresh flip inside the entry window", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 100) * 1000, // Up mène, avant fenêtre [120,180]
      });
      // flip vers Down à 150s (dans la fenêtre d'entrée)
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.57, 100),
        nowMs: (W + 121) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].token.outcome, "Down"); // le NOUVEAU favori
      assert.equal(opps[0].orderType, "FOK");
    });

    it("does not emit outside the entry window (elapsed 200s > max 180s)", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 100) * 1000,
      });
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.57, 100),
        nowMs: (W + 181) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("does not emit when the flip is stale", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 100) * 1000,
      });
      // flip à 121s, entrée à 121+91 = 212s (> 180 max elapsed de toute façon)
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.42, 0.57, 100),
        nowMs: (W + 212) * 1000,
      });
      assert.equal(opps.length, 0);
    });
  });

  describe("early-conviction", () => {
    const makeStrategy = () => new EarlyConvictionStrategy();
    const config = testConfig({ strategyId: "early-conviction", maxSharesPerOrder: 40 });
    const event = testEvent(1_800_000_000);
    const W = event.windowStart;

    it("buys the favorite immediately when it already prices >= min", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 10) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].token.outcome, "Up");
      assert.equal(opps[0].orderType, "FOK");
      assert.equal(opps[0].price, 0.62);
    });

    it("does not emit after the early window closes (elapsed > 45s)", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 46) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("does not emit below the conviction floor (0.55 < 0.60)", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.55, 0.44, 100),
        nowMs: (W + 10) * 1000,
      });
      assert.equal(opps.length, 0);
    });

    it("rejects an askMin below 0.5 in config validation", () => {
      const cfg = testConfig({ strategyId: "early-conviction", earlyConvictionAskMin: 0.45 });
      assert.throws(() => validateConfigCoherence(cfg), /must be >= 0.5/);
    });

    it("coerces sticky arb flags via validateConfigCoherence", () => {
      const cfg = testConfig({ strategyId: "early-conviction", arbAskLockOnly: true, enableExpensiveHedge: true });
      validateConfigCoherence(cfg);
      assert.equal(cfg.arbAskLockOnly, false);
      assert.equal(cfg.enableExpensiveHedge, false);
    });
  });
});