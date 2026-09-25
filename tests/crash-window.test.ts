import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { RestingManager } from "../src/bot/resting-manager.js";
import { testConfig } from "./helpers.js";
import type { SimulatedPosition, TokenBook } from "../src/types.js";

/**
 * Crash-window test: the executor writes addOpenPosition + attachLeg + removePostedOrder.
 * A crash between addOpenPosition and removePostedOrder leaves BOTH a filled open position
 * AND a posted (resting) row for the same order. postedOverlapsOpen must dedupe by CLOB
 * orderId so exposure/resting is not double-counted after reload (loadFromDb path).
 */
function pos(
  partial: Partial<SimulatedPosition> & Pick<SimulatedPosition, "id" | "kind" | "status">,
): SimulatedPosition {
  return {
    eventSlug: "btc-updown-15m-1000",
    eventTitle: "BTC",
    tokenId: partial.kind === "cheap" ? "t-down" : "t-up",
    outcome: partial.kind === "cheap" ? "Down" : "Up",
    outcomeIndex: partial.kind === "cheap" ? 1 : 0,
    limitPrice: 0.08,
    fillPrice: 0.08,
    size: 10,
    cost: 0.8,
    windowEnd: 1900,
    fillReason: "marketable",
    pairId: "btc-updown-15m-1000:1900",
    ...partial,
  };
}

function book(tokenId: string, bestBid: number | null): TokenBook {
  return {
    tokenId,
    outcome: tokenId === "t-down" ? "Down" : "Up",
    outcomeIndex: tokenId === "t-down" ? 1 : 0,
    bestBid,
    bestAsk: bestBid === null ? null : bestBid + 0.01,
    bestAskSize: null,
    bestBidSize: null,
    bid2: null,
    bid2Size: null,
    bid3: null,
    bid3Size: null,
  };
}

describe("crash between addOpenPosition and removePostedOrder", () => {
  it("loadFromDb dedupes a posted order overlapping an open fill (by orderId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-crash-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);

    // Executor crashed after addOpenPosition + attachLeg but BEFORE
    // removePostedOrder: both rows are in SQLite.
    const filled = pos({ id: "live:abc", kind: "cheap", status: "open" });
    repos.positions.insert(filled);
    repos.pairs.upsert({
      id: filled.pairId,
      eventSlug: filled.eventSlug,
      eventTitle: filled.eventTitle,
      windowEnd: filled.windowEnd,
      cheapLegs: [],
      expensiveLegs: [],
      status: "partial",
    });
    // Posted row for the SAME CLOB order (live:abc → orderId "abc").
    const ctx = {
      eventSlug: filled.eventSlug,
      windowEnd: filled.windowEnd,
      tokenId: filled.tokenId,
      outcome: filled.outcome,
      outcomeIndex: filled.outcomeIndex,
      kind: "cheap" as const,
      limitPrice: filled.limitPrice,
      size: filled.size,
      pairId: filled.pairId,
      eventTitle: filled.eventTitle,
      bestAskAtFill: null,
    };
    repos.postedOrders.insert({
      key: "k1",
      eventSlug: filled.eventSlug,
      windowEnd: filled.windowEnd,
      cost: 0.8,
      createdAt: Date.now(),
      orderId: "abc",
      ...ctx,
    });

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();

    // Open exposure counts the fill (0.8). The posted row overlaps the same
    // orderId → its working remainder must be 0 (no double count).
    assert.equal(tracker.getOpenExposure(), 0.8);
    assert.equal(tracker.getRestingExposure(), 0);
    assert.equal(tracker.getAllPostedOrders().length, 1);

    // The reconciliation the lifecycle would run: removing the posted row
    // must not affect the open position.
    tracker.removePostedOrder("k1");
    assert.equal(tracker.getOpenExposure(), 0.8);
    assert.equal(tracker.getRestingExposure(), 0);
    db.close();
  });

  it("keeps a posted remainder countable when open fills do NOT overlap it", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-crash2-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);

    // A resting GTC (no fill yet) must still count toward resting exposure.
    repos.postedOrders.insert({
      key: "k2",
      eventSlug: "btc-updown-15m-1000",
      windowEnd: 1900,
      cost: 0.8,
      createdAt: Date.now(),
      orderId: "def",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.08,
      size: 10,
      pairId: "btc-updown-15m-1000:1900",
      eventTitle: "BTC",
      bestAskAtFill: null,
    });

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();

    assert.equal(tracker.getOpenExposure(), 0);
    assert.equal(tracker.getRestingExposure(), 0.8);
    db.close();
  });
});

describe("FOK SELL sell-unconfirmed — holding semantics (defendPair)", () => {
  const PAIR = "btc-updown-15m-1000:1900";

  function makeDeps(placeSellResult: Record<string, unknown>) {
    const tracker = new TradeTracker();
    const cheap = pos({ id: "c1", kind: "cheap", status: "open" });
    tracker.addOpenPosition(cheap);
    tracker.attachLeg(cheap);
    // Simulate orchestrate's Policy-A enqueue mark.
    tracker.mark(`policy-a-defend:${PAIR}`);
    const calls: string[] = [];
    const strategy = {
      id: "arb" as const,
      leadsWithEdge: false,
      independentHedgeGrid: undefined,
      defendShares: () => 10,
      onDefendCommitted: () => calls.push("onDefendCommitted"),
    };
    const manager = new RestingManager(
      {
        config: testConfig(),
        tracker,
        scanner: {
          getTokenBook: async () => book("t-down", 0.12),
          scan: async () => [],
          inTradingWindow: () => true,
          getTokenBooks: async () => [],
        },
        trader: {
          placeSell: async () => placeSellResult,
        },
        lifecycle: {
          clearCheapMissing: () => {},
          cancelRestingHedgesForPair: async () => {},
        },
      },
      strategy as never,
    );
    return { manager, tracker, calls };
  }

  it("sell-unconfirmed: cheap stays open, exposure intact, retry re-enabled (key unmarked)", async () => {
    const { manager, tracker } = makeDeps({ filled: false, reason: "sell-unconfirmed" });
    await manager.defendPair(PAIR);

    assert.equal(tracker.getOpenPositions().length, 1, "position NOT closed as sold");
    assert.equal(tracker.getOpenExposure(), 0.8);
    assert.equal(tracker.getResolvedPositions().length, 0);
    assert.equal(tracker.has(`policy-a-defend:${PAIR}`), false, "key unmarked → retry possible");
  });

  it("successful sell: cheap closed as sold, key left as-is (marked at enqueue)", async () => {
    const { manager, tracker, calls } = makeDeps({
      filled: true,
      filledSize: 10,
      fillPrice: 0.12,
    });
    await manager.defendPair(PAIR);

    assert.equal(tracker.getOpenPositions().length, 0);
    assert.equal(tracker.getOpenExposure(), 0);
    assert.equal(tracker.getResolvedPositions()[0]?.status, "sold");
    assert.ok(calls.includes("onDefendCommitted"));
  });

  it("killed FOK: cheap stays open as directional (no unmark — one defend attempt per pair)", async () => {
    const { manager, tracker } = makeDeps({ filled: false, reason: "killed-fok-sell" });
    await manager.defendPair(PAIR);

    assert.equal(tracker.getOpenPositions().length, 1);
    assert.equal(tracker.getOpenExposure(), 0.8);
    assert.equal(tracker.getResolvedPositions().length, 0);
  });
});