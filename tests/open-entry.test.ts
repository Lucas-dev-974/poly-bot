import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { OpenEntryStrategy } from "../src/strategy/open-entry-strategy.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition, TradeOpportunity } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

function baseConfig() {
  return testConfig({
    strategyId: "open-entry",
    enableExpensiveHedge: false,
    arbAskLockOnly: true, // sticky flag must not block emission
    openEntryOrderUsdc: 15,
    openEntryLeanTrigger: 0.15,
    openEntryMaxElapsedSec: 300,
    openEntryFairAskSumMax: 1.02,
    openEntryMaxSpread: 0.04,
    maxSharesPerOrder: 40,
  });
}

function fillCheap(
  tracker: TradeTracker,
  event: ReturnType<typeof testEvent>,
  fillPrice = 0.6,
): string {
  const pairId = `${event.slug}:${event.windowEnd}`;
  const position: SimulatedPosition = {
    id: "open-entry-filled",
    eventSlug: event.slug,
    eventTitle: event.title,
    tokenId: "t-up",
    outcome: "Up",
    outcomeIndex: 0,
    kind: "cheap",
    limitPrice: fillPrice,
    fillPrice,
    size: 20,
    cost: fillPrice * 20,
    windowEnd: event.windowEnd,
    status: "open",
    fillReason: "marketable",
    pairId,
  };
  tracker.addOpenPosition(position);
  return pairId;
}

describe("open-entry strategy", () => {
  it("parses and registers open-entry", () => {
    assert.equal(parseStrategyId("open-entry"), "open-entry");
    assert.equal(createStrategy("open-entry").id, "open-entry");
    assert.equal(createStrategy("open-entry").usesDefendAsExit, true);
    assert.equal(createStrategy("open-entry").leadsWithEdge, false);
  });

  it("emits FOK buy on the leading token when lean >= trigger in window", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 10) * 1000;
    // UP mène de 0.46 (0.70 vs 0.24) : somme 0.94 fair, spread 1 tick
    const opps = strategy.findOpportunities({
      config,
      tracker: new TradeTracker(),
      event,
      books: books(0.7, 0.24, 100),
      nowMs,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].token.outcome, "Up");
    assert.equal(opps[0].price, 0.7);
  });

  it("emits on the DOWN side when DOWN leads", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: books(0.24, 0.7, 100),
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].token.outcome, "Down");
  });

  it("skips after the entry window", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: books(0.7, 0.24, 100),
      nowMs: (event.windowStart + 301) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when lean below trigger", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: books(0.6, 0.5, 100), // diff 0.10 < 0.15
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when the open is not fair (askSum > fairAskSumMax)", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: books(0.75, 0.35, 100), // sum 1.10 > 1.02
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when spread too wide", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const wide = books(0.7, 0.24, 100);
    wide[0].bestBid = 0.6; // spread 0.10 > 0.04
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: wide,
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("skips when depth below size (FOK full-depth preflight)", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker: new TradeTracker(),
      event,
      books: books(0.7, 0.24, 5), // computeSize(15/0.70)=21 > 5
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("does not stack a second entry after a filled leg", () => {
    const strategy = new OpenEntryStrategy();
    const event = testEvent();
    const tracker = new TradeTracker();
    fillCheap(tracker, event);
    const opps = strategy.findOpportunities({
      config: baseConfig(),
      tracker,
      event,
      books: books(0.7, 0.24, 100),
      nowMs: (event.windowStart + 10) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("coerces sticky arbAskLockOnly / hedge off in validateConfigCoherence", () => {
    const config = baseConfig();
    validateConfigCoherence(config);
    assert.equal(config.arbAskLockOnly, false);
    assert.equal(config.enableExpensiveHedge, false);
  });

  it("throws on incoherent SL scale (late dist > struct dist)", () => {
    const config = baseConfig();
    config.openEntrySlLateDist = 0.2; // > struct 0.1
    assert.throws(() => validateConfigCoherence(config), /late stop is the TIGHTER/);
  });

  it("records entry price on onBuyCommitted and triggers the structural SL", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const ws = event.windowStart;
    const entryOpportunity: TradeOpportunity = {
      kind: "cheap",
      event,
      token: { ...books(0.7, 0.24, 100)[0] },
      price: 0.6,
      size: 20,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "k",
      pairId: `${event.slug}:${event.windowEnd}`,
      orderType: "FOK",
    };
    strategy.onBuyCommitted?.(entryOpportunity);

    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.6);

    // tick à 40 s : DOWN a pris le lead de 0.25 depuis ~20s, ask tenu 0.48
    // (entry 0.6 - structDist 0.1 - tick 0.01 = 0.49 -> 0.48 déclenche)
    const flipSince = (ws + 20) * 1000;
    const nowMs = (ws + 40) * 1000;
    const state = strategy["states"].get(pairId)!;
    state.adverseSinceMs = flipSince;
    const defend = strategy.shouldDefend({
      config,
      favoriteAsk: 0.73, // mène de 0.25 >= 0.2 (flip adverse réel)
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.48, // <= 0.49 (entry - dist - tick)
      tracker,
      nowMs,
    });
    assert.equal(defend, true);
    assert.equal(strategy.defendShares({
      config,
      favoriteAsk: 0.73,
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.48,
      tracker,
      nowMs,
    }), 20);
  });

  it("does NOT trigger the structural SL without the confirmed flip", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const ws = event.windowStart;
    const entryOpportunity: TradeOpportunity = {
      kind: "cheap",
      event,
      token: { ...books(0.7, 0.24, 100)[0] },
      price: 0.6,
      size: 20,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "k",
      pairId: `${event.slug}:${event.windowEnd}`,
      orderType: "FOK",
    };
    strategy.onBuyCommitted?.(entryOpportunity);

    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.6);
    const state = strategy["states"].get(pairId)!;
    state.adverseSinceMs = null; // pas de flip confirmé

    // dégât prix présent (0.48 <= 0.49) mais flip jamais confirmé → hold
    const defend = strategy.shouldDefend({
      config,
      favoriteAsk: 0.55, // mène de 0.25 mais flip débuté à peine (maintenant)
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.48,
      tracker,
      nowMs: (ws + 40) * 1000,
    });
    assert.equal(defend, false);
  });

  it("triggers the late SL after slLateAfterSec on a small loss", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const ws = event.windowStart;
    const entryOpportunity: TradeOpportunity = {
      kind: "cheap",
      event,
      token: { ...books(0.7, 0.24, 100)[0] },
      price: 0.6,
      size: 20,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "k",
      pairId: `${event.slug}:${event.windowEnd}`,
      orderType: "FOK",
    };
    strategy.onBuyCommitted?.(entryOpportunity);

    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.6);
    const state = strategy["states"].get(pairId)!;
    state.adverseSinceMs = null;

    // 320 s : > slLateAfterSec 300, ask tenu 0.53 <= 0.6 - 0.06 - 0.01 = 0.53
    const defend = strategy.shouldDefend({
      config,
      favoriteAsk: 0.5,
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.53,
      tracker,
      nowMs: (ws + 320) * 1000,
    });
    assert.equal(defend, true);
  });

  it("holds before slLateAfterSec even on a small loss", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const ws = event.windowStart;
    const entryOpportunity: TradeOpportunity = {
      kind: "cheap",
      event,
      token: { ...books(0.7, 0.24, 100)[0] },
      price: 0.6,
      size: 20,
      tickSize: "0.01",
      negRisk: false,
      tradeKey: "k",
      pairId: `${event.slug}:${event.windowEnd}`,
      orderType: "FOK",
    };
    strategy.onBuyCommitted?.(entryOpportunity);

    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.6);
    const state = strategy["states"].get(pairId)!;
    state.adverseSinceMs = null;

    const defend = strategy.shouldDefend({
      config,
      favoriteAsk: 0.5,
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.53,
      tracker,
      nowMs: (ws + 290) * 1000, // < 300
    });
    assert.equal(defend, false);
  });

  it("returns skip on hedgeAtPostTime and keep on resting actions", () => {
    const strategy = new OpenEntryStrategy();
    const config = baseConfig();
    const event = testEvent();
    assert.deepEqual(
      strategy.hedgeAtPostTime({
        config,
        tracker: new TradeTracker(),
        pairId: "p",
        freshAsk: 0.6,
        nowMs: 0,
      }),
      { action: "skip", reason: "open-entry-no-hedge" },
    );
  });
});