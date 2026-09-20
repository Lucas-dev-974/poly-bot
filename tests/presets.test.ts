import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateConfigCoherence, validateTradingConfig } from "../src/config.js";
import {
  listStrategyPresets,
  presetsForStrategy,
} from "../src/strategy-presets.js";
import { testConfig } from "./helpers.js";

describe("strategy presets", () => {
  it("loads the bundled presets from config/presets", () => {
    const presets = listStrategyPresets();
    const ids = presets.map((preset) => preset.id).sort();
    assert.deepEqual(ids, [
      "antiflip-revert",
      "ask-lock",
      "conservative",
      "coverage-max",
      "dip-revert",
      "early-conviction",
      "edge-lead",
      "fav-band",
      "fav-band-opt",
      "fav-band-opt-risk",
      "flip-confirm",
      "lock-harvest",
      "open-entry",
      "reverse",
    ]);

    const coverage = presets.find((preset) => preset.id === "coverage-max");
    const conservative = presets.find((preset) => preset.id === "conservative");
    const edgeLead = presets.find((preset) => preset.id === "edge-lead");
    const reverse = presets.find((preset) => preset.id === "reverse");
    const askLock = presets.find((preset) => preset.id === "ask-lock");
    const lockHarvest = presets.find((preset) => preset.id === "lock-harvest");
    const dipRevert = presets.find((preset) => preset.id === "dip-revert");
    const favBand = presets.find((preset) => preset.id === "fav-band");
    assert.ok(coverage);
    assert.ok(conservative);
    assert.ok(edgeLead);
    assert.ok(reverse);
    assert.ok(askLock);
    assert.ok(lockHarvest);
    assert.ok(dipRevert);
    assert.ok(favBand);
    assert.equal(coverage.settings.expensiveOrderType, "FOK");
    assert.equal(coverage.settings.expensiveOrderUsdc, 15);
    assert.equal(conservative.settings.expensiveOrderType, "GTC");
    assert.equal(conservative.settings.expensiveOrderUsdc, 12);
    assert.equal(coverage.strategyId, "arb");
    assert.equal(conservative.strategyId, "arb");
    assert.equal(coverage.settings.strategyId, "arb");
    assert.equal(conservative.settings.strategyId, "arb");
    assert.equal(edgeLead.strategyId, "edge-lead");
    assert.equal(edgeLead.settings.strategyId, "edge-lead");
    assert.equal(edgeLead.settings.pollIntervalMs, 1000);
    assert.equal(edgeLead.settings.maxShareEdge, 15);
    assert.equal(reverse.strategyId, "reverse");
    assert.equal(reverse.settings.strategyId, "reverse");
    assert.equal(reverse.settings.cheapBuyMin, 0.07);
    assert.equal(reverse.settings.cheapBuyMax, 0.1);
    assert.equal(reverse.settings.expensiveBuyMin, 0.9);
    assert.equal(reverse.settings.expensiveBuyMax, 0.95);
    assert.equal(reverse.settings.reverseCheapOrderUsdc, 10);
    assert.equal(reverse.settings.expensiveOrderUsdc, 50);
    assert.equal(reverse.settings.maxSharesPerOrder, 90);
    assert.equal(reverse.settings.maxOpenPositionsPerSide, 6);
    assert.equal(reverse.settings.maxExposureUsdc, 340);
    assert.equal(reverse.settings.simulatedCapital, 1000);
    assert.equal(askLock.settings.arbAskLockOnly, true);
    assert.equal(lockHarvest.settings.arbAskLockOnly, true);
    assert.equal(dipRevert.strategyId, "dip-revert");
    assert.equal(dipRevert.settings.strategyId, "dip-revert");
    assert.equal(dipRevert.settings.dipRevertBandMin, 0.55);
    assert.equal(dipRevert.settings.dipRevertBandMax, 0.65);
    assert.equal(dipRevert.settings.dipRevertMaxElapsedSec, 420);
    assert.equal(dipRevert.settings.dipRevertExitTakeProfitEnabled, false);
    assert.equal(dipRevert.settings.dipRevertExitWinAsk, 0.85);
    assert.equal(favBand.strategyId, "fav-band");
    assert.equal(favBand.settings.favBandAskMin, 0.7);
  });

  it("filters bundled presets by engine", () => {
    assert.deepEqual(
      presetsForStrategy("arb").map((preset) => preset.id).sort(),
      ["ask-lock", "conservative", "coverage-max", "lock-harvest"],
    );
    assert.deepEqual(presetsForStrategy("barbell"), []);
    assert.deepEqual(
      presetsForStrategy("edge-lead").map((preset) => preset.id),
      ["edge-lead"],
    );
    assert.deepEqual(
      presetsForStrategy("reverse").map((preset) => preset.id),
      ["reverse"],
    );
    assert.deepEqual(
      presetsForStrategy("fav-band").map((preset) => preset.id).sort(),
      ["fav-band", "fav-band-opt", "fav-band-opt-risk"],
    );
    assert.deepEqual(
      presetsForStrategy("dip-revert").map((preset) => preset.id),
      ["dip-revert"],
    );
    assert.deepEqual(
      presetsForStrategy("antiflip-revert").map((preset) => preset.id),
      ["antiflip-revert"],
    );
    assert.deepEqual(
      presetsForStrategy("flip-confirm").map((preset) => preset.id),
      ["flip-confirm"],
    );
    assert.deepEqual(
      presetsForStrategy("early-conviction").map((preset) => preset.id),
      ["early-conviction"],
    );
    assert.deepEqual(
      presetsForStrategy("open-entry").map((preset) => preset.id),
      ["open-entry"],
    );
  });

  it("throws when a preset file omits strategyId", () => {
    const dir = mkdtempSync(join(tmpdir(), "presets-"));
    writeFileSync(
      join(dir, "orphan.json"),
      JSON.stringify({
        id: "orphan",
        name: "Orphan",
        settings: { cheapBuyMin: 0.07, cheapBuyMax: 0.1, pollIntervalMs: 5000 },
      }),
      "utf8",
    );
    assert.throws(() => listStrategyPresets(dir), /Invalid strategyId/);
  });

  it("throws when a preset file has an unknown strategyId", () => {
    const dir = mkdtempSync(join(tmpdir(), "presets-"));
    writeFileSync(
      join(dir, "nope.json"),
      JSON.stringify({
        id: "nope",
        strategyId: "nope",
        name: "Nope",
        settings: { cheapBuyMin: 0.07 },
      }),
      "utf8",
    );
    assert.throws(() => listStrategyPresets(dir), /Invalid strategyId/);
  });

  it("each bundled preset is a coherent live-safe strategy", () => {
    for (const preset of listStrategyPresets()) {
      const config = testConfig({
        ...preset.settings,
        funderAddress: "0x1234567890123456789012345678901234567890",
        privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
      });
      assert.doesNotThrow(() => validateConfigCoherence(config));
      assert.doesNotThrow(() => validateTradingConfig(config));
    }
  });
});