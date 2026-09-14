import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { edgeLeadPocGraph } from "../src/strategy/graph/edge-lead-graph.js";
import { GraphStrategy } from "../src/strategy/graph/interpreter.js";
import { createStrategy, leadsWithEdgeFor } from "../src/strategy/registry.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { books, testConfig, testEvent } from "./helpers.js";

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "strategy-graphs-"));
  const db = new Database(join(dir, "t.db"), true);
  db.init();
  return db;
}

describe("strategy graph persistence", () => {
  it("round-trips a graph and prefers JSON leadsWithEdge on read", () => {
    const db = tempDb();
    const repos = createRepositories(db);
    const stored = repos.strategyGraphs.upsert(edgeLeadPocGraph());
    assert.equal(stored.id, "custom:edge-lead-poc");
    assert.equal(stored.leadsWithEdge, true);
    assert.equal(stored.version, 1);

    const again = repos.strategyGraphs.upsert({ ...stored, name: "renamed" });
    assert.equal(again.version, 2);
    assert.equal(again.createdAt, stored.createdAt);

    db.run(`UPDATE strategy_graphs SET leadsWithEdge = 0 WHERE id = ?`, [
      stored.id,
    ]);
    const read = repos.strategyGraphs.get(stored.id);
    assert.equal(read?.leadsWithEdge, true);
    assert.equal(leadsWithEdgeFor(stored.id, repos), true);
  });

  it("does not purge strategy_graphs on database.reset", () => {
    const db = tempDb();
    const repos = createRepositories(db);
    repos.strategyGraphs.upsert(edgeLeadPocGraph());
    db.reset();
    assert.ok(repos.strategyGraphs.get("custom:edge-lead-poc"));
  });

  it("loads a GraphStrategy from the repository", () => {
    const db = tempDb();
    const repos = createRepositories(db);
    repos.strategyGraphs.upsert(edgeLeadPocGraph());
    const strategy = createStrategy("custom:edge-lead-poc", repos);
    assert.ok(strategy instanceof GraphStrategy);
    assert.equal(strategy.id, "custom:edge-lead-poc");
    assert.equal(strategy.leadsWithEdge, true);
  });

  it("throws when the custom graph is missing", () => {
    const db = tempDb();
    const repos = createRepositories(db);
    assert.throws(
      () => createStrategy("custom:missing", repos),
      /Unknown custom strategy/,
    );
  });

  it("round-trips chartRules in graphJson", () => {
    const db = tempDb();
    const repos = createRepositories(db);
    const base = edgeLeadPocGraph();
    const withRules = {
      ...base,
      id: "custom:chart-rules-test",
      chartRules: [
        {
          id: "z1",
          startSec: 0,
          endSec: 300,
          token: "cheap" as const,
          direction: "down" as const,
          action: "sell" as const,
          bandMin: 0.04,
          bandMax: 0.14,
          afterFill: "favorite" as const,
          confirmTicks: 5,
          outOfBand: "cancel-lock" as const,
          lossPct: 10,
          dependsOn: ["el-buy-fav"],
        },
      ],
    };
    repos.strategyGraphs.upsert(withRules);
    const read = repos.strategyGraphs.get("custom:chart-rules-test");
    assert.equal(read?.chartRules?.length, 1);
    assert.equal(read?.chartRules?.[0]?.action, "sell");
    assert.equal(read?.chartRules?.[0]?.endSec, 300);
    assert.equal(read?.chartRules?.[0]?.bandMin, 0.04);
    assert.equal(read?.chartRules?.[0]?.afterFill, "favorite");
    assert.equal(read?.chartRules?.[0]?.confirmTicks, 5);
    assert.equal(read?.chartRules?.[0]?.outOfBand, "cancel-lock");
    assert.equal(read?.chartRules?.[0]?.lossPct, 10);
    assert.deepEqual(read?.chartRules?.[0]?.dependsOn, ["el-buy-fav"]);
  });

  it("downgrades graph runtime errors to safe fallbacks instead of throwing", () => {
    // A runtime op failure (div by zero) must not abort the bot tick: each
    // TradingStrategy method catches and returns its safe fallback
    // (findOpportunities → [], cheap/edgeOrderAction → "keep",
    // shouldDefend → false, defendShares → 0, hedgeAtPostTime → skip,
    // shouldSellExpensiveEdge → false). The graph is structurally valid
    // (constructor validation passes); the error only happens at eval time.
    const base = edgeLeadPocGraph();
    const lit = (value: unknown) => ({ kind: "literal", value } as const);
    const divZeroMethod = (root: string) => ({
      root,
      nodes: [{ id: root, op: "div" as const, params: { a: lit(1), b: lit(0) } }],
      edges: [],
    });
    const broken = {
      ...base,
      id: "custom:broken-runtime",
      findOpportunities: divZeroMethod("root"),
      cheapOrderAction: divZeroMethod("root"),
      edgeOrderAction: divZeroMethod("root"),
      shouldDefend: divZeroMethod("root"),
      defendShares: divZeroMethod("root"),
      hedgeAtPostTime: divZeroMethod("root"),
      shouldSellExpensiveEdge: divZeroMethod("root"),
    };
    const strategy = new GraphStrategy(broken);
    const config = testConfig({ strategyId: "custom:broken-runtime" });
    const event = testEvent();
    const tracker = new TradeTracker();
    const pairId = `${event.slug}:${event.windowEnd}`;

    assert.deepEqual(strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.6, 0.4),
      nowMs: (event.windowStart + 100) * 1000,
    }), []);
    assert.equal(
      strategy.cheapOrderAction({
        config,
        limitPrice: 0.6,
        cheapBook: books(0.6, 0.4)[0],
        favoriteAsk: 0.9,
        pairId,
        tracker,
      }),
      "keep",
    );
    assert.equal(
      strategy.edgeOrderAction({
        config,
        edgeBook: books(0.6, 0.4)[0],
        pairId,
        tracker,
      }),
      "keep",
    );
    assert.equal(
      strategy.shouldDefend({
        config,
        favoriteAsk: 0.9,
        filledCheap: 10,
        filledExpensive: 0,
        pairId,
        tracker,
      }),
      false,
    );
    assert.equal(
      strategy.defendShares({
        config,
        favoriteAsk: 0.9,
        filledCheap: 10,
        filledExpensive: 0,
        pairId,
        tracker,
      }),
      0,
    );
    assert.deepEqual(
      strategy.hedgeAtPostTime({
        config,
        tracker,
        pairId,
        freshAsk: 0.9,
      }),
      { action: "skip", reason: "graph-error-fallback" },
    );
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        config,
        tracker,
        pairId,
        expensiveBid: 0.7,
        expensiveFillPrice: 0.85,
        expensiveSize: 10,
        cheapFilled: 0,
        marketAgeMs: 500_000,
      }),
      false,
    );
  });
});
