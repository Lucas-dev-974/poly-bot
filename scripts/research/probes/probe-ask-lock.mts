import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows, booksFromRows } from "../../../src/backtest/windows.ts";

const srcDb = join("data", "bot-live.db");
const dstDb = join("data", "bot-asklock-probe.db");
copyFileSync(srcDb, dstDb);
for (const suf of ["-wal", "-shm"] as const) {
  const p = srcDb + suf;
  if (existsSync(p)) copyFileSync(p, dstDb + suf);
}
const db = new Database(dstDb, true);
db.init();
const repos = createRepositories(db);
const all = listBacktestWindows(repos, {});
const prefixes = new Map<string, { n: number; complete: number }>();
for (const w of all) {
  const p = w.eventSlug.split("-").slice(0, 3).join("-");
  const cur = prefixes.get(p) ?? { n: 0, complete: 0 };
  cur.n++;
  if (w.complete) cur.complete++;
  prefixes.set(p, cur);
}
console.log("prefixes", Object.fromEntries([...prefixes.entries()].sort((a,b)=>b[1].complete-a[1].complete).slice(0,20)));

const btc = all.filter((w) => w.eventSlug.startsWith("btc-updown-15m") && w.complete).slice(0, 85);
const locks = [0.97, 0.98, 0.99, 1.0, 1.01, 1.02];
const stats: Record<string, { ticks: number; windowsWith: number; bestSum: number }> = {};
for (const L of locks) stats[String(L)] = { ticks: 0, windowsWith: 0, bestSum: 99 };

// Also: maker-style opportunity count where min(cheapAsk,0.18)+min(expAsk,0.85) <= 0.99
let makerLockTicks = 0;
let makerLockWindows = 0;
let cheapAskPlusExpAsk: number[] = [];

for (const w of btc) {
  const rows = repos.bookSnapshots.bySlugAndRange(
    w.eventSlug,
    w.windowStart * 1000,
    w.windowEnd * 1000,
  );
  const byTs = booksFromRows(rows);
  const seen: Record<string, boolean> = {};
  let makerSeen = false;
  for (const [, books] of byTs) {
    if (books.length < 2) continue;
    const asks = books.map((b) => b.bestAsk).filter((x): x is number => x != null);
    if (asks.length < 2) continue;
    const sum = Math.round((asks[0] + asks[1]) * 100) / 100;
    cheapAskPlusExpAsk.push(sum);
    for (const L of locks) {
      if (sum <= L) {
        stats[String(L)].ticks++;
        seen[String(L)] = true;
        if (sum < stats[String(L)].bestSum) stats[String(L)].bestSum = sum;
      }
    }
    // identify cheap = lower ask, expensive = higher ask
    const cheapAsk = Math.min(asks[0], asks[1]);
    const expAsk = Math.max(asks[0], asks[1]);
    const makerCheap = Math.min(cheapAsk, 0.18);
    const hedge = Math.min(expAsk, 0.85);
    if (makerCheap + hedge <= 0.99 && cheapAsk >= 0.01) {
      makerLockTicks++;
      makerSeen = true;
    }
  }
  for (const L of locks) if (seen[String(L)]) stats[String(L)].windowsWith++;
  if (makerSeen) makerLockWindows++;
}
cheapAskPlusExpAsk.sort((a,b)=>a-b);
const pct = (p: number) => cheapAskPlusExpAsk[Math.floor((cheapAskPlusExpAsk.length-1)*p)];
console.log(JSON.stringify({
  windows: btc.length,
  askAskStats: stats,
  makerStyleLockTicks: makerLockTicks,
  makerStyleLockWindows: makerLockWindows,
  askAskDistribution: {
    n: cheapAskPlusExpAsk.length,
    p01: pct(0.01),
    p05: pct(0.05),
    p10: pct(0.1),
    p50: pct(0.5),
    min: cheapAskPlusExpAsk[0],
    max: cheapAskPlusExpAsk[cheapAskPlusExpAsk.length-1],
  }
}, null, 2));
