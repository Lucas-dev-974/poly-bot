// Quick census: BTC 15m windows in bot-live.db (completeness per criteria).
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_fav-census-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

const db = new Database(workDb, true);
db.init();
const repos = createRepositories(db);

// All slugs summary
const groups = repos.bookSnapshots.listTickGroups();
const slugsByFamily = new Map<string, { n: number; first: number; last: number }>();
for (const g of groups) {
  const prefix = g.eventSlug.split("-").slice(0, 3).join("-"); // e.g. btc-updown-15m
  const cur = slugsByFamily.get(prefix) ?? { n: 0, first: Infinity, last: 0 };
  cur.n += 1;
  cur.first = Math.min(cur.first, g.ts);
  cur.last = Math.max(cur.last, g.ts);
  slugsByFamily.set(prefix, cur);
}

const all = listBacktestWindows(repos, {});
const btc15 = all.filter((w) => w.eventSlug.startsWith("btc-updown-15m"));
const eth15 = all.filter((w) => w.eventSlug.startsWith("eth-updown-15m"));
const btc15Complete = btc15.filter((w) => w.complete);

// Date range of BTC15 windows
let minStart = Infinity, maxEnd = 0;
for (const w of btc15) {
  minStart = Math.min(minStart, w.windowStart);
  maxEnd = Math.max(maxEnd, w.windowEnd);
}

// Per-day counts of BTC15 complete windows (UTC)
const perDay = new Map<string, { total: number; complete: number }>();
for (const w of btc15) {
  const day = new Date(w.windowStart * 1000).toISOString().slice(0, 10);
  const cur = perDay.get(day) ?? { total: 0, complete: 0 };
  cur.total += 1;
  if (w.complete) cur.complete += 1;
  perDay.set(day, cur);
}

console.log(JSON.stringify({
  families: [...slugsByFamily.entries()].map(([k, v]) => ({ family: k, windows: v.n, from: new Date(v.first).toISOString(), to: new Date(v.last).toISOString() })).sort((a, b) => a.family.localeCompare(b.family)),
  btc15: {
    total: btc15.length,
    complete: btc15Complete.length,
    from: new Date(minStart).toISOString(),
    to: new Date(maxEnd).toISOString(),
    perDay: [...perDay.entries()].map(([day, v]) => ({ day, total: v.total, complete: v.complete })).sort((a, b) => a.day.localeCompare(b.day)),
  },
  eth15: { total: eth15.length, complete: eth15.filter((w) => w.complete).length },
}, null, 2));

try { (db as { close?: () => void }).close?.(); } catch {}