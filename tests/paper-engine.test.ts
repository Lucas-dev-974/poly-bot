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

  it("trading: false (famille non tradable) bloque les nouvelles entrées sim", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    engine.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now(), { trading: false });
    assert.equal(engine.getOpenPositions().length, 0);
    assert.equal(repos.simPositions.all().length, 0);
    // Les bids restent mémorisés malgré le gate (valorisation P&L).
    assert.ok(engine.getState().positionsValue >= 0);
    repos.db.close();
  });

  it("reset archive les resolues, garde les ouvertes et le cash", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    engine.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now());
    const openBefore = engine.getOpenPositions().length;
    assert.ok(openBefore > 0);

    // Seed une position resolue (won) avec strategyId pour verifier l archive.
    const openPos = engine.getOpenPositions()[0]!;
    repos.simPositions.insert({
      ...openPos,
      id: "resolved-seed-1",
      status: "won",
      pnl: 1.25,
      resolvedAt: Date.now(),
      strategyId: "arb",
    });
    // Recharge tracker via nouvel engine? Non: reset lit DB via archiveResolved.
    // Le tracker memoire n a pas cette resolue; on teste surtout DB + open conservees.
    const cashBefore = engine.getState().cash;
    const result = engine.reset();
    assert.equal(result.archived, 1);
    assert.ok(result.batchId.startsWith("sim-archive-"));
    assert.equal(engine.getOpenPositions().length, openBefore, "ouvertes conservees");
    assert.equal(engine.getResolvedPositions().length, 0, "resolues memoire videes");
    assert.equal(
      repos.simPositions.all().filter((p) => p.status !== "open").length,
      0,
      "plus de resolues dans sim_positions",
    );
    assert.equal(
      repos.simPositions.all().filter((p) => p.status === "open").length,
      openBefore,
    );
    const archived = repos.db.all<{ id: string; strategyId: string | null; archiveBatchId: string }>(
      "SELECT id, strategyId, archiveBatchId FROM sim_positions_archive",
    );
    assert.equal(archived.length, 1);
    assert.equal(archived[0]!.id, "resolved-seed-1");
    assert.equal(archived[0]!.strategyId, "arb");
    assert.equal(archived[0]!.archiveBatchId, result.batchId);
    assert.equal(engine.getState().cash, cashBefore, "cash inchange");
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

  it("resolveDue purge les GTC resting dont la fenêtre est passée", async () => {
    const repos = simRepos();
    const slug = "btc-updown-5m-1700000000";
    const windowEnd = Math.floor(Date.now() / 1000) - 300; // déjà passée
    // Seed AVANT init() : loadFromDb charge sim_posted_orders en mémoire au
    // démarrage du tracker (comme un vrai restart). limitPrice 0.10 : sous
    // maxCheapForLock = pairLockMax(0.98) - favoriteAsk(0.88) → pas de
    // cancel-lock au 1er tick ; ask 0.75 > limit 0.10 → pas de fill. Le GTC
    // survit au tick et resolveDue doit le purger (miroir closeWindow).
    repos.simPostedOrders.insert({
      key: "k1",
      eventSlug: slug,
      windowEnd,
      cost: 0.5,
      createdAt: Date.now() - 1000,
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: 0.10,
      size: 5,
      pairId: `${slug}:${windowEnd}`,
      eventTitle: "BTC Up/Down",
      bestAskAtFill: 0.68,
      strategyId: "arb",
    });
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    const ev = event(windowEnd);
    const askAboveLimit: TokenBook[] = [
      { tokenId: "t-up", outcome: "Up", outcomeIndex: 0, bestBid: 0.87, bestAsk: 0.88, bestAskSize: 100, bestBidSize: 100 },
      { tokenId: "t-down", outcome: "Down", outcomeIndex: 1, bestBid: 0.74, bestAsk: 0.75, bestAskSize: 100, bestBidSize: 100 },
    ];
    engine.onBooks(ev, askAboveLimit, Date.now(), { trading: true });
    assert.ok(engine.getRestingForSlug("").length > 0, "le GTC seedé devrait être rechargé au 1er onBooks");
    await engine.resolveDue();
    assert.equal(engine.getRestingForSlug("").length, 0, "resolveDue doit purger le GTC expiré");
    repos.db.close();
  });

  it("emitBalance persiste le cash en DB : les crédits de résolution survivent au restart", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    engine.onBooks(event(Date.now() / 1000 + 240), books(0.1, 0.88), Date.now());
    const cashAfterOpen = engine.getState().cash;
    assert.ok(cashAfterOpen < 1000, "le débit d'entrée doit avoir eu lieu");
    // Crédit de résolution (payout win d'une position 5 shares) : ne touche que
    // le ledger en mémoire — avant le fix, ce crédit n'était jamais écrit en DB
    // (seuls les débits via onPositionOpened l'étaient).
    const internals = engine as unknown as {
      ledger: { credit(n: number): void };
      emitBalance(): void;
    };
    internals.ledger.credit(5);
    assert.ok(Math.abs(engine.getState().cash - (cashAfterOpen + 5)) < 0.01);
    // emitBalance (timer 5s en prod) doit persister le cash crédité.
    internals.emitBalance();
    const persisted = Number(repos.simState.get("capitalCash"));
    assert.ok(
      Math.abs(persisted - (cashAfterOpen + 5)) < 0.01,
      `capitalCash en DB doit inclure le crédit (${persisted} != ${cashAfterOpen + 5})`,
    );
    repos.db.close();
  });

  it("trading:false laisse sortir via defend (TP antiflip), bloque les entrées", () => {
    const repos = simRepos();
    const windowEnd = Math.floor(Date.now() / 1000) + 240;
    const slug = "btc-updown-5m-1700000000";
    const fillPrice = 0.4;
    const tpPct = 0.1;
    // target = round2(0.4 * 1.1) = 0.44
    repos.simPositions.insert({
      id: "af-open-1",
      eventSlug: slug,
      eventTitle: "BTC Up/Down",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      kind: "cheap",
      limitPrice: fillPrice,
      fillPrice,
      size: 10,
      cost: fillPrice * 10,
      windowEnd,
      status: "open",
      fillReason: "marketable",
      pairId: `${slug}:${windowEnd}`,
      strategyId: "antiflip-revert",
    });
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.setEnabled(true);
    engine.applyConfig({
      strategyId: "antiflip-revert",
      settings: { antiflipTakeProfitPct: tpPct },
    });
    assert.equal(engine.getOpenPositions().length, 1);

    const ev = event(windowEnd);
    // Bid sous TP + trading off : hold, pas de nouvelle entrée.
    engine.onBooks(ev, books(0.42, 0.55), Date.now(), { trading: false });
    assert.equal(engine.getOpenPositions().length, 1, "bid sous TP: hold");

    const booksAtTp: TokenBook[] = [
      {
        tokenId: "t-up", outcome: "Up", outcomeIndex: 0,
        bestBid: 0.54, bestAsk: 0.55, bestAskSize: 100, bestBidSize: 100,
      },
      {
        tokenId: "t-down", outcome: "Down", outcomeIndex: 1,
        bestBid: 0.44, bestAsk: 0.45, bestAskSize: 100, bestBidSize: 100,
      },
    ];
    engine.onBooks(ev, booksAtTp, Date.now() + 1, { trading: false });
    assert.equal(engine.getOpenPositions().length, 0, "TP via defend malgré trading:false");
    assert.equal(
      engine.getResolvedPositions().filter((p) => p.status === "sold").length,
      1,
    );
    repos.db.close();
  });
});
