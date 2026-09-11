import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { edgeLeadChartRules } from "../src/strategy/chart-rule.js";
import { ChartRulesStrategy } from "../src/strategy/chart-rules-strategy.js";
import { edgeLeadPocGraph } from "../src/strategy/graph/edge-lead-graph.js";
import type { ChartRule, StrategyGraph } from "../src/strategy/graph/types.js";
import { validateStrategyGraph } from "../src/strategy/graph/validate.js";
import type { DefendContext, EdgeSellContext } from "../src/strategy/trading-strategy.js";
import { createStrategy } from "../src/strategy/registry.js";
import { TradeTracker } from "../src/trade-tracker.js";
import type { SimulatedPosition, TradeOpportunity } from "../src/types.js";
import { books, testConfig, testEvent } from "./helpers.js";

function chartGraph(rules: ChartRule[]): StrategyGraph {
  const base = edgeLeadPocGraph();
  return {
    ...base,
    id: "custom:chart-rules-test",
    name: "chart-rules-test",
    chartRules: rules,
  };
}

function rule(
  partial: Partial<ChartRule> & Pick<ChartRule, "token" | "direction" | "action">,
): ChartRule {
  return {
    id: partial.id ?? "z1",
    startSec: partial.startSec ?? 0,
    endSec: partial.endSec ?? 300,
    lookbackMs: partial.lookbackMs ?? 5000,
    minSlope: partial.minSlope ?? 0.002,
    once: partial.once ?? true,
    ...partial,
  };
}

function findCtx(
  strategyNowMs: number,
  asks: { up: number; down: number },
  tracker: TradeTracker,
) {
  const event = testEvent();
  return {
    config: testConfig(),
    tracker,
    event,
    books: books(asks.up, asks.down),
    nowMs: strategyNowMs,
  };
}

function windowT0(): number {
  return testEvent().windowStart * 1000;
}

function commitBuys(strategy: ChartRulesStrategy, opps: TradeOpportunity[]): void {
  for (const opp of opps) strategy.onBuyCommitted?.(opp);
}

function addFill(
  tracker: TradeTracker,
  event: ReturnType<typeof testEvent>,
  kind: "cheap" | "expensive",
  size: number,
  fillPrice: number,
): void {
  const position: SimulatedPosition = {
    id: `test-${kind}-${size}-${fillPrice}`,
    eventSlug: event.slug,
    eventTitle: event.title,
    tokenId: kind === "cheap" ? "t-down" : "t-up",
    outcome: kind === "cheap" ? "Down" : "Up",
    outcomeIndex: kind === "cheap" ? 1 : 0,
    kind,
    limitPrice: fillPrice,
    fillPrice,
    size,
    cost: fillPrice * size,
    windowEnd: event.windowEnd,
    status: "open",
    fillReason: "marketable",
    pairId: `${event.slug}:${event.windowEnd}`,
  };
  tracker.addOpenPosition(position);
}

describe("chartRules strategy", () => {
  it("rejects overlapping bounds and too-short lookback", () => {
    const graph = chartGraph([
      rule({
        token: "cheap",
        direction: "down",
        action: "buy",
        startSec: 10,
        endSec: 10,
        lookbackMs: 1000,
      }),
    ]);
    const errors = validateStrategyGraph(graph, { pollIntervalMs: 2000 });
    assert.ok(errors.some((e) => e.includes("startSec must be < endSec")));
    assert.ok(errors.some((e) => e.includes("lookbackMs")));
  });

  it("buys cheap when the ask trends down inside the zone", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "cheap", direction: "down", action: "buy" })]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, tracker)).length,
      0,
    );
    const opps = strategy.findOpportunities(
      findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].token.tokenId, "t-down");
    assert.equal(opps[0].price, 0.08);
  });

  it("buys favorite (expensive) when the ask trends up inside the zone", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "favorite", direction: "up", action: "buy" })]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    strategy.findOpportunities(findCtx(t0, { up: 0.86, down: 0.12 }, tracker));
    const opps = strategy.findOpportunities(
      findCtx(t0 + 5000, { up: 0.92, down: 0.1 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "expensive");
    assert.equal(opps[0].token.tokenId, "t-up");
  });

  it("once=true retries until the buy is committed, then blocks", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "cheap", direction: "down", action: "buy" })]),
    );
    const t0 = windowT0();
    const first = new TradeTracker();
    strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, first));
    const opps = strategy.findOpportunities(
      findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, first),
    );
    assert.equal(opps.length, 1);
    assert.equal(
      strategy.findOpportunities(findCtx(t0 + 6000, { up: 0.4, down: 0.07 }, first))
        .length,
      1,
    );
    commitBuys(strategy, opps);
    const second = new TradeTracker();
    assert.equal(
      strategy.findOpportunities(findCtx(t0 + 10_000, { up: 0.4, down: 0.06 }, second))
        .length,
      0,
    );
  });

  it("once=false can fire again on a new tracker", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({ token: "cheap", direction: "down", action: "buy", once: false }),
      ]),
    );
    const t0 = windowT0();
    const first = new TradeTracker();
    strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, first));
    assert.equal(
      strategy.findOpportunities(findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, first))
        .length,
      1,
    );
    const second = new TradeTracker();
    assert.equal(
      strategy.findOpportunities(findCtx(t0 + 10_000, { up: 0.4, down: 0.06 }, second))
        .length,
      1,
    );
  });

  it("does not buy outside the time zone", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "down",
          action: "buy",
          startSec: 100,
          endSec: 200,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, tracker));
    assert.equal(
      strategy.findOpportunities(findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, tracker))
        .length,
      0,
    );
  });

  it("sell cheap without an open position does not cancel a resting GTC", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "cheap", direction: "down", action: "sell" })]),
    );
    const event = testEvent();
    const tracker = new TradeTracker();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, tracker));
    strategy.findOpportunities(findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, tracker));
    assert.equal(
      strategy.cheapOrderAction({
        config: testConfig(),
        limitPrice: 0.08,
        cheapBook: books(0.4, 0.08)[1],
        favoriteAsk: 0.4,
        pairId,
        nowMs: t0 + 5000,
      }),
      "keep",
    );
  });

  it("sell cheap on a fill defends shares without once blocking defendShares", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "cheap", direction: "down", action: "sell" })]),
    );
    const event = testEvent();
    const tracker = new TradeTracker();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    strategy.findOpportunities(findCtx(t0, { up: 0.4, down: 0.12 }, tracker));
    strategy.findOpportunities(findCtx(t0 + 5000, { up: 0.4, down: 0.08 }, tracker));
    const defend: DefendContext = {
      config: testConfig(),
      favoriteAsk: 0.4,
      filledCheap: 10,
      filledExpensive: 0,
      pairId,
      nowMs: t0 + 5000,
    };
    assert.equal(strategy.shouldDefend(defend), true);
    assert.equal(strategy.defendShares(defend), 10);
    assert.equal(strategy.shouldDefend(defend), true);
    strategy.onDefendCommitted?.(pairId);
    assert.equal(strategy.shouldDefend(defend), false);
  });

  it("sell favorite does nothing without an open expensive position", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "favorite", direction: "down", action: "sell" })]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        config: testConfig(),
        tracker,
        pairId,
        expensiveBid: 0.8,
        expensiveFillPrice: 0.88,
        expensiveSize: 0,
        cheapFilled: 0,
        marketAgeMs: 5000,
        nowMs: t0 + 5000,
      }),
      false,
    );
  });

  it("sell favorite uses injected nowMs for the trend clock", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([rule({ token: "favorite", direction: "down", action: "sell" })]),
    );
    const event = testEvent();
    const tracker = new TradeTracker();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const base: EdgeSellContext = {
      config: testConfig(),
      tracker,
      pairId,
      expensiveBid: 0.9,
      expensiveFillPrice: 0.88,
      expensiveSize: 10,
      cheapFilled: 0,
      marketAgeMs: 0,
      nowMs: t0,
    };
    assert.equal(strategy.shouldSellExpensiveEdge(base), false);
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        ...base,
        expensiveBid: 0.8,
        marketAgeMs: 5000,
        nowMs: t0 + 5000,
      }),
      true,
    );
  });

  it("rejects bandMin >= bandMax", () => {
    const graph = chartGraph([
      rule({
        token: "favorite",
        direction: "up",
        action: "buy",
        bandMin: 0.9,
        bandMax: 0.85,
      }),
    ]);
    const errors = validateStrategyGraph(graph, { pollIntervalMs: 2000 });
    assert.ok(errors.some((e) => e.includes("bandMin must be < bandMax")));
  });

  it("confirmTicks=4 does not buy favorite; 5 rising ticks does", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.85,
          bandMax: 0.9,
          confirmTicks: 5,
          maxDownTick: 0.01,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    const ticks = [0.851, 0.852, 0.853, 0.854, 0.855];
    for (let i = 0; i < 4; i++) {
      assert.equal(
        strategy.findOpportunities(
          findCtx(t0 + i, { up: ticks[i], down: 0.12 }, tracker),
        ).length,
        0,
      );
    }
    const opps = strategy.findOpportunities(
      findCtx(t0 + 4, { up: ticks[4], down: 0.12 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "expensive");
    assert.equal(opps[0].token.tokenId, "t-up");
  });

  it("cheap is blocked before the expensive fill", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          afterFill: "favorite",
          once: false,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    assert.equal(
      strategy.findOpportunities(
        findCtx(windowT0(), { up: 0.88, down: 0.1 }, tracker),
      ).length,
      0,
    );
  });

  it("cheap posts after expensive fill when the claimed other is in band", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          afterFill: "favorite",
          once: false,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const event = testEvent();
    addFill(tracker, event, "expensive", 10, 0.88);
    const opps = strategy.findOpportunities(
      findCtx(windowT0(), { up: 0.05, down: 0.1 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "cheap");
    assert.equal(opps[0].token.tokenId, "t-down");
    assert.equal(opps[0].price, 0.1);
  });

  it("buy cheap outOfBand cancel-lock keeps in band and cancels out of band", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          outOfBand: "cancel-lock",
          once: false,
        }),
      ]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();
    strategy.findOpportunities(findCtx(t0, { up: 0.88, down: 0.1 }, tracker));
    const ctx = {
      config: testConfig(),
      limitPrice: 0.1,
      pairId,
      nowMs: t0,
      favoriteAsk: 0.88,
    };
    assert.equal(
      strategy.cheapOrderAction({
        ...ctx,
        cheapBook: books(0.88, 0.1)[1],
      }),
      "keep",
    );
    assert.equal(
      strategy.cheapOrderAction({
        ...ctx,
        cheapBook: books(0.88, 0.2)[1],
      }),
      "cancel-lock",
    );
  });

  it("sell favorite loss window uses injected nowMs", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "favorite",
          direction: "down",
          action: "sell",
          startSec: 480,
          endSec: 900,
          minElapsedSec: 480,
          lossPct: 10,
          lossWindowMs: 10_000,
        }),
      ]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();
    const base: EdgeSellContext = {
      config: testConfig(),
      tracker,
      pairId,
      expensiveBid: 0.79,
      expensiveFillPrice: 0.88,
      expensiveSize: 10,
      cheapFilled: 0,
      marketAgeMs: 480_000,
      nowMs: t0 + 480_000,
    };
    assert.equal(strategy.shouldSellExpensiveEdge(base), false);
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        ...base,
        marketAgeMs: 490_000,
        nowMs: t0 + 490_000,
      }),
      true,
    );
  });

  it("minElapsedSec blocks a buy that is otherwise in-band", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          minElapsedSec: 60,
          once: false,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.88, down: 0.1 }, tracker)).length,
      0,
    );
    assert.equal(
      strategy.findOpportunities(
        findCtx(t0 + 60_000, { up: 0.88, down: 0.1 }, tracker),
      ).length,
      1,
    );
  });

  it("cheap band uses round2 like native cancel-lock", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          once: false,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const opps = strategy.findOpportunities(
      findCtx(windowT0(), { up: 0.88, down: 0.144 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].price, 0.14);
  });

  it("edgeLeadChartRules validates and does not defend", () => {
    const graph = chartGraph(edgeLeadChartRules(900));
    assert.deepEqual(validateStrategyGraph(graph, { pollIntervalMs: 1000 }), []);
    const strategy = new ChartRulesStrategy(graph);
    assert.equal(strategy.leadsWithEdge, true);
    const event = testEvent();
    const pairId = `${event.slug}:${event.windowEnd}`;
    assert.equal(
      strategy.shouldDefend({
        config: testConfig(),
        favoriteAsk: 0.88,
        filledCheap: 10,
        filledExpensive: 10,
        pairId,
        nowMs: event.windowStart * 1000,
      }),
      false,
    );
  });

  it("createStrategy uses ChartRulesStrategy when chartRules are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "chart-rules-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    const graph = chartGraph([
      rule({ token: "cheap", direction: "down", action: "buy" }),
    ]);
    repos.strategyGraphs.upsert(graph);
    const strategy = createStrategy("custom:chart-rules-test", repos);
    assert.ok(strategy instanceof ChartRulesStrategy);
    assert.equal(strategy.id, "custom:chart-rules-test");
  });

  it("rejects dependsOn cycle, self, and unknown ids", () => {
    const cycle = chartGraph([
      rule({
        id: "a",
        token: "favorite",
        direction: "up",
        action: "buy",
        dependsOn: ["b"],
      }),
      rule({
        id: "b",
        token: "cheap",
        direction: "up",
        action: "buy",
        dependsOn: ["a"],
      }),
    ]);
    assert.ok(
      validateStrategyGraph(cycle, { pollIntervalMs: 2000 }).some((e) =>
        e.includes("dependsOn cycle"),
      ),
    );
    const unknown = chartGraph([
      rule({
        id: "a",
        token: "favorite",
        direction: "up",
        action: "buy",
        dependsOn: ["missing"],
      }),
    ]);
    assert.ok(
      validateStrategyGraph(unknown, { pollIntervalMs: 2000 }).some((e) =>
        e.includes("unknown id"),
      ),
    );
    const self = chartGraph([
      rule({
        id: "a",
        token: "favorite",
        direction: "up",
        action: "buy",
        dependsOn: ["a"],
      }),
    ]);
    assert.ok(
      validateStrategyGraph(self, { pollIntervalMs: 2000 }).some((e) =>
        e.includes("cannot include itself"),
      ),
    );
  });

  it("blocks a child zone until its parent has filled", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          id: "z1",
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.85,
          bandMax: 0.9,
          once: true,
        }),
        rule({
          id: "z2",
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          dependsOn: ["z1"],
          once: true,
        }),
      ]),
    );
    const tracker = new TradeTracker();
    const t0 = windowT0();
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.5, down: 0.1 }, tracker)).length,
      0,
    );
    const opps = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "expensive");
    commitBuys(strategy, opps);
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.88, down: 0.1 }, tracker))
        .length,
      0,
    );
    addFill(tracker, testEvent(), "expensive", 10, 0.88);
    const children = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, "cheap");
  });

  it("fans out from zone 1 to zone 2 and zone 3", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          id: "z1",
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.85,
          bandMax: 0.9,
          once: true,
        }),
        rule({
          id: "z2",
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          dependsOn: ["z1"],
          once: true,
        }),
        rule({
          id: "z3",
          token: "favorite",
          direction: "down",
          action: "sell",
          bandMin: 0.5,
          bandMax: 1,
          dependsOn: ["z1"],
          once: true,
        }),
      ]),
    );
    const event = testEvent();
    const tracker = new TradeTracker();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const sellBase: EdgeSellContext = {
      config: testConfig(),
      tracker,
      pairId,
      expensiveBid: 0.88,
      expensiveFillPrice: 0.88,
      expensiveSize: 5,
      cheapFilled: 0,
      marketAgeMs: 0,
      nowMs: t0,
    };
    assert.equal(strategy.shouldSellExpensiveEdge(sellBase), false);
    const opps = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "expensive");
    assert.equal(strategy.shouldSellExpensiveEdge(sellBase), false);
    commitBuys(strategy, opps);
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.88, down: 0.1 }, tracker))
        .length,
      0,
    );
    assert.equal(strategy.shouldSellExpensiveEdge(sellBase), false);
    addFill(tracker, event, "expensive", 10, 0.88);
    const children = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, "cheap");
    assert.equal(strategy.shouldSellExpensiveEdge(sellBase), true);
  });

  it("fires children in the same tick even if they are listed before the parent", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          id: "z2",
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          dependsOn: ["z1"],
          once: true,
        }),
        rule({
          id: "z3",
          token: "favorite",
          direction: "down",
          action: "sell",
          bandMin: 0.5,
          bandMax: 1,
          dependsOn: ["z1"],
          once: true,
        }),
        rule({
          id: "z1",
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.85,
          bandMax: 0.9,
          once: true,
        }),
      ]),
    );
    const event = testEvent();
    const tracker = new TradeTracker();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const opps = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(opps.length, 1);
    assert.equal(opps[0].kind, "expensive");
    commitBuys(strategy, opps);
    assert.equal(
      strategy.findOpportunities(findCtx(t0, { up: 0.88, down: 0.1 }, tracker))
        .length,
      0,
    );
    addFill(tracker, event, "expensive", 10, 0.88);
    const children = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    assert.equal(children.length, 1);
    assert.equal(children[0].kind, "cheap");
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        config: testConfig(),
        tracker,
        pairId,
        expensiveBid: 0.88,
        expensiveFillPrice: 0.88,
        expensiveSize: 5,
        cheapFilled: 0,
        marketAgeMs: 0,
        nowMs: t0,
      }),
      true,
    );
  });

  it("cheap cancel-lock waits for dependsOn parents", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          id: "z1",
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.85,
          bandMax: 0.9,
          once: true,
        }),
        rule({
          id: "z2",
          token: "cheap",
          direction: "up",
          action: "buy",
          bandMin: 0.04,
          bandMax: 0.14,
          outOfBand: "cancel-lock",
          dependsOn: ["z1"],
          once: false,
        }),
      ]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();
    const ctx = {
      config: testConfig(),
      limitPrice: 0.1,
      pairId,
      nowMs: t0,
      favoriteAsk: 0.5,
      cheapBook: books(0.5, 0.2)[1],
      tracker,
    };
    assert.equal(strategy.cheapOrderAction(ctx), "keep");
    const opps = strategy.findOpportunities(
      findCtx(t0, { up: 0.88, down: 0.1 }, tracker),
    );
    commitBuys(strategy, opps);
    assert.equal(strategy.cheapOrderAction(ctx), "keep");
    addFill(tracker, event, "expensive", 10, 0.88);
    assert.equal(
      strategy.cheapOrderAction({
        ...ctx,
        favoriteAsk: 0.88,
        cheapBook: books(0.88, 0.2)[1],
      }),
      "cancel-lock",
    );
  });

  it("sell cheap with a price band uses cheapAsk", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "cheap",
          direction: "down",
          action: "sell",
          bandMin: 0.04,
          bandMax: 0.14,
        }),
      ]),
    );
    const event = testEvent();
    const pairId = `${event.slug}:${event.windowEnd}`;
    const t0 = event.windowStart * 1000;
    const defend: DefendContext = {
      config: testConfig(),
      favoriteAsk: 0.88,
      filledCheap: 10,
      filledExpensive: 0,
      pairId,
      nowMs: t0,
    };
    assert.equal(strategy.shouldDefend(defend), false);
    assert.equal(strategy.shouldDefend({ ...defend, cheapAsk: 0.2 }), false);
    assert.equal(strategy.shouldDefend({ ...defend, cheapAsk: 0.1 }), true);
    assert.equal(strategy.defendShares({ ...defend, cheapAsk: 0.1 }), 10);
  });

  it("cancels resting edge on the chart favorite band, not config", () => {
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          token: "favorite",
          direction: "up",
          action: "buy",
          bandMin: 0.7,
          bandMax: 0.8,
        }),
      ]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();
    strategy.findOpportunities(findCtx(t0, { up: 0.75, down: 0.2 }, tracker));
    const edgeBook = books(0.75, 0.2)[0];
    const ctx = {
      config: testConfig({ edgeBandMin: 0.85, edgeBandMax: 0.9 }),
      pairId,
      nowMs: t0,
    };
    assert.equal(
      strategy.edgeOrderAction({ ...ctx, edgeBook }),
      "keep",
    );
    assert.equal(
      strategy.edgeOrderAction({
        ...ctx,
        edgeBook: { ...edgeBook, bestAsk: 0.88 },
      }),
      "cancel-lock",
    );
  });

  it("falling asks must not fake a favorite sell-down on flat bids", () => {
    // Ghost bug: buy path sampled asks into the same series as sell bids.
    // Falling asks + flat bids must NOT trigger a sell-down trend.
    const strategy = new ChartRulesStrategy(
      chartGraph([
        rule({
          id: "sell-fav",
          token: "favorite",
          direction: "down",
          action: "sell",
          lookbackMs: 5000,
          minSlope: 0.002,
        }),
      ]),
    );
    const event = testEvent();
    const t0 = event.windowStart * 1000;
    const pairId = `${event.slug}:${event.windowEnd}`;
    const tracker = new TradeTracker();

    // Pollute ask series with a clear downtrend (0.95 → 0.85 over 5s).
    strategy.findOpportunities(findCtx(t0, { up: 0.95, down: 0.1 }, tracker));
    strategy.findOpportunities(
      findCtx(t0 + 5000, { up: 0.85, down: 0.1 }, tracker),
    );

    const base: EdgeSellContext = {
      config: testConfig(),
      tracker,
      pairId,
      expensiveBid: 0.9,
      expensiveFillPrice: 0.88,
      expensiveSize: 10,
      cheapFilled: 0,
      marketAgeMs: 5000,
      nowMs: t0 + 5000,
    };
    // Flat bids only → no sell-down if ask/bid series are separated.
    assert.equal(strategy.shouldSellExpensiveEdge(base), false);
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        ...base,
        expensiveBid: 0.9,
        marketAgeMs: 10_000,
        nowMs: t0 + 10_000,
      }),
      false,
    );
    // Real bid downtrend still works.
    assert.equal(
      strategy.shouldSellExpensiveEdge({
        ...base,
        expensiveBid: 0.8,
        marketAgeMs: 10_000,
        nowMs: t0 + 10_000,
      }),
      true,
    );
  });

});
