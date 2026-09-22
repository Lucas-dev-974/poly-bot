import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CrossImbalanceHistory,
  crossImbalance,
  crossImbalanceSigned,
} from "../src/utils/book-imbalance.js";
import { FavBandStrategy } from "../src/strategy/fav-band-strategy.js";
import { validateConfigCoherence } from "../src/config.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";
import type { TokenBook } from "../src/types.js";

function sizedBooks(
  upBidSize: number,
  upAskSize: number,
  downBidSize: number,
  downAskSize: number,
): TokenBook[] {
  const base = books(0.75, 0.26, 100) as Array<
    TokenBook & { bid2Size?: number | null; ask2Size?: number | null }
  >;
  return base.map((book) => ({
    ...book,
    ask2: book.bestAsk,
    ask2Size: 0,
    ask3: book.bestAsk,
    ask3Size: 0,
    bid2: book.bestBid,
    bid2Size: 0,
    bid3: book.bestBid,
    bid3Size: 0,
    bestAskSize: book.outcomeIndex === 0 ? upAskSize : downAskSize,
    bestBidSize: book.outcomeIndex === 0 ? upBidSize : downBidSize,
  }));
}

describe("book imbalance utils", () => {
  it("crossImbalance: mirror books with equal sizes cancel out", () => {
    // bids Up 100 + asks Down 100 (bull) vs asks Up 100 + bids Down 100 (bear)
    const booksEq = sizedBooks(100, 100, 100, 100);
    assert.equal(crossImbalance(booksEq[0], booksEq[1]), 0);
  });

  it("crossImbalance: bullish when Up bids + Down asks dominate", () => {
    // Up bid heavy, Down ask heavy → pressure toward Up
    const booksBull = sizedBooks(300, 10, 10, 300);
    const v = crossImbalance(booksBull[0], booksBull[1]);
    assert.ok(v !== null && v > 0.5);
  });

  it("crossImbalanceSigned flips sign for Down", () => {
    const booksBull = sizedBooks(300, 10, 10, 300);
    const up = crossImbalanceSigned(booksBull[0], booksBull[1], 0);
    const down = crossImbalanceSigned(booksBull[0], booksBull[1], 1);
    assert.ok(up !== null && up > 0);
    assert.ok(down !== null && down < 0);
    assert.equal(up, down === null ? null : -down);
  });

  it("returns null when both books are undefined", () => {
    assert.equal(crossImbalance(undefined, undefined), null);
  });

  it("CrossImbalanceHistory: consecutiveAtOrAbove needs N passing samples", () => {
    const h = new CrossImbalanceHistory();
    h.push("p", 1, -0.2, 8);
    h.push("p", 2, -0.2, 8);
    // 2 samples both >= -0.3 → passes
    assert.equal(h.consecutiveAtOrAbove("p", -0.3, 2), true);
    // 1 passing + 1 failing: last-2 window contains a failing sample
    const h2 = new CrossImbalanceHistory();
    h2.push("p", 1, -0.5, 8);
    h2.push("p", 2, -0.2, 8);
    assert.equal(h2.consecutiveAtOrAbove("p", -0.3, 2), false);
    // 1 sample, need 2 → not armed
    const h3 = new CrossImbalanceHistory();
    h3.push("p", 1, -0.2, 8);
    assert.equal(h3.consecutiveAtOrAbove("p", -0.3, 2), false);
    // null sample fails the condition
    const h4 = new CrossImbalanceHistory();
    h4.push("p", 1, -0.2, 8);
    h4.push("p", 2, null, 8);
    assert.equal(h4.consecutiveAtOrAbove("p", -0.3, 2), false);
  });
});

describe("fav-band cross-imbalance gate", () => {
  function config(gate: Record<string, unknown>) {
    const cfg = testConfig({
      strategyId: "fav-band",
      enableExpensiveHedge: false,
      favBandAskMin: 0.7,
      favBandAskMax: 0.85,
      favBandMinElapsedSec: 0,
      favBandOrderUsdc: 15,
      maxSharesPerOrder: 40,
    });
    for (const [k, v] of Object.entries(gate)) {
      (cfg as Record<string, unknown>)[k] = v;
    }
    validateConfigCoherence(cfg, { leadsWithEdge: false });
    return cfg;
  }

  function favUp() {
    // Up 0.75 = favorite; strong bearish pressure (Up asks + Down bids)
    return sizedBooks(10, 300, 300, 10);
  }

  function bullBooks() {
    // Large Up ask size so the 0.8× depth preflight (20 shares requested)
    // passes; ask-heavy Down mirrors it (cross ≈ +0.94).
    return sizedBooks(3000, 100, 100, 3000);
  }

  it("gate off by default (null): no imbalance filtering", () => {
    const strategy = new FavBandStrategy();
    const cfg = config({});
    const event = testEvent(1_800_000_000);
    const nowMs = (event.windowStart + 300) * 1000;
    // bearish books — would fail any floor, but gate is off
    const opps = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: favUp(),
      nowMs,
    });
    assert.equal(opps.length, 1);
  });

  it("blocks entry while pressure is strongly against for < 2 ticks", () => {
    const strategy = new FavBandStrategy();
    const cfg = config({ favBandImbalanceCrossMin: -0.3, favBandImbalanceTicks: 2 });
    const event = testEvent(1_800_000_000);
    // tick 1: bearish
    const opps1 = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: favUp(),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps1.length, 0);
    // tick 2: bearish again — only 2 bearish samples but floor -0.3 requires
    // >= -0.3; bearish is ~-0.97 so still blocked... unless armed needs 2 GOOD
    // samples. 2 bad samples do not pass the floor → still blocked.
    const opps2 = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: favUp(),
      nowMs: (event.windowStart + 310) * 1000,
    });
    assert.equal(opps2.length, 0);
  });

  it("allows entry once the floor is met for N consecutive ticks", () => {
    const strategy = new FavBandStrategy();
    const cfg = config({ favBandImbalanceCrossMin: -0.3, favBandImbalanceTicks: 2 });
    const event = testEvent(1_800_000_000);
    // tick 1: bullish sample → history [bull] → not armed (needs 2)
    const opps1 = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: bullBooks(),
      nowMs: (event.windowStart + 300) * 1000,
    });
    assert.equal(opps1.length, 0);
    // tick 2: bullish again → last-2 = [bull, bull] → armed → entry
    const opps2 = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: bullBooks(),
      nowMs: (event.windowStart + 310) * 1000,
    });
    assert.equal(opps2.length, 1);
  });

  it("a fresh against-pressure sample re-blocks immediately (no stale arming)", () => {
    const strategy = new FavBandStrategy();
    const cfg = config({ favBandImbalanceCrossMin: -0.3, favBandImbalanceTicks: 2 });
    const event = testEvent(1_800_000_000);
    strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: bullBooks(),
      nowMs: (event.windowStart + 300) * 1000,
    });
    // armed after tick 1? No — needs 2. But at tick 2 the bearish sample lands:
    // last-2 = [bull, bear] → floor fails → blocked even after arming.
    strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: bullBooks(),
      nowMs: (event.windowStart + 305) * 1000,
    });
    const opps = strategy.findOpportunities({
      config: cfg,
      tracker: new TradeTracker(),
      event,
      books: favUp(),
      nowMs: (event.windowStart + 310) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("rejects invalid config values", () => {
    assert.throws(() => {
      const cfg = testConfig({ strategyId: "fav-band" });
      (cfg as Record<string, unknown>)["favBandImbalanceCrossMin"] = -1.5;
      validateConfigCoherence(cfg, { leadsWithEdge: false });
    }, /favBandImbalanceCrossMin/);
    assert.throws(() => {
      const cfg = testConfig({ strategyId: "fav-band" });
      (cfg as Record<string, unknown>)["favBandImbalanceTicks"] = 0;
      validateConfigCoherence(cfg, { leadsWithEdge: false });
    }, /favBandImbalanceTicks/);
  });
});