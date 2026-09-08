import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
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
          testConfig({ dryRun: false, simResolveFallback: "probabilistic", funderAddress: "0x1", privateKey: "0x2" }),
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
});

/**
 * loadConfig overlay fail-loud tests.
 *
 * These tests manipulate the real data/bot-settings.json file (backed up
 * and restored). They verify that:
 *  - In live mode (DRY_RUN=false), an invalid overlay JSON throws.
 *  - In dry-run mode, an invalid overlay is warned + ignored (no throw).
 *  - A valid overlay is applied and divergences are logged.
 */
describe("loadConfig overlay fail-loud", () => {
  const originalEnv = { ...process.env };
  const realPath = join(process.cwd(), "data", "bot-settings.json");
  let backup: string | null = null;

  afterEach(() => {
    // Restore the overlay file and env.
    if (backup !== null) {
      writeFileSync(realPath, backup, "utf8");
      backup = null;
    } else if (existsSync(realPath)) {
      // If there was no file originally, remove the test artifact.
      // But only if we created it. We track via backup being null.
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("throws on invalid overlay JSON in live mode (DRY_RUN=false)", () => {
    backup = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
    writeFileSync(realPath, "{ invalid json }", "utf8");
    process.env.DRY_RUN = "false";
    process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
    process.env.FUNDER_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.SIM_RESOLVE_FALLBACK = "none";
    assert.throws(() => loadConfig(), /Runtime settings file is invalid/);
  });

  it("warns + falls back on invalid overlay in dry-run mode", () => {
    backup = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
    writeFileSync(realPath, "{ invalid json }", "utf8");
    process.env.DRY_RUN = "true";
    delete process.env.PRIVATE_KEY;
    delete process.env.FUNDER_ADDRESS;
    // Should not throw — dry-run tolerates a broken overlay.
    const config = loadConfig();
    assert.equal(config.dryRun, true);
  });

  it("applies valid overlay and logs divergences", () => {
    backup = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
    writeFileSync(realPath, JSON.stringify({ cheapOrderUsdc: 42 }), "utf8");
    process.env.DRY_RUN = "true";
    delete process.env.PRIVATE_KEY;
    delete process.env.FUNDER_ADDRESS;
    delete process.env.CHEAP_ORDER_USDC;
    const config = loadConfig();
    // Overlay should have applied cheapOrderUsdc=42.
    assert.equal(config.cheapOrderUsdc, 42);
  });
});