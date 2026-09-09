import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { booksFromRows, rowsToSeries } from "../src/backtest/windows.js";
import { Database } from "../src/db/database.js";
import { createRepositories } from "../src/db/index.js";

describe("analytics snapshots", () => {
  it("round-trips Gamma stats and L3 book levels", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-snaps-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);

    repos.marketSnapshots.insert({
      ts: 1_800_000_000_000,
      eventSlug: "btc-updown-15m-1800000000",
      eventTitle: "BTC Up or Down",
      conditionId: "0xcond",
      windowStart: 1_800_000_000,
      windowEnd: 1_800_000_900,
      volume: 1250.5,
      volume24hr: 80,
      liquidity: 4200,
      lastTradePrice: 0.86,
      spread: 0.01,
    });
    repos.bookSnapshots.insert({
      ts: 1_800_000_000_000,
      eventSlug: "btc-updown-15m-1800000000",
      tokenId: "t-up",
      outcome: "Up",
      outcomeIndex: 0,
      bestBid: 0.85,
      bestAsk: 0.86,
      bestAskSize: 10,
      bestBidSize: 8,
      ask2: 0.87,
      ask2Size: 15,
      ask3: 0.88,
      ask3Size: 20,
      bid2: 0.84,
      bid2Size: 12,
      bid3: 0.83,
      bid3Size: 9,
    });

    const market = repos.marketSnapshots.latestBySlug("btc-updown-15m-1800000000");
    assert.equal(market?.volume, 1250.5);
    assert.equal(market?.volume24hr, 80);
    assert.equal(market?.liquidity, 4200);
    assert.equal(market?.lastTradePrice, 0.86);
    assert.equal(market?.spread, 0.01);

    const books = repos.bookSnapshots.bySlugAndRange(
      "btc-updown-15m-1800000000",
      1_800_000_000_000,
      1_800_000_000_000,
    );
    assert.equal(books.length, 1);
    assert.equal(books[0]?.ask2, 0.87);
    assert.equal(books[0]?.ask2Size, 15);
    assert.equal(books[0]?.ask3, 0.88);
    assert.equal(books[0]?.bid2, 0.84);
    assert.equal(books[0]?.bid3Size, 9);
    const replayed = booksFromRows(books).get(1_800_000_000_000);
    assert.equal(replayed?.[0]?.ask2, 0.87);
    assert.equal(replayed?.[0]?.bid3Size, 9);
    db.close();
  });

  it("stores null Gamma stats and missing L2/L3 as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-snaps-"));
    const db = new Database(join(dir, "t.db"), true);
    db.init();
    const repos = createRepositories(db);
    repos.marketSnapshots.insert({
      ts: 1,
      eventSlug: "eth-updown-15m-1",
      eventTitle: "ETH",
      conditionId: "0x2",
      windowStart: 1,
      windowEnd: 2,
    });
    repos.bookSnapshots.insert({
      ts: 1,
      eventSlug: "eth-updown-15m-1",
      tokenId: "t-down",
      outcome: "Down",
      outcomeIndex: 1,
      bestBid: 0.1,
      bestAsk: 0.11,
      bestAskSize: 5,
      bestBidSize: 4,
    });
    const market = repos.marketSnapshots.latestBySlug("eth-updown-15m-1");
    assert.equal(market?.volume, null);
    assert.equal(market?.liquidity, null);
    const book = repos.bookSnapshots.byTokenAndRange("t-down", 1, 1)[0];
    assert.equal(book?.ask2, null);
    assert.equal(book?.bid3, null);
    db.close();
  });

  it("joins volume and liquidity onto backtest series ticks", () => {
    const ts = 1_800_000_000_000;
    const series = rowsToSeries(
      [
        {
          ts,
          eventSlug: "btc-updown-15m-1800000000",
          tokenId: "t-up",
          outcome: "Up",
          outcomeIndex: 0,
          bestBid: 0.8,
          bestAsk: 0.82,
          bestAskSize: 10,
          bestBidSize: 8,
        },
        {
          ts,
          eventSlug: "btc-updown-15m-1800000000",
          tokenId: "t-down",
          outcome: "Down",
          outcomeIndex: 1,
          bestBid: 0.17,
          bestAsk: 0.19,
          bestAskSize: 10,
          bestBidSize: 8,
        },
      ],
      [{ ts, volume: 1250.5, liquidity: 4200 }],
    );
    assert.equal(series.length, 1);
    assert.equal(series[0]?.volume, 1250.5);
    assert.equal(series[0]?.liquidity, 4200);
    assert.equal(series[0]?.upMid, 0.81);
    assert.ok(Math.abs((series[0]?.upSpread ?? 0) - 0.02) < 1e-10);
    assert.ok(Math.abs((series[0]?.downSpread ?? 0) - 0.02) < 1e-10);
    assert.equal(series[0]?.upBidSize, 8);
    assert.equal(series[0]?.upAskSize, 10);
    assert.equal(series[0]?.downBidSize, 8);
    assert.equal(series[0]?.downAskSize, 10);
  });
});
