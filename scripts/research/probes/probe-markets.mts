import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows, booksFromRows } from "../../../src/backtest/windows.ts";

const src = join("data", "bot-live.db");
const dst = join("data", "bot-mkt-probe.db");
copyFileSync(src, dst);
for (const s of ["-wal", "-shm"] as const) if (existsSync(src + s)) copyFileSync(src + s, dst + s);
const db = new Database(dst, true); db.init();
const repos = createRepositories(db);
const all = listBacktestWindows(repos, {});
const by = new Map<string, { n: number; complete: number }>();
for (const w of all) {
  const parts = w.eventSlug.split("-");
  // asset + type hint: first 2-4 tokens
  let key = parts.slice(0, 3).join("-");
  if (parts[1] === "updown") key = parts.slice(0, 3).join("-");
  const cur = by.get(key) ?? { n: 0, complete: 0 };
  cur.n++; if (w.complete) cur.complete++;
  by.set(key, cur);
}
console.log([...by.entries()].sort((a,b)=>b[1].complete-a[1].complete).map(([k,v])=>({k,...v})));
