import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPECTED_TICKS,
  MIN_TICKS,
  completenessFromSearchParams,
  evaluateCompleteness,
  parseCompletenessCriteria,
  windowBoundsFromSlug,
} from "../src/backtest/completeness.js";
import { windowMatchesPrefix } from "../src/backtest/windows.js";

describe("backtest completeness", () => {
  const start = 1_800_000_000;
  const end = start + 900;

  it("900 ticks at 1 Hz covering the window is complete", () => {
    const ticks = Array.from({ length: 900 }, (_, i) => start * 1000 + i * 1000);
    const stats = evaluateCompleteness(start, end, ticks);
    assert.equal(stats.tickCount, 900);
    assert.equal(stats.complete, true);
    assert.ok(stats.maxGapMs <= 1000);
  });

  it("a 3s internal gap is incomplete", () => {
    const ticks = Array.from({ length: 900 }, (_, i) => start * 1000 + i * 1000);
    ticks[400] = ticks[399] + 3000;
    for (let i = 401; i < ticks.length; i++) ticks[i] = ticks[i - 1] + 1000;
    const stats = evaluateCompleteness(start, end, ticks);
    assert.equal(stats.complete, false);
    assert.ok(stats.maxGapMs >= 3000);
    assert.ok(stats.gapCount >= 1);
  });

  it("disabling the max-gap rule accepts a 3s hole", () => {
    const ticks = Array.from({ length: 900 }, (_, i) => start * 1000 + i * 1000);
    ticks[400] = ticks[399] + 3000;
    for (let i = 401; i < ticks.length; i++) ticks[i] = ticks[i - 1] + 1000;
    const stats = evaluateCompleteness(start, end, ticks, {
      minTicks: MIN_TICKS,
      maxGapMs: null,
      maxEdgeGapMs: 2000,
    });
    assert.equal(stats.complete, true);
    assert.ok(stats.maxGapMs >= 3000);
  });

  it("custom minTicks=10 accepts a short series when gap and edge are off", () => {
    const ticks = Array.from({ length: 10 }, (_, i) => start * 1000 + i * 1000);
    const off = { minTicks: 10, maxGapMs: null, maxEdgeGapMs: null };
    assert.equal(evaluateCompleteness(start, end, ticks, off).complete, true);
    assert.equal(
      evaluateCompleteness(start, end, ticks, { ...off, minTicks: 11 }).complete,
      false,
    );
  });

  it("edge rule can be disabled independently", () => {
    const ticks = [start * 1000 + 10_000, end * 1000 - 10_000];
    const base = { minTicks: null, maxGapMs: null, maxEdgeGapMs: 2000 };
    assert.equal(evaluateCompleteness(start, end, ticks, base).complete, false);
    assert.equal(
      evaluateCompleteness(start, end, ticks, { ...base, maxEdgeGapMs: 15_000 }).complete,
      true,
    );
    assert.equal(
      evaluateCompleteness(start, end, ticks, { ...base, maxEdgeGapMs: null }).complete,
      true,
    );
  });

  it("ticks outside the window are ignored", () => {
    const ticks = [
      (start - 10) * 1000,
      ...Array.from({ length: 10 }, (_, i) => start * 1000 + i * 1000),
      (end + 10) * 1000,
    ];
    const stats = evaluateCompleteness(start, end, ticks);
    assert.equal(stats.tickCount, 10);
    assert.equal(stats.complete, false);
  });

  it("a tick exactly at windowEnd is included", () => {
    const stats = evaluateCompleteness(start, end, [end * 1000]);
    assert.equal(stats.tickCount, 1);
    assert.equal(stats.lastTs, end * 1000);
  });

  it("parses 15m slug bounds", () => {
    const bounds = windowBoundsFromSlug(`btc-updown-15m-${start}`);
    assert.deepEqual(bounds, { windowStart: start, windowEnd: end });
  });

  it("MIN_TICKS is 95% of expected", () => {
    assert.equal(EXPECTED_TICKS, 900);
    assert.equal(MIN_TICKS, 855);
  });

  it("parseCompletenessCriteria defaults and disables rules", () => {
    assert.deepEqual(parseCompletenessCriteria({}), {
      minTicks: 855,
      maxGapMs: 2000,
      maxEdgeGapMs: 2000,
    });
    assert.deepEqual(parseCompletenessCriteria({ requireMinTicks: false, minTicks: 800 }), {
      minTicks: null,
      maxGapMs: 2000,
      maxEdgeGapMs: 2000,
    });
    assert.equal(parseCompletenessCriteria({ minTicks: 800 }).minTicks, 800);
  });

  it("completenessFromSearchParams reads 0/1 flags", () => {
    const params = new URLSearchParams("requireMaxGap=0&maxGapMs=4000&minTicks=800");
    const criteria = completenessFromSearchParams(params);
    assert.equal(criteria.minTicks, 800);
    assert.equal(criteria.maxGapMs, null);
    assert.equal(criteria.maxEdgeGapMs, 2000);
  });

  it("matches a slug prefix by start or first asset segment", () => {
    const slug = `btc-updown-15m-${start}`;
    assert.equal(windowMatchesPrefix(slug, "btc"), true);
    assert.equal(windowMatchesPrefix(slug, "btc-updown-15m"), true);
    assert.equal(windowMatchesPrefix(slug, "eth"), false);
  });
});
