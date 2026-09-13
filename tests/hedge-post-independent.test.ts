import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  shouldCancelOrphanIndependentHedges,
  shouldPostIndependentHedge,
} from "../src/strategy/hedge-post.js";

describe("shouldPostIndependentHedge", () => {
  it("accepts a grid level at or below a fresh ask inside the band", () => {
    assert.deepEqual(
      shouldPostIndependentHedge(0.93, 0.9, 0.87, 0.95),
      { ok: true },
    );
  });

  it("rejects null ask", () => {
    assert.equal(
      shouldPostIndependentHedge(null, 0.9, 0.87, 0.95).ok,
      false,
    );
  });

  it("rejects ask above expensiveBuyMax", () => {
    const r = shouldPostIndependentHedge(0.97, 0.9, 0.87, 0.95);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "outside-band-above");
  });

  it("rejects ask below expensiveBuyMin", () => {
    const r = shouldPostIndependentHedge(0.8, 0.9, 0.87, 0.95);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "outside-band");
  });

  it("rejects limit above the live ask", () => {
    const r = shouldPostIndependentHedge(0.9, 0.92, 0.87, 0.95);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "limit-above-ask");
  });

  it("tolerates float noise via round2", () => {
    assert.deepEqual(
      shouldPostIndependentHedge(0.9000000002, 0.9, 0.87, 0.95),
      { ok: true },
    );
  });
});

describe("shouldCancelOrphanIndependentHedges", () => {
  it("cancels when fill required, nothing filled, no cheap resting", () => {
    assert.equal(
      shouldCancelOrphanIndependentHedges({
        filledCheap: 0,
        restingCheapCount: 0,
        requireCheapFillBeforeExpensive: true,
      }),
      true,
    );
  });

  it("keeps hedges while another cheap GTC is still resting", () => {
    assert.equal(
      shouldCancelOrphanIndependentHedges({
        filledCheap: 0,
        restingCheapCount: 1,
        requireCheapFillBeforeExpensive: true,
      }),
      false,
    );
  });

  it("keeps hedges after a cheap fill", () => {
    assert.equal(
      shouldCancelOrphanIndependentHedges({
        filledCheap: 5,
        restingCheapCount: 0,
        requireCheapFillBeforeExpensive: true,
      }),
      false,
    );
  });

  it("never orphan-cancels when requireCheapFillBeforeExpensive is false", () => {
    assert.equal(
      shouldCancelOrphanIndependentHedges({
        filledCheap: 0,
        restingCheapCount: 0,
        requireCheapFillBeforeExpensive: false,
      }),
      false,
    );
  });
});
