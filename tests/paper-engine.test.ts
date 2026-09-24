import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { PaperTradingEngine } from "../src/paper/engine.js";
import { strategyDefaults, type BotConfig } from "../src/config.js";
import type { TokenBook, UpDownEvent } from "../src/types.js";

function simRepos() {
  const dir = mkdtempSync(join(tmpdir(), "arb-sim-"));
  const db = new Database(join(dir, "sim.db"), true);
  db.init();
  return createRepositories(db);
}

function baseConfig(): BotConfig {
  return {
    ...strategyDefaults(),
    simulatedCapital: 1000,
    strategyId: "arb",
    // Clé/funder factices : la validation exige leur présence, mais la
    // simulation n'envoie aucun ordre réel et ne les utilise jamais.
    privateKey: "0x" + "0".repeat(64),
    funderAddress: "0x" + "0".repeat(40),
  } as unknown as BotConfig;
}

function event(windowEndSec: number): UpDownEvent {
  const slug = "btc-updown-5m-1700000000";
  return {
    title: "BTC Up/Down",
    slug,
    market: {
      conditionId: "0xabc",
      slug,
      clobTokenIds: JSON.stringify(["t-up", "t-down"]),
      outcomes: JSON.stringify(["Up", "Down"]),
      negRisk: false,
      orderPriceMinTickSize: 0.01,
      active: false,
      closed: false,
    },
    windowStart: windowEndSec - 300,
    windowEnd: windowEndSec,
  };
}

function books(cheapAsk: number, upAsk: number, size = 100): TokenBook[] {
  return [
    { tokenId: "t-up", outcome: "Up", outcomeIndex: 0, bestBid: upAsk - 0.01, bestAsk: upAsk, bestAskSize: size, bestBidSize: size },
    { tokenId: "t-down", outcome: "Down", outcomeIndex: 1, bestBid: cheapAsk - 0.01, bestAsk: cheapAsk, bestAskSize: size, bestBidSize: size },
  ];
}

describe("PaperTradingEngine", () => {
  it("enable + onBooks ouvre une position papier et débite le cash", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    const ev = event(Date.now() / 1000 + 240);
    engine.onBooks(ev, books(0.1, 0.88), Date.now());
    const open = engine.getOpenPositions();
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, "cheap");
    assert.ok(open[0].cost > 0);
    assert.ok(engine.getState().cash < 1000);
    assert.equal(repos.simPositions.all().length, 1);
    repos.db.close();
  });

  it("désactivé, onBooks est un no-op", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now());
    assert.equal(engine.getOpenPositions().length, 0);
    assert.equal(repos.simPositions.all().length, 0);
    repos.db.close();
  });

  it("reset remet le cash au capital initial et vide les tables", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    engine.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now());
    assert.ok(engine.getOpenPositions().length > 0);
    engine.reset();
    assert.equal(engine.getOpenPositions().length, 0);
    assert.equal(engine.getState().cash, 1000);
    assert.equal(repos.simPositions.all().length, 0);
    assert.equal(repos.simState.get("capitalCash"), "1000");
    repos.db.close();
  });

  it("restart : le nouveau moteur restaure enabled, cash et positions", () => {
    const repos = simRepos();
    const e1 = new PaperTradingEngine(baseConfig(), repos);
    e1.init();
    e1.setEnabled(true);
    e1.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now());
    const cashAfter = e1.getState().cash;
    assert.ok(cashAfter < 1000);

    const e2 = new PaperTradingEngine(baseConfig(), repos);
    e2.init();
    assert.equal(e2.isEnabled(), true);
    assert.ok(Math.abs(e2.getState().cash - cashAfter) < 0.01);
    assert.equal(e2.getOpenPositions().length, 1);
    repos.db.close();
  });

  it("dédup : pas de 2e jambe cheap pour la même opportunité", () => {
    // Après un fill cheap, le hedge expensive peut s'ouvrir (comportement
    // attendu) ; on vérifie qu'aucune 2e jambe cheap n'est prise.
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    const ev = event(Date.now() / 1000 + 240);
    engine.onBooks(ev, books(0.1, 0.88), Date.now());
    const cheapCount = () =>
      engine.getOpenPositions().filter((p) => p.kind === "cheap").length;
    const count = cheapCount();
    assert.ok(count >= 1);
    engine.onBooks(ev, books(0.1, 0.88), Date.now() + 1000);
    assert.equal(cheapCount(), count);
  });

  it("hot-swap de stratégie via applyConfig", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.applyConfig({ strategyId: "barbell" });
    assert.equal(engine.getState().strategyId, "barbell");
    repos.db.close();
  });
});