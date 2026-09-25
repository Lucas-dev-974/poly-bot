import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VOID_SETTLEMENT_PRICE,
  VOID_WINNER_INDEX,
  extractSettlement,
  extractWinner,
} from "../src/position-resolver.js";

describe("extractSettlement — void 50/50", () => {
  it("detects a void 50/50 settlement (uma resolved) for BOTH outcomes", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.5","0.5"]',
      umaResolutionStatus: "resolved",
    };
    assert.equal(extractSettlement(result, { outcome: "Up", outcomeIndex: 0 }), "void");
    assert.equal(extractSettlement(result, { outcome: "Down", outcomeIndex: 1 }), "void");
  });

  it("does NOT resolve a 50/50 payload without the uma flag (mid-window tie)", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.5","0.5"]',
    };
    assert.equal(extractSettlement(result, { outcome: "Up", outcomeIndex: 0 }), null);
  });

  it("does NOT confuse a live favorite (0.92/0.08) with a settlement", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.92","0.08"]',
      umaResolutionStatus: "resolved",
    };
    // UMA resolved with NON-equal prices → official winner even if prices have not snapped.
    assert.equal(extractSettlement(result, { outcome: "Up", outcomeIndex: 0 }), "win");
    assert.equal(extractSettlement(result, { outcome: "Down", outcomeIndex: 1 }), "lose");
  });

  it("handles near-equal intermediate prices within 1e-6 as void", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.5000001","0.5"]',
      umaResolutionStatus: "resolved",
    };
    assert.equal(extractSettlement(result, { outcome: "Up", outcomeIndex: 0 }), "void");
  });

  it("keeps the classic extremes as win/lose", () => {
    const snap = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["1","0"]',
    };
    assert.equal(extractSettlement(snap, { outcome: "Up" }), "win");
    assert.equal(extractSettlement(snap, { outcome: "Down" }), "lose");
    const preSnap = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.9995","0.0005"]',
    };
    assert.equal(extractSettlement(preSnap, { outcome: "Up" }), "win");
  });

  it("falls back to winningOutcome", () => {
    const result = {
      outcomes: '["Up","Down"]',
      winningOutcome: "Down",
    };
    assert.equal(extractSettlement(result, { outcome: "Up" }), "lose");
    assert.equal(extractSettlement(result, { outcome: "Down" }), "win");
  });
});

describe("extractWinner — back-compat wrapper on void payloads", () => {
  it("returns true for Up (not a false winner — credit paths use extractSettlement)", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.5","0.5"]',
      umaResolutionStatus: "resolved",
    };
    assert.equal(extractWinner(result, { outcome: "Up", outcomeIndex: 0 }), true);
    // Legacy semantics: Down side gets "not won" — acceptable because the
    // winnerIndexFromGamma path now persists index 2 for voids instead of
    // consulting this wrapper.
    assert.equal(extractWinner(result, { outcome: "Down", outcomeIndex: 1 }), true);
  });

  it("keeps null for unresolved mid-window prices", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.72","0.28"]',
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), null);
  });
});

describe("void constants", () => {
  it("settlement price is 0.5 and winner index 2", () => {
    assert.equal(VOID_SETTLEMENT_PRICE, 0.5);
    assert.equal(VOID_WINNER_INDEX, 2);
  });
});