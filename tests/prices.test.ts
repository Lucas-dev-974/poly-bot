import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSize, priceLevels } from "../src/utils/prices.js";

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
