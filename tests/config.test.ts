import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  envEnum,
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
});
