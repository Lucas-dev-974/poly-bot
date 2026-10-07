/**
 * Export COMPLETE BTC 15m windows (no gaps) — subset of gt700 resolved.
 * Read-only against data/bot-live.db. Does not modify the existing gt700 CSVs.
 *
 * Complete = paired ticks within [window_start, window_end):
 *   first elapsed_sec <= 5, last elapsed_sec >= 895,
 *   max consecutive gap <= 5 s, tick_count > 700, known Up/Down winner.
 *
 * Usage: npx tsx scripts/research/datasets/export-btc15-complete.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { createWriteStream, type WriteStream } from "fs";

const DB_PATH = path.resolve("data/bot-live.db");
const OUT_DIR = path.resolve("data/datasets/btc15-clustering");
const MIN_TICKS = 700;
const WINDOW_SEC = 900;
const MAX_GAP_SEC = 5;
const MAX_FIRST_ELAPSED = 5;
const MIN_LAST_ELAPSED = 895;
const DEPTH_N = 3;

interface Cand {
  eventSlug: string;
  winnerOutcomeIndex: number;
  source: string;
  conditionId: string | null;
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

interface PairedTick {
  ts: number;
  up: BookRow;
  down: BookRow;
}

interface WindowMetrics {
  ticks: PairedTick[];
  clippedOut: number;
  firstElapsed: number;
  lastElapsed: number;
  maxGapSec: number;
  tickCount: number;
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

function depthBid(r: { bestBidSize: number | null; bid2Size: number | null; bid3Size: number | null }): number {
  return (r.bestBidSize ?? 0) + (r.bid2Size ?? 0) + (r.bid3Size ?? 0);
}

function depthAsk(r: { bestAskSize: number | null; ask2Size: number | null; ask3Size: number | null }): number {
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

function loadCandidates(db: Database.Database): Cand[] {
  // Same base as gt700: >700 paired ticks (all timestamps) + known winner 0/1
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
      SELECT eventSlug, COUNT(*) AS tick_count
      FROM paired
      GROUP BY eventSlug
    ),
    meta AS (
      SELECT eventSlug, MAX(conditionId) AS conditionId
      FROM market_snapshots
      WHERE eventSlug LIKE 'btc-updown-15m-%'
      GROUP BY eventSlug
    )
    SELECT c.eventSlug, mr.winnerOutcomeIndex, mr.source, meta.conditionId
    FROM counts c
    JOIN market_resolutions mr ON mr.eventSlug = c.eventSlug
    LEFT JOIN meta ON meta.eventSlug = c.eventSlug
    WHERE c.tick_count > ?
      AND mr.winnerOutcomeIndex IN (0, 1)
    ORDER BY CAST(substr(c.eventSlug, -10) AS INTEGER) ASC
  `,
    )
    .all(MIN_TICKS) as Cand[];
}

function buildPairedInBounds(
  rows: BookRow[],
  windowStartSec: number,
  windowEndSec: number,
): WindowMetrics {
  const startMs = windowStartSec * 1000;
  const endMs = windowEndSec * 1000; // exclusive end for clipping
  const byTs = new Map<number, { up?: BookRow; down?: BookRow }>();
  let totalPairedAll = 0;

  for (const r of rows) {
    let e = byTs.get(r.ts);
    if (!e) {
      e = {};
      byTs.set(r.ts, e);
    }
    if (r.outcomeIndex === 0) e.up = r;
    else if (r.outcomeIndex === 1) e.down = r;
  }

  const allPaired: PairedTick[] = [];
  for (const ts of [...byTs.keys()].sort((a, b) => a - b)) {
    const e = byTs.get(ts)!;
    if (e.up && e.down) {
      totalPairedAll++;
      allPaired.push({ ts, up: e.up, down: e.down });
    }
  }

  const ticks = allPaired.filter((t) => t.ts >= startMs && t.ts < endMs);
  const clippedOut = totalPairedAll - ticks.length;

  if (ticks.length === 0) {
    return {
      ticks,
      clippedOut,
      firstElapsed: NaN,
      lastElapsed: NaN,
      maxGapSec: Infinity,
      tickCount: 0,
    };
  }

  const firstElapsed = (ticks[0].ts - startMs) / 1000;
  const lastElapsed = (ticks[ticks.length - 1].ts - startMs) / 1000;
  let maxGapSec = 0;
  for (let i = 1; i < ticks.length; i++) {
    const gap = (ticks[i].ts - ticks[i - 1].ts) / 1000;
    if (gap > maxGapSec) maxGapSec = gap;
  }

  return { ticks, clippedOut, firstElapsed, lastElapsed, maxGapSec, tickCount: ticks.length };
}

function isComplete(m: WindowMetrics, maxGapLimit: number): boolean {
  if (m.tickCount <= MIN_TICKS) return false;
  if (!(m.firstElapsed <= MAX_FIRST_ELAPSED)) return false;
  if (!(m.lastElapsed >= MIN_LAST_ELAPSED)) return false;
  if (!(m.maxGapSec <= maxGapLimit)) return false;
  return true;
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
  "max_gap_sec",
  "first_elapsed_sec",
  "last_elapsed_sec",
].join(",");

async function main(): Promise<void> {
  console.log(`[complete] opening DB read-only: ${DB_PATH}`);
  const db = openDb();
  const candidates = loadCandidates(db);
  console.log(`[complete] gt700+resolved candidates: ${candidates.length}`);

  const bookStmt = db.prepare(`
    SELECT ts, outcomeIndex, bestBid, bestAsk, bestBidSize, bestAskSize,
           ask2, ask2Size, ask3, ask3Size, bid2, bid2Size, bid3, bid3Size
    FROM book_snapshots
    WHERE eventSlug = ?
    ORDER BY ts ASC
  `);

  type Eval = {
    cand: Cand;
    windowStartSec: number;
    windowEndSec: number;
    metrics: WindowMetrics;
  };

  const evaluated: Eval[] = [];
  let failLateStart = 0;
  let failEarlyEnd = 0;
  let failGap5 = 0;
  let failTooFewInBounds = 0;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const windowStartSec = parseWindowStart(cand.eventSlug);
    if (windowStartSec == null) continue;
    const windowEndSec = windowStartSec + WINDOW_SEC;
    const rows = bookStmt.all(cand.eventSlug) as BookRow[];
    const metrics = buildPairedInBounds(rows, windowStartSec, windowEndSec);
    evaluated.push({ cand, windowStartSec, windowEndSec, metrics });

    // Per-criterion failures (can overlap) among candidates
    if (metrics.tickCount <= MIN_TICKS) failTooFewInBounds++;
    if (!(metrics.firstElapsed <= MAX_FIRST_ELAPSED)) failLateStart++;
    if (!(metrics.lastElapsed >= MIN_LAST_ELAPSED)) failEarlyEnd++;
    if (!(metrics.maxGapSec <= MAX_GAP_SEC)) failGap5++;

    if ((i + 1) % 200 === 0 || i + 1 === candidates.length) {
      console.log(`[complete] evaluated ${i + 1}/${candidates.length}`);
    }
  }

  const selected = evaluated.filter((e) => isComplete(e.metrics, MAX_GAP_SEC));
  const sens3 = evaluated.filter((e) => isComplete(e.metrics, 3)).length;
  const sens5 = selected.length;
  const sens10 = evaluated.filter((e) => isComplete(e.metrics, 10)).length;

  console.log(`[complete] selected (gap<=5): ${selected.length}; sens3=${sens3} sens10=${sens10}`);
  console.log(
    JSON.stringify({
      candidates: candidates.length,
      failTooFewInBounds,
      failLateStart,
      failEarlyEnd,
      failGap5,
      selected: selected.length,
      sens3,
      sens5,
      sens10,
    }),
  );

  if (selected.length === 0) {
    db.close();
    throw new Error("No complete windows");
  }

  const starts = selected.map((e) => e.windowStartSec);
  const firstStart = Math.min(...starts);
  const lastStart = Math.max(...starts);
  const startYmd = ymdUtc(firstStart);
  const endYmd = ymdUtc(lastStart);
  const nDays = calendarDaysInclusive(firstStart, lastStart);
  const tag = `${startYmd}_to_${endYmd}_${nDays}j`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ticksTmp = path.join(OUT_DIR, `_tmp_ticks_complete_${tag}.csv`);
  const windowsTmp = path.join(OUT_DIR, `_tmp_windows_complete_${tag}.csv`);
  const ticksFinal = path.join(OUT_DIR, `btc15_ticks_complete_${tag}.csv`);
  const windowsFinal = path.join(OUT_DIR, `btc15_windows_complete_${tag}.csv`);

  const tickWriter = new ChunkWriter(ticksTmp, TICK_HEADER);
  const windowWriter = new ChunkWriter(windowsTmp, WINDOW_HEADER);

  let upWins = 0;
  let downWins = 0;
  let totalTickRows = 0;
  let totalClipped = 0;
  const perWindow: Array<{ slug: string; n: number; maxGap: number; firstE: number; lastE: number }> = [];

  for (let wi = 0; wi < selected.length; wi++) {
    const { cand, windowStartSec, windowEndSec, metrics } = selected[wi];
    const winner = cand.winnerOutcomeIndex === 0 ? "Up" : "Down";
    const upWon = cand.winnerOutcomeIndex === 0 ? 1 : 0;
    if (upWon) upWins++;
    else downWins++;

    totalClipped += metrics.clippedOut;
    let openUpAsk: number | null = null;
    let closeUpAsk: number | null = null;
    let openDownAsk: number | null = null;
    let closeDownAsk: number | null = null;

    for (let ti = 0; ti < metrics.ticks.length; ti++) {
      const { ts, up, down } = metrics.ticks[ti];
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
          csvEscape(cand.eventSlug),
          csvEscape(cand.conditionId),
          csvEscape(isoUtc(windowStartSec, true)),
          csvEscape(isoUtc(windowEndSec, true)),
          csvEscape(isoUtc(ts)),
          numOrEmpty(ts),
          numOrEmpty(Math.round(elapsed * 1000) / 1000),
          String(ti),
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
    }

    totalTickRows += metrics.ticks.length;
    perWindow.push({
      slug: cand.eventSlug,
      n: metrics.tickCount,
      maxGap: metrics.maxGapSec,
      firstE: metrics.firstElapsed,
      lastE: metrics.lastElapsed,
    });

    const firstTs = metrics.ticks[0].ts;
    const lastTs = metrics.ticks[metrics.ticks.length - 1].ts;
    const coverage = (lastTs - firstTs) / 1000 / WINDOW_SEC;

    windowWriter.writeLine(
      [
        csvEscape(cand.eventSlug),
        csvEscape(cand.conditionId),
        csvEscape(isoUtc(windowStartSec, true)),
        csvEscape(isoUtc(windowEndSec, true)),
        String(metrics.tickCount),
        csvEscape(isoUtc(firstTs)),
        csvEscape(isoUtc(lastTs)),
        numOrEmpty(Math.round(coverage * 10000) / 10000),
        winner,
        String(upWon),
        csvEscape(cand.source),
        numOrEmpty(openUpAsk),
        numOrEmpty(closeUpAsk),
        numOrEmpty(openDownAsk),
        numOrEmpty(closeDownAsk),
        numOrEmpty(Math.round(metrics.maxGapSec * 1000) / 1000),
        numOrEmpty(Math.round(metrics.firstElapsed * 1000) / 1000),
        numOrEmpty(Math.round(metrics.lastElapsed * 1000) / 1000),
      ].join(","),
    );

    if ((wi + 1) % 100 === 0 || wi + 1 === selected.length) {
      console.log(`[complete] wrote ${wi + 1}/${selected.length} (ticks ${totalTickRows})`);
    }
  }

  await tickWriter.close();
  await windowWriter.close();
  db.close();

  if (fs.existsSync(ticksFinal)) fs.unlinkSync(ticksFinal);
  if (fs.existsSync(windowsFinal)) fs.unlinkSync(windowsFinal);
  fs.renameSync(ticksTmp, ticksFinal);
  fs.renameSync(windowsTmp, windowsFinal);

  const ticksStat = fs.statSync(ticksFinal);
  const windowsStat = fs.statSync(windowsFinal);

  // Append/update README — preserve gt700 section, add/replace complete section
  const readmePath = path.join(OUT_DIR, "README.md");
  let existing = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : "";
  const marker = "\n## Complete windows subset (no gaps)";
  const cut = existing.indexOf(marker);
  if (cut >= 0) existing = existing.slice(0, cut).trimEnd() + "\n";

  const completeSection = `
## Complete windows subset (no gaps)

Raw ticks only (no resampling / no forward-fill). Same tick columns as the gt700 export; ticks **outside** \`[window_start, window_end)\` are dropped.

### Completeness rules (paired ticks with \`ts\` in \`[window_start, window_end)\`)
1. \`first_elapsed_sec <= 5\`
2. \`last_elapsed_sec >= 895\`
3. \`max_gap_sec <= 5\` (max gap between consecutive paired ticks)
4. \`tick_count > 700\` (in-bounds paired ticks)
5. Known unambiguous winner (Up/Down)

### File naming
\`btc15_ticks_complete_<YYYY-MM-DD>_to_<YYYY-MM-DD>_<N>j.csv\`
\`btc15_windows_complete_<YYYY-MM-DD>_to_<YYYY-MM-DD>_<N>j.csv\`
Range = first/last **selected complete** window start (UTC dates), N = inclusive calendar days.
Current: \`${path.basename(ticksFinal)}\` / \`${path.basename(windowsFinal)}\`

### Date range
- First window start: ${isoUtc(firstStart, true)} UTC / ${parisLabel(firstStart)} Europe/Paris
- Last window start: ${isoUtc(lastStart, true)} UTC / ${parisLabel(lastStart)} Europe/Paris
- Inclusive calendar days: **${nDays}**

### Counts
- Complete windows: **${selected.length}**
- Tick rows (in-bounds): **${totalTickRows}**
- Ticks clipped (outside \`[start, end)\`): **${totalClipped}**
- Up wins: **${upWins}** / Down wins: **${downWins}**

### Exclusions from gt700+resolved candidates (${candidates.length})
Per-criterion counts (a window may fail several; not mutually exclusive):
- Too few in-bounds ticks (≤700): **${failTooFewInBounds}**
- Late start (first_elapsed > 5s): **${failLateStart}**
- Early end (last_elapsed < 895s): **${failEarlyEnd}**
- Gap > 5s: **${failGap5}**
- Selected (pass all with max_gap ≤ 5s): **${selected.length}**

### Sensitivity (same edge + tick rules; only max_gap limit varies)
| max_gap | complete windows |
|--------:|-----------------:|
| ≤ 3 s | ${sens3} |
| ≤ 5 s | ${sens5} |
| ≤ 10 s | ${sens10} |

### Extra windows CSV columns
| column | meaning |
|--------|---------|
| max_gap_sec | max consecutive paired-tick gap (seconds) inside the window |
| first_elapsed_sec | elapsed of first in-bounds paired tick |
| last_elapsed_sec | elapsed of last in-bounds paired tick |

### Files
- \`${path.basename(ticksFinal)}\` (${(ticksStat.size / 1e6).toFixed(2)} MB)
- \`${path.basename(windowsFinal)}\` (${(windowsStat.size / 1e6).toFixed(2)} MB)

Generated by \`scripts/research/datasets/export-btc15-complete.ts\` (not committed). The original gt700 CSVs are unchanged.
`;

  fs.writeFileSync(readmePath, existing.trimEnd() + "\n" + completeSection, { encoding: "utf8" });

  fs.writeFileSync(
    path.join(OUT_DIR, "_complete_meta.json"),
    JSON.stringify(
      {
        ticksFinal,
        windowsFinal,
        tag,
        startYmd,
        endYmd,
        nDays,
        firstStart,
        lastStart,
        windowCount: selected.length,
        totalTickRows,
        totalClipped,
        upWins,
        downWins,
        candidates: candidates.length,
        failTooFewInBounds,
        failLateStart,
        failEarlyEnd,
        failGap5,
        sens3,
        sens5,
        sens10,
        ticksBytes: ticksStat.size,
        windowsBytes: windowsStat.size,
        sampleSlugs: selected.slice(0, 2).map((e) => e.cand.eventSlug).concat(
          selected.slice(-2).map((e) => e.cand.eventSlug),
        ),
      },
      null,
      2,
    ),
    { encoding: "utf8" },
  );

  console.log("[complete] DONE");
  console.log(
    JSON.stringify(
      {
        ticksFinal,
        windowsFinal,
        tag,
        windowCount: selected.length,
        totalTickRows,
        totalClipped,
        upWins,
        downWins,
        ticksMB: +(ticksStat.size / 1e6).toFixed(2),
        windowsMB: +(windowsStat.size / 1e6).toFixed(2),
        sens3,
        sens5,
        sens10,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});