import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BalanceGuard } from "../src/bot/balance-guard.js";
import type { BotConfig } from "../src/config.js";
import type { Trader } from "../src/trader.js";

/**
 * Garde-fou balance (pré-check local) : le solde caché < coût estimé doit
 * suspendre TOUT passage d'ordre (venue) pendant 60s — une seule trace par
 * fenêtre de pénurie — jusqu'à un post réussi (noteBalanceOk) ou reset.
 */
function makeGuard(): BalanceGuard {
  const trader = {
    getAvailableCollateral: async () => 100,
  } as unknown as Trader;
  return new BalanceGuard({ config: {} as BotConfig, trader });
}

describe("BalanceGuard - shortage backoff (pré-check local)", () => {
  it("pas de backoff à l'état frais", () => {
    const g = makeGuard();
    assert.equal(g.isInBackoff(1_000), false);
  });

  it("noteBalanceShortage suspend 60s puis se lève", () => {
    const g = makeGuard();
    const t0 = 1_000_000;
    g.noteBalanceShortage(t0);
    assert.equal(g.isInBackoff(t0), true);
    assert.equal(g.isInBackoff(t0 + 59_000), true);
    assert.equal(g.isInBackoff(t0 + 60_001), false);
  });

  it("noteBalanceOk (post réussi) lève la pause shortage immédiatement", () => {
    const g = makeGuard();
    const t0 = 1_000_000;
    g.noteBalanceShortage(t0);
    assert.equal(g.isInBackoff(t0 + 1_000), true);
    g.noteBalanceOk();
    assert.equal(g.isInBackoff(t0 + 1_000), false);
  });

  it("3 rejets venue (existing) suspendent aussi isInBackoff", () => {
    const g = makeGuard();
    const t0 = 2_000_000;
    g.noteBalanceRejection(t0);
    g.noteBalanceRejection(t0);
    assert.equal(g.isInBackoff(t0), false);
    g.noteBalanceRejection(t0);
    assert.equal(g.isInBackoff(t0), true); // 3e rejet → 60s
    assert.equal(g.isInBackoff(t0 + 60_001), false);
  });

  it("reset purgem les deux backoffs", () => {
    const g = makeGuard();
    const t0 = 3_000_000;
    g.noteBalanceShortage(t0);
    g.noteBalanceRejection(t0);
    g.noteBalanceRejection(t0);
    g.noteBalanceRejection(t0);
    g.reset();
    assert.equal(g.isInBackoff(t0), false);
  });
});