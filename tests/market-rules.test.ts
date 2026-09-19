import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";
import {
  DEFAULT_MARKET_FLAGS,
  MarketRuleStore,
  prefixesWithLiveExposure,
  splitEventsByRules,
  toggleTradingBlockReason,
} from "../src/market-rules.js";
import { prefixOfSlug } from "../src/utils/market.js";
import { testEvent } from "./helpers.js";

function withDb<T>(fn: (repos: ReturnType<typeof createRepositories>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "market-rules-"));
  const db = new Database(join(dir, "t.db"), true);
  db.init();
  try {
    return fn(createRepositories(db));
  } finally {
    db.close(); // libère le handle sinon rmSync → EBUSY sous Windows
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("prefixOfSlug", () => {
  it("extrait la famille d'un vrai slug 15m", () => {
    assert.equal(prefixOfSlug("btc-updown-15m-1758000000"), "btc-updown-15m");
    assert.equal(prefixOfSlug("sol-updown-15m-1758123456"), "sol-updown-15m");
  });

  it("laisse un slug sans suffixe epoch intact", () => {
    assert.equal(prefixOfSlug("btc-updown-15m"), "btc-updown-15m");
  });
});

describe("MarketRuleRepository roundtrip", () => {
  it("ensureDefaults est idempotent et ne mute pas une ligne existante", () => {
    withDb((repos) => {
      repos.marketRules.ensureDefaults(["btc-updown-15m", "eth-updown-15m"]);
      repos.marketRules.ensureDefaults(["btc-updown-15m"]); // 2e appel
      const rows = repos.marketRules.list();
      assert.equal(rows.length, 2);
      const btc = repos.marketRules.get("btc-updown-15m");
      assert.ok(btc);
      assert.equal(btc.recordingEnabled, 1);
      assert.equal(btc.tradingEnabled, 1);
      assert.equal(btc.addedBy, "default");

      // Une ligne déjà désactivée n'est PAS réactivée par ensureDefaults.
      repos.marketRules.setFlags("eth-updown-15m", { tradingEnabled: false });
      repos.marketRules.ensureDefaults(["eth-updown-15m"]);
      assert.equal(repos.marketRules.get("eth-updown-15m")?.tradingEnabled, 0);
    });
  });

  it("setFlags mute les flags demandés et conserve le reste", () => {
    withDb((repos) => {
      repos.marketRules.ensureDefaults(["btc-updown-15m"]);
      const row = repos.marketRules.setFlags("btc-updown-15m", { tradingEnabled: false }, "user");
      assert.equal(row.tradingEnabled, 0);
      assert.equal(row.recordingEnabled, 1);
      assert.equal(row.addedBy, "user");
      const listed = repos.marketRules.list().find((r) => r.prefix === "btc-updown-15m");
      assert.ok(listed);
      assert.equal(listed.updatedAt >= listed.createdAt, true);
    });
  });

  it("discovered retourne les familles vues récemment, hors exclusions", () => {
    withDb((repos) => {
      const now = Date.now();
      repos.marketSnapshots.insert({
        ts: now,
        eventSlug: "xrp-updown-15m-1758000000",
        eventTitle: "XRP",
        conditionId: "0xc",
        windowStart: 1758000000,
        windowEnd: 1758000900,
      });
      const found = repos.marketRules.discovered(["btc-updown-15m"], now - 1000);
      assert.deepEqual(
        found.map((r) => r.prefix),
        ["xrp-updown-15m"],
      );
      // Exclu :
      repos.marketSnapshots.insert({
        ts: now,
        eventSlug: "btc-updown-15m-1758000000",
        eventTitle: "BTC",
        conditionId: "0xb",
        windowStart: 1758000000,
        windowEnd: 1758000900,
      });
      assert.equal(
        repos.marketRules.discovered(["btc-updown-15m"], now - 1000).length,
        1,
      );
      // Trop vieux :
      assert.equal(repos.marketRules.discovered([], now + 1000).length, 0);
    });
  });
});

describe("splitEventsByRules (pur)", () => {
  const ev = (slug: string) => ({ ...testEvent(), slug });

  it("applique les 4 combinaisons recording/trading", () => {
    const flags = new Map<string, { recording: boolean; trading: boolean }>([
      ["btc-updown-15m", { recording: true, trading: true }],
      ["eth-updown-15m", { recording: true, trading: false }],
      ["sol-updown-15m", { recording: false, trading: true }],
      ["xrp-updown-15m", { recording: false, trading: false }],
    ]);
    const out = splitEventsByRules(
      [
        ev("btc-updown-15m-1758000000"),
        ev("eth-updown-15m-1758000000"),
        ev("sol-updown-15m-1758000000"),
        ev("xrp-updown-15m-1758000000"),
      ],
      (p) => flags.get(p) ?? DEFAULT_MARKET_FLAGS,
    );
    assert.deepEqual(
      out.map((o) => [o.recording, o.trading]),
      [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ],
    );
  });

  it("famille inconnue = défaut (recording + trading)", () => {
    const out = splitEventsByRules([ev("doge-updown-15m-1758000000")], () =>
      DEFAULT_MARKET_FLAGS,
    );
    assert.deepEqual(out[0], {
      recording: true,
      trading: true,
      event: out[0].event,
    });
  });
});

describe("garde toggle trading", () => {
  it("refuse avec exposition ouverte, autorise sinon", () => {
    const exposure = prefixesWithLiveExposure(
      [{ eventSlug: "btc-updown-15m-1758000000" }],
      [{ eventSlug: "eth-updown-15m-1758123456" }],
    );
    assert.ok(toggleTradingBlockReason("btc-updown-15m", exposure));
    assert.ok(toggleTradingBlockReason("eth-updown-15m", exposure));
    assert.equal(toggleTradingBlockReason("sol-updown-15m", exposure), null);
  });
});

describe("MarketRuleStore", () => {
  it("loadFromDb + get + setFlags + addPrefix", () => {
    withDb((repos) => {
      repos.marketRules.ensureDefaults(["btc-updown-15m"]);
      const store = new MarketRuleStore();
      store.loadFromDb(repos);
      assert.deepEqual(store.get("btc-updown-15m"), { recording: true, trading: true });
      // Famille inconnue → défaut historique.
      assert.deepEqual(store.get("nope-updown-15m"), DEFAULT_MARKET_FLAGS);

      store.setFlags("btc-updown-15m", { trading: false }, repos);
      assert.deepEqual(store.get("btc-updown-15m"), { recording: true, trading: false });
      // La DB reflète le changement (un NOUVEAU store le relit).
      const reloaded = new MarketRuleStore();
      reloaded.loadFromDb(repos);
      assert.deepEqual(reloaded.get("btc-updown-15m"), { recording: true, trading: false });

      store.addPrefix("sol-updown-15m", repos);
      assert.deepEqual(store.get("sol-updown-15m"), { recording: true, trading: true });
      assert.equal(repos.marketRules.get("sol-updown-15m")?.addedBy, "default");
    });
  });
});