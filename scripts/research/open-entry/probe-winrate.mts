/**
 * Probe winrate : lance un mini backtest via runBacktest (2 fenêtres
 * synthétiques stubbées) et vérifie que le BacktestResult porte
 * wins/losses/winRate cohérents avec les positions résolues.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { runBacktest } from "../../../src/backtest/runner.ts";
import { testConfig, testEvent, books } from "../../../tests/helpers.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import type { BacktestWindowMeta, BacktestTradeRow, BookSnapshotRow } from "../../../src/backtest/types.ts";

const dir = mkdtempSync(join(tmpdir(), "oe-wr-"));
const db = new Database(join(dir, "probe.db"), true);
db.init();
const repos = createRepositories(db);

const ev = testEvent(1_800_000_000);
const window: BacktestWindowMeta = {
  eventSlug: ev.slug,
  eventTitle: ev.title,
  conditionId: ev.market.conditionId,
  upTokenId: "t-up",
  downTokenId: "t-down",
  windowStart: ev.windowStart,
  windowEnd: ev.windowEnd,
  complete: true,
  tickCount: 900,
  coveragePct: 1,
  maxGapMs: 1000,
  gapCount: 0,
  active: true,
  closed: false,
} as unknown as BacktestWindowMeta;

// Stub repos : bookSnapshots renvoie un carnet simple (favori 0.62 à t=5s)
const upBook: BookSnapshotRow = {
  ts: (ev.windowStart + 5) * 1000,
  outcomeIndex: 0,
  bestAsk: 0.62,
  bestBid: 0.61,
  bestAskSize: 100,
  bestBidSize: 100,
} as unknown as BookSnapshotRow;
const downBook = { ...upBook, outcomeIndex: 1, bestAsk: 0.39, bestBid: 0.38 };

const stubRepos = {
  ...repos,
  bookSnapshots: {
    bySlugAndRange: () => [upBook, downBook],
  },
  backtestTrades: {
    insert: () => {},
  },
  marketResolutions: {
    get: () => ({ eventSlug: ev.slug, winnerOutcomeIndex: 0, source: "test", ts: 0 }),
    upsert: () => {},
  },
};
// Le stub de carnet est minimal (pas de bid2/bid3...) : neutralise les
// undefined que le vrai book snapshot n'aurait pas, pour que l'upsert
// backtest_positions ne crashe pas sur un bind SQLite undefined.
for (const key of ["backtestPositions", "backtestRuns", "backtestTrades"] as const) {
  const repo = stubRepos[key] as unknown as Record<string, (...a: never[]) => void>;
  for (const method of Object.keys(repo)) {
    const original = repo[method]!;
    repo[method] = ((...args: unknown[]) => {
      const cleaned = args.map((a) =>
        a != null && typeof a === "object"
          ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === undefined ? null : v]))
          : a,
      );
      return (original as (...a: unknown[]) => unknown)(...cleaned);
    }) as never;
  }
}

const config = testConfig({ strategyId: "early-conviction", dryRun: true, simulatedCapital: 500, maxExposureUsdc: 450 });
config.earlyConvictionMaxElapsedSec = 45;
config.earlyConvictionOrderUsdc = 15;

const result = await runBacktest({
  runId: "wr-probe",
  config,
  windows: [window],
  repos: stubRepos as never,
  hooks: { shouldCancel: () => false, onProgress: () => {} },
});

console.log("RESULT:", JSON.stringify({
  pnl: result.pnl,
  fillCount: result.fillCount,
  wins: result.wins,
  losses: result.losses,
  winRate: result.winRate,
}));
if (result.winRate === undefined) {
  throw new Error("winRate ABSENT du BacktestResult");
}
// Le tracker in-memory compte won/lost via resolvePosition — le probe
// vérifie la cohérence interne : winRate = wins / (wins + losses).
const resolved = result.wins! + result.losses!;
if (resolved === 0) throw new Error("aucune résolution — probe invalide");
if (Math.abs(result.winRate! - result.wins! / resolved) > 1e-9) {
  throw new Error("winRate != wins/(wins+losses)");
}
console.log("OK — winRate =", result.winRate, "= " + result.wins + "/" + resolved);

try { (db as { close?: () => void }).close?.(); } catch {}
rmSync(dir, { recursive: true, force: true });