import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReverseStrategy } from "../src/strategy/reverse-strategy.js";
import { TradeTracker } from "../src/trade-tracker.js";
import { createStrategy } from "../src/strategy/registry.js";
import { books, testConfig, testEvent } from "./helpers.js";

function reverseConfig(overrides: Record<string, unknown> = {}) {
  return testConfig({
    strategyId: "reverse",
    cheapBuyMin: 0.07,
    cheapBuyMax: 0.1,
    expensiveBuyMin: 0.9,
    expensiveBuyMax: 0.95,
    enableExpensiveHedge: true,
    requireCheapFillBeforeExpensive: true,
    cheapOrderUsdc: 10,
    expensiveOrderUsdc: 50,
    maxSharesPerOrder: 90,
    maxOpenPositionsPerSide: 6,
    ...overrides,
  });
}

function makeTracker(): TradeTracker {
  return new TradeTracker();
}

function withFilledCheap(tracker: TradeTracker, event: ReturnType<typeof testEvent>, size = 10): string {
  const pairId = `${event.slug}:${event.windowEnd}`;
  tracker.addOpenPosition({
    id: "filled-cheap",
    eventSlug: event.slug,
    eventTitle: event.title,
    tokenId: "t-down",
    outcome: "Down",
    outcomeIndex: 1,
    kind: "cheap",
    limitPrice: 0.08,
    fillPrice: 0.08,
    size,
    cost: 0.08 * size,
    windowEnd: event.windowEnd,
    status: "open",
    fillReason: "resting",
    pairId,
  });
  return pairId;
}


function run(strategy: ReverseStrategy, config: ReturnType<typeof reverseConfig>) {
  const tracker = makeTracker();
  const event = testEvent();
  return { tracker, event, opps: strategy.findOpportunities({ config, tracker, event, books: books(0.95, 0.08) }) };
}

describe("ReverseStrategy", () => {
  it("is registered as a native strategy", () => {
    const strategy = createStrategy("reverse");
    assert.ok(strategy instanceof ReverseStrategy);
    assert.equal(strategy.id, "reverse");
  });

  it("posts a cheap grid on the underdog (min ask) at 7-10c levels", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const { opps } = run(strategy, config);

    // books(0.95, 0.08) → Down (0.08) est l'underdog, Up (0.95) le favori.
    const cheap = opps.filter((o) => o.kind === "cheap");
    assert.ok(cheap.length > 0);
    assert.ok(cheap.every((o) => o.token.outcome === "Down"));
    // Grille 7, 8, 9, 10 (dans les bornes, priceLevels step 0.01).
    assert.deepEqual(cheap.map((o) => o.price).sort(), [0.07, 0.08, 0.09, 0.10]);
  });

  it("posts expensive without cheap fill when requireCheapFillBeforeExpensive is off", () => {
    const config = reverseConfig({ requireCheapFillBeforeExpensive: false });
    const strategy = new ReverseStrategy();
    const { opps } = run(strategy, config);
    assert.ok(opps.some((o) => o.kind === "expensive"));
  });

  it("does not post expensive before a cheap fill", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const { opps } = run(strategy, config);
    assert.equal(opps.filter((o) => o.kind === "expensive").length, 0);
    assert.ok(opps.some((o) => o.kind === "cheap"));
  });

  it("posts a hedge grid on the favorite only after a cheap fill", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();
    withFilledCheap(tracker, event);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.95, 0.08),
    });

    const hedge = opps.filter((o) => o.kind === "expensive");
    assert.ok(hedge.length > 0);
    assert.ok(hedge.every((o) => o.token.outcome === "Up"));
    // Favori ask = 0.95 → niveaux 0.90..0.95 (capped au max config, ici 0.95).
    assert.deepEqual(hedge.map((o) => o.price).sort(), [0.90, 0.91, 0.92, 0.93, 0.94, 0.95]);
  });

  it("deduplicates already-posted levels via the tracker key", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();

    const first = strategy.findOpportunities({ config, tracker, event, books: books(0.95, 0.08) });
    assert.ok(first.length > 0);
    // L'exécuteur marque la clé après une soumission GTC acceptée.
    for (const opp of first) tracker.mark(opp.tradeKey);

    // Re-scan de la même fenêtre : les clés sont marquées, plus rien de neuf.
    const second = strategy.findOpportunities({ config, tracker, event, books: books(0.95, 0.08) });
    assert.equal(second.length, 0);
  });

  it("does not post cheap when the underdog ask is already below cheapBuyMin", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();
    withFilledCheap(tracker, event);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.96, 0.04),
    });
    assert.equal(opps.filter((o) => o.kind === "cheap").length, 0);
    assert.ok(opps.some((o) => o.kind === "expensive"));
  });

  it("still posts cheap when the underdog ask is exactly cheapBuyMin", () => {
    const strategy = new ReverseStrategy();
    const opps = strategy.findOpportunities({
      config: reverseConfig(),
      tracker: makeTracker(),
      event: testEvent(),
      books: books(0.95, 0.07),
    });
    assert.ok(opps.some((o) => o.kind === "cheap"));
  });

  it("skips when the book is one-sided (no true underdog/favorite)", () => {
    const config = reverseConfig();
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();
    const oneSided = books(0.95, 0.95);
    oneSided[1].bestAsk = null;
    const opps = strategy.findOpportunities({ config, tracker, event, books: oneSided });
    assert.equal(opps.length, 0);
  });

  it("caps the cheap and hedge grids at maxOpenPositionsPerSide in one tick", () => {
    const config = reverseConfig({ maxOpenPositionsPerSide: 2 });
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();
    withFilledCheap(tracker, event);
    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.95, 0.08),
    });

    const cheap = opps.filter((o) => o.kind === "cheap");
    const hedge = opps.filter((o) => o.kind === "expensive");
    // 1 cheap déjà fillé compte dans le plafond (max=2) → 1 nouveau cheap.
    assert.equal(cheap.length, 1);
    assert.equal(hedge.length, 2);
    assert.equal(cheap[0]?.price, 0.07);
    assert.deepEqual(hedge.map((o) => o.price), [0.90, 0.91]);
    assert.ok(cheap.every((o) => o.token.outcome === "Down"));
    assert.ok(hedge.every((o) => o.token.outcome === "Up"));
  });

  it("counts already-open legs toward the same-tick cap", () => {
    const config = reverseConfig({ maxOpenPositionsPerSide: 2 });
    const strategy = new ReverseStrategy();
    const tracker = makeTracker();
    const event = testEvent();
    const pairId = `${event.slug}:${event.windowEnd}`;
    tracker.addOpenPosition({
      id: "open-cheap",
      eventSlug: event.slug,
      eventTitle: event.title,
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.07,
      fillPrice: 0.07,
      size: 10,
      cost: 0.7,
      windowEnd: event.windowEnd,
      status: "open",
      fillReason: "resting",
      pairId,
    });
    tracker.mark(tracker.makeKey(event.slug, "Down", "cheap", 0.07));

    const opps = strategy.findOpportunities({
      config,
      tracker,
      event,
      books: books(0.95, 0.08),
    });
    const cheap = opps.filter((o) => o.kind === "cheap");
    const hedge = opps.filter((o) => o.kind === "expensive");
    assert.equal(cheap.length, 1);
    assert.equal(cheap[0]?.price, 0.08);
    assert.equal(hedge.length, 2);
  });

  it("does not defend or sell the edge (expectation strategy, not arb)", () => {
    const strategy = new ReverseStrategy();
    assert.equal(strategy.shouldDefend({} as never), false);
    assert.equal(strategy.defendShares({} as never), 0);
    assert.equal(strategy.shouldSellExpensiveEdge({} as never), false);
    assert.equal(strategy.leadsWithEdge, false);
    assert.equal(strategy.independentHedgeGrid, true);
  });
});
