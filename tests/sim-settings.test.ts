import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import { PaperTradingEngine } from "../src/paper/engine.js";
import { strategyDefaults, type BotConfig } from "../src/config.js";
import type { RuntimeSettingsPatch } from "../src/runtime-settings.js";
import type { TokenBook, UpDownEvent } from "../src/types.js";

function simRepos() {
  const dir = mkdtempSync(join(tmpdir(), "arb-sim-settings-"));
  const db = new Database(join(dir, "sim.db"), true);
  db.init();
  return createRepositories(db);
}

function baseConfig(): BotConfig {
  return {
    ...strategyDefaults(),
    simulatedCapital: 1000,
    strategyId: "arb",
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

/** Config 5m minimale pour ouvrir une entrée antiflip (gates levés). */
function antiflip5mConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const cfg = baseConfig();
  cfg.strategyId = "antiflip-revert";
  cfg.antiflip5mOnly = true;
  cfg.antiflipBandMin = 0.3;
  cfg.antiflipBandMax = 0.4;
  cfg.antiflipDeposedAskMin = null;
  cfg.antiflipFavAskMin = 0;
  cfg.antiflipFavAskMax = 1;
  cfg.antiflipMinElapsedSec = 0;
  cfg.antiflipMaxElapsedSec = 185;
  cfg.antiflipEntryDelaySec = 0;
  cfg.antiflipFlipLookbackMs = 30000;
  cfg.antiflipOrderUsdc = 5;
  cfg.maxOpenPositionsPerSide = 1;
  cfg.marketSlugPrefixes = ["btc-updown-5m"];
  return { ...cfg, ...overrides };
}

describe("sim settings (panneau config 5m)", () => {
  it("getEffectiveConfig expose la config courante du moteur", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    const cfg = engine.getEffectiveConfig();
    assert.equal(cfg.strategyId, "arb");
    assert.equal(cfg.simulatedCapital, 1000);
    repos.db.close();
  });

  it("getEffectiveConfig reflète applyConfig (settings patch)", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.applyConfig({
      strategyId: "antiflip-revert",
      settings: {
        antiflipBandMin: 0.3,
        antiflipBandMax: 0.4,
        antiflipTakeProfitPct: 0.1,
        antiflip5mOnly: true,
        antiflipMinElapsedSec: 0,
        maxOpenPositionsPerSide: 1,
      } as RuntimeSettingsPatch,
    });
    const cfg = engine.getEffectiveConfig();
    assert.equal(cfg.strategyId, "antiflip-revert");
    assert.equal(cfg.antiflipBandMin, 0.3);
    assert.equal(cfg.antiflipBandMax, 0.4);
    assert.equal(cfg.antiflipTakeProfitPct, 0.1);
    repos.db.close();
  });

  it("édition runtime : fusion avec les settings courants (pas de remplacement)", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    // Édition 1 : bande [0.30, 0.40] + TP 10%.
    engine.applyConfig({
      strategyId: "antiflip-revert",
      settings: {
        antiflipBandMin: 0.3,
        antiflipBandMax: 0.4,
        antiflipTakeProfitPct: 0.1,
      } as RuntimeSettingsPatch,
    });
    // Édition 2 : budget seul — le TP et la bande doivent être conservés.
    engine.applyConfig({
      settings: { antiflipOrderUsdc: 7 } as RuntimeSettingsPatch,
    });
    const cfg = engine.getEffectiveConfig();
    assert.equal(cfg.antiflipOrderUsdc, 7, "nouvelle valeur appliquée");
    assert.equal(cfg.antiflipTakeProfitPct, 0.1, "TP conservé (fusion)");
    assert.equal(cfg.antiflipBandMin, 0.3, "bande conservée (fusion)");
    repos.db.close();
  });

  it("switch de preset : les settings hérités sont purgés (le preset prime)", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    // Preset re-entry + édition runtime : bande élargie [0.30, 0.45] avec
    // budget relevé (validation budget : min 3 USDC à 0.45 pour 5 shares),
    // TP 0.1.
    engine.applyConfig({
      strategyId: "antiflip-revert",
      presetId: "antiflip-5m-reentry",
      settings: {
        antiflipBandMax: 0.45,
        antiflipOrderUsdc: 5,
        antiflipTakeProfitPct: 0.1,
      } as RuntimeSettingsPatch,
    });
    assert.equal(engine.getEffectiveConfig().antiflipBandMax, 0.45);
    assert.equal(engine.getEffectiveConfig().antiflipTakeProfitPct, 0.1);

    // Switch vers tp20 SANS settings : le preset tp20 (bande [0.30,0.40],
    // TP 0.2) doit primer sur les éditions héritées — sinon le panneau
    // afficherait les valeurs de l'ancien preset après un switch.
    engine.applyConfig({ strategyId: "antiflip-revert", presetId: "antiflip-5m-tp20" });
    const cfg = engine.getEffectiveConfig();
    assert.equal(engine.getState().presetId, "antiflip-5m-tp20");
    assert.equal(cfg.antiflipTakeProfitPct, 0.2, "TP du preset tp20");
    assert.equal(cfg.antiflipBandMin, 0.3, "bandeMin du preset tp20");
    assert.equal(cfg.antiflipBandMax, 0.4, "bandeMax du preset tp20");
    repos.db.close();
  });

  it("édition runtime sur le preset courant : le preset reste actif", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    engine.applyConfig({
      strategyId: "antiflip-revert",
      presetId: "antiflip-5m-tp10",
    });
    engine.applyConfig({
      settings: { antiflipOrderUsdc: 7 } as RuntimeSettingsPatch,
    });
    const cfg = engine.getEffectiveConfig();
    assert.equal(engine.getState().presetId, "antiflip-5m-tp10", "preset inchangé");
    assert.equal(cfg.antiflipOrderUsdc, 7, "patch runtime appliqué");
    assert.equal(cfg.antiflipTakeProfitPct, 0.1, "TP du preset tp10 conservé");
    repos.db.close();
  });

  it("antiflipTakeProfitPct invalide (> 0.9) est rejeté", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(baseConfig(), repos);
    engine.init();
    assert.throws(() => {
      engine.applyConfig({
        strategyId: "antiflip-revert",
        settings: { antiflipTakeProfitPct: 1.5 } as RuntimeSettingsPatch,
      });
    }, /antiflipTakeProfitPct|take.?profit/i);
    repos.db.close();
  });

  it("TP intra-market : vend au bid quand bid >= fill x (1 + tpPct)", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(antiflip5mConfig({ antiflipTakeProfitPct: 0.2 }), repos);
    engine.init();
    engine.setEnabled(true);

    const now = Date.now();
    const ev = event(now / 1000 + 240);
    // Tick 1 : pré-flip — favori "Down" à 0.62, déchu "Up" à 0.37.
    engine.onBooks(ev, books(0.62, 0.37, 100), now);
    // Tick 2 (flip, +6s > délai 0) : "Up" redevient favori à 0.62,
    // le déchu "Down" cote 0.35 ∈ bande [0.30, 0.40] → FOK buy.
    engine.onBooks(ev, books(0.35, 0.62, 100), now + 6000);
    const open = engine.getOpenPositions();
    assert.equal(open.length, 1, "entrée antiflip ouverte");
    const fillPrice = open[0].fillPrice;
    const target = fillPrice * 1.2;

    // Tick suivant : bid du token détenu atteint le TP → vente.
    const tpBid = Math.min(0.99, Math.ceil(target * 100) / 100);
    const upBooks: TokenBook[] = [
      { tokenId: "t-up", outcome: "Up", outcomeIndex: 0, bestBid: 0.61, bestAsk: 0.62, bestAskSize: 100, bestBidSize: 100 },
      { tokenId: "t-down", outcome: "Down", outcomeIndex: 1, bestBid: tpBid, bestAsk: Math.min(0.99, tpBid + 0.01), bestAskSize: 100, bestBidSize: 100 },
    ];
    engine.onBooks(ev, upBooks, now + 7000);
    assert.equal(engine.getOpenPositions().length, 0, "position vendue au TP");

    const resolved = repos.simPositions.all();
    const sold = resolved.find((p) => p.status === "sold");
    assert.ok(sold, "position marquée 'sold'");
    assert.ok((sold?.sellPrice ?? 0) >= target - 1e-9);
    repos.db.close();
  });

  it("TP = 0 : hold to resolution (pas de vente intra-market)", () => {
    const repos = simRepos();
    const engine = new PaperTradingEngine(antiflip5mConfig({ antiflipTakeProfitPct: 0 }), repos);
    engine.init();
    engine.setEnabled(true);

    const now = Date.now();
    const ev = event(now / 1000 + 240);
    // Même séquence de flip que le test TP.
    engine.onBooks(ev, books(0.62, 0.37, 100), now);
    engine.onBooks(ev, books(0.35, 0.62, 100), now + 6000);
    assert.equal(engine.getOpenPositions().length, 1);

    // Bid très haut : sans TP, aucune vente intra-market.
    const upBooks: TokenBook[] = [
      { tokenId: "t-up", outcome: "Up", outcomeIndex: 0, bestBid: 0.61, bestAsk: 0.62, bestAskSize: 100, bestBidSize: 100 },
      { tokenId: "t-down", outcome: "Down", outcomeIndex: 1, bestBid: 0.9, bestAsk: 0.91, bestAskSize: 100, bestBidSize: 100 },
    ];
    engine.onBooks(ev, upBooks, now + 7000);
    assert.equal(engine.getOpenPositions().length, 1, "position toujours ouverte (hold)");
    repos.db.close();
  });
});