import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import type { SimulatedPosition } from "../src/types.js";

function withDb<T>(fn: (repos: ReturnType<typeof createRepositories>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "engine-stats-"));
  const db = new Database(join(dir, "t.db"), true);
  db.init();
  try {
    return fn(createRepositories(db));
  } finally {
    db.close(); // libère le handle sinon rmSync → EBUSY sous Windows
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakePosition(overrides: Partial<SimulatedPosition>): SimulatedPosition {
  return {
    id: overrides.id ?? "p1",
    eventSlug: overrides.eventSlug ?? "evt",
    eventTitle: overrides.eventTitle ?? "Evt",
    tokenId: overrides.tokenId ?? "tok",
    outcome: overrides.outcome ?? "Up",
    outcomeIndex: overrides.outcomeIndex ?? 0,
    kind: overrides.kind ?? "cheap",
    limitPrice: overrides.limitPrice ?? 0.4,
    fillPrice: overrides.fillPrice ?? 0.4,
    size: overrides.size ?? 10,
    cost: overrides.cost ?? 4,
    windowEnd: overrides.windowEnd ?? Date.now() / 1000 + 600,
    status: overrides.status ?? "open",
    fillReason: overrides.fillReason ?? "marketable",
    pairId: overrides.pairId ?? "evt:123",
    strategyId: overrides.strategyId,
    pnl: overrides.pnl,
  };
}

describe("positions: engineStats (agrégation par strategyId)", () => {
  it("regroupe par moteur et exclut les positions ouvertes du P&L", () => {
    withDb((repos) => {
      const positions = repos.positions;

      positions.insert(fakePosition({ id: "a", strategyId: "arb", status: "won", pnl: 5 }));
      positions.insert(fakePosition({ id: "b", strategyId: "arb", status: "lost", pnl: -2 }));
      positions.insert(fakePosition({ id: "c", strategyId: "fav-band", status: "sold", pnl: 1.5 }));
      positions.insert(fakePosition({ id: "d", strategyId: "fav-band", status: "open" }));
      positions.insert(fakePosition({ id: "e", status: "won", pnl: 3 })); // sans moteur

      const rows = positions.engineStats();
      const byEngine = new Map(rows.map((r) => [r.engine, r]));

      assert.equal(rows.length, 3);

      const arb = byEngine.get("arb");
      assert.ok(arb);
      assert.equal(arb.realizedPnl, 3);
      assert.equal(arb.wins, 1);
      assert.equal(arb.losses, 1);
      assert.equal(arb.openExposure, 0);
      assert.equal(arb.openCount, 0);

      const fav = byEngine.get("fav-band");
      assert.ok(fav);
      assert.equal(fav.realizedPnl, 1.5); // sold compté, open exclu
      assert.equal(fav.wins, 0);
      assert.equal(fav.losses, 0);
      assert.equal(fav.openExposure, 4);
      assert.equal(fav.openCount, 1);

      const none = byEngine.get("(sans moteur)");
      assert.ok(none);
      assert.equal(none.realizedPnl, 3);
      assert.equal(none.wins, 1);
    });
  });

  it("retourne un tableau vide sur une base neuve", () => {
    assert.deepEqual(withDb((repos) => repos.positions.engineStats()), []);
  });
});