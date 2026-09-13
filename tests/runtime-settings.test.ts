import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig, validateTradingConfig } from "../src/config.js";
import {
  applyRuntimeSettings,
  readRuntimeSettings,
  readRuntimeSettingsSync,
  keysForStrategy,
  sanitizePatch,
  writeRuntimeSettings,
} from "../src/runtime-settings.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bot-settings-"));
  tempDirs.push(dir);
  return join(dir, "bot-settings.json");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("sanitizePatch", () => {
  it("accepts editable fields", () => {
    const patch = sanitizePatch({ cheapBuyMin: 0.08, pollIntervalMs: 3000 });
    assert.equal(patch.cheapBuyMin, 0.08);
    assert.equal(patch.pollIntervalMs, 3000);
  });

  it("accepts maxShareEdge", () => {
    assert.equal(sanitizePatch({ maxShareEdge: 12 }).maxShareEdge, 12);
  });

  it("rejects unknown fields", () => {
    assert.throws(() => sanitizePatch({ foo: 1 }), /Unknown field: foo/);
  });

  it("rejects forbidden fields", () => {
    assert.throws(() => sanitizePatch({ dryRun: false }), /Field not editable: dryRun/);
    assert.throws(() => sanitizePatch({ privateKey: "0xabc" }), /Field not editable: privateKey/);
  });

  it("parses market slug prefixes from CSV string", () => {
    const patch = sanitizePatch({ marketSlugPrefixes: "btc-updown-15m, eth-updown-15m" });
    assert.deepEqual(patch.marketSlugPrefixes, ["btc-updown-15m", "eth-updown-15m"]);
  });

  it("parses nullable minMinutesBeforeCloseToBuy", () => {
    assert.equal(sanitizePatch({ minMinutesBeforeCloseToBuy: null }).minMinutesBeforeCloseToBuy, null);
    assert.equal(sanitizePatch({ minMinutesBeforeCloseToBuy: "" }).minMinutesBeforeCloseToBuy, null);
    assert.equal(sanitizePatch({ minMinutesBeforeCloseToBuy: 3 }).minMinutesBeforeCloseToBuy, 3);
  });

  it("parses empty simRandomSeed as undefined", () => {
    assert.equal(sanitizePatch({ simRandomSeed: "" }).simRandomSeed, undefined);
  });

  it("parses strategyId case-insensitively", () => {
    assert.equal(sanitizePatch({ strategyId: "barbell" }).strategyId, "barbell");
    assert.equal(sanitizePatch({ strategyId: "ARB" }).strategyId, "arb");
  });

  it("rejects unknown strategyId", () => {
    assert.throws(() => sanitizePatch({ strategyId: "nope" }), /Invalid strategyId/);
  });

  it("accepts custom strategy ids", () => {
    assert.equal(
      sanitizePatch({ strategyId: "custom:Edge-Lead-POC" }).strategyId,
      "custom:edge-lead-poc",
    );
  });
});

describe("applyRuntimeSettings", () => {
  it("updates config and writes full snapshot", async () => {
    const path = tempSettingsPath();
    const config = testConfig({
      cheapBuyMin: 0.07,
      funderAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
    });
    const changed = await applyRuntimeSettings(config, { cheapBuyMin: 0.08 }, path);
    assert.ok(changed.has("cheapBuyMin"));
    assert.equal(config.cheapBuyMin, 0.08);

    const stored = JSON.parse(readFileSync(path, "utf8")) as { cheapBuyMin: number };
    assert.equal(stored.cheapBuyMin, 0.08);
    assert.equal(stored.pollIntervalMs, config.pollIntervalMs);
  });

  it("rolls back on validation failure", async () => {
    const path = tempSettingsPath();
    const config = testConfig({
      cheapBuyMin: 0.07,
      cheapBuyMax: 0.1,
      funderAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
    });
    await assert.rejects(
      () => applyRuntimeSettings(config, { cheapBuyMin: 0.2 }, path),
      /CHEAP_BUY_MIN/,
    );
    assert.equal(config.cheapBuyMin, 0.07);
  });

  it("rejects probabilistic fallback in live mode", async () => {
    const path = tempSettingsPath();
    const config = testConfig({
      simResolveFallback: "none",
      funderAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
    });
    await assert.rejects(
      () => applyRuntimeSettings(config, { simResolveFallback: "probabilistic" }, path),
      /must be none/,
    );
    assert.equal(config.simResolveFallback, "none");
  });

  it("ignores backtest-only keys on live apply (no in-memory mutate)", async () => {
    const path = tempSettingsPath();
    const config = testConfig({
      strategyId: "arb",
      simulatedCapital: 50,
      simFillProbabilityNonMarketable: 0.1,
      cheapOrderUsdc: 1,
      funderAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
      simResolveFallback: "none",
    });
    await applyRuntimeSettings(
      config,
      { cheapOrderUsdc: 3, simulatedCapital: 999, simFillProbabilityNonMarketable: 0.9 },
      path,
    );
    assert.equal(config.cheapOrderUsdc, 3);
    assert.equal(config.simulatedCapital, 50);
    assert.equal(config.simFillProbabilityNonMarketable, 0.1);
  });
});

describe("readRuntimeSettings", () => {
  it("returns empty object when file is missing", async () => {
    const path = tempSettingsPath();
    const settings = await readRuntimeSettings(path);
    assert.deepEqual(settings, {});
  });

  it("round-trips written settings", async () => {
    const path = tempSettingsPath();
    await writeRuntimeSettings(
      {
        marketSlugPrefixes: ["btc-updown-15m"],
        minMinutesBeforeCloseToBuy: null,
        simRandomSeed: undefined,
      },
      path,
    );
    const settings = await readRuntimeSettings(path);
    assert.deepEqual(settings.marketSlugPrefixes, ["btc-updown-15m"]);
    assert.equal(settings.minMinutesBeforeCloseToBuy, null);
    assert.equal(settings.simRandomSeed, undefined);
  });

  it("throws on corrupted JSON", async () => {
    const path = tempSettingsPath();
    writeFileSync(path, "{not-json", "utf8");
    await assert.rejects(() => readRuntimeSettings(path), /Invalid JSON/);
  });
});

describe("loadConfig JSON merge", () => {
  it("merges runtime JSON over code defaults", () => {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({ cheapBuyMin: 0.08 }), "utf8");

    const base = testConfig({ cheapBuyMin: 0.07 });
    const overlay = readRuntimeSettingsSync(path);
    Object.assign(base, overlay);
    assert.equal(base.cheapBuyMin, 0.08);
  });
});

describe("validateTradingConfig with JSON settings", () => {
  it("accepts coherent merged config", () => {
    const config = testConfig({
      cheapBuyMin: 0.08,
      funderAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
    });
    assert.doesNotThrow(() => validateTradingConfig(config));
  });
});

describe("keysForStrategy", () => {
  it("omits SIM/backtest-only keys from live editable set", () => {
    const keys = keysForStrategy("arb");
    assert.ok(!keys.includes("simulatedCapital"));
    assert.ok(!keys.includes("simFillProbabilityNonMarketable"));
    assert.ok(!keys.includes("simRandomSeed"));
  });

  it("keeps edge keys for edge-lead and for custom when leadsWithEdge is true", () => {
    assert.ok(keysForStrategy("edge-lead").includes("edgeBandMin"));
    assert.ok(!keysForStrategy("arb").includes("edgeBandMin"));
    assert.ok(!keysForStrategy("custom:foo").includes("edgeBandMin"));
    assert.ok(keysForStrategy("custom:foo", true).includes("edgeBandMin"));
  });

  it("omits pair lock and barbell ratio for reverse", () => {
    assert.ok(keysForStrategy("reverse").includes("expensiveBuyMin"));
    assert.ok(!keysForStrategy("reverse").includes("pairLockMax"));
    assert.ok(!keysForStrategy("reverse").includes("barbellHedgeRatio"));
    assert.ok(keysForStrategy("arb").includes("pairLockMax"));
  });

  it("separates arb lock from barbell ratio keys", () => {
    const arb = keysForStrategy("arb");
    const barbell = keysForStrategy("barbell");
    assert.ok(arb.includes("pairLockMax"));
    assert.ok(!arb.includes("barbellHedgeRatio"));
    assert.ok(!arb.includes("simRequireCoveredPair"));
    assert.ok(!arb.includes("enableExpensiveHedge"));
    assert.ok(barbell.includes("barbellHedgeRatio"));
    assert.ok(!barbell.includes("pairLockMax"));
    assert.ok(!barbell.includes("simRequireCoveredPair"));
    assert.ok(!keysForStrategy("reverse").includes("simRequireCoveredPair"));
  });
});
