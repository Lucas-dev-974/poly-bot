import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  envEnum,
  loadConfig,
  validateConfigCoherence,
  validateTradingConfig,
} from "../src/config.js";
import { testConfig } from "./helpers.js";

describe("envEnum", () => {
  it("accepts case-insensitive allowed values", () => {
    process.env.EXPENSIVE_ORDER_TYPE = "gtc";
    assert.equal(envEnum("EXPENSIVE_ORDER_TYPE", ["FOK", "GTC"] as const, "FOK"), "GTC");
    delete process.env.EXPENSIVE_ORDER_TYPE;
  });

  it("throws on unknown values", () => {
    process.env.SIM_RESOLVE_FALLBACK = "random";
    assert.throws(
      () => envEnum("SIM_RESOLVE_FALLBACK", ["none", "probabilistic"] as const, "none"),
      /Invalid value/,
    );
    delete process.env.SIM_RESOLVE_FALLBACK;
  });
});

describe("validateTradingConfig", () => {
  it("rejects live when fallback is not none", () => {
    assert.throws(
      () =>
        validateTradingConfig(
          testConfig({ simResolveFallback: "probabilistic", funderAddress: "0x1", privateKey: "0x2" }),
        ),
      /must be none/,
    );
  });

  it("rejects inverted price bands", () => {
    assert.throws(
      () => validateConfigCoherence(testConfig({ cheapBuyMin: 0.2, cheapBuyMax: 0.1 })),
      /CHEAP_BUY_MIN/,
    );
  });

  it("rejects pairLockMax >= 1.00", () => {
    assert.throws(
      () => validateConfigCoherence(testConfig({ pairLockMax: 1.0 })),
      /PAIR_LOCK_MAX/,
    );
  });

  it("rejects pairLockMax < 0.90", () => {
    assert.throws(
      () => validateConfigCoherence(testConfig({ pairLockMax: 0.89 })),
      /PAIR_LOCK_MAX/,
    );
  });

  it("rejects barbellHedgeRatio of 0 or above 1 only for barbell", () => {
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({ strategyId: "barbell", barbellHedgeRatio: 0 }),
        ),
      /BARBELL_HEDGE_RATIO/,
    );
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({ strategyId: "barbell", barbellHedgeRatio: 1.1 }),
        ),
      /BARBELL_HEDGE_RATIO/,
    );
    // arb ignores barbellHedgeRatio — invalid ratio must not block arb saves
    assert.doesNotThrow(() =>
      validateConfigCoherence(testConfig({ strategyId: "arb", barbellHedgeRatio: 0 })),
    );
  });

  it("accepts barbellHedgeRatio of 1 for barbell", () => {
    assert.doesNotThrow(() =>
      validateConfigCoherence(
        testConfig({ strategyId: "barbell", barbellHedgeRatio: 1 }),
      ),
    );
  });

  it("rejects arb without expensive hedge", () => {
    assert.throws(
      () =>
        validateConfigCoherence(
          testConfig({ strategyId: "arb", enableExpensiveHedge: false }),
        ),
      /ENABLE_EXPENSIVE_HEDGE/,
    );
  });

  it("does not require pairLockMax range for barbell", () => {
    assert.doesNotThrow(() =>
      validateConfigCoherence(
        testConfig({
          strategyId: "barbell",
          barbellHedgeRatio: 0.5,
          pairLockMax: 1.0,
        }),
      ),
    );
  });

  it("skips edge-band checks for custom ids unless leadsWithEdge is set", () => {
    const custom = testConfig({
      strategyId: "custom:edge-lead-poc",
      edgeBandMin: 0.9,
      edgeBandMax: 0.8,
    });
    assert.doesNotThrow(() => validateConfigCoherence(custom));
    assert.throws(
      () => validateConfigCoherence(custom, { leadsWithEdge: true }),
      /EDGE_BAND_MIN must be < EDGE_BAND_MAX/,
    );
  });
});

/**
 * loadConfig JSON strategy tests.
 *
 * These tests manipulate the real data/bot-settings.json file (backed up
 * and restored). They verify that:
 *  - A valid JSON file is required.
 *  - Invalid JSON refuses to start.
 *  - A valid JSON is applied; leftover strategy env vars are ignored.
 */
describe("loadConfig strategy JSON", () => {
  const originalEnv = { ...process.env };
  const realPath = join(process.cwd(), "data", "bot-settings.json");
  let backup: string | null = null;

  afterEach(() => {
    if (backup !== null) {
      writeFileSync(realPath, backup, "utf8");
      backup = null;
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  function stashJson(): void {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    backup = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
  }

  it("throws on invalid JSON", () => {
    stashJson();
    writeFileSync(realPath, "{ invalid json }", "utf8");
    process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
    process.env.FUNDER_ADDRESS = "0x0000000000000000000000000000000000000001";
    assert.throws(() => loadConfig(), /Runtime settings file is invalid/);
  });

  it("throws when the JSON is missing", () => {
    stashJson();
    if (existsSync(realPath)) unlinkSync(realPath);
    process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
    process.env.FUNDER_ADDRESS = "0x0000000000000000000000000000000000000001";
    assert.throws(() => loadConfig(), /is required/);
  });

  it("applies the JSON and ignores leftover strategy env vars", () => {
    stashJson();
    writeFileSync(realPath, JSON.stringify({ cheapOrderUsdc: 42 }), "utf8");
    process.env.CHEAP_ORDER_USDC = "99";
    process.env.POLL_INTERVAL_MS = "250";
    delete process.env.PRIVATE_KEY;
    delete process.env.FUNDER_ADDRESS;
    const config = loadConfig();
    assert.equal(config.cheapOrderUsdc, 42);
    assert.equal(config.pollIntervalMs, 5000);
  });
});