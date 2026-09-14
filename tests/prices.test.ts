import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSize,
  priceLevels,
  validateEngineBudget,
} from "../src/utils/prices.js";

describe("priceLevels", () => {
  it("includes both ends at 0.01 step", () => {
    assert.deepEqual(priceLevels(0.07, 0.1), [0.07, 0.08, 0.09, 0.1]);
  });
});

describe("computeSize", () => {
  it("returns shares for a 1 USDC cheap order", () => {
    assert.equal(computeSize(1, 0.08, 20), 12.5);
  });

  it("bumps size one tick when floor undershoots the $1 notional", () => {
    assert.equal(computeSize(1, 0.19, 30), 5.27);
  });

  it("returns null below 5 shares", () => {
    assert.equal(computeSize(0.3, 0.1, 20), null);
  });

  it("returns null below $1 notional", () => {
    assert.equal(computeSize(0.8, 0.07, 20), null);
  });

  it("caps at maxShares", () => {
    assert.equal(computeSize(10, 0.07, 20), 20);
  });
});

describe("validateEngineBudget", () => {
  it("throws when the budget cannot reach MIN_CLOB_SHARES at band max (incident fav-band 1 USDC)", () => {
    assert.throws(
      () => validateEngineBudget(1, 0.85, "fav-band"),
      /fav-band.*needs >= 4.25 USDC/,
    );
  });

  it("accepts a budget that reaches MIN_CLOB_SHARES at band max", () => {
    assert.doesNotThrow(() => validateEngineBudget(15, 0.85, "fav-band"));
  });

  it("accepts the legacy 1 USDC arb cheap band (0.07-0.13)", () => {
    assert.doesNotThrow(() => validateEngineBudget(1, 0.13, "arb cheap"));
  });

  it("rejects exactly-at-minimum budgets (floor, no slack)", () => {
    // 5 shares * 0.85 = 4.25 exact -> floor((4.25/0.85)*100)/100 = 5.0 ok
    assert.doesNotThrow(() => validateEngineBudget(4.25, 0.85, "fav-band"));
    // 4.24 -> 4.987 shares -> reject
    assert.throws(() => validateEngineBudget(4.24, 0.85, "fav-band"));
  });
});
