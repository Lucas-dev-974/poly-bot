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
});
