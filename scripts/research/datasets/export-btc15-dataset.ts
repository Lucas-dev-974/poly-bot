/**
 * Export BTC 15m Polymarket up/down windows with >700 book ticks and known resolution.
 * Read-only against data/bot-live.db. Streaming CSV writers keep memory low.
 *
 * Usage: npx tsx scripts/research/datasets/export-btc15-dataset.ts
 *
 * Tick definition: one tick = one distinct book snapshot timestamp (ms) for the
 * window where BOTH Up (outcomeIndex=0) and Down (outcomeIndex=1) rows exist.
 * Matches src/backtest listTickGroups (COUNT DISTINCT outcomeIndex >= 2) and
 * model-ia patterns-ml dataset merge-by-ts requiring both sides.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream, type WriteStream } from "fs";

const DB_PATH = path.resolve("data/bot-live.db");
const OUT_DIR = path.resolve("data/datasets/btc15-clustering");
const PREFIX = "btc-updown-15m-";
const MIN_TICKS = 700; // strictly greater than
const WINDOW_SEC = 900;
const DEPTH_N = 3; // best + ask2/bid2 + ask3/bid3

interface WindowRow {
  eventSlug: string;
  tick_count: number;
  first_ts: number;
  last_ts: number;
  winnerOutcomeIndex: number;
  source: string;
  conditionId: string | null;
  windowStartDb: number | null;
  windowEndDb: number | null;
}

interface BookRow {
  ts: number;
  outcomeIndex: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  ask2: number | null;
  ask2Size: number | null;
  ask3: number | null;
  ask3Size: number | null;
  bid2: number | null;
  bid2Size: number | null;
  bid3: number | null;
  bid3Size: number | null;
}

function isoUtc(msOrSec: number, isSec = false): string {
  const ms = isSec ? msOrSec * 1000 : msOrSec;
  return new Date(ms).toISOString();
}

function parseWindowStart(slug: string): number | null {
  const m = slug.match(/-(\d{10})$/);
  return m ? Number(m[1]) : null;
}

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function numOrEmpty(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  return String(v);
}

function mid(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null) return null;
  return (bid + ask) / 2;
}

function spread(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null) return null;
  const s = ask - bid;
  return Number.isFinite(s) ? s : null;
}

function depthBid(r: {
  bestBidSize: number | null;
  bid2Size: number | null;
  bid3Size: number | null;
}): number {
  return (r.bestBidSize ?? 0) + (r.bid2Size ?? 0) + (r.bid3Size ?? 0);
}

function depthAsk(r: {
  bestAskSize: number | null;
  ask2Size: number | null;
  ask3Size: number | null;
}): number {
  return (r.bestAskSize ?? 0) + (r.ask2Size ?? 0) + (r.ask3Size ?? 0);
}

function calendarDaysInclusive(startSec: number, endSec: number): number {
  const a = new Date(startSec * 1000);
  const b = new Date(endSec * 1000);
  const utcA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const utcB = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((utcB - utcA) / 86_400_000) + 1;
}

function ymdUtc(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function parisLabel(sec: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(sec * 1000));
}

class ChunkWriter {
  private stream: WriteStream;
  private buf: string[] = [];
  private readonly chunkSize: number;
  bytes = 0;
  rows = 0;

  constructor(filePath: string, header: string, chunkSize = 500) {
    this.stream = createWriteStream(filePath, { encoding: "utf8" });
    this.chunkSize = chunkSize;
    this.writeLine(header);
  }

  writeLine(line: string): void {
    this.buf.push(line);
    this.rows++;
    if (this.buf.length >= this.chunkSize) this.flush();
  }

  flush(): void {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join("\n") + "\n";
    this.buf = [];
    this.bytes += Buffer.byteLength(chunk, "utf8");
    this.stream.write(chunk);
  }

  async close(): Promise<void> {
    this.flush();
    await new Promise<void>((resolve, reject) => {
      this.stream.end(() => resolve());
      this.stream.on("error", reject);
    });
  }
}

function openDb(): Database.Database {
  if (!fs.existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 8000");
  db.pragma("query_only = ON");
  return db;
}

function exclusionBreakdown(db: Database.Database): {
  totalBtc15: number;
  tooFewTicks: number;
  noResolution: number;
  ambiguous: number;
  selected: number;
} {
  const row = db
    .prepare(
      `
    WITH paired AS (
      SELECT eventSlug, ts
      FROM book_snapshots
      WHERE eventSlug LIKE 'btc-updown-15m-%'
      GROUP BY eventSlug, ts
      HAVING COUNT(DISTINCT outcomeIndex) >= 2
    ),
    counts AS (
      SELECT eventSlug, COUNT(*) AS tick_count
      FROM paired
      GROUP BY eventSlug
    )
    SELECT
      COUNT(*) AS totalBtc15,
      SUM(CASE WHEN c.tick_count <= ? THEN 1 ELSE 0 END) AS tooFewTicks,
      SUM(CASE WHEN c.tick_count > ? AND mr.eventSlug IS NULL THEN 1 ELSE 0 END) AS noResolution,
      SUM(CASE WHEN c.tick_count > ? AND mr.winnerOutcomeIndex = 2 THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN c.tick_count > ? AND mr.winnerOutcomeIndex IN (0,1) THEN 1 ELSE 0 END) AS selected
    FROM counts c
    LEFT JOIN market_resolutions mr ON mr.eventSlug = c.eventSlug
  `,
    )
    .get(MIN_TICKS, MIN_TICKS, MIN_TICKS, MIN_TICKS) as any;
  return {
    totalBtc15: Number(row.totalBtc15),
    tooFewTicks: Number(row.tooFewTicks),
    noResolution: Number(row.noResolution),
    ambiguous: Number(row.ambiguous),
    selected: Number(row.selected),
  };
}

function loadSelectedWindows(db: Database.Database): WindowRow[] {
  return db
    .prepare(
      `
    WITH paired AS (
      SELECT eventSlug, ts
      FROM book_snapshots
      WHERE eventSlug LIKE 'btc-updown-15m-%'
      GROUP BY eventSlug, ts
      HAVING COUNT(DISTINCT outcomeIndex) >= 2
    ),
    counts AS (
      SELECT eventSlug, COUNT(*) AS tick_count, MIN(ts) AS first_ts, MAX(ts) AS last_ts
      FROM paired
      GROUP BY eventSlug
    ),
    meta AS (
      SELECT eventSlug,
             MAX(conditionId) AS conditionId,
             MAX(windowStart) AS windowStartDb,
             MAX(windowEnd) AS windowEndDb
      FROM market_snapshots
      WHERE eventSlug LIKE 'btc-updown-15m-%'
      GROUP BY eventSlug
    )
    SELECT
      c.eventSlug,
      c.tick_count,
      c.first_ts,
      c.last_ts,
      mr.winnerOutcomeIndex,
      mr.source,
      meta.conditionId,
      meta.windowStartDb,
      meta.windowEndDb
    FROM counts c
    JOIN market_resolutions mr ON mr.eventSlug = c.eventSlug
    LEFT JOIN meta ON meta.eventSlug = c.eventSlug
    WHERE c.tick_count > ?
      AND mr.winnerOutcomeIndex IN (0, 1)
    ORDER BY CAST(substr(c.eventSlug, -10) AS INTEGER) ASC
  `,
    )
    .all(MIN_TICKS) as WindowRow[];
}

const TICK_HEADER = [
  "window_id",
  "condition_id",
  "window_start",
  "window_end",
  "ts",
  "ts_ms",
  "elapsed_sec",
  "tick_index",
  "best_bid_up",
  "best_ask_up",
  "bid_size_up",
  "ask_size_up",
  "depth_bid_up",
  "depth_ask_up",
  "best_bid_down",
  "best_ask_down",
  "bid_size_down",
  "ask_size_down",
  "depth_bid_down",
  "depth_ask_down",
  "mid_up",
  "mid_down",
  "ask_sum",
  "spread_up",
  "spread_down",
  "winner",
  "up_won",
].join(",");

const WINDOW_HEADER = [
  "window_id",
  "condition_id",
  "window_start",
  "window_end",
  "tick_count",
  "first_ts",
  "last_ts",
  "coverage",
  "winner",
  "up_won",
  "resolution_source",
  "open_up_ask",
  "close_up_ask",
  "open_down_ask",
  "close_down_ask",
].join(",");

async function main(): Promise<void> {
  console.log(`[export] opening DB read-only: ${DB_PATH}`);
  const db = openDb();

  const exclusions = exclusionBreakdown(db);
  console.log("[export] exclusions:", exclusions);

  const windows = loadSelectedWindows(db);
  console.log(`[export] selected windows: ${windows.length}`);
  if (windows.length === 0) {
    db.close();
    throw new Error("No windows selected");
  }

  const starts = windows.map((w) => parseWindowStart(w.eventSlug)!);
  const firstStart = Math.min(...starts);
  const lastStart = Math.max(...starts);
  const startYmd = ymdUtc(firstStart);
  const endYmd = ymdUtc(lastStart);
  const nDays = calendarDaysInclusive(firstStart, lastStart);
  const tag = `${startYmd}_to_${endYmd}_${nDays}j`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ticksTmp = path.join(OUT_DIR, `_tmp_ticks_${tag}.csv`);
  const windowsTmp = path.join(OUT_DIR, `_tmp_windows_${tag}.csv`);
  const ticksFinal = path.join(OUT_DIR, `btc15_ticks_gt700_${tag}.csv`);
  const windowsFinal = path.join(OUT_DIR, `btc15_windows_gt700_${tag}.csv`);
  const readmePath = path.join(OUT_DIR, "README.md");

  const tickWriter = new ChunkWriter(ticksTmp, TICK_HEADER);
  const windowWriter = new ChunkWriter(windowsTmp, WINDOW_HEADER);

  const bookStmt = db.prepare(`
    SELECT ts, outcomeIndex, bestBid, bestAsk, bestBidSize, bestAskSize,
           ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size
    FROM book_snapshots
    WHERE eventSlug = ?
    ORDER BY ts ASC
  `);

  let upWins = 0;
  let downWins = 0;
  let totalTickRows = 0;
  let windowsWithGaps = 0;
  let duplicateTsSkipped = 0;
  let unpairedTsSkipped = 0;
  const perWindowCounts: Array<{ slug: string; n: number; expected: number }> = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const windowStartSec = parseWindowStart(w.eventSlug);
    if (windowStartSec == null) {
      console.warn(`[export] skip bad slug: ${w.eventSlug}`);
      continue;
    }
    const windowEndSec = windowStartSec + WINDOW_SEC;
    const winner = w.winnerOutcomeIndex === 0 ? "Up" : "Down";
    const upWon = w.winnerOutcomeIndex === 0 ? 1 : 0;
    if (upWon) upWins++;
    else downWins++;

    const rows = bookStmt.all(w.eventSlug) as BookRow[];
    const byTs = new Map<number, { up?: BookRow; down?: BookRow }>();
    for (const r of rows) {
      let entry = byTs.get(r.ts);
      if (!entry) {
        entry = {};
        byTs.set(r.ts, entry);
      }
      if (r.outcomeIndex === 0) {
        if (entry.up) duplicateTsSkipped++;
        entry.up = r;
      } else if (r.outcomeIndex === 1) {
        if (entry.down) duplicateTsSkipped++;
        entry.down = r;
      }
    }

    const tsSorted = [...byTs.keys()].sort((a, b) => a - b);
    let tickIndex = 0;
    let openUpAsk: number | null = null;
    let closeUpAsk: number | null = null;
    let openDownAsk: number | null = null;
    let closeDownAsk: number | null = null;
    let prevTs: number | null = null;
    let hasGap = false;
    let written = 0;

    for (const ts of tsSorted) {
      const pair = byTs.get(ts)!;
      if (!pair.up || !pair.down) {
        unpairedTsSkipped++;
        continue;
      }
      if (prevTs != null && ts - prevTs > 5000) hasGap = true;
      prevTs = ts;

      const up = pair.up;
      const down = pair.down;
      const midUp = mid(up.bestBid, up.bestAsk);
      const midDown = mid(down.bestBid, down.bestAsk);
      const askSum =
        up.bestAsk != null && down.bestAsk != null ? up.bestAsk + down.bestAsk : null;

      if (openUpAsk == null && up.bestAsk != null) openUpAsk = up.bestAsk;
      if (up.bestAsk != null) closeUpAsk = up.bestAsk;
      if (openDownAsk == null && down.bestAsk != null) openDownAsk = down.bestAsk;
      if (down.bestAsk != null) closeDownAsk = down.bestAsk;

      const elapsed = (ts - windowStartSec * 1000) / 1000;
      tickWriter.writeLine(
        [
          csvEscape(w.eventSlug),
          csvEscape(w.conditionId),
          csvEscape(isoUtc(windowStartSec, true)),
          csvEscape(isoUtc(windowEndSec, true)),
          csvEscape(isoUtc(ts)),
          numOrEmpty(ts),
          numOrEmpty(Math.round(elapsed * 1000) / 1000),
          String(tickIndex),
          numOrEmpty(up.bestBid),
          numOrEmpty(up.bestAsk),
          numOrEmpty(up.bestBidSize),
          numOrEmpty(up.bestAskSize),
          numOrEmpty(depthBid(up)),
          numOrEmpty(depthAsk(up)),
          numOrEmpty(down.bestBid),
          numOrEmpty(down.bestAsk),
          numOrEmpty(down.bestBidSize),
          numOrEmpty(down.bestAskSize),
          numOrEmpty(depthBid(down)),
          numOrEmpty(depthAsk(down)),
          numOrEmpty(midUp),
          numOrEmpty(midDown),
          numOrEmpty(askSum),
          numOrEmpty(spread(up.bestBid, up.bestAsk)),
          numOrEmpty(spread(down.bestBid, down.bestAsk)),
          winner,
          String(upWon),
        ].join(","),
      );
      tickIndex++;
      written++;
    }

    if (hasGap) windowsWithGaps++;
    totalTickRows += written;
    perWindowCounts.push({ slug: w.eventSlug, n: written, expected: w.tick_count });

    const coverage =
      w.first_ts != null && w.last_ts != null
        ? (w.last_ts - w.first_ts) / 1000 / WINDOW_SEC
        : 0;

    windowWriter.writeLine(
      [
        csvEscape(w.eventSlug),
        csvEscape(w.conditionId),
        csvEscape(isoUtc(windowStartSec, true)),
        csvEscape(isoUtc(windowEndSec, true)),
        String(written),
        csvEscape(isoUtc(w.first_ts)),
        csvEscape(isoUtc(w.last_ts)),
        numOrEmpty(Math.round(coverage * 10000) / 10000),
        winner,
        String(upWon),
        csvEscape(w.source),
        numOrEmpty(openUpAsk),
        numOrEmpty(closeUpAsk),
        numOrEmpty(openDownAsk),
        numOrEmpty(closeDownAsk),
      ].join(","),
    );

    if ((wi + 1) % 100 === 0 || wi + 1 === windows.length) {
      console.log(`[export] windows ${wi + 1}/${windows.length} (tick rows so far ${totalTickRows})`);
    }
  }

  await tickWriter.close();
  await windowWriter.close();
  db.close();

  // Rename temp -> final
  if (fs.existsSync(ticksFinal)) fs.unlinkSync(ticksFinal);
  if (fs.existsSync(windowsFinal)) fs.unlinkSync(windowsFinal);
  fs.renameSync(ticksTmp, ticksFinal);
  fs.renameSync(windowsTmp, windowsFinal);

  const mismatches = perWindowCounts.filter((p) => p.n !== p.expected || p.n <= MIN_TICKS);
  const missingWinner = 0; // enforced by selection

  const ticksStat = fs.statSync(ticksFinal);
  const windowsStat = fs.statSync(windowsFinal);

  const readme = `# BTC 15m clustering dataset (gt700)

## Source
- SQLite DB: \`data/bot-live.db\` (opened **read-only** with better-sqlite3 \`{ readonly: true, fileMustExist: true }\`, \`busy_timeout\`, \`query_only=ON\`)
- Tables: \`book_snapshots\` joined with \`market_resolutions\` (and \`market_snapshots\` for condition_id / window bounds metadata)
- Identification of BTC 15m windows: slug prefix \`btc-updown-15m-\` (same as \`src/backtest/windows.ts\` prefix filter + \`windowBoundsFromSlug\`)
- Up/Down mapping: \`outcomeIndex=0\` → Up, \`outcomeIndex=1\` → Down (same as backtest / patterns-ml)
- Winner: \`market_resolutions.winnerOutcomeIndex\` (0=Up, 1=Down); void/ambiguous (=2) excluded

## Selection rules
1. Asset BTC, interval 15 minutes only (\`btc-updown-15m-*\`)
2. Tick count **strictly greater than 700**
3. Known unambiguous resolution (winner Up or Down)

## How ticks were counted
A **tick** = one distinct \`book_snapshots.ts\` (ms) for the window where **both** Up and Down rows exist (\`COUNT(DISTINCT outcomeIndex) >= 2\` per \`eventSlug, ts\`).
This matches \`listTickGroups\` in \`src/db/snapshot-repositories.ts\` and the merge-by-ts logic in \`model-ia/scripts/research/patterns-ml/dataset.mts\`.
Unpaired timestamps (only one side) are skipped and not counted.

## File naming
CSV names encode the dataset range from the **first and last selected window start** (UTC calendar dates) and the inclusive day count:
\`btc15_ticks_gt700_<YYYY-MM-DD>_to_<YYYY-MM-DD>_<N>j.csv\`
\`btc15_windows_gt700_<YYYY-MM-DD>_to_<YYYY-MM-DD>_<N>j.csv\`
Example: \`${path.basename(ticksFinal)}\`

## Date range
- First window start: ${isoUtc(firstStart, true)} UTC / ${parisLabel(firstStart)} Europe/Paris
- Last window start: ${isoUtc(lastStart, true)} UTC / ${parisLabel(lastStart)} Europe/Paris
- Inclusive calendar days: **${nDays}**

## Row counts
- Windows: **${windows.length}**
- Tick rows: **${totalTickRows}**
- Up wins: **${upWins}** / Down wins: **${downWins}**

## Exclusions (all BTC 15m windows in DB)
- Total BTC 15m windows with ≥1 paired tick: **${exclusions.totalBtc15}**
- Excluded — too few ticks (≤700): **${exclusions.tooFewTicks}**
- Excluded — no resolution: **${exclusions.noResolution}**
- Excluded — ambiguous/void (winnerOutcomeIndex=2): **${exclusions.ambiguous}**
- Selected: **${exclusions.selected}**

## Depth
Top **N=${DEPTH_N}** book levels summed for \`depth_bid_*\` / \`depth_ask_*\` (best + level2 + level3). Raw JSON is not stored; levels are already columnar in the DB.

## Column dictionary — ticks CSV
| column | meaning |
|--------|---------|
| window_id | event slug (\`btc-updown-15m-<startSec>\`) |
| condition_id | Polymarket condition id (from market_snapshots if present) |
| window_start / window_end | ISO UTC bounds from slug (15m) |
| ts / ts_ms | snapshot time ISO UTC / epoch ms |
| elapsed_sec | seconds since window_start |
| tick_index | 0-based index within window (time-sorted) |
| best_bid_up / best_ask_up / bid_size_up / ask_size_up | L1 Up |
| depth_bid_up / depth_ask_up | sum of sizes over top ${DEPTH_N} bid/ask levels (Up) |
| best_bid_down / best_ask_down / bid_size_down / ask_size_down | L1 Down |
| depth_bid_down / depth_ask_down | sum of sizes over top ${DEPTH_N} levels (Down) |
| mid_up / mid_down | (bid+ask)/2 when both present |
| ask_sum | up_ask + down_ask |
| spread_up / spread_down | ask − bid |
| winner / up_won | resolution (Up/Down) and 1/0 flag (repeated on each row) |

## Column dictionary — windows CSV
| column | meaning |
|--------|---------|
| window_id / condition_id / window_start / window_end | as above |
| tick_count | paired-tick count written for this window |
| first_ts / last_ts | first/last paired tick ISO UTC |
| coverage | (last_ts − first_ts) seconds / 900 |
| winner / up_won / resolution_source | outcome + source (e.g. gamma) |
| open_up_ask / close_up_ask | Up ask on first/last tick with ask |
| open_down_ask / close_down_ask | Down ask on first/last tick with ask |

No BTC spot/reference price column exists in the DB (market_snapshots has volume/liquidity/lastTradePrice/spread only; lastTradePrice is usually null), so none was exported.

## Validation notes (export-time)
- Per-window written tick count vs SQL tick_count mismatches: **${mismatches.length}**
- Windows missing winner: **${missingWinner}**
- Windows with an internal gap >5s between consecutive ticks: **${windowsWithGaps}**
- Duplicate (slug,ts,side) overwrites skipped: **${duplicateTsSkipped}**
- Unpaired timestamps skipped: **${unpairedTsSkipped}**

## Files
- \`${path.basename(ticksFinal)}\` (${(ticksStat.size / 1e6).toFixed(2)} MB)
- \`${path.basename(windowsFinal)}\` (${(windowsStat.size / 1e6).toFixed(2)} MB)
- \`README.md\` (this file)

Generated by \`scripts/research/datasets/export-btc15-dataset.ts\` (not committed).
`;

  fs.writeFileSync(readmePath, readme, { encoding: "utf8" });

  // Write a small validation sidecar JSON for the follow-up check
  const metaPath = path.join(OUT_DIR, "_export_meta.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        ticksFinal,
        windowsFinal,
        readmePath,
        tag,
        startYmd,
        endYmd,
        nDays,
        firstStart,
        lastStart,
        windowCount: windows.length,
        totalTickRows,
        upWins,
        downWins,
        exclusions,
        ticksBytes: ticksStat.size,
        windowsBytes: windowsStat.size,
        mismatches: mismatches.slice(0, 20),
        mismatchCount: mismatches.length,
        windowsWithGaps,
        duplicateTsSkipped,
        unpairedTsSkipped,
        sampleSlugs: windows.slice(0, 2).map((w) => w.eventSlug).concat(
          windows.slice(-2).map((w) => w.eventSlug),
        ),
      },
      null,
      2,
    ),
    { encoding: "utf8" },
  );

  console.log("[export] DONE");
  console.log(JSON.stringify({
    ticksFinal,
    windowsFinal,
    readmePath,
    tag,
    windowCount: windows.length,
    totalTickRows,
    upWins,
    downWins,
    ticksMB: +(ticksStat.size / 1e6).toFixed(2),
    windowsMB: +(windowsStat.size / 1e6).toFixed(2),
    mismatchCount: mismatches.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});