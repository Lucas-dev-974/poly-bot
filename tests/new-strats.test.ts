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

  describe("antiflip-revert — presets 5m (audits/5min-strategies A/H/K)", () => {
    const makeStrategy = () => new AntiflipRevertStrategy();
    const event = testEvent(1_800_000_000); // slug 15m
    const W = event.windowStart;

    /** Preset A (re-entry) : délai 5s, bande [0.30,0.40], gate 5m ON. */
    const configA = testConfig({
      strategyId: "antiflip-revert",
      antiflip5mOnly: true,
      antiflipBandMin: 0.3,
      antiflipBandMax: 0.4,
      antiflipDeposedAskMin: null,
      antiflipFlipLookbackMs: 30_000,
      antiflipMinElapsedSec: 0,
      antiflipMaxElapsedSec: 185,
      antiflipOrderUsdc: 2,
      maxSharesPerOrder: 5,
      antiflipEntryDelaySec: 5,
      antiflipFavAskMin: 0,
      antiflipFavAskMax: 1,
    });
    /** Preset H (sharp) : A + chute ≥ 12¢ du sommet pré-flip. */
    const configH = testConfig({ ...configA, antiflipSharpDropMin: 0.12 });
    /** Preset K (bounce) : bounce 8¢ + floor 0.40, bande [0.40,0.60], budget 3$. */
    const configK = testConfig({
      strategyId: "antiflip-revert",
      antiflip5mOnly: true,
      antiflipBandMin: 0.4,
      antiflipBandMax: 0.6,
      antiflipDeposedAskMin: null,
      antiflipFlipLookbackMs: 120_000,
      antiflipMinElapsedSec: 0,
      antiflipMaxElapsedSec: 285,
      antiflipOrderUsdc: 3,
      maxSharesPerOrder: 5,
      antiflipEntryDelaySec: 3,
      antiflipBounceMin: 0.08,
      antiflipBounceFloor: 0.4,
      antiflipFavAskMin: 0,
      antiflipFavAskMax: 1,
    });

    const ev5m = {
      ...event,
      slug: `btc-updown-5m-${W}`,
      windowStart: W,
      windowEnd: W + 300,
    };

    it("blocks a 15m market when antiflip5mOnly is on even though every other gate passes", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config: configA,
        tracker,
        event, // slug 15m
        books: books(0.62, 0.37, 100),
        nowMs: (W + 10) * 1000,
      });
      const opps = strategy.findOpportunities({
        config: configA,
        tracker,
        event,
        books: books(0.35, 0.62, 100),
        nowMs: (W + 20) * 1000, // délai 5s écoulé, déchu 0.35 ∈ bande
      });
      assert.equal(opps.length, 0);
    });

    it("preset A: emits after the flip delay on a 5m market", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config: configA,
        tracker,
        event: ev5m,
        books: books(0.62, 0.37, 100),
        nowMs: (W + 10) * 1000,
      });
      // Flip à +11s : déchu 0.35 ∈ bande mais délai 5s non écoulé.
      const tooEarly = strategy.findOpportunities({
        config: configA,
        tracker,
        event: ev5m,
        books: books(0.35, 0.62, 100),
        nowMs: (W + 11) * 1000,
      });
      assert.equal(tooEarly.length, 0);
      // +5s après le flip : entrée autorisée sur le DÉCHU.
      const opps = strategy.findOpportunities({
        config: configA,
        tracker,
        event: ev5m,
        books: books(0.35, 0.62, 100),
        nowMs: (W + 16) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].token.outcome, "Up");
      assert.equal(opps[0].price, 0.35);
      assert.equal(opps[0].orderType, "FOK");
    });

    it("preset H: requires a sharp drop from the pre-flip peak", () => {
      // Cas positif : sommet pré-flip 0.55 → déchu 0.38 (chute 0.17 ≥ 0.12).
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config: configH,
        tracker,
        event: ev5m,
        books: books(0.55, 0.4, 100),
        nowMs: (W + 10) * 1000,
      });
      strategy.findOpportunities({
        config: configH,
        tracker,
        event: ev5m,
        books: books(0.38, 0.6, 100),
        nowMs: (W + 11) * 1000,
      });
      const opps = strategy.findOpportunities({
        config: configH,
        tracker,
        event: ev5m,
        books: books(0.38, 0.6, 100),
        nowMs: (W + 16) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].price, 0.38);

      // Cas négatif : sommet pré-flip 0.45 → déchu 0.38 (chute 0.07 < 0.12).
      const shallow = makeStrategy();
      const shallowTracker = new TradeTracker();
      const cfgShallow = testConfig({ ...configH, antiflipFlipLookbackMs: 30_000 });
      shallow.findOpportunities({
        config: cfgShallow,
        tracker: shallowTracker,
        event: ev5m,
        books: books(0.45, 0.4, 100),
        nowMs: (W + 10) * 1000,
      });
      shallow.findOpportunities({
        config: cfgShallow,
        tracker: shallowTracker,
        event: ev5m,
        books: books(0.38, 0.6, 100),
        nowMs: (W + 11) * 1000,
      });
      const none = shallow.findOpportunities({
        config: cfgShallow,
        tracker: shallowTracker,
        event: ev5m,
        books: books(0.38, 0.6, 100),
        nowMs: (W + 16) * 1000,
      });
      assert.equal(none.length, 0);
    });

    it("preset K: enters on the bounce off the post-flip low above the floor", () => {
      const strategy = makeStrategy();
      const tracker = new TradeTracker();
      strategy.findOpportunities({
        config: configK,
        tracker,
        event: ev5m,
        books: books(0.55, 0.4, 100),
        nowMs: (W + 10) * 1000,
      });
      // Flip à +11s, déchu 0.45 ∈ [0.40,0.60], délai 3s non écoulé.
      strategy.findOpportunities({
        config: configK,
        tracker,
        event: ev5m,
        books: books(0.45, 0.62, 100),
        nowMs: (W + 11) * 1000,
      });
      // +3s : plancher initial 0.42, rebond 0 → pas d'entrée.
      const noBounce = strategy.findOpportunities({
        config: configK,
        tracker,
        event: ev5m,
        books: books(0.42, 0.65, 100),
        nowMs: (W + 14) * 1000,
      });
      assert.equal(noBounce.length, 0);
      // Rebond 0.51 - 0.42 = 0.09 ≥ 0.08, floor 0.40 ok, bande ≤ 0.60 → entrée.
      const opps = strategy.findOpportunities({
        config: configK,
        tracker,
        event: ev5m,
        books: books(0.51, 0.7, 100),
        nowMs: (W + 22) * 1000,
      });
      assert.equal(opps.length, 1);
      assert.equal(opps[0].token.outcome, "Up");
      assert.equal(opps[0].price, 0.51);
    });

    it("rejects a bounce floor outside the band", () => {
      const cfg = testConfig({
        strategyId: "antiflip-revert",
        antiflipBandMin: 0.3,
        antiflipBandMax: 0.4,
        antiflipBounceFloor: 0.5,
      });
      assert.throws(() => validateConfigCoherence(cfg), /within \[antiflipBandMin, antiflipBandMax\]/);
    });

    it("rejects an inverted favorite uncertainty band", () => {
      const cfg = testConfig({
        strategyId: "antiflip-revert",
        antiflipFavAskMin: 0.65,
        antiflipFavAskMax: 0.45,
      });
      assert.throws(() => validateConfigCoherence(cfg), /antiflipFavAskMin must be < antiflipFavAskMax/);
    });

    it("preset A-TP: validates TP presets and coherence bounds", () => {
      // Presets TP10/TP20 passent la validation de cohérence (gate 5m, bande, TP ≤ 0.9).
      for (const tp of [0.1, 0.2]) {
        const cfg = testConfig({
          ...configA,
          antiflipTakeProfitPct: tp,
        });
        assert.doesNotThrow(() => validateConfigCoherence(cfg));
      }
      // TP > 0.9 rejeté.
      const tooHigh = testConfig({ ...configA, antiflipTakeProfitPct: 1.0 });
      assert.throws(() => validateConfigCoherence(tooHigh), /antiflipTakeProfitPct must be between 0 and 0.9/);
      // TP négatif rejeté.
      const negative = testConfig({ ...configA, antiflipTakeProfitPct: -0.1 });
      assert.throws(() => validateConfigCoherence(negative), /antiflipTakeProfitPct must be between 0 and 0.9/);
    });
  });
});