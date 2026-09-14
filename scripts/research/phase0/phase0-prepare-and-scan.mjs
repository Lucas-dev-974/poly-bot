import { DatabaseSync } from "node:sqlite";
import { writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const dataDir = join(root, "data");

// Write Phase 0 settings sidecar (does not replace live settings)
const phase0 = {
  pollIntervalMs: 5000,
  marketSlugPrefixes: ["btc-updown-15m"],
  strategyId: "arb",
  cheapBuyMin: 0.07,
  cheapBuyMax: 0.2,
  expensiveBuyMin: 0.78,
  expensiveBuyMax: 0.9,
  enableExpensiveHedge: true,
  cheapOrderUsdc: 1,
  pairLockMax: 0.98,
  expensiveOrderUsdc: 15,
  expensiveOrderType: "FOK",
  maxSharesPerOrder: 20,
  maxOpenPositionsPerSide: 1,
  maxExposureUsdc: 40,
  minutesBeforeCloseMin: 0,
  minutesBeforeCloseMax: 15,
  minMinutesBeforeCloseToBuy: null,
  simulatedCapital: 50,
  simFillProbabilityNonMarketable: 0.3,
  simResolveDelaySeconds: 5,
  simResolveRetryIntervalMs: 5000,
  simResolveMaxRetries: 5,
  simResolveFallback: "none",
  simMaxRetryAttempts: 20,
};
writeFileSync(
  join(dataDir, "bot-settings.phase0-coverage-max.json"),
  JSON.stringify(phase0, null, 2) + "\n",
);
console.log("Wrote data/bot-settings.phase0-coverage-max.json");

function classifyPairs(dbPath) {
  if (!existsSync(dbPath)) {
    console.log("Missing", dbPath);
    return;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const pairs = db
    .prepare("SELECT id, eventSlug, status, directional, realizedPnl FROM arb_pairs")
    .all();
  const positions = db
    .prepare(
      "SELECT pairId, kind, status, size, fillPrice, sellPrice FROM positions",
    )
    .all();

  const byPair = new Map();
  for (const p of positions) {
    if (!byPair.has(p.pairId)) byPair.set(p.pairId, []);
    byPair.get(p.pairId).push(p);
  }

  const counts = {
    pairs_total: pairs.length,
    locked_1_1: 0,
    partial: 0,
    naked_or_directional: 0,
    defended_sold: 0,
    other: 0,
  };

  for (const pair of pairs) {
    const legs = byPair.get(pair.id) ?? [];
    const cheap = legs.filter((l) => l.kind === "cheap");
    const exp = legs.filter((l) => l.kind === "expensive");
    const cheapFilled = cheap.reduce((s, l) => s + (l.size || 0), 0);
    const expFilled = exp.reduce((s, l) => s + (l.size || 0), 0);
    const cheapSold = cheap.some((l) => l.status === "sold");

    if (cheapSold) {
      counts.defended_sold++;
    } else if (pair.directional === 1 || (cheapFilled > 0 && expFilled <= 0)) {
      counts.naked_or_directional++;
    } else if (cheapFilled > 0 && expFilled > 0 && Math.abs(cheapFilled - expFilled) < 0.01) {
      counts.locked_1_1++;
    } else if (cheapFilled > 0 && expFilled > 0 && expFilled < cheapFilled - 0.01) {
      counts.partial++;
    } else {
      counts.other++;
    }
  }

  console.log("\n===", dbPath, "===");
  console.log(counts);
  if (pairs.length > 0) {
    const locked = counts.locked_1_1;
    const bad = counts.naked_or_directional + counts.partial;
    const withCheap = locked + bad + counts.defended_sold;
    console.log(
      "approx naked+partial rate among pairs with activity:",
      withCheap ? ((bad / withCheap) * 100).toFixed(1) + "%" : "n/a",
    );
  }
}

classifyPairs(join(dataDir, "bot.db"));
