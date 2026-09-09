import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition } from "../src/types.js";

function pos(partial: Partial<SimulatedPosition> & Pick<SimulatedPosition, "id" | "kind" | "status">): SimulatedPosition {
  return {
    eventSlug: "btc-updown-15m-1000",
    eventTitle: "BTC",
    tokenId: partial.kind === "cheap" ? "t-down" : "t-up",
    outcome: partial.kind === "cheap" ? "Down" : "Up",
    outcomeIndex: partial.kind === "cheap" ? 1 : 0,
    limitPrice: 0.08,
    fillPrice: 0.08,
    size: 10,
    cost: 0.8,
    windowEnd: 1900,
    fillReason: "marketable",
    pairId: "btc-updown-15m-1000:1900",
    ...partial,
  };
}

describe("TradeTracker", () => {
  it("finalizePair marks directional when one side is missing", () => {
    const tracker = new TradeTracker();
    const cheap = pos({ id: "c1", kind: "cheap", status: "lost", pnl: -0.8 });
    tracker.addOpenPosition(cheap);
    tracker.attachLeg(cheap);
    tracker.resolvePosition({ ...cheap, status: "lost", pnl: -0.8 });
    const pair = tracker.getPair(cheap.pairId)!;
    tracker.finalizePair(pair);
    assert.equal(pair.status, "resolved");
    assert.equal(pair.directional, true);
    assert.ok((pair.realizedPnl ?? 0) < 0);
  });

  it("reuses the same open-position instances after loadFromDb (audit 2.2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-tracker-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    const open = pos({ id: "live:abc", kind: "cheap", status: "open" });
    repos.positions.insert(open);
    repos.pairs.upsert({
      id: open.pairId,
      eventSlug: open.eventSlug,
      eventTitle: open.eventTitle,
      windowEnd: open.windowEnd,
      cheapLegs: [],
      expensiveLegs: [],
      status: "partial",
    });

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();
    const loaded = tracker.getOpenPositions()[0];
    const pair = tracker.getPair(open.pairId)!;
    assert.equal(pair.cheapLegs[0], loaded);
    loaded.status = "lost";
    assert.equal(pair.cheapLegs[0].status, "lost");
    tracker.finalizePair(pair);
    assert.equal(pair.status, "resolved");
    db.close();
  });

  it("getResolvedPositions returns newest resolved first after loadFromDb", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-tracker-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    const older = pos({
      id: "old",
      kind: "cheap",
      status: "lost",
      pnl: -0.8,
      resolvedAt: Date.parse("2026-09-04T12:00:00Z"),
    });
    const newer = pos({
      id: "new",
      kind: "expensive",
      status: "won",
      pnl: 9.2,
      resolvedAt: Date.parse("2026-09-06T08:00:00Z"),
    });
    repos.positions.insert(older);
    repos.positions.updateStatus(older);
    repos.positions.insert(newer);
    repos.positions.updateStatus(newer);

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();
    const resolved = tracker.getResolvedPositions();
    assert.equal(resolved[0]?.id, "new");
    assert.equal(resolved[1]?.id, "old");
    db.close();
  });

  it("loadFromDb preserves strategyId on positions and posted orders", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-tracker-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    const open = pos({
      id: "live:abc",
      kind: "cheap",
      status: "open",
      strategyId: "barbell",
    });
    repos.positions.insert(open);
    repos.postedOrders.insert({
      key: "k1",
      eventSlug: open.eventSlug,
      windowEnd: open.windowEnd,
      cost: open.cost,
      createdAt: Date.now(),
      orderId: "oid-1",
      tokenId: open.tokenId,
      outcome: open.outcome,
      outcomeIndex: open.outcomeIndex,
      kind: open.kind,
      limitPrice: open.limitPrice,
      size: open.size,
      pairId: open.pairId,
      eventTitle: open.eventTitle,
      bestAskAtFill: 0.08,
      strategyId: "edge-lead",
    });

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();
    assert.equal(tracker.getOpenPositions()[0]?.strategyId, "barbell");
    const posted = tracker.getPostedOrdersWithOrderId();
    assert.equal(posted[0]?.strategyId, "edge-lead");
    const byToken = repos.positions.byTokenIds([open.tokenId]);
    assert.equal(byToken[0]?.strategyId, "barbell");
    db.close();
  });

  it("loadFromDb leaves strategyId undefined for legacy rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-tracker-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    repos.positions.insert(pos({ id: "legacy", kind: "cheap", status: "open" }));

    const tracker = new TradeTracker(
      repos.positions,
      repos.pairs,
      repos.keys,
      repos.retries,
      repos.windowClaims,
      repos.postedOrders,
    );
    tracker.loadFromDb();
    assert.equal(tracker.getOpenPositions()[0]?.strategyId, undefined);
    db.close();
  });
});
