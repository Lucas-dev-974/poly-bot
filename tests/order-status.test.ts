import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmedFillSize,
  confirmedSoldSize,
  normalizeOrderStatus,
  parseOrderStatus,
  sharesFromConditionalBalance,
} from "../src/utils/order-status.js";
import {
  isAskInExpensiveBand,
  isPairCovered,
  shouldDefendUncoveredPair,
} from "../src/strategy.js";

describe("normalizeOrderStatus", () => {
  it("maps official ORDER_STATUS_* enums", () => {
    assert.equal(normalizeOrderStatus("ORDER_STATUS_LIVE"), "live");
    assert.equal(normalizeOrderStatus("ORDER_STATUS_MATCHED"), "matched");
    assert.equal(normalizeOrderStatus("ORDER_STATUS_CANCELED"), "cancelled");
    assert.equal(normalizeOrderStatus("ORDER_STATUS_CANCELED_MARKET_RESOLVED"), "cancelled");
    assert.equal(normalizeOrderStatus("ORDER_STATUS_INVALID"), "invalid");
  });

  it("maps short client statuses", () => {
    assert.equal(normalizeOrderStatus("live"), "live");
    assert.equal(normalizeOrderStatus("matched"), "matched");
    assert.equal(normalizeOrderStatus("canceled"), "cancelled");
    assert.equal(normalizeOrderStatus("cancelled"), "cancelled");
  });
});

describe("parseOrderStatus", () => {
  it("does not treat a LIVE order as filled even if size_matched equals original_size", () => {
    const parsed = parseOrderStatus({
      status: "live",
      size_matched: "5",
      original_size: "5",
    });
    assert.equal(parsed.filled, false);
    assert.equal(parsed.cancelled, false);
    assert.equal(parsed.sizeMatched, 5);
  });

  it("treats MATCHED + size_matched > 0 as filled", () => {
    const parsed = parseOrderStatus({
      status: "ORDER_STATUS_MATCHED",
      size_matched: "5",
      original_size: "5",
    });
    assert.equal(parsed.filled, true);
    assert.equal(parsed.sizeMatched, 5);
  });

  it("treats ORDER_STATUS_CANCELED as cancelled, not filled", () => {
    const parsed = parseOrderStatus({
      status: "ORDER_STATUS_CANCELED",
      size_matched: "5",
      original_size: "5",
    });
    assert.equal(parsed.cancelled, true);
    assert.equal(parsed.filled, false);
  });

  it("treats missing size_matched as zero", () => {
    const parsed = parseOrderStatus({ status: "matched" });
    assert.equal(parsed.filled, false);
    assert.equal(parsed.sizeMatched, 0);
  });
});

describe("confirmedFillSize", () => {
  it("fail-closes when the balance check did not run", () => {
    assert.equal(confirmedFillSize(5, null), 0);
  });

  it("returns 0 when the wallet holds nothing", () => {
    assert.equal(confirmedFillSize(5, 0), 0);
  });

  it("books the shares actually held (fee dust)", () => {
    assert.equal(confirmedFillSize(5, 4.95), 4.95);
    assert.equal(confirmedFillSize(5, 5), 5);
  });
});

describe("sharesFromConditionalBalance", () => {
  it("converts 6-decimal raw units", () => {
    assert.equal(sharesFromConditionalBalance(5_000_000), 5);
  });

  it("passes through already-converted share counts", () => {
    assert.equal(sharesFromConditionalBalance(5), 5);
  });
});

describe("confirmedSoldSize", () => {
  it("trusts the wallet drop when CLOB reports a kill", () => {
    const result = confirmedSoldSize(5, 0, 5, 0);
    assert.equal(result.soldSize, 5);
    assert.equal(result.balanceUnknown, false);
  });

  it("does not invent a sell when tokens are still held", () => {
    const result = confirmedSoldSize(5, 5, 5, 5);
    assert.equal(result.soldSize, 0);
    assert.equal(result.balanceUnknown, false);
  });

  it("records a partial drop", () => {
    const result = confirmedSoldSize(5, 0, 5, 2);
    assert.equal(result.soldSize, 3);
  });

  it("trusts CLOB size when both balances are unknown", () => {
    const filled = confirmedSoldSize(5, 5, null, null);
    assert.equal(filled.soldSize, 5);
    assert.equal(filled.balanceUnknown, false);
    const unknown = confirmedSoldSize(5, 0, null, null);
    assert.equal(unknown.soldSize, 0);
    assert.equal(unknown.balanceUnknown, true);
  });

  it("treats a zero after-balance as a full sell", () => {
    const result = confirmedSoldSize(5, 0, null, 0);
    assert.equal(result.soldSize, 5);
  });
});

describe("isAskInExpensiveBand", () => {
  it("rejects asks below min and above max", () => {
    assert.equal(isAskInExpensiveBand(0.72, 0.76, 0.85), false);
    assert.equal(isAskInExpensiveBand(0.9, 0.76, 0.85), false);
    assert.equal(isAskInExpensiveBand(null, 0.76, 0.85), false);
  });

  it("accepts asks inside the band", () => {
    assert.equal(isAskInExpensiveBand(0.76, 0.76, 0.85), true);
    assert.equal(isAskInExpensiveBand(0.81, 0.76, 0.85), true);
    assert.equal(isAskInExpensiveBand(0.85, 0.76, 0.85), true);
  });
});

describe("shouldDefendUncoveredPair", () => {
  it("defends only when the favorite ask is above the hedge max", () => {
    assert.equal(shouldDefendUncoveredPair(0.86, 0.85), true);
    assert.equal(shouldDefendUncoveredPair(0.85, 0.85), false);
    assert.equal(shouldDefendUncoveredPair(0.81, 0.85), false);
  });

  it("does not defend on a missing book or a collapsed favorite", () => {
    assert.equal(shouldDefendUncoveredPair(null, 0.85), false);
    assert.equal(shouldDefendUncoveredPair(0.72, 0.85), false);
  });
});

describe("isPairCovered", () => {
  it("is covered when expensive size matches or exceeds cheap", () => {
    assert.equal(isPairCovered(5.27, 5.27), true);
    assert.equal(isPairCovered(5, 5.01), true);
  });

  it("is not covered when the hedge is missing or short", () => {
    assert.equal(isPairCovered(5, 0), false);
    assert.equal(isPairCovered(5.27, 5), false);
    assert.equal(isPairCovered(0, 5), false);
  });
});
