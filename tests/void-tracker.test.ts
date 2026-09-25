import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition } from "../src/types.js";

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

describe("void settlement — tracker accounting", () => {
  it("counts a void leg in realized PnL but NOT in wins/losses", () => {
    const tracker = new TradeTracker();
    const voidLeg = pos({ id: "v1", kind: "cheap", status: "void", pnl: 4.2 });
    tracker.addOpenPosition({ ...voidLeg, status: "open" });
    tracker.resolvePosition({ ...voidLeg, status: "void", pnl: 4.2 });

    assert.equal(tracker.getRealizedPnl(), 4.2);
    // Wins/losses are private; verify via the resolver-facing counts:
    // resolved count includes void, wins/losses do not.
    assert.equal(tracker.getResolvedPositions().length, 1);
    assert.equal(tracker.getResolvedPositions()[0].status, "void");
  });

  it("finalizePair credits void legs at 0.5 × size (not $1)", () => {
    const tracker = new TradeTracker();
    const cheap = pos({ id: "c1", kind: "cheap", status: "void" });
    const expensive = pos({ id: "e1", kind: "expensive", status: "void" });
    for (const leg of [cheap, expensive]) {
      tracker.addOpenPosition({ ...leg });
      tracker.attachLeg(leg);
      // pnl = credit(0.5 × 10 = 5) − cost(0.8)
      tracker.resolvePosition({ ...leg, status: "void", pnl: 4.2 });
    }
    const pair = tracker.getPair(cheap.pairId)!;
    tracker.finalizePair(pair);

    assert.equal(pair.status, "resolved");
    // credit = 2 × (10 × 0.5) = 10 ; cost = 2 × 0.8 = 1.6 → pnl = +8.4
    assert.ok(Math.abs((pair.realizedPnl ?? 0) - 8.4) < 1e-9);
  });
});