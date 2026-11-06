import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readCalendarDayMetrics,
  readCalendarMetrics,
} from "../src/db/db-metrics.js";
import { createRepositories } from "../src/db/index.js";
import { Database } from "../src/db/database.js";

/** Jours civils UTC de la fixture (2026-09-08 et 2026-09-09). */
const DAY_A = 20_704;
const DAY_B = 20_705;
const baseA = DAY_A * 86_400_000;
const baseB = DAY_B * 86_400_000;

interface Fixture {
  path: string;
  db: Database;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cal-metrics-"));
  const path = join(dir, "t.db");
  const db = new Database(path, true);
  db.init();
  const repos = createRepositories(db);

  // Jour A : 3 lignes marché sur 2 marchés distincts + 2 lignes carnet.
  repos.marketSnapshots.insert({
    ts: baseA + 1_000,
    eventSlug: "btc-updown-15m-1788844800",
    eventTitle: "BTC Up or Down",
    conditionId: "0xa",
    windowStart: 1_788_844_800,
    windowEnd: 1_788_844_800 + 900,
  });
  repos.marketSnapshots.insert({
    ts: baseA + 2_000,
    eventSlug: "btc-updown-15m-1788844800",
    eventTitle: "BTC Up or Down",
    conditionId: "0xa",
    windowStart: 1_788_844_800,
    windowEnd: 1_788_844_800 + 900,
  });
  repos.marketSnapshots.insert({
    ts: baseA + 5_000,
    eventSlug: "eth-updown-15m-1788844800",
    eventTitle: "ETH Up or Down",
    conditionId: "0xb",
    windowStart: 1_788_844_800,
    windowEnd: 1_788_844_800 + 900,
  });
  repos.bookSnapshots.insert({
    ts: baseA + 1_000,
    eventSlug: "btc-updown-15m-1788844800",
    tokenId: "t-up",
    outcome: "Up",
    outcomeIndex: 0,
    bestBid: 0.85,
    bestAsk: 0.86,
    bestAskSize: 10,
    bestBidSize: 8,
  });
  repos.bookSnapshots.insert({
    ts: baseA + 1_200,
    eventSlug: "btc-updown-15m-1788844800",
    tokenId: "t-down",
    outcome: "Down",
    outcomeIndex: 1,
    bestBid: 0.13,
    bestAsk: 0.14,
    bestAskSize: 10,
    bestBidSize: 8,
  });

  // Jour B : le MÊME prefix btc, un autre créneau — 1 marché distinct ce jour.
  repos.marketSnapshots.insert({
    ts: baseB + 1_000,
    eventSlug: "btc-updown-15m-1788931200",
    eventTitle: "BTC Up or Down (day 2)",
    conditionId: "0xc",
    windowStart: 1_788_931_200,
    windowEnd: 1_788_931_200 + 900,
  });

  return { path, db };
}

describe("db calendar (onglet Calendrier)", () => {
  it("agrège par jour civil UTC : marchés distincts, lignes, book, couverture", async () => {
    const f = fixture();
    try {
      const m = await readCalendarMetrics(f.path);
      assert.equal(m.rangeStart, DAY_A);
      assert.equal(m.rangeEnd, DAY_B);
      assert.equal(m.days.length, 2);

      const a = m.days[0]!;
      assert.equal(a.day, DAY_A);
      assert.equal(a.mktRows, 3);
      assert.equal(a.markets, 2); // btc + eth le même jour
      assert.equal(a.bookRows, 2);
      assert.equal(a.coverage?.[0], baseA + 1_000);
      assert.equal(a.coverage?.[1], baseA + 5_000);

      const b = m.days[1]!;
      assert.equal(b.day, DAY_B);
      assert.equal(b.mktRows, 1);
      assert.equal(b.markets, 1);
      assert.equal(b.bookRows, 0); // aucun carnet ce jour
      assert.equal(b.coverage?.[0], baseB + 1_000);
    } finally {
      f.db.close();
    }
  });

  it("détaille les fenêtres d'UNE journée, triées par windowStart", async () => {
    const f = fixture();
    try {
      const rows = await readCalendarDayMetrics(
        f.path,
        baseA,
        baseA + 86_400_000,
      );
      // Fenêtres distinctes du jour A, triées par windowStart.
      assert.deepEqual(
        rows.map((r) => r.slug),
        ["btc-updown-15m-1788844800", "eth-updown-15m-1788844800"],
      );
      assert.equal(rows[0]?.n, 2); // 2 lignes marché pour le slug btc
      assert.equal(rows[1]?.n, 1);
      assert.equal(rows[0]?.ws, 1_788_844_800);

      // Journée sans données : tableau vide.
      const empty = await readCalendarDayMetrics(
        f.path,
        (DAY_B + 5) * 86_400_000,
        (DAY_B + 6) * 86_400_000,
      );
      assert.equal(empty.length, 0);
    } finally {
      f.db.close();
    }
  });

  it("s'expose via Database avec cache + rejet day invalide", async () => {
    const f = fixture();
    try {
      const report = await f.db.listCalendar();
      assert.equal(report.rangeStart, DAY_A);
      assert.equal(report.days.length, 2);
      assert.equal(report.calendarError, null);

      // Second appel : servi par le cache (mêmes données, sans re-scan).
      const again = await f.db.listCalendar();
      assert.equal(again.days.length, 2);

      const day = await f.db.listCalendarDay(DAY_A);
      assert.equal(day.length, 2);

      await assert.rejects(() => f.db.listCalendarDay(-1));
    } finally {
      f.db.close();
    }
  });
});
