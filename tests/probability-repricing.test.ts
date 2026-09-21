import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence } from "../src/config.js";
import { parseStrategyId } from "../src/strategy/ids.js";
import { createStrategy } from "../src/strategy/registry.js";
import { ProbabilityRepricingStrategy } from "../src/strategy/probability-repricing-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition, TradeOpportunity } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

function baseConfig() {
  return testConfig({
    strategyId: "probability-repricing",
    enableExpensiveHedge: false,
    arbAskLockOnly: true,
    repricingOrderUsdc: 15,
    repricingPEntryMax: 0.25,
    repricingSpreadMax: 0.04,
    repricingEdgeMin: 0.01,
    repricingDislocationMin: 0.5,
    repricingHistoryWindowMs: 10_000,
    repricingTauMinSec: 60,
    repricingLateWindowSec: 30,
    repricingTauForceExitSec: 20,
    repricingTargetAbs: 0.05,
    repricingStopAbs: 0.08,
    repricingHoldMaxSec: 120,
    repricingSpreadMaxExit: 0.06,
    repricingSignalTtlMs: 60_000,
    repricingModeAEnabled: false,
    maxSharesPerOrder: 40,
  });
}

function fillCheap(
  tracker: TradeTracker,
  event: ReturnType<typeof testEvent>,
  fillPrice = 0.15,
): string {
  const pairId = `${event.slug}:${event.windowEnd}`;
  const position: SimulatedPosition = {
    id: "repricing-filled",
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

function buyOpp(
  event: ReturnType<typeof testEvent>,
  pairId: string,
  price: number,
): TradeOpportunity {
  return {
    kind: "cheap",
    event,
    token: books(price, 0.8, 100)[0],
    price,
    size: 20,
    tickSize: "0.01",
    negRisk: false,
    tradeKey: `k-${price}`,
    pairId,
    orderType: "FOK",
  };
}

describe("probability-repricing strategy", () => {
  it("parses and registers probability-repricing", () => {
    assert.equal(parseStrategyId("probability-repricing"), "probability-repricing");
    const s = createStrategy("probability-repricing");
    assert.equal(s.id, "probability-repricing");
    assert.equal(s.usesDefendAsExit, true);
    assert.equal(s.leadsWithEdge, false);
  });

  it("coerces sticky arbAskLockOnly / hedge off in validateConfigCoherence", () => {
    const config = baseConfig();
    validateConfigCoherence(config);
    assert.equal(config.arbAskLockOnly, false);
    assert.equal(config.enableExpensiveHedge, false);
  });

  it("state machine: IDLE→ENTERING on dislocation, OPEN on commit", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    const W = event.windowStart;
    const pairId = `${event.slug}:${event.windowEnd}`;

    for (const [i, ask] of [0.2, 0.19, 0.18, 0.16, 0.14].entries()) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.8, 100),
        nowMs: (W + 100 + i) * 1000,
      });
    }
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.12, 0.85, 100),
      nowMs: (W + 110) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(opps[0].orderType, "FOK");
    assert.equal(opps[0].kind, "cheap");
    assert.ok(opps[0].price <= 0.13);

    const snapEntering = strategy.getPairSnapshot(pairId);
    assert.ok(snapEntering);
    assert.equal(snapEntering!.phase, "ENTERING");

    strategy.onBuyCommitted(opps[0]);
    const snapOpen = strategy.getPairSnapshot(pairId);
    assert.equal(snapOpen!.phase, "OPEN");
    assert.equal(snapOpen!.entryPrice, opps[0].price);
  });

  it("rejects entry when tau < tau_min", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    config.repricingTauMinSec = 200;
    const event = testEvent(1_800_000_000);
    const tracker = new TradeTracker();
    for (const [i, ask] of [0.2, 0.18, 0.15, 0.12, 0.1].entries()) {
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.85, 100),
        nowMs: (event.windowEnd - 50 + i) * 1000,
      });
      assert.equal(opps.length, 0, `tick ${i} should reject (late tau)`);
    }
  });

  it("rejects entry when spread too wide", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    config.repricingSpreadMax = 0.01;
    const event = testEvent();
    const tracker = new TradeTracker();
    const W = event.windowStart;
    const wide = (ask: number) => [
      {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: ask - 0.05,
        bestAsk: ask,
        bestAskSize: 100,
        bestBidSize: 100,
      },
      {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.7,
        bestAsk: 0.75,
        bestAskSize: 100,
        bestBidSize: 100,
      },
    ];
    for (const [i, ask] of [0.2, 0.18, 0.15, 0.12].entries()) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: wide(ask),
        nowMs: (W + 100 + i) * 1000,
      });
    }
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: wide(0.12),
      nowMs: (W + 120) * 1000,
    });
    assert.equal(opps.length, 0);
  });

  it("rejects a second entry while already filled (no double OPEN)", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    fillCheap(tracker, event, 0.15);
    const W = event.windowStart;
    for (const [i, ask] of [0.2, 0.15, 0.1].entries()) {
      const opps = strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.8, 100),
        nowMs: (W + 100 + i) * 1000,
      });
      assert.equal(opps.length, 0);
    }
  });

  it("exits on TP abs via executable bid", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.15);
    strategy.onBuyCommitted(buyOpp(event, pairId, 0.15));
    const nowMs = (event.windowStart + 120) * 1000;
    const defendCtx = {
      config,
      favoriteAsk: 0.7,
      filledCheap: 20,
      filledExpensive: 0,
      pairId,
      cheapAsk: 0.22,
      cheapBid: 0.21,
      tracker,
      nowMs,
    };
    assert.equal(strategy.shouldDefend(defendCtx), true);
    assert.equal(strategy.getPairSnapshot(pairId)?.exitReason, "tp_abs");
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "EXITING");
    assert.equal(strategy.defendShares(defendCtx), 20);
    strategy.onDefendCommitted(pairId);
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "FLAT");
  });

  it("exits on stop_abs and tau_force", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.2);
    strategy.onBuyCommitted(buyOpp(event, pairId, 0.2));

    assert.equal(
      strategy.shouldDefend({
        config,
        favoriteAsk: 0.7,
        filledCheap: 20,
        filledExpensive: 0,
        pairId,
        cheapAsk: 0.12,
        cheapBid: 0.11,
        tracker,
        nowMs: (event.windowStart + 50) * 1000,
      }),
      true,
    );
    assert.equal(strategy.getPairSnapshot(pairId)?.exitReason, "stop_abs");

    const strategy2 = new ProbabilityRepricingStrategy();
    const configTau = { ...config, repricingHoldMaxSec: 1e15 };
    const pairId2 = fillCheap(new TradeTracker(), event, 0.2);
    // Seed lastTickNowMs via find so entryTs is sim-clock, not wall clock.
    strategy2.findOpportunities({
      config: configTau,
      tracker: new TradeTracker(),
      event,
      books: books(0.2, 0.8, 100),
      nowMs: (event.windowStart + 10) * 1000,
    });
    strategy2.onBuyCommitted(buyOpp(event, pairId2, 0.2));
    assert.equal(
      strategy2.shouldDefend({
        config: configTau,
        favoriteAsk: 0.7,
        filledCheap: 20,
        filledExpensive: 0,
        pairId: pairId2,
        cheapAsk: 0.2,
        cheapBid: 0.19,
        tracker,
        nowMs: (event.windowEnd - 10) * 1000,
      }),
      true,
    );
    assert.equal(strategy2.getPairSnapshot(pairId2)?.exitReason, "tau_force");
  });

  it("marks forced_settlement when tau<=0 with inventory", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.15);
    strategy.onBuyCommitted(buyOpp(event, pairId, 0.15));
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.15, 0.8, 100),
      nowMs: (event.windowEnd + 1) * 1000,
    });
    const snap = strategy.getPairSnapshot(pairId)!;
    assert.equal(snap.forcedSettlement, true);
    assert.equal(snap.exitReason, "forced_settlement");
    assert.equal(snap.phase, "FLAT");
  });

  it("edge_est is targetAbs minus fees/slips (no spread drag)", () => {
    const config = baseConfig();
    config.repricingTargetAbs = 0.06;
    config.repricingFeesRoundtrip = 0.002;
    config.repricingSlipEntryBuffer = 0.005;
    config.repricingSlipExitBuffer = 0.005;
    const edge = ProbabilityRepricingStrategy.computeEdgeEst(config);
    // 0.06 - 0.002 - 0.005 - 0.005 = 0.048
    assert.ok(Math.abs(edge - 0.048) < 1e-9, `edge=${edge}`);
  });

  it("dislocation z-score is positive when ask dumps vs history", () => {
    const z = ProbabilityRepricingStrategy.computeDislocationZ(
      [0.2, 0.2, 0.2, 0.2, 0.2],
      0.1,
    );
    assert.ok(z > 1, `z=${z}`);
  });

  it("scores dislocation against prior history only (no self-inclusion)", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    config.repricingDislocationMin = 100; // absurd — only flat-history dump can pass
    const event = testEvent();
    const tracker = new TradeTracker();
    const W = event.windowStart;
    // Flat history at 0.20
    for (let i = 0; i < 5; i++) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(0.2, 0.8, 100),
        nowMs: (W + 50 + i) * 1000,
      });
    }
    // With self-inclusion, dumping to 0.10 would dilute z; without it z is huge.
    config.repricingDislocationMin = 0.5;
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.1, 0.85, 100),
      nowMs: (W + 60) * 1000,
    });
    assert.equal(opps.length, 1, "dump vs prior flat history must fire");
  });

  it("signal TTL expires ARMED and blocks re-arm until signal clears", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    config.repricingSignalTtlMs = 2_000;
    const event = testEvent();
    const tracker = new TradeTracker();
    const W = event.windowStart;
    const shallow = (ask: number) => [
      {
        tokenId: "t-up",
        outcome: "Up",
        outcomeIndex: 0,
        bestBid: ask - 0.01,
        bestAsk: ask,
        bestAskSize: 1, // too small for FOK size
        bestBidSize: 100,
      },
      {
        tokenId: "t-down",
        outcome: "Down",
        outcomeIndex: 1,
        bestBid: 0.7,
        bestAsk: 0.75,
        bestAskSize: 100,
        bestBidSize: 100,
      },
    ];
    // Build history with tight timestamps so TTL does not fire during warmup.
    const t0 = (W + 100) * 1000;
    for (const [i, ask] of [0.2, 0.18, 0.16, 0.14, 0.12].entries()) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: shallow(ask),
        nowMs: t0 + i * 100,
      });
    }
    // Signal valid but depth insufficient → ARMED (still within TTL).
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: shallow(0.11),
      nowMs: t0 + 600,
    });
    const pairId = `${event.slug}:${event.windowEnd}`;
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "ARMED");

    // Same continuous signal past TTL → IDLE; gate blocks same-tick re-arm.
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: shallow(0.11),
      nowMs: t0 + 600 + 2_500,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "IDLE");

    // Still continuous signal → stay IDLE (gate not cleared).
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: shallow(0.11),
      nowMs: t0 + 600 + 3_000,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "IDLE");

    // Signal absent → clears gate.
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: shallow(0.5),
      nowMs: t0 + 600 + 3_500,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "IDLE");

    // Signal returns → may ARMED again.
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: shallow(0.11),
      nowMs: t0 + 600 + 4_000,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "ARMED");
  });

  it("resets ENTERING→IDLE when signal disappears after failed FOK", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    const W = event.windowStart;
    const pairId = `${event.slug}:${event.windowEnd}`;

    for (const [i, ask] of [0.2, 0.18, 0.16, 0.14, 0.12].entries()) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.8, 100),
        nowMs: (W + 100 + i) * 1000,
      });
    }
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.11, 0.85, 100),
      nowMs: (W + 110) * 1000,
    });
    assert.equal(opps.length, 1);
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "ENTERING");

    // FOK failed (no fill); next tick signal gone → must leave ENTERING.
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.5, 0.5, 100),
      nowMs: (W + 111) * 1000,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "IDLE");
  });

  it("resurrects OPEN after partial defend marked FLAT with residual inventory", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = fillCheap(tracker, event, 0.15);
    strategy.onBuyCommitted(buyOpp(event, pairId, 0.15));
    strategy.onDefendCommitted(pairId); // optimistic FLAT
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "FLAT");

    // Residual inventory still open → next tick must resurrect OPEN for exits.
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.15, 0.8, 100),
      nowMs: (event.windowStart + 200) * 1000,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "OPEN");
    assert.equal(
      strategy.shouldDefend({
        config,
        favoriteAsk: 0.7,
        filledCheap: 20,
        filledExpensive: 0,
        pairId,
        cheapAsk: 0.22,
        cheapBid: 0.21,
        tracker,
        nowMs: (event.windowStart + 200) * 1000,
      }),
      true,
    );
  });

  it("hold_time uses lastTickNowMs (sim clock), not armedTs", () => {
    const strategy = new ProbabilityRepricingStrategy();
    const config = baseConfig();
    config.repricingHoldMaxSec = 30;
    config.repricingSignalTtlMs = 60_000;
    const event = testEvent();
    const tracker = new TradeTracker();
    const W = event.windowStart;
    const pairId = `${event.slug}:${event.windowEnd}`;

    for (const [i, ask] of [0.2, 0.18, 0.16, 0.14, 0.12].entries()) {
      strategy.findOpportunities({
        config,
        tracker,
        event,
        books: books(ask, 0.8, 1), // shallow → stays ARMED
        nowMs: (W + 100 + i) * 1000,
      });
    }
    // First arm at ~W+105
    strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.11, 0.85, 1),
      nowMs: (W + 105) * 1000,
    });
    assert.equal(strategy.getPairSnapshot(pairId)?.phase, "ARMED");

    // Fill 20s later with depth restored
    const fillNow = (W + 125) * 1000;
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.11, 0.85, 100),
      nowMs: fillNow,
    });
    assert.equal(opps.length, 1);
    strategy.onBuyCommitted(opps[0]);

    // 10s after fill — hold < 30 → no time_stop
    assert.equal(
      strategy.shouldDefend({
        config,
        favoriteAsk: 0.7,
        filledCheap: 20,
        filledExpensive: 0,
        pairId,
        cheapAsk: 0.12,
        cheapBid: 0.11,
        tracker,
        nowMs: fillNow + 10_000,
      }),
      false,
    );
    // 31s after fill → time_stop (would fire early if entryTs were armedTs)
    assert.equal(
      strategy.shouldDefend({
        config,
        favoriteAsk: 0.7,
        filledCheap: 20,
        filledExpensive: 0,
        pairId,
        cheapAsk: 0.12,
        cheapBid: 0.11,
        tracker,
        nowMs: fillNow + 31_000,
      }),
      true,
    );
    assert.equal(strategy.getPairSnapshot(pairId)?.exitReason, "time_stop");
  });
});
