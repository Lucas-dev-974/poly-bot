/**
 * Diagnostic — diff entre l'univers officiel (listBacktestWindows) et le
 * loader research-new-strats/universe.mts. Pour chaque slug : ticks officiels
 * vs ticks loader, et raison d'exclusion éventuelle.
 * npx tsx scripts/research/research-new-strats/diag-universe.mts
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "../../../src/db/database.ts";
import { createRepositories } from "../../../src/db/index.ts";
import { listBacktestWindows } from "../../../src/backtest/windows.ts";
import { loadUniverse, parseWindowStart } from "./universe.mts";
import { isCompleteFromStats } from "../../../src/backtest/completeness.ts";
import { rmSync } from "node:fs";

const srcDb = join("data", "bot-live.db");
const workDb = join("data", `_diag-univ-${Date.now()}.db`);
{
  const src = new DatabaseSync(srcDb, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${workDb.replace(/\\/g, "/")}'`);
  } finally {
    src.close();
  }
}

try {
  const db = new Database(workDb, true);
  db.init();
  const repos = createRepositories(db);
  const criteria = { minTicks: 801, maxGapMs: 60_000, maxEdgeGapMs: null };
  const officialAll = listBacktestWindows(repos, { completeness: criteria });

  const resSet = new Set(
    (new DatabaseSync(srcDb, { readOnly: true })
      .prepare("SELECT eventSlug FROM market_resolutions")
      .all() as Array<{ eventSlug: string }>).map((r) => r.eventSlug),
  );
  const official = officialAll.filter(
    (w) => resSet.has(w.eventSlug) && w.eventSlug.startsWith("btc-updown-15m-"),
  );
  console.log(`official complete+resolved: ${official.length}`);

  const mine = loadUniverse(srcDb);
  console.log(`loader universe: ${mine.slugs.size}`);

  const officialSlugs = new Set(official.map((w) => w.eventSlug));
  const mineSlugs = new Set(mine.slugs.keys());

  const onlyOfficial = [...officialSlugs].filter((s) => !mineSlugs.has(s));
  const onlyMine = [...mineSlugs].filter((s) => !officialSlugs.has(s));
  console.log(`in official but NOT loader: ${onlyOfficial.length}`);
  console.log(`in loader but NOT official: ${onlyMine.length}`);

  // inspect 5 examples of onlyOfficial : pourquoi le loader les exclut
  const db2 = new DatabaseSync(srcDb, { readOnly: true });
  for (const slug of onlyOfficial.slice(0, 5)) {
    const wsSec = parseWindowStart(slug);
    const startMs = wsSec! * 1000;
    const endMs = startMs + 900_000;
    const rows = db2
      .prepare(
        `SELECT ts, COUNT(*) AS cnt, COUNT(DISTINCT outcomeIndex) AS d
         FROM book_snapshots WHERE eventSlug = ? AND ts >= ? AND ts <= ?
         GROUP BY ts ORDER BY ts`,
      )
      .all(slug, startMs, endMs) as Array<{ ts: number; cnt: number; d: number }>;
    const bothOutcomes = rows.filter((r) => r.d >= 2).map((r) => r.ts);
    const sorted = bothOutcomes.slice().sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < sorted.length; i++)
      maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
    const officialWin = official.find((w) => w.eventSlug === slug);
    console.log(
      `${slug}: official ticks=${officialWin?.tickCount} maxGap=${officialWin?.maxGapMs} | loader-ticks(d>=2)=${bothOutcomes.length} maxGap=${maxGap} | rawTsGroups=${rows.length} dupGroups=${rows.filter((r) => r.cnt > 2).length}`,
    );
  }
  db2.close();
  db.close();
} finally {
  for (const f of [workDb, `${workDb}-wal`, `${workDb}-shm`]) {
    try {
      rmSync(f);
    } catch {
      /* absent */
    }
  }
}