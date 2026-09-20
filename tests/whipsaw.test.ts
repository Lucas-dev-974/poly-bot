import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWhipsawScore,
  favBandLossStreak,
  priorWinnerFlipRate,
} from "../src/strategy/whipsaw.js";
import type { SimulatedPosition } from "../src/types.js";

describe("whipsaw helpers", () => {
  it("scores flips and ask range", () => {
    const s = computeWhipsawScore({
      intraFlips: 2,
      askRange: 0.15,
      priorWinnerFlipRate: 0.6,
      lossStreak: 3,
    });
    // 22 + 15 + 12 + 12 = 61
    assert.equal(s, 61);
  });

  it("computes loss streak newest-first", () => {
    const resolved = [
      { strategyId: "fav-band", status: "won", pnl: 1, resolvedAt: 300 },
      { strategyId: "fav-band", status: "lost", pnl: -3, resolvedAt: 200 },
      { strategyId: "fav-band", status: "lost", pnl: -3, resolvedAt: 100 },
    ] as SimulatedPosition[];
    // sorted newest first: won then lost — streak 0
    assert.equal(favBandLossStreak(resolved), 0);
    const losing = [
      { strategyId: "fav-band", status: "lost", pnl: -3, resolvedAt: 300 },
      { strategyId: "fav-band", status: "lost", pnl: -3, resolvedAt: 200 },
      { strategyId: "fav-band", status: "won", pnl: 1, resolvedAt: 100 },
    ] as SimulatedPosition[];
    assert.equal(favBandLossStreak(losing), 2);
  });

  it("prior winner flip rate", () => {
    assert.equal(priorWinnerFlipRate([0, 1, 0, 1]), 1);
    assert.equal(priorWinnerFlipRate([0, 0, 0]), 0);
  });
});