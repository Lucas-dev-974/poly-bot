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

  it("allows sub-$1 notional when shares meet MIN_CLOB_SHARES (resting GTC)", () => {
    // 5 × 0.16 = $0.80 — valid for resting inverse hedge
    assert.equal(computeSize(1, 0.16, 5), 5);
  });

  it("returns null below 5 shares", () => {
    assert.equal(computeSize(0.3, 0.1, 20), null);
  });

  it("caps at maxShares", () => {
    assert.equal(computeSize(10, 0.07, 20), 20);
  });
});

describe("validateEngineBudget", () => {
  it("throws when the budget cannot reach MIN_CLOB_SHARES at band max (incident fav-band 1 USDC)", () => {
    assert.throws(
      () => validateEngineBudget(1, 0.85, "fav-band"),
      /fav-band.*MIN_CLOB_SHARES/
    );
  });

  it("accepts a budget that reaches MIN_CLOB_SHARES at band max", () => {
    assert.doesNotThrow(() => validateEngineBudget(15, 0.85, "fav-band"));
  });

  it("accepts the legacy 1 USDC arb cheap band (0.07-0.13)", () => {
    assert.doesNotThrow(() => validateEngineBudget(1, 0.13, "arb cheap"));
  });

  it("accepts fav-band inverse at 0.16 with maxShares=5 (sub-$1 notional OK)", () => {
    assert.doesNotThrow(() => validateEngineBudget(1, 0.16, "fav-band inverse", 5));
  });

  it("rejects when maxShares alone cannot reach MIN_CLOB_SHARES", () => {
    assert.throws(
      () => validateEngineBudget(10, 0.16, "fav-band inverse", 4),
      /maxShares=4/
    );
  });
});
