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
    assert.equal(coverage.strategyId, "arb");
    assert.equal(conservative.strategyId, "arb");
    assert.equal(coverage.settings.strategyId, "arb");
    assert.equal(conservative.settings.strategyId, "arb");
  });

  it("filters bundled presets by engine", () => {
    assert.deepEqual(
      presetsForStrategy("arb").map((preset) => preset.id).sort(),
      ["conservative", "coverage-max"],
    );
    assert.deepEqual(presetsForStrategy("barbell"), []);
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
        dryRun: false,
        funderAddress: "0x1234567890123456789012345678901234567890",
        privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
      });
      assert.doesNotThrow(() => validateConfigCoherence(config));
      assert.doesNotThrow(() => validateTradingConfig(config));
    }
  });
});
