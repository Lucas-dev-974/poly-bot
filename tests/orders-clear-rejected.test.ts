import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";

type Repos = ReturnType<typeof createRepositories>;

function withDb<T>(fn: (repos: Repos) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "orders-purge-"));
  const db = new Database(join(dir, "t.db"), true);
  db.init();
  try {
    return fn(createRepositories(db));
  } finally {
    db.close(); // libère le handle sinon rmSync → EBUSY sous Windows
    rmSync(dir, { recursive: true, force: true });
  }
}

function opp(key = "k1") {
  return {
    kind: "cheap" as const,
    tradeKey: key,
    pairId: `${key}:pair`,
    event: {
      slug: "btc-updown-15m-1",
      title: "Bitcoin Up or Down",
      windowEnd: 9_999_999_999,
    },
    token: { tokenId: `tok-${key}`, outcome: "Up", outcomeIndex: 0 },
  };
}

describe("OrderRepository.deleteRejected (purge des rejetés)", () => {
  it("supprime filled=0 (hors resting/cancelled), garde fills, resting, cancelled", () => {
    withDb((repos) => {
      const o = repos.orders;
      o.record(
        { dryRun: false, price: 0.09, size: 11, filled: false, reason: "insufficient-balance", orderType: "GTC" },
        opp(),
      );
      o.record(
        { dryRun: false, price: 0.11, size: 9, filled: false, reason: "too-close-to-close", orderType: "GTC" },
        opp("k2"),
      );
      o.record(
        { dryRun: false, price: 0.1, size: 5, filled: false, reason: "readonly-live", orderType: "GTC" },
        opp("k3"),
      );
      // GTC en attente : PAS un rejet, doit rester.
      o.record(
        { dryRun: false, price: 0.12, size: 5, filled: false, reason: "resting", orderType: "GTC" },
        opp("k4"),
      );
      // Annulé : laissé intact.
      o.record(
        { dryRun: false, price: 0.13, size: 5, filled: false, reason: "cancelled", orderType: "GTC" },
        opp("k5"),
      );
      // Fills réels : laissés intacts.
      o.record({ dryRun: false, price: 0.14, size: 5, filled: true, orderType: "GTC" }, opp("k6"));
      o.record({ dryRun: false, price: 0.15, size: 5, filled: true, orderType: "GTC" }, opp("k7"));

      assert.equal(o.deleteRejected(), 3);
      const remaining = o.recent(10);
      // 7 − 3 rejetés = 2 fills + 1 resting + 1 cancelled.
      assert.equal(remaining.length, 4);
      assert.ok(remaining.every((r) => r.filled === 1 || r.reason === "resting" || r.reason === "cancelled"));
      // Idempotent : rien à supprimer au 2e appel.
      assert.equal(o.deleteRejected(), 0);
    });
  });
});