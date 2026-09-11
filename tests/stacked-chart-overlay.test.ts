import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diamondPoints,
  isOverlayPosition,
  marketRealizedPnl,
  matchWalletTradesToWindows,
  metricScaleMax,
  overlayMarksForWindow,
  seriesPath,
  toChartTimeSec,
  markerRadiiWorld,
} from "../frontend/src/utils/stacked-chart.ts";

describe("stacked chart position overlay", () => {
  it("converts millisecond fill timestamps to chart seconds", () => {
    assert.equal(toChartTimeSec(1_800_000_000_000), 1_800_000_000);
    assert.equal(toChartTimeSec(1_800_000_000), 1_800_000_000);
    assert.equal(toChartTimeSec(0), 0);
  });

  it("accepts sold-clone rows and skips empty timestamps", () => {
    assert.equal(
      isOverlayPosition({ id: "run:key:sold-1800000000000", ts: 1_800_000_000_000, fillPrice: 0.42 }),
      true,
    );
    assert.equal(isOverlayPosition({ id: "run:key:1800000000000", ts: 0, fillPrice: 0.42 }), false);
    assert.equal(
      isOverlayPosition({ id: "run:key:1800000000000", ts: 1_800_000_000_000, fillPrice: 0.42 }),
      true,
    );
  });

  it("keeps fills that fall inside the window, including sold rows", () => {
    const start = 1_800_000_000;
    const end = start + 900;
    const rows = [
      { id: "in", ts: (start + 10) * 1000, fillPrice: 0.4 },
      { id: "out", ts: (end + 10) * 1000, fillPrice: 0.4 },
      { id: "run:key:sold-1", ts: (start + 20) * 1000, fillPrice: 0.4 },
    ];
    const marks = overlayMarksForWindow(rows, start, end);
    assert.deepEqual(marks.map((row) => row.id), ["in", "run:key:sold-1"]);
  });

  it("builds a diamond around the wallet fill", () => {
    assert.equal(diamondPoints(10, 20, 4), "10,16 14,20 10,24 6,20");
  });

  it("sizes overlay dots so they stay circular on a stretched SVG", () => {
    const { rx, ry } = markerRadiiWorld(1200, 480, 800, 480, 8);
    assert.equal(rx, 12);
    assert.equal(ry, 8);
  });

  it("matches wallet trades to windows by slug or conditionId", () => {
    const windows = [
      { eventSlug: "btc-updown-15m-1000", conditionId: "0xabc" },
      { eventSlug: "eth-updown-15m-1000", conditionId: "0xdef" },
    ];
    const trades = [
      {
        timestamp: 1001,
        price: 0.4,
        size: 10,
        side: "BUY" as const,
        outcome: "Up",
        outcomeIndex: 0,
        conditionId: "",
        slug: "",
        eventSlug: "btc-updown-15m-1000",
      },
      {
        timestamp: 1002,
        price: 0.6,
        size: 5,
        side: "SELL" as const,
        outcome: "Down",
        outcomeIndex: 1,
        conditionId: "0xDEF",
        slug: "eth-updown-15m-1000",
        eventSlug: "other",
      },
      {
        timestamp: 1003,
        price: 0.5,
        size: 1,
        side: "BUY" as const,
        outcome: "Up",
        outcomeIndex: 0,
        conditionId: "0xzzz",
        slug: "sol-updown-15m-1000",
        eventSlug: "sol-updown-15m-1000",
      },
    ];
    const marks = matchWalletTradesToWindows(trades, windows);
    assert.deepEqual(
      marks.map((row) => row.eventSlug),
      ["btc-updown-15m-1000", "eth-updown-15m-1000"],
    );
    assert.equal(marks[1]?.fillPrice, 0.6);
  });

  it("sums realized market PnL and ignores open legs", () => {
    assert.equal(marketRealizedPnl([]), null);
    assert.equal(marketRealizedPnl([{ pnl: null }, { pnl: null }]), null);
    assert.equal(
      marketRealizedPnl([{ pnl: 1.25 }, { pnl: -0.4 }, { pnl: null }]),
      0.85,
    );
  });

  it("uses the shared max of volume and liquidity for the overlay scale", () => {
    assert.equal(
      metricScaleMax([
        { t: 1, upMid: 0.5, downMid: 0.5, volume: 100, liquidity: 40 },
        { t: 2, upMid: 0.5, downMid: 0.5, volume: 80, liquidity: 250 },
      ]),
      250,
    );
  });

  it("draws a volume series path", () => {
    const d = seriesPath(
      [
        { t: 10, upMid: 0.5, downMid: 0.5, volume: 10 },
        { t: 11, upMid: 0.5, downMid: 0.5, volume: 20 },
      ],
      "volume",
      (t) => t,
      (v) => v,
      false,
    );
    assert.equal(d.startsWith("M"), true);
    assert.equal(d.includes("L"), true);
  });
});
