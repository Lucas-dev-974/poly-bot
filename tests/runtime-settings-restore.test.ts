import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  applyRuntimeSettings,
  keysForStrategy,
} from "../src/runtime-settings.js";
import { testConfig } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("applyRuntimeSettings — write failure restores the snapshot", () => {
  it("restores in-memory config when writeRuntimeSettings fails after validation", async () => {
    const config = testConfig();
    // Point the settings file at a path whose parent is a FILE (not a dir):
    // mkdirSync/writeFile inside atomicWriteJson fails after validation passed.
    const dir = mkdtempSync(join(tmpdir(), "bot-settings-full-"));
    tempDirs.push(dir);
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x", "utf8");
    const badPath = join(blocker, "settings.json");

    const before = {
      cheapBuyMax: config.cheapBuyMax,
      cheapOrderUsdc: config.cheapOrderUsdc,
      pairLockMax: config.pairLockMax,
    };

    await assert.rejects(
      applyRuntimeSettings(
        config,
        { cheapBuyMax: 0.12, cheapOrderUsdc: 2, pairLockMax: 0.97 },
        badPath,
        undefined,
      ),
    );

    // Config must be restored to the pre-patch snapshot.
    assert.equal(config.cheapBuyMax, before.cheapBuyMax);
    assert.equal(config.cheapOrderUsdc, before.cheapOrderUsdc);
    assert.equal(config.pairLockMax, before.pairLockMax);
  });

  it("validates against keysForStrategy (live PATCH surface unchanged by void work)", () => {
    const arb = keysForStrategy("arb");
    assert.ok(arb.includes("cheapBuyMax"));
    assert.ok(!arb.includes("simulatedCapital"));
  });
});