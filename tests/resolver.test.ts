import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractWinner } from "../src/position-resolver.js";

describe("extractWinner", () => {
  it("parses JSON string outcomes/prices", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["1","0"]',
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), true);
    assert.equal(extractWinner(result, { outcome: "Down" }), false);
  });

  it("returns null for mid-window prices", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.92","0.08"]',
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), null);
  });

  it("accepts near-settlement 0.9995 / 0.0005", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.9995","0.0005"]',
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), true);
    assert.equal(extractWinner(result, { outcome: "Down" }), false);
  });

  it("parses already-decoded arrays", () => {
    const result = {
      outcomes: ["Up", "Down"],
      outcomePrices: ["0", "1"],
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), false);
    assert.equal(extractWinner(result, { outcome: "Down" }), true);
  });

  it("matches outcome names case-insensitively", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["1","0"]',
    };
    assert.equal(extractWinner(result, { outcome: "up" }), true);
  });

  it("falls back to outcomeIndex when the name is missing", () => {
    const result = {
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]',
    };
    assert.equal(extractWinner(result, { outcome: "Up", outcomeIndex: 0 }), true);
    assert.equal(extractWinner(result, { outcome: "Down", outcomeIndex: 1 }), false);
  });

  it("uses umaResolutionStatus=resolved when prices have not snapped", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.72","0.28"]',
      umaResolutionStatus: "resolved",
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), true);
    assert.equal(extractWinner(result, { outcome: "Down" }), false);
  });

  it("does not resolve mid-window prices just because closed=true", () => {
    const result = {
      outcomes: '["Up","Down"]',
      outcomePrices: '["0.72","0.28"]',
      closed: true,
    };
    assert.equal(extractWinner(result, { outcome: "Up" }), null);
  });
});
