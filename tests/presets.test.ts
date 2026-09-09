import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfigCoherence, validateTradingConfig } from "../src/config.js";
import { listStrategyPresets } from "../src/strategy-presets.js";
import { testConfig } from "./helpers.js";

describe("strategy presets", () => {
  it("loads Couverture max and Conservateur from config/presets", () => {
    const presets = listStrategyPresets();
    const ids = presets.map((preset) => preset.id).sort();
    assert.deepEqual(ids, ["conservative", "coverage-max"]);

    const coverage = presets.find((preset) => preset.id === "coverage-max");
    const conservative = presets.find((preset) => preset.id === "conservative");
    assert.ok(coverage);
    assert.ok(conservative);
    assert.equal(coverage.settings.expensiveOrderType, "FOK");
    assert.equal(coverage.settings.expensiveOrderUsdc, 15);
    assert.equal(conservative.settings.expensiveOrderType, "GTC");
    assert.equal(conservative.settings.expensiveOrderUsdc, 12);
  });

  it("each bundled preset is a coherent live-safe strategy", () => {
    for (const preset of listStrategyPresets()) {
      const config = testConfig({
        ...preset.settings,
        dryRun: false,
        funderAddress: "0x1234567890123456789012345678901234567890",
        privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
      });
      assert.doesNotThrow(() => validateConfigCoherence(config));
      assert.doesNotThrow(() => validateTradingConfig(config));
    }
  });
});
